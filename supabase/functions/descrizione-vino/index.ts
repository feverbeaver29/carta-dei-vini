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
      .select("descrizione")
      .eq("fingerprint", fp)
      .maybeSingle();

    if (selErr) console.warn("Selezione fingerprint errore:", selErr);

    if (exGlobal?.descrizione) {
      return new Response(JSON.stringify({ descrizione: exGlobal.descrizione }), { status: 200, headers: CORS });
    }

    // 2) (retrocompatibilità) prova il vecchio match per ristorante/nome/annata/uvaggio
    let q = supabase
      .from("descrizioni_vini")
      .select("descrizione")
      .eq("nome", nome);

    if (ristorante_id) q = q.eq("ristorante_id", ristorante_id);
    if (annata) q = q.eq("annata", annata); else q = q.is("annata", null);
    if (uvaggio) q = q.eq("uvaggio", uvaggio); else q = q.is("uvaggio", null);

    const { data: exOld } = await q.maybeSingle();
    if (exOld?.descrizione) {
      // backfill fingerprint su record esistente
      await supabase
        .from("descrizioni_vini")
        .update({ fingerprint: fp })
        .eq("nome", nome)
        .maybeSingle();

      return new Response(JSON.stringify({ descrizione: exOld.descrizione }), { status: 200, headers: CORS });
    }

    // 3) Genera descrizione con OpenAI
    const prompt = `Agisci come un sommelier professionista in un ristorante. Scrivi una descrizione sintetica e tecnica di questo vino, suddivisa in 3 sezioni distinte:

Stile: massimo 2 frasi. Descrivi il carattere del vino (es. elegante, fruttato, intenso...), tenendo conto della categoria, dell’uvaggio e della zona. Evita frasi generiche come “elegante e complesso” o “tipico della zona”.

Sensazione al palato: massimo 2 frasi. Spiega struttura, acidità, tannini ed equilibrio. Usa un linguaggio concreto ma sobrio, evitando formule abusate come “tannini morbidi e acidità piacevole”.

Abbinamenti consigliati: massimo 2 frasi. Suggerisci categorie di piatti (es. carne alla griglia, antipasti vegetariani, primi di pesce, formaggi stagionati), senza ricette o ingredienti specifici.

Scrivi in modo professionale, sobrio e adatto a una carta dei vini. Evita ripetizioni e frasi vaghe. evita di ripetere il nome del vino. Non superare i 400 caratteri in totale.

Dati disponibili:
Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}
Categoria: ${categoria || "non specificata"}
Sottocategoria: ${sottocategoria || "non specificata"}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 300
    });

    const descrizione = completion.choices[0].message?.content?.trim() ?? "";

    // 4) Salva con UPSERT sulla fingerprint (evita il 23505)
    //    ignoreDuplicates: true => se esiste già, NON sovrascrive.
    const { error: upErr } = await supabase
      .from("descrizioni_vini")
      .upsert(
        {
          fingerprint: fp,
          nome,
          annata: annata || null,
          uvaggio: uvaggio || null,
          ristorante_id: ristorante_id || null,
          descrizione
        },
        { onConflict: "fingerprint", ignoreDuplicates: true }
      );

    if (upErr) {
      console.error("❌ Errore salvataggio descrizione:", upErr);
      // comunque ritorniamo la descrizione generata
    }

    return new Response(JSON.stringify({ descrizione }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione descrizione", detail: err?.message ?? String(err) }), {
      status: 500,
      headers: CORS
    });
  }
});

