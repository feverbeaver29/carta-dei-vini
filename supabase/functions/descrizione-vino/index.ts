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
    const { nome, annata, uvaggio, ristorante_id } = await req.json();
const { data: existing } = await supabase
  .from("descrizioni_vini")
  .select("descrizione")
  .eq("ristorante_id", ristorante_id)
  .eq("nome", nome)
  .eq("annata", annata || null)
  .eq("uvaggio", uvaggio || null)
  .maybeSingle();

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

    const prompt = `Agisci come un sommelier professionista in un ristorante. 
Descrivi in massimo 4 frasi questo vino a un cliente che sta scegliendo cosa bere. 
Usa un tono competente ma semplice, senza romanticismi o esagerazioni. 
Evita termini troppo tecnici, e concentrati sullo stile, i profumi e la sensazione al palato.

Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}`;

const completion = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",
  messages: [{ role: "user", content: prompt }],
  temperature: 0.5,
  max_tokens: 120
});

    const descrizione = completion.choices[0].message.content.trim();
await supabase.from("descrizioni_vini").insert({
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

