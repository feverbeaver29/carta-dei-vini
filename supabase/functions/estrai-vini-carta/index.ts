import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";



const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // oppure metti 'https://www.winesfever.com' se vuoi restringerlo
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

const { testo, categorieGiaPresenti, sottocategorieGiaPresenti } = await req.json();

const url = new URL(req.url);
const ristoranteId = url.searchParams.get("ristorante_id");

if (!ristoranteId) {
  return new Response(JSON.stringify({ error: "ID ristorante mancante" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

const { data: risto } = await supabase
  .from("ristoranti")
  .select("subscription_plan")
  .eq("id", ristoranteId)
  .single();

if (risto?.subscription_plan !== "pro") {
  return new Response(JSON.stringify({ error: "Funzione OCR disponibile solo per utenti PRO" }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

if (!testo || typeof testo !== "string" || testo.length < 20) {
  return new Response(JSON.stringify({ error: "Testo OCR non valido" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

const prompt = `
Riceverai il testo OCR di una carta dei vini. Estrai ogni vino come oggetto JSON con i campi:

- "nome_completo": string (es. "PIAGGIA 'Sasso' Carmignano DOCG")
- "annata": string oppure "" se assente
- "valuta": uno tra "€", "$", "£", "CHF", "¥" (indovina dal contesto se possibile, altrimenti "€")
- "prezzo": string numero SENZA simbolo valuta (bottiglia 0,75 L) oppure "" se assente
- "prezzo_bicchiere": string numero SENZA simbolo valuta (prezzo al calice) oppure ""
- "prezzo_025": string numero SENZA simbolo valuta per 1/4 L (0,25) oppure ""
- "prezzo_0375": string numero SENZA simbolo valuta per 0,375 L oppure ""
- "prezzo_05": string numero SENZA simbolo valuta per 1/2 L (0,5) oppure ""
- "prezzo_15": string numero SENZA simbolo valuta per 1,5 L oppure ""
- "prezzo_3l": string numero SENZA simbolo valuta per 3 L oppure ""
- "categoria": una delle categorie più simili tra: ${categorieGiaPresenti.join(", ")} (oppure "" se non deducibile)
- "sottocategoria": una delle sottocategorie più simili tra: ${sottocategorieGiaPresenti.join(", ")} (oppure "")
- "uvaggio": vitigni principali (se assente prova a dedurlo dal nome, altrimenti "")

Linee guida:
- Riconosci sinonimi: "calice", "by the glass", "g.", "glass" → prezzo_bicchiere.  
- 1/4 L = 0,25; 1/2 L = 0,5; "mezza" = 0,375; "magnum" = 1,5 L; "jeroboam" = 3 L.  
- Se un prezzo non è presente, restituisci "" (stringa vuota).
- Usa il punto o la virgola come in input; NON includere il simbolo di valuta nei prezzi.
- Rispondi **solo** con un ARRAY JSON valido di oggetti con ESATTAMENTE queste chiavi.

Esempio di un elemento:
{
  "nome_completo":"Chianti Classico Riserva",
  "annata":"2019",
  "valuta":"€",
  "prezzo":"28",
  "prezzo_bicchiere":"6",
  "prezzo_025":"",
  "prezzo_0375":"15",
  "prezzo_05":"",
  "prezzo_15":"55",
  "prezzo_3l":"",
  "categoria":"Rossi",
  "sottocategoria":"Toscana",
  "uvaggio":"Sangiovese"
}

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

