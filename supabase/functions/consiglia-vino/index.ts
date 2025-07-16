import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function filtraEVotiVini({ vini, boost = [], prezzo_massimo = null, colori = [], recenti = {}, usageStats = {} }) {
  if (!Array.isArray(vini)) return [];

  return vini
    .filter(v => v.visibile !== false)
    .map(v => {
      let score = 0;
      const prezzoNum = parseFloat((v.prezzo || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
      const isBoost = boost.includes(v.nome);

      if (isBoost) score += 100;
      if (prezzo_massimo && prezzoNum <= prezzo_massimo) score += 20;

      if (Array.isArray(colori) && colori.length > 0) {
        const cat = (v.categoria || "").toLowerCase();
        const match = colori.some(c => cat.includes(c.toLowerCase()));
        if (!match) return null; // ❌ ESCLUDI vino
        score += 15;
      }

      if (!isBoost) {
        const penalitaRecenti = recenti[v.nome] || 0;
        score -= penalitaRecenti * 15;
        if (!recenti[v.nome]) {
          score += 10; // bonus
        }
      }

      return { ...v, score };
    })
    .filter(Boolean) // ✅ qui va messo
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

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

    // 🧠 Recupera gli ultimi 10 vini consigliati dal log Supabase
      const recentRes = await fetch(`${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&order=creato_il.desc&limit=100`, {
      headers
    });
    const recentLog = await recentRes.json();
// 🔁 Calcola la frequenza dei vini (non boost) negli ultimi suggerimenti
const frequenzaRecenti = {};
recentLog.forEach(r => {
  (r.vini || []).forEach(nome => {
    if (!boost.includes(nome)) {
      frequenzaRecenti[nome] = (frequenzaRecenti[nome] || 0) + 1;
    }
  });
});

    // ✅ Filtra e valuta i vini
    const viniFiltrati = filtraEVotiVini({
      vini,
      boost,
      prezzo_massimo: prezzo_massimo ? parseInt(prezzo_massimo) : null,
      colori,
      recenti: frequenzaRecenti,
    });

    if (viniFiltrati.length === 0) {
      return new Response(JSON.stringify({ error: "Nessun vino filtrato compatibile." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

const vinoList = viniFiltrati.map(w => {
  const isBoost = boost.includes(w.nome);
  const categoria = (w.categoria || "").toUpperCase();
  return `- ${w.nome}${isBoost ? " ⭐" : ""}  
Categoria: ${categoria}  
(${w.tipo || "tipo non specificato"}, ${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || "uvaggio non specificato"}, €${w.prezzo})`;
}).join("\n");

    const prompt = `Sei un sommelier professionale che lavora all’interno di un ristorante. Il cliente ha ordinato il seguente pasto:

"${piatto}"

Il ristorante dispone di questi vini in carta:
${vinoList}

Il tuo compito è consigliare **da ${min} a ${max} vini**, presenti nella lista sopra, che possano accompagnare bene tutto il pasto. Preferisci vini versatili e coerenti.

❗ I vini **marcati con ⭐ sono priorità per il ristorante**: se almeno uno di essi è coerente col piatto, **devi includerlo tra i consigliati**.  
❗ Non consigliare sempre gli stessi vini. Cerca varietà e equilibrio nelle scelte.

${prezzo_massimo ? `❗ Consiglia solo vini con prezzo massimo €${prezzo_massimo}.` : ""}
${Array.isArray(colori) && colori.length < 4 ? `✅ Filtra per categoria: includi solo vini ${colori.join(", ")}` : ""}

Per ogni vino consigliato, rispondi con questo formato:

- Nome del vino  Prezzo  
Uvaggio  
Motivazione tecnica in massimo 2 frasi (acidità, struttura, freschezza, tannini, versatilità…)

Esempio:
- Chianti Classico DOCG  €24  
Sangiovese  
Tannini levigati e buona acidità: ideale per piatti strutturati a base di carne.

⛔ Non inventare vini. Consiglia solo tra quelli elencati sopra.  
Se non ci sono abbinamenti perfetti, suggerisci comunque quelli più adatti.  
Non aggiungere altro testo oltre il formato richiesto.`;

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

    // 🔍 Estrai i nomi dei vini consigliati dalla risposta
    const viniSuggeriti = [];
    const righe = reply?.split("\n") || [];

    for (const riga of righe) {
      const match = riga.match(/^- (.+?)\s+€\d+/);
      if (match && match[1]) {
        viniSuggeriti.push(match[1].trim());
      }
    }

    // 🔴 Verifica se almeno un boost è stato incluso
    const boostInclusi = viniSuggeriti.some(nome => boost.includes(nome));

    // 💾 Salva log del suggerimento
    await fetch(`${supabaseUrl}/rest/v1/consigliati_log`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        ristorante_id,
        piatto,
        vini: viniSuggeriti,
        boost_inclusi: boostInclusi
      })
    });

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


