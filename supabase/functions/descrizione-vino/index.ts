import { serve } from "https://deno.land/std/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

const ALLOWED_ORIGIN = "https://www.winesfever.com";

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json"
};

// --- util: normalizza nome vino in fingerprint "ordine-agnostico"
function fingerprintName(nome: string): string {
  if (!nome) return "";
  const stop = new Set([
    "il","lo","la","i","gli","le","l","un","una","uno",
    "del","della","dei","degli","delle","di","de","da","d",
    "e","ed","the","and","of"
  ]);

  const base = nome
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/["“”'’(),.;:]/g, " ")
    .replace(/&/g, " e ")
    .replace(/\b(19|20)\d{2}\b/g, " ");

  const tokens = base
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter(w => !stop.has(w));

  tokens.sort();
  return tokens.join("-");
}

// --- colore di base
function guessColor(meta: { nome?: string; categoria?: string; uvaggio?: string; sottocategoria?: string; }): "rosso"|"bianco"|"rosato" {
  const T = (s:string)=> (s||"").toLowerCase();
  const all = [meta.nome, meta.categoria, meta.sottocategoria, meta.uvaggio].map(T).join(" ");
  if (/\brosat[oi]|ros[eé]\b/.test(all)) return "rosato";
  if (/\bbianc[oi]\b/.test(all)) return "bianco";
  return "rosso";
}

// --- guide (vocabolari consentiti + baseline)
type Guides = { allowedNotes: string[]; allowedPairings: string[]; baseline?: { body:number; sweetness:number; acidity:number; notes?:string[]; pairings?:string[]; summary?:string } };

function buildGuides(meta: { nome: string; uvaggio?: string; categoria?: string; sottocategoria?: string }): Guides {
  const color = guessColor(meta);
  const uv = (meta.uvaggio||"").toLowerCase();
  const denom = (meta.nome + " " + (meta.categoria||"") + " " + (meta.sottocategoria||"")).toLowerCase();

  const baseByColor: Record<"rosso"|"bianco"|"rosato", Guides> = {
    rosso: {
      allowedNotes: ["ciliegia","amarena","prugna","mora","ribes nero","violetta","rosa secca","pepe nero","cannella","chiodo di garofano","liquirizia","tabacco","cuoio","terroso","balsamico","erbe mediterranee"],
      allowedPairings: ["carni rosse","primi al ragù","formaggi stagionati","selvaggina","brasati"]
    },
    bianco: {
      allowedNotes: ["agrumi","limone","pompelmo","frutta gialla","pesca","pera","mela","fiori bianchi","erbe","minerale"],
      allowedPairings: ["antipasti di pesce","primi di pesce","carni bianche","formaggi freschi"]
    },
    rosato: {
      allowedNotes: ["frutta rossa","fragola","lampone","melograno","floreale","erbe"],
      allowedPairings: ["salumi","fritture","cucina mediterranea"]
    }
  };

  let g: Guides = JSON.parse(JSON.stringify(baseByColor[color]));

  if (/sangiovese/.test(uv) || /chianti classico/.test(denom)) {
    g.baseline = {
      body: 60, sweetness: 5, acidity: 70,
      notes: ["ciliegia","violetta","spezie"],
      pairings: ["carni rosse","primi al ragù","formaggi stagionati"],
      summary: "Sangiovese teso e succoso: frutto rosso, slancio acido e trama sapida."
    };
    g.allowedNotes = ["ciliegia","amarena","prugna","viola","violetta","rosa secca","pepe nero","cannella","chiodo di garofano","erbe mediterranee","balsamico","terroso"];
  }

  return g;
}

// --- raffinatore
function refineWithGuides(s:any, guides:Guides, color:"rosso"|"bianco"|"rosato"){
  const clamp = (n:any)=> Math.max(0, Math.min(100, Number(n)||0));

  if (guides.baseline){
    s.profile = s.profile || {};
    s.profile.body = clamp(s.profile.body ?? guides.baseline.body);
    s.profile.sweetness = clamp(s.profile.sweetness ?? guides.baseline.sweetness);
    s.profile.acidity = clamp(s.profile.acidity ?? guides.baseline.acidity);
    if (!s.summary && guides.baseline.summary) s.summary = guides.baseline.summary;
    if ((!s.notes || !s.notes.length) && guides.baseline.notes) s.notes = guides.baseline.notes.map((label:string)=>({label}));
    if ((!s.pairings || !s.pairings.length) && guides.baseline.pairings) s.pairings = guides.baseline.pairings.slice();
  }

  const allow = guides.allowedNotes.map(x=>x.toLowerCase());
  let notes = (Array.isArray(s.notes)? s.notes: []).map((n:any)=> (typeof n==="string"? n : (n?.label||"")).toLowerCase());
  notes = notes.filter(n => allow.includes(n));
  for (const n of allow){ if (notes.length>=3) break; if (!notes.includes(n)) notes.push(n); }
  s.notes = notes.slice(0,3).map((x:string)=>({label: x.charAt(0).toUpperCase()+x.slice(1)}));

  const allowP = guides.allowedPairings.map(x=>x.toLowerCase());
  let pair = (Array.isArray(s.pairings)? s.pairings: []).map((p:any)=> (typeof p==="string"? p : (p?.label||"")).toLowerCase());
  if (color==="rosso") pair = pair.filter((p:string) => !/pesce/i.test(p));
  pair = pair.filter((p:string)=> allowP.includes(p));
  for (const p of allowP){ if (pair.length>=3) break; if (!pair.includes(p)) pair.push(p); }
  s.pairings = pair.slice(0,3).map((x:string)=> x.charAt(0).toUpperCase()+x.slice(1));

  s.profile = s.profile || {};
  s.profile.body = clamp(s.profile.body);
  s.profile.sweetness = clamp(s.profile.sweetness);
  s.profile.acidity = clamp(s.profile.acidity);
  s.summary = (s.summary||"").slice(0,160);

  return s;
}

// --- builder deterministico di “hook + palato”
function buildHookAndPalate(s: any, color: "rosso"|"bianco"|"rosato") {
  const toLow = (a:any)=> (Array.isArray(a)? a:[]).map((x:any)=> (typeof x==="string"? x : (x?.label||""))).filter(Boolean).map((x:string)=>x.toLowerCase());
  const core = toLow(s?.style?.aroma_core);
  const chipNotes = toLow(s?.notes);
  const aroma = (core.length ? core : chipNotes).slice(0,2).join(" e ");

  const hook = aroma
    ? `Profuma di ${aroma}${color!=="bianco" && !/pepe|spezi/.test(aroma) ? " con un tocco speziato" : ""}.`
    : (color==="bianco" ? "Profuma di frutta e fiori bianchi." : color==="rosato" ? "Profuma di frutta rossa e fiori." : "Profumi di frutto e spezia.");

  const bodyMap: Record<string,string> = { leggero:"corpo leggero", medio:"corpo medio", pieno:"corpo pieno" };
  const acidMap: Record<string,string> = { bassa:"acidità morbida", media:"acidità equilibrata", alta:"acidità vivace" };
  const tanMap:  Record<string,string> = { assente:"", fine:"tannino fine", presente:"tannino presente" };

  const structure = (s?.style?.structure||"").toLowerCase();
  const acidity   = (s?.style?.acidity||"").toLowerCase();
  const tannin    = (s?.style?.tannin||"").toLowerCase();

  const bodyTxt = bodyMap[structure] || "corpo medio";
  const acidTxt = acidMap[acidity]   || (color==="bianco" ? "acidità vivace" : "acidità equilibrata");
  let tanTxt    = tanMap[tannin]     || (color==="rosso" ? "tannino fine" : "");
  tanTxt = tanTxt ? `, ${tanTxt}` : "";

  const palate = `${bodyTxt}, ${acidTxt}${tanTxt}: beva scorrevole e pulita.`;
  return { hook, palate };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json();
    const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } = body || {};

    if (!nome) {
      return new Response(JSON.stringify({ error: "Parametro 'nome' mancante" }), { status: 400, headers: CORS });
    }

    const fp = fingerprintName(nome);

    // 1) cache globale per fingerprint
    const { data: exGlobal } = await supabase
      .from("descrizioni_vini")
      .select("descrizione, scheda")
      .eq("fingerprint", fp)
      .maybeSingle();

    if (exGlobal?.descrizione) {
      return new Response(JSON.stringify({
        descrizione: exGlobal.descrizione,
        scheda: exGlobal.scheda || null
      }), { status: 200, headers: CORS });
    }

    // 2) retrocompatibilità: ristorante/nome/annata/uvaggio
    let q = supabase
      .from("descrizioni_vini")
      .select("descrizione, scheda")
      .eq("nome", nome);

    if (ristorante_id) q = q.eq("ristorante_id", ristorante_id);
    if (annata) q = q.eq("annata", annata); else q = q.is("annata", null);
    if (uvaggio) q = q.eq("uvaggio", uvaggio); else q = q.is("uvaggio", null);

    const { data: exOld } = await q.maybeSingle();
    if (exOld?.descrizione) {
      await supabase.from("descrizioni_vini").update({ fingerprint: fp }).eq("nome", nome).maybeSingle();
      return new Response(JSON.stringify({
        descrizione: exOld.descrizione,
        scheda: exOld.scheda || null
      }), { status: 200, headers: CORS });
    }

    // 3) genera scheda strutturata (solo JSON) + testo deterministico
    const color = guessColor({ nome, uvaggio, categoria, sottocategoria });
    const guides = buildGuides({ nome, uvaggio, categoria, sottocategoria });

    const jsonPrompt = {
      role: "user",
      content: `Restituisci SOLO un JSON con questo schema (nessun testo fuori JSON):
{
  "style": {
    "aroma_core": ["..",".."],        // 1-2 parole ciascuna, SOLO da: ${guides.allowedNotes.join(", ")}
    "structure": "leggero|medio|pieno",
    "acidity": "bassa|media|alta",
    "tannin": "assente|fine|presente" // per bianchi/rosati preferisci "assente" o "fine"
  },
  "notes": [{"label":".."},{"label":".."},{"label":".."}],  // 3 esatte, SOLO dalla lista consentita
  "pairings": ["..","..",".."]                              // 3 esatti, SOLO dalla lista consentita
}
Regole:
- Colore dedotto: ${color}.
- Usa SOLO i termini consentiti per "notes" e "pairings".
- Non inventare legno, regioni o dettagli non presenti.
- Se i dati scarseggiano, resta coerente con colore/vitigno.

Dati:
Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}
Categoria: ${categoria || "non specificata"}
Sottocategoria: ${sottocategoria || "non specificata"}`
    };

    const model = "gpt-4o-mini";
    const sheet = await openai.chat.completions.create({
      model,
      messages: [jsonPrompt],
      temperature: 0.15,
      max_tokens: 280,
      response_format: { type: "json_object" }
    });

    let scheda: any = {};
    try {
      const raw = sheet.choices[0].message?.content ?? "{}";
      const cleaned = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
      scheda = JSON.parse(cleaned);
    } catch (e) {
      console.warn("JSON parse fallito, uso scheda vuota:", e);
      scheda = {};
    }

    // profilo numerico base se mancante (verrà rifinito da guides)
    const clamp = (n: any) => Math.max(0, Math.min(100, Number(n) || 0));
    scheda.profile = scheda.profile || {};
    // numeri neutri: saranno corretti dal baseline delle guide
    scheda.profile.body = clamp(scheda.profile.body ?? 50);
    scheda.profile.sweetness = clamp(scheda.profile.sweetness ?? 5);
    scheda.profile.acidity = clamp(scheda.profile.acidity ?? (color==="bianco" ? 65 : 55));
    scheda.notes = Array.isArray(scheda.notes) ? scheda.notes.slice(0,3) : [];
    scheda.pairings = Array.isArray(scheda.pairings) ? scheda.pairings.slice(0,3) : [];

    // rifinitura con whitelist/baseline
    scheda = refineWithGuides(scheda, guides, color);

    // 2 frasi deterministiche (hook + palato)
    const { hook, palate } = buildHookAndPalate(scheda, color);
    const descrizionePulita = `${hook} ${palate}`.trim();

    // salva
    const { error: upErr } = await supabase
      .from("descrizioni_vini")
      .upsert(
        {
          fingerprint: fp,
          nome,
          annata: annata || null,
          uvaggio: uvaggio || null,
          ristorante_id: ristorante_id || null,
          descrizione: descrizionePulita,
          scheda: { ...scheda, summary: descrizionePulita } // metto il testo anche in summary della scheda
        },
        { onConflict: "fingerprint", ignoreDuplicates: false }
      );
    if (upErr) console.error("❌ Errore salvataggio descrizione/scheda:", upErr);

    return new Response(JSON.stringify({ descrizione: descrizionePulita, scheda: { ...scheda, summary: descrizionePulita } }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione descrizione", detail: err?.message ?? String(err) }), {
      status: 500,
      headers: CORS
    });
  }
});


