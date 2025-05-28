import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { testo } = await req.json();

    if (!testo || typeof testo !== "string") {
      return new Response(JSON.stringify({ error: "Testo mancante o non valido" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const prompt = `
Testo OCR da etichetta:

"${testo}"

Estrai i seguenti dati se presenti, e restituiscili solo in formato JSON:

{
  "produttore": "...",
  "denominazione": "...",
  "annata": "...",
  "uvaggio": "...",
  "categoria": "...",
  "sottocategoria": "..."
}

Se mancano dati, restituisci stringa vuota per ciascun campo.
Nessuna spiegazione, solo JSON.
`;

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: "Chiave OpenAI mancante" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const json = await completion.json();
    const reply = json.choices?.[0]?.message?.content ?? "";

    console.log("📦 Risposta GPT:", reply);

    // Estrai blocco JSON dalla risposta
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) {
      return new Response(JSON.stringify({ error: "JSON non trovato nella risposta GPT", reply }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const parsed = JSON.parse(match[0]);

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: corsHeaders,
    });

  } catch (err) {
    console.error("❌ Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore server", detail: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
