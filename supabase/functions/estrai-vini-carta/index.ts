import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // oppure metti 'https://www.winesfever.com' se vuoi restringerlo
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

const { testo } = await req.json();
if (!testo || typeof testo !== "string" || testo.length < 20) {
  return new Response(JSON.stringify({ error: "Testo OCR non valido" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

const prompt = `
Hai ricevuto un testo OCR che rappresenta una sezione di una carta dei vini.  
Analizza e riconosci ogni vino contenuto nel testo. Per ogni vino estrai:

- nome_completo (es: "PIAGGIA 'Sasso' Carmignano DOCG")
- annata (se presente)
- prezzo (se presente)
- valuta (€, $, £, CHF, ecc.)
- categoria (se assente, suggeriscine una tu)
- sottocategoria (se assente, suggeriscine una tu)
- uvaggio (se assente, prova a dedurlo in base al nome)

❗Rispondi solo con un array JSON valido di oggetti vino, esempio:
[
  {
    "nome_completo": "...",
    "annata": "...",
    "prezzo": "...",
    "valuta": "...",
    "categoria": "...",
    "sottocategoria": "...",
    "uvaggio": "..."
  },
  ...
]

Testo OCR:
${testo}
`.trim();

    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const data = await completion.json();
    const text = data.choices?.[0]?.message?.content?.trim();

try {
  const match = text.match(/\[[\s\S]*?\]/); // estrae l'array JSON
  if (!match) throw new Error("Nessun array JSON trovato");

  const vini = JSON.parse(match[0]);

  return new Response(JSON.stringify({ vini }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
} catch (err) {
  return new Response(JSON.stringify({
    error: "Parsing JSON fallito",
    raw: text,
    detail: err.message
  }), {
    status: 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
});

