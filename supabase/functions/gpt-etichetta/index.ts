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
Hai il seguente testo OCR proveniente da un'etichetta di vino:

"${testo}"

Estrai da questo testo, se presenti, i seguenti campi:

- produttore (nome dell'azienda o cantina)
- denominazione (nome del vino, DOC, DOCG ecc.)
- annata (anno del vino, se presente)
- uvaggio (tipologia di uve, se indicata)
- categoria (rosso, bianco, rosato, bollicine, passito ecc.)
- sottocategoria (Bolgheri, Chianti, Langhe, ecc.)

Rispondi solo con un oggetto JSON come questo:

{
  "produttore": "...",
  "denominazione": "...",
  "annata": "...",
  "uvaggio": "...",
  "categoria": "...",
  "sottocategoria": "..."
}
Se un campo non è presente, lascialo vuoto.
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

    if (!completion.ok) {
      const errText = await completion.text();
      console.error("❌ Errore OpenAI:", errText);
      return new Response(JSON.stringify({ error: "Errore OpenAI", detail: errText }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const json = await completion.json();
    const reply = json.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(reply);
    } catch {
      return new Response(JSON.stringify({ error: "Risposta non in formato JSON", content: reply }), {
        status: 500,
        headers: corsHeaders,
      });
    }

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
