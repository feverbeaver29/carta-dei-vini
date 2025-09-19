import { serve } from "https://deno.land/std/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

const ALLOWED_ORIGIN = "https://www.winesfever.com"; // oppure "*"

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
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // via accenti
    .toLowerCase()
    .replace(/["“”'’(),.;:]/g, " ")
    .replace(/&/g, " e ")
    .replace(/\b(19|20)\d{2}\b/g, " "); // via anni es. 2019

  const tokens = base
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter(w => !stop.has(w));

  tokens.sort(); // ordine alfabetico => ordine-agnostico
  return tokens.join("-");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    // 204: nessun body, headers CORS completi
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json();
    const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } = body || {};

    if (!nome) {
      return new Response(JSON.stringify({ error: "Parametro 'nome' mancante" }), { status: 400, headers: CORS });
    }

    const fp = fingerprintName(nome);

    // 1) Cerca GLOBALMENTE per fingerprint (riuso tra ristoranti)
    const { data: exGlobal, error: selErr } = await supabase
      .from("descrizioni_vini")
      .select("descrizione, scheda")
      .eq("fingerprint", fp)
      .maybeSingle();

    if (selErr) console.warn("Selezione fingerprint errore:", selErr);

if (exGlobal?.descrizione) {
  return new Response(JSON.stringify({
    descrizione: exGlobal.descrizione,
    scheda: exGlobal.scheda || null
  }), { status: 200, headers: CORS });
}

    // 2) (retrocompatibilità) prova il vecchio match per ristorante/nome/annata/uvaggio
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
// --- deduci colore di base e utility
function guessColor(meta: { nome?: string; categoria?: string; uvaggio?: string; sottocategoria?: string; }): "rosso"|"bianco"|"rosato" {
  const T = (s:string)=> (s||"").toLowerCase();
  const all = [meta.nome, meta.categoria, meta.sottocategoria, meta.uvaggio].map(T).join(" ");
  if (/\brosat[oi]|ros[eé]\b/.test(all)) return "rosato";
  if (/\bbianc[oi]\b/.test(all)) return "bianco";
  return "rosso";
}

// --- “guide” per note e abbinamenti (estendibile in futuro o spostabile su tabella Supabase)
type Guides = { allowedNotes: string[]; allowedPairings: string[]; baseline?: { body:number; sweetness:number; acidity:number; notes?:string[]; pairings?:string[]; summary?:string } };

function buildGuides(meta: { nome: string; uvaggio?: string; categoria?: string; sottocategoria?: string }): Guides {
  const color = guessColor(meta);
  const uv = (meta.uvaggio||"").toLowerCase();
  const denom = (meta.nome + " " + (meta.categoria||"") + " " + (meta.sottocategoria||"")).toLowerCase();

  // default per colore
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

  // baseline per vitigno/denominazione note (puoi ampliare)
  if (/sangiovese/.test(uv) || /chianti classico/.test(denom)) {
    g.baseline = {
      body: 60, sweetness: 5, acidity: 70,
      notes: ["ciliegia","violetta","spezie"],
      pairings: ["carni rosse","primi al ragù","formaggi stagionati"],
      summary: "Sangiovese teso e succoso: frutto rosso, slancio acido e trama sapida."
    };
    // raffina il vocabolario per questo caso
    g.allowedNotes = ["ciliegia","amarena","prugna","viola","violetta","rosa secca","pepe nero","cannella","chiodo di garofano","erbe mediterranee","balsamico","terroso"];
  }

  return g;
}

// --- post-filtro per rendere coerente la scheda con le guide
function refineWithGuides(s:any, guides:Guides, color:"rosso"|"bianco"|"rosato"){
  const clamp = (n:any)=> Math.max(0, Math.min(100, Number(n)||0));

  // applica baseline se presente (senza sovrascrivere valori plausibili già messi)
  if (guides.baseline){
    s.profile = s.profile || {};
    s.profile.body = clamp(s.profile.body ?? guides.baseline.body);
    s.profile.sweetness = clamp(s.profile.sweetness ?? guides.baseline.sweetness);
    s.profile.acidity = clamp(s.profile.acidity ?? guides.baseline.acidity);
    if (!s.summary && guides.baseline.summary) s.summary = guides.baseline.summary;
    if ((!s.notes || !s.notes.length) && guides.baseline.notes) s.notes = guides.baseline.notes.map(label=>({label}));
    if ((!s.pairings || !s.pairings.length) && guides.baseline.pairings) s.pairings = guides.baseline.pairings.slice();
  }

  // NOTE: tieni solo quelle nel dizionario consentito; completa fino a 3
  const allow = guides.allowedNotes.map(x=>x.toLowerCase());
  let notes = (Array.isArray(s.notes)? s.notes: []).map((n:any)=> (typeof n==="string"? n : (n?.label||"")).toLowerCase());
  notes = notes.filter(n => allow.includes(n));
  for (const n of allow){ if (notes.length>=3) break; if (!notes.includes(n)) notes.push(n); }
  s.notes = notes.slice(0,3).map(x=>({label: x.charAt(0).toUpperCase()+x.slice(1)}));

  // PAIRINGS: per i rossi elimina pesce; scegli 3 dal vocabolario
  const allowP = guides.allowedPairings.map(x=>x.toLowerCase());
  let pair = (Array.isArray(s.pairings)? s.pairings: []).map((p:any)=> (typeof p==="string"? p : (p?.label||"")).toLowerCase());
  if (color==="rosso") pair = pair.filter(p => !/pesce/i.test(p));
  pair = pair.filter(p=> allowP.includes(p));
  for (const p of allowP){ if (pair.length>=3) break; if (!pair.includes(p)) pair.push(p); }
  s.pairings = pair.slice(0,3).map(x=> x.charAt(0).toUpperCase()+x.slice(1));

  // clamp finale
  s.profile = s.profile || {};
  s.profile.body = clamp(s.profile.body);
  s.profile.sweetness = clamp(s.profile.sweetness);
  s.profile.acidity = clamp(s.profile.acidity);
  s.summary = (s.summary||"").slice(0,160);

  return s;
}

// 3) Genera scheda + descrizione con OpenAI (JSON + testo)
const color = guessColor({ nome, uvaggio, categoria, sottocategoria });
const guides = buildGuides({ nome, uvaggio, categoria, sottocategoria });

const jsonPrompt = {
  role: "user",
  content: `Genera SOLO un JSON (nessun testo fuori JSON) con questo schema:
{
 "summary": "max 140 caratteri, tono professionale e credibile",
 "profile": { "body": 0-100, "sweetness": 0-100, "acidity": 0-100 },
 "notes": [{"label": "una o due parole"}],   // esattamente 3 voci
 "pairings": ["...", "...", "..."]           // esattamente 3 voci
}

Istruzioni:
- Colore vino: ${color}.
- Scegli le 3 "notes" SOLO dalla lista consentita (senza crearne di nuove): ${guides.allowedNotes.join(", ")}.
- Scegli i 3 "pairings" SOLO da: ${guides.allowedPairings.join(", ")}.
- Usa termini specifici (es. "ciliegia", "mora", "pepe nero") quando sono nella lista.
- Se i dati sono scarsi, resta coerente con color, vitigno e denominazione.

Dati disponibili:
Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}
Categoria: ${categoria || "non specificata"}
Sottocategoria: ${sottocategoria || "non specificata"}`
};

const descPrompt = {
  role: "user",
  content: `Scrivi un paragrafo tecnico, sobrio ed elegante in italiano (max 320 caratteri).
- Non usare titoli, grassetti, elenchi o markdown.
- Non ripetere il nome del vino.
- 3 micro-frasi: 1) stile generale; 2) sensazioni al palato (struttura, acidità/tannino, equilibrio); 3) abbinamenti in categorie (es. carni alla griglia, primi di pesce, formaggi stagionati).
- Evita formule generiche (“elegante e complesso”, “tannini morbidi”).
Dati:
Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}
Categoria: ${categoria || "non specificata"}
Sottocategoria: ${sottocategoria || "non specificata"}`
};

// 👉 modelli: se hai "gpt-4o-mini" usalo (ottimo+costo basso). Altrimenti tieni 3.5.
const model = "gpt-4o-mini"; // fallback: "gpt-3.5-turbo"

// prima la scheda JSON
const sheet = await openai.chat.completions.create({
  model,
  messages: [jsonPrompt],
  temperature: 0.2,                 // meno “creativo” per il JSON
  max_tokens: 300,
  response_format: { type: "json_object" }
});


let scheda: any = {};
try {
  const raw = sheet.choices[0].message?.content ?? "{}";
  console.log("JSON scheda grezzo:", raw.slice(0,200));
  const cleaned = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""); // via code fences
  scheda = JSON.parse(cleaned);
} catch (e) {
  console.warn("JSON parse fallito, uso scheda vuota:", e);
}

