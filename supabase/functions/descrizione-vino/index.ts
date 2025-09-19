import { serve } from "https://deno.land/std/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
    return new Response("ok", { status: 200, headers: CORS });
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

// 3) Genera scheda + descrizione con OpenAI (JSON + testo)
const jsonPrompt = {
  role: "user",
  content: `Genera una SCHEDA JSON concisa per un vino e, separatamente, un breve testo tecnico.
RESTITUISCI SOLO JSON (nessun testo fuori JSON) con questo schema:

{
 "summary": "max 140 caratteri, invogliante ma sobrio",
 "profile": { "body": 0-100, "sweetness": 0-100, "acidity": 0-100 },
 "notes": [{"label": "max 1-2 parole"}]  // esattamente 3 voci
 "pairings": ["...", "...", "..."]       // esattamente 3 voci, categorie
}

Linee guida:
- Italiano, tono professionale.
- Niente marche/claim di marketing.
- "notes": termini generici (frutta gialla, agrumi, floreale, erbe, spezie…).
- Se mancano dati, usa valori plausibili per la tipologia senza inventare annate.
Dati:
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
  temperature: 0.4,
  max_tokens: 300
});

let scheda: any = null;
try {
  scheda = JSON.parse(sheet.choices[0].message?.content ?? "{}");
  // harden: clamp valori e limiti
  const clamp = (n: any) => Math.max(0, Math.min(100, Number(n) || 0));
  scheda.profile = scheda.profile || {};
  scheda.profile.body = clamp(scheda.profile.body);
  scheda.profile.sweetness = clamp(scheda.profile.sweetness);
  scheda.profile.acidity = clamp(scheda.profile.acidity);
  scheda.notes = Array.isArray(scheda.notes) ? scheda.notes.slice(0,3) : [];
  scheda.pairings = Array.isArray(scheda.pairings) ? scheda.pairings.slice(0,3) : [];
  scheda.summary = (scheda.summary || "").slice(0, 160);
} catch {
  // se qualcosa va storto, metti una scheda minimale
  scheda = {
    summary: "Profilo equilibrato, frutto nitido e buona freschezza.",
    profile: { body: 50, sweetness: 10, acidity: 60 },
    notes: [{label:"Frutta gialla"},{label:"Agrumi"},{label:"Floreale"}],
    pairings: ["Antipasti di pesce","Primi leggeri","Formaggi freschi"]
  };
}

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

