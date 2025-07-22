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

  try {
    const { righe } = await req.json();
    if (!Array.isArray(righe) || righe.length === 0) {
      return new Response(JSON.stringify({ error: "Nessuna riga ricevuta" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const prompt = `
Hai ricevuto due righe OCR da una carta dei vini.
Estrai in JSON i seguenti campi:
- produttore
- denominazione
- annata (se presente)
- prezzo (se presente)
- valuta (€, $, £, CHF, ecc.)
- categoria (se assente, suggeriscine una tu)
- sottocategoria (se assente, suggeriscine una tu)
- uvaggio (se assente, prova a dedurlo in base a nome e produttore)

❗Rispondi solo ed esclusivamente con un oggetto JSON valido, senza nessun commento o spiegazione.  
Esempio (usa questo formato preciso, nessun altro):
{"produttore":"...","denominazione":"...","annata":"...","prezzo":"...","valuta":"...","categoria":"...","sottocategoria":"...","uvaggio":"..."}

Riga 1: ${righe[0] || ""}
Riga 2: ${righe[1] || ""}
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
  const match = text.match(/\{[\s\S]*?\}/); // estrae il primo blocco JSON valido
  if (!match) throw new Error("Nessun blocco JSON trovato");

  const vino = JSON.parse(match[0]);

  return new Response(JSON.stringify({ vino }), {
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

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

