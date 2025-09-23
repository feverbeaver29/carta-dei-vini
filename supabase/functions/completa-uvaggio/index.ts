// supabase/functions/completa-uvaggio/index.ts
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Metodo non consentito" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const { nome_completo } = await req.json();

    if (!nome_completo || typeof nome_completo !== "string" || nome_completo.trim().length < 3) {
      return new Response(JSON.stringify({ error: "nome_completo mancante o non valido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY non configurata" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Prompt: restituisci JSON strutturato, non inventare se incerto
    const messages = [
      { role: "system", content: "Sei un sommelier. Se non sei ragionevolmente sicuro, indica confidenza <= 0.5 e non inventare." },
      { role: "user", content:
`Dammi l'uvaggio del vino: "${nome_completo}".
Rispondi SOLO in JSON con:
{"uvaggio":"...", "grapes":["..."], "confidence":0.xx, "sources":["..."]}` }
    ];

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages
      })
    });

    const data = await completion.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || "{}";

    // Parse sicuro del JSON prodotto dal modello
    let out = { uvaggio: "", grapes: [] as string[], confidence: 0, sources: [] as string[] };
    try {
      const parsed = JSON.parse(content);
      out.uvaggio = String(parsed.uvaggio || "").trim();
      out.grapes = Array.isArray(parsed.grapes) ? parsed.grapes : [];
      out.confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      out.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    } catch {
      // lascia out di default
    }

    // Se nessuna fonte, non alzare oltre 0.8
    if ((!out.sources || out.sources.length === 0) && out.confidence > 0.8) {
      out.confidence = 0.8;
    }

    return new Response(JSON.stringify(out), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "max-age=3600" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