// harden minimi
const clamp = (n: any) => Math.max(0, Math.min(100, Number(n) || 0));
scheda.profile = scheda.profile || {};
scheda.profile.body = clamp(scheda.profile.body);
scheda.profile.sweetness = clamp(scheda.profile.sweetness);
scheda.profile.acidity = clamp(scheda.profile.acidity);
scheda.notes = Array.isArray(scheda.notes) ? scheda.notes.slice(0,3) : [];
scheda.pairings = Array.isArray(scheda.pairings) ? scheda.pairings.slice(0,3) : [];
scheda.summary = (scheda.summary || "").slice(0,160);

// 👇 APPLICA SEMPRE IL RAFFINATORE (anche se il JSON era vuoto)
scheda = refineWithGuides(scheda, guides, color);

// poi il testo tecnico
const completion = await openai.chat.completions.create({
  model,
  messages: [descPrompt],
  temperature: 0.6,
  max_tokens: 350
});
const descrizione = completion.choices[0].message?.content?.trim() ?? "";
// pulizia: niente markdown/grassetti, niente bullet, compatta spazi
const stripMd = (s: string) =>
  s.replace(/\*\*/g, "")
   .replace(/(^|\s)[\-•]\s+/g, "$1")
   .replace(/\s+/g, " ")
   .trim();

// evita che il testo inizi ripetendo il nome
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nomeRe = new RegExp("^\\s*" + esc(nome) + "\\s*[:\\-–—]?\\s*", "i");

let descrizionePulita = stripMd(descrizione).replace(nomeRe, "");

// 4) UPSERT: salviamo sia 'descrizione' sia 'scheda'
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
      scheda
    },
    { onConflict: "fingerprint", ignoreDuplicates: false }
  );

if (upErr) console.error("❌ Errore salvataggio descrizione/scheda:", upErr);

return new Response(JSON.stringify({ descrizione: descrizionePulita, scheda }), { status: 200, headers: CORS });


  } catch (err: any) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione descrizione", detail: err?.message ?? String(err) }), {
      status: 500,
      headers: CORS
    });
  }
});

