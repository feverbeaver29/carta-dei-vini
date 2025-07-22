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

    if (!nome_completo || typeof nome_completo !== "string") {
      return new Response(JSON.stringify({ error: "nome_completo mancante o non valido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const messages = [
      {
        role: "system",
        content: "Sei un esperto sommelier. Ti viene chiesto di identificare l'uvaggio più probabile di un vino, partendo solo dal suo nome completo."
      },
      {
        role: "user",
        content: `Qual è l'uvaggio del vino "${nome_completo}"? Rispondi solo con il nome dell'uvaggio, senza aggiungere commenti o spiegazioni.`
      }
    ];

    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages,
        max_tokens: 100,
        temperature: 0.2
      })
    });

    const data = await completion.json();
    const uvaggio = data.choices?.[0]?.message?.content?.trim();

    return new Response(JSON.stringify({ uvaggio }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

