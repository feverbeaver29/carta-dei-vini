import { serve } from "https://deno.land/std/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  try {
    // ✅ QUI mancava!
    const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } = await req.json();
let query = supabase
  .from("descrizioni_vini")
  .select("descrizione")
  .eq("ristorante_id", ristorante_id)
  .eq("nome", nome);

if (annata) {
  query = query.eq("annata", annata);
} else {
  query = query.is("annata", null);
}

if (uvaggio) {
  query = query.eq("uvaggio", uvaggio);
} else {
  query = query.is("uvaggio", null);
}

const { data: existing } = await query.maybeSingle();

if (existing?.descrizione) {
  return new Response(JSON.stringify({ descrizione: existing.descrizione }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

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

    const descrizione = completion.choices[0].message.content.trim();
const { error: insertError } = await supabase.from("descrizioni_vini").insert({
  nome,
  annata: annata || null,
  uvaggio: uvaggio || null,
  ristorante_id,
  descrizione
});

if (insertError) {
  console.error("❌ Errore salvataggio descrizione:", insertError);
}

    return new Response(JSON.stringify({ descrizione }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });

  } catch (err) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione descrizione", detail: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }
});

