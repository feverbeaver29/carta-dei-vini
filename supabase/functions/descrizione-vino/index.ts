import { serve } from "https://deno.land/std/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});

serve(async (req) => {
  // ✅ Risposta preflight CORS
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
const prompt = `Agisci come un sommelier professionista in un ristorante. 
Descrivi in massimo 4 frasi questo vino a un cliente che sta scegliendo cosa bere. 
Usa un tono competente ma semplice, senza romanticismi o esagerazioni. 
Evita termini troppo tecnici, e concentrati sullo stile, i profumi e la sensazione al palato.

Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}`;

const completion = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",         // ✅ più veloce
  messages: [{ role: "user", content: prompt }],
  temperature: 0.5,               // ✅ meno variabilità, più professionale
  max_tokens: 120                 // ✅ ancora più veloce
});

    const descrizione = completion.choices[0].message.content.trim();

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
    return new Response(JSON.stringify({ error: "Errore generazione descrizione" }), {
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

