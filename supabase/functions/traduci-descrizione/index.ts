// traduci-descrizione/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Configuration, OpenAIApi } from "npm:openai";

const config = new Configuration({
  apiKey: Deno.env.get("OPENAI_API_KEY"),
});
const openai = new OpenAIApi(config);

serve(async (req) => {
  try {
    const { text, targetLang } = await req.json();

    if (!text || !targetLang) {
      return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400 });
    }

    const prompt = `Traduci il seguente testo in ${targetLang.toUpperCase()} mantenendo uno stile elegante, adatto a una carta dei vini. Non aggiungere nulla, non firmarti:\n\n"${text}"`;

    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo", // puoi usare anche "gpt-3.5-turbo" se vuoi risparmiare
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
    });

    const translation = completion.data.choices[0].message?.content?.trim();

    return new Response(JSON.stringify({ text: translation }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Traduzione GPT fallita:", e);
    return new Response(JSON.stringify({ error: "Errore durante la traduzione GPT" }), {
      status: 500,
    });
  }
});
