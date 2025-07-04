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

    const promptByLang = {
  en: `Translate this wine category name for a wine list. Return only the translation, no explanations. Category: "${text}"`,
  fr: `Traduisez ce nom de catégorie de vin pour une carte des vins. Donnez uniquement la traduction, sans explication. Catégorie : "${text}"`,
  de: `Übersetze diesen Weinkategoriennamen für eine Weinkarte. Gib nur die Übersetzung zurück, ohne Erklärungen. Kategorie: "${text}"`,
  es: `Traduce este nombre de categoría de vino para una carta de vinos. Devuelve solo la traducción, sin explicaciones. Categoría: "${text}"`,
  zh: `将此葡萄酒类别名称翻译为酒单用语。只返回翻译，不要解释。类别："${text}"`,
  it: `Traduci il nome di questa categoria enologica per una carta dei vini. Restituisci solo la traduzione, senza spiegazioni. Categoria: "${text}"`
};

const prompt = promptByLang[targetLang] || promptByLang["en"];

    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    if (!chatResponse.ok) throw new Error(await chatResponse.text());

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
    return new Response(JSON.stringify({ error: "Errore GPT" }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    });
  }
});
