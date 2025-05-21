import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
      status: 200
    });
  }

  try {
    const { vini, piatto, ristorante_id } = await req.json();
    const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
const supabaseKey = Deno.env.get("SERVICE_ROLE_KEY");
const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

const infoRes = await fetch(`${supabaseUrl}/rest/v1/ristoranti?id=eq.${ristorante_id}&select=sommelier_range,sommelier_boost`, { headers });
const [info] = await infoRes.json();

const range = info?.sommelier_range || "2-3";
const boost = info?.sommelier_boost || "";

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

const [min, max] = range.split("-").map(n => parseInt(n));

let boostText = "";
if (boost) {
  boostText = `\n\nSe coerente con il piatto, considera di consigliare anche il vino: "${boost}". Solo se è adatto, non forzare.`;
}

const prompt = `Sei un sommelier elegante e professionale. Ecco una lista di vini disponibili:\n${vini.map(w => `- ${w.nome} (${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || ''}, prezzo: ${w.prezzo})`).join("\n")}

Abbina da ${min} a ${max} vini della lista al piatto: '${piatto}'.

Per ogni vino, rispondi seguendo ESATTAMENTE questo formato:

- [Nome completo del vino]  [Prezzo]
[Uvaggio]
[Motivazione in massimo 2 frasi]

${boostText}

Non suggerire vini che non sono presenti nella lista.  
Se nessuno è perfetto, scegli comunque il più vicino per caratteristiche (senza inventare nulla).  
Rispondi solo con i blocchi sopra, uno per ogni vino.`;



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

