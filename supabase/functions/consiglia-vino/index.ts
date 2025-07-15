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
    const { vini, piatto, ristorante_id, prezzo_massimo, colori } = await req.json();
    const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
    const supabaseKey = Deno.env.get("SERVICE_ROLE_KEY");
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

    const infoRes = await fetch(`${supabaseUrl}/rest/v1/ristoranti?id=eq.${ristorante_id}&select=sommelier_range,sommelier_boost_multi`, { headers });
    const [info] = await infoRes.json();

    const range = info?.sommelier_range || "2-3";
    const [min, max] = range.split("-").map(n => parseInt(n));

    let boost = [];
    try {
      boost = JSON.parse(info?.sommelier_boost_multi || "[]");
    } catch (_) {
      boost = [];
    }

    if (!vini || !Array.isArray(vini) || vini.length === 0) {
      return new Response(JSON.stringify({ error: "Nessun vino nel sistema." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!piatto) {
      return new Response(JSON.stringify({ error: "Manca il nome del piatto." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // 🟢 Costruzione della lista vini
    const vinoList = vini.map(w => {
      const isBoost = boost.includes(w.nome);
      return `- ${w.nome}${isBoost ? " ⭐" : ""} (${w.tipo || "tipo non specificato"}, ${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || "uvaggio non specificato"}, €${w.prezzo})`;
    }).join("\n");

    const boostText = boost.length > 0
      ? `💡 Alcuni vini sono segnalati dal ristorante come **prioritari** (marcati con ⭐). Se sono coerenti con il piatto, includine almeno uno tra i suggerimenti.\n`
      : "";

    // 🟢 Prompt finale
    const prompt = `Sei un sommelier professionale che lavora all’interno di un ristorante. Il cliente ha ordinato il seguente pasto:

"${piatto}"

Il ristorante dispone di questi vini in carta:
${vinoList}

Il tuo compito è consigliare **da ${min} a ${max} vini**, presenti nella lista sopra, che possano accompagnare bene tutto il pasto (più portate). Preferisci vini versatili e con coerenza gastronomica.

${prezzo_massimo ? `❗ Consiglia solo vini con prezzo massimo €${prezzo_massimo}.` : ""}
${Array.isArray(colori) && colori.length < 4 ? `✅ Filtra per categoria: includi solo vini ${colori.join(", ")}` : ""}

${boostText}

Per ogni vino consigliato, rispondi nel formato seguente:

- Nome del vino  Prezzo  
Uvaggio  
Motivazione tecnica in massimo 2 frasi: evidenzia acidità, struttura, tannini, freschezza, versatilità…

Esempio:
- Chianti Classico DOCG  €24  
Sangiovese  
Tannini levigati e buona acidità: ideale per piatti strutturati a base di carne.

⛔ Non inventare vini. Consiglia solo tra quelli elencati.  
Se non ci sono abbinamenti perfetti, suggerisci comunque quelli più adatti.  
Non aggiungere testo fuori dal formato richiesto.`;

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
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      })
    });

    if (!completion.ok) {
      const errText = await completion.text();
      return new Response(JSON.stringify({ error: "Errore OpenAI", detail: errText }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const json = await completion.json();
    const reply = json.choices?.[0]?.message?.content;

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


