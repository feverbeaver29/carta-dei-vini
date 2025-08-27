import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const LANGS = {
  it: { name: "italiano", GRAPE: "UVAGGIO", MOTIVE: "MOTIVAZIONE" },
  en: { name: "English",  GRAPE: "GRAPE",   MOTIVE: "RATIONALE" },
  de: { name: "Deutsch",  GRAPE: "REBSORTE",MOTIVE: "BEGRÜNDUNG" },
  es: { name: "Español",  GRAPE: "UVA",     MOTIVE: "MOTIVACIÓN" },
  fr: { name: "Français", GRAPE: "CÉPAGES", MOTIVE: "JUSTIFICATION" },
  zh: { name: "中文",       GRAPE: "葡萄品种",  MOTIVE: "理由" }
};
const norm = (s:string) => (s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/\s+/g, " ")
  .trim();


function filtraEVotiVini({ vini, boost = [], prezzo_massimo = null, colori = [], recenti = {}, usageStats = {} }) {
  if (!Array.isArray(vini)) return [];

  // ranking base
  const ranked = vini
    .filter(v => v.visibile !== false)
    .filter(v => { // hard filter per prezzo massimo
      if (!prezzo_massimo) return true;
      const num = parseFloat((v.prezzo || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
      return num <= prezzo_massimo;
    })
    .map(v => {
      let score = 0;
      const isBoost = boost.includes(v.nome);

      if (isBoost) score += 100;

      // filtro categorie richieste (rosso/bianco/…)
      if (Array.isArray(colori) && colori.length > 0) {
        const cat = (v.categoria || "").toLowerCase();
        const match = colori.some(c => cat.includes(c.toLowerCase()));
        if (!match) return null; // escludi
        score += 15;
      }

      // anti-ripetizione recente (tranne i boost)
      if (!isBoost) {
        score -= penalitaRecenti * 15;
        const isBoost = boost.includes(norm(v.nome));              // qui "boost" contiene già nomi normalizzati
        const nomeN = norm(v.nome);
        const penalitaRecenti = recenti[nomeN] || 0;
        if (!recenti[nomeN]) score += 10;
      }

      // leggero bonus se disponibile al calice
      if (v.prezzo_bicchiere) score += 8;

      // euristica produttore (per diversificazione)
      const producer = (v.nome || "").split(/\s+/)[0].toLowerCase();
      v.__producer = producer;

      return { ...v, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // diversificazione: max 2 vini per produttore
  const seenProd = new Map();
  const diversified = [];
  for (const w of ranked) {
    const c = seenProd.get(w.__producer) || 0;
    if (c < 2) {
      diversified.push(w);
      seenProd.set(w.__producer, c + 1);
    }
    if (diversified.length >= 20) break;
  }
  return diversified;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
      status: 200
    });
  }

  try {
    const { vini, piatto, ristorante_id, prezzo_massimo, colori, lang } = await req.json();
    const L = LANGS[lang] || LANGS.it; // default italiano
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
      const boostNorm = new Set((boost || []).map(norm));
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

let recentLog = [];
try {
  const recentRes = await fetch(`${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&order=creato_il.desc&limit=100`, { headers });
  if (recentRes.ok) {
    recentLog = await recentRes.json();
  }
} catch (_) {
  recentLog = [];
}

// 🔁 Calcola la frequenza dei vini (non boost) negli ultimi suggerimenti
const frequenzaRecenti: Record<string, number> = {};
recentLog.forEach(r => {
  (r.vini || []).forEach((nome: string) => {
    const n = norm(nome);
    if (!boostNorm.has(n)) {
      frequenzaRecenti[n] = (frequenzaRecenti[n] || 0) + 1;
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
  const isBoost = boostNorm.has(norm(w.nome));
  const prezzi = [
    w.prezzo ? `bottiglia: ${w.prezzo}` : null,
    w.prezzo_bicchiere ? `calice: ${w.prezzo_bicchiere}` : null,
    w.prezzo_025 ? `1/4lt: ${w.prezzo_025}` : null,
    w.prezzo_0375 ? `0,375lt: ${w.prezzo_0375}` : null,
    w.prezzo_05 ? `1/2lt: ${w.prezzo_05}` : null,
    w.prezzo_15 ? `1,5lt: ${w.prezzo_15}` : null,
    w.prezzo_3l ? `3lt: ${w.prezzo_3l}` : null,
  ].filter(Boolean).join(" • ");

  return `- ${w.nome}${isBoost ? " ⭐" : ""} (${w.tipo || "tipo non specificato"}, ${w.categoria}, ${w.sottocategoria}, ${w.uvaggio || "uvaggio non specificato"}) [${prezzi || "prezzi non indicati"}]`;
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

Rispondi in **${L.name}** e usa ESATTAMENTE questo formato (senza altre righe o caratteri):

- NOME DEL VINO (solo nome, senza prezzi)
${L.GRAPE}: ...
${L.MOTIVE}: ... (massimo 2 frasi, tecniche)

Esempio:
- Chianti Classico DOCG
${L.GRAPE}: Sangiovese
${L.MOTIVE}: Tannini levigati e buona acidità...

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

// 🔍 Estrai i nomi dei vini consigliati (prima riga di ogni blocco, senza dipendere da €)
const viniSuggeriti = (reply || "")
  .split(/^- /m)              // separa i blocchi che iniziano con "- "
  .map(b => b.trim())
  .filter(Boolean)
  .map(b => b.split("\n")[0]  // prendi solo la prima riga del blocco
    .split(/€|EUR|CHF|\$|£|¥/)[0] // taglia eventuali prezzi se l'AI li avesse messi
    .replace(/^[-•]\s*/, "")
    .trim()
  )
  .filter(Boolean);

    // 🔴 Verifica se almeno un boost è stato incluso
    const boostInclusi = viniSuggeriti.some(nome => boostNorm.has(norm(nome)));

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


