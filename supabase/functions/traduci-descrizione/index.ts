import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }

  try {
    const { text, targetLang } = await req.json();
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

    const prompt = `Traduci il seguente testo in ${targetLang.toUpperCase()} mantenendo uno stile elegante, adatto a una carta dei vini. Non aggiungere nulla, non firmarti:\n\n"${text}"`;

    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6
      })
    });

    if (!chatResponse.ok) {
      const err = await chatResponse.text();
      throw new Error("Errore OpenAI: " + err);
    }

    const result = await chatResponse.json();
    const translation = result.choices?.[0]?.message?.content?.trim();

    return new Response(JSON.stringify({ text: translation }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  } catch (e) {
    console.error("Errore durante la traduzione:", e);
    return new Response(JSON.stringify({ error: "Errore durante la traduzione GPT" }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
});


