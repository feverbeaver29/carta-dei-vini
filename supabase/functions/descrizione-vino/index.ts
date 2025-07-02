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
    const { nome, annata, uvaggio, } = await req.json();
const prompt = `Agisci come un sommelier. Scrivi una descrizione breve ed elegante (max 5 righe) per presentare questo vino a un cliente in sala. 
Non usare un tono tecnico o spocchioso: sii coinvolgente, diretto e rispettoso. 
Concentrati sul carattere del vino, i vitigni e l'esperienza di degustazione.

Nome: ${nome}
${annata ? "Annata: " + annata : ""}
Uvaggio: ${uvaggio || "non specificato"}`;

    const completion = await openai.chat.completions.create({
  model: "gpt-3.5-turbo",         // ✅ velocità migliorata
  messages: [{ role: "user", content: prompt }],
  temperature: 0.6,               // ✅ un po' più snello
  max_tokens: 150                // ✅ molto più veloce
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

