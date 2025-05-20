import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Permetti tutte le origini (puoi limitarlo al tuo dominio se vuoi)
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    // Risposta preflight CORS
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { vini, piatto } = await req.json();

    if (!vini || !Array.isArray(vini) || vini.length === 0) {
      console.error("❌ Nessun vino ricevuto");
      return new Response(JSON.stringify({ error: "Nessun vino nel sistema." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!piatto) {
      console.error("❌ Piatto non specificato");
      return new Response(JSON.stringify({ error: "Manca il nome del piatto." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const prompt = `Sei un sommelier elegante e preparato. Ecco una lista di vini presenti in un ristorante:\n${vini.map(w => `- ${w.nome} (${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || ''}, prezzo: ${w.prezzo})`).join("\n")}

Abbina 2 o 3 vini della lista al piatto: '${piatto}'.

Per ciascun vino, scrivi:
1. Il nome esatto del vino
2. L'uvaggio
3. Il prezzo
4. Una breve motivazione in massimo 2 frasi

Non inventare vini: puoi consigliare solo quelli presenti nella lista sopra. Se nessuno è adatto, non suggerire nulla.

Rispondi in formato elenco puntato, ogni vino separato, con le 4 informazioni.`;

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      console.error("❌ OPENAI_API_KEY mancante");
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
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
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
    const reply = json.choices?.[0]?.message?.content;

    console.log("✅ Suggerimento generato:", reply);

    return new Response(JSON.stringify({ suggestion: reply }), {
      headers: corsHeaders,
    });

  } catch (err) {
    console.error("❌ Errore imprevisto:", err);
    return new Response(JSON.stringify({ error: "Errore interno", detail: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});

