import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { text, targetLang } = await req.json();

    // 🧼 0) normalizza lingua in ingresso (gestisce alias comuni)
    const alias: Record<string, string> = {
      gb: "en",
      us: "en",
      cn: "zh",
      "zh-cn": "zh",
      "zh-tw": "zh",     // se un domani vuoi traduzioni separate, cambia qui
      kr: "ko",
      korean: "ko",
      russian: "ru"
    };
    const tl = (alias[(targetLang || "").toLowerCase()] || (targetLang || "").toLowerCase()) as
      "it" | "en" | "fr" | "de" | "es" | "zh" | "ko" | "ru";

    const allowed = new Set(["it","en","fr","de","es","zh","ko","ru"]);
    const finalLang = allowed.has(tl) ? tl : "en";

    // evitare chiamate inutili: se chiedo "it" e il testo è già italiano, restituisco com'è
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ text: "" }), { headers: corsHeaders });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
    const MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini"; // fallback moderno

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

    // 🔍 1) cache DB
    const { data: existing } = await supabase
      .from("traduzioni_categorie")
      .select("traduzione")
      .eq("originale", text)
      .eq("lingua", finalLang)
      .maybeSingle();

    if (existing?.traduzione) {
      return new Response(JSON.stringify({ text: existing.traduzione }), { headers: corsHeaders });
    }

    // 📚 2) prompt localizzati (aggiunti KO e RU)
    const promptByLang: Record<string, string> = {
      en: `Translate this wine category name for a professional wine list. Return only the translation, no explanations. Category: "${text}"`,
      fr: `Traduisez ce nom de catégorie pour une carte des vins professionnelle. Ne renvoyez que la traduction, sans explications. Catégorie : "${text}"`,
      de: `Übersetze diesen Weinkategorienamen für eine professionelle Weinkarte. Gib nur die Übersetzung zurück, ohne Erklärungen. Kategorie: "${text}"`,
      es: `Traduce este nombre de categoría para una carta de vinos profesional. Devuelve solo la traducción, sin explicaciones. Categoría: "${text}"`,
      zh: `将以下葡萄酒分类名称专业地翻译成中文，用于酒单。只返回翻译，不要任何解释："${text}"`,
      it: `Traduci il nome di questa categoria per una carta dei vini professionale. Restituisci solo la traduzione, senza spiegazioni. Categoria: "${text}"`,
      ko: `전문 와인 리스트에 맞게 다음 와인 카테고리 이름을 한국어로 번역하세요. 설명 없이 번역만 반환하세요: "${text}"`,
      ru: `Переведите это название категории вина для профессиональной винной карты. Верните только перевод, без пояснений. Категория: "${text}"`
    };

    const prompt = promptByLang[finalLang] || promptByLang.en;

    // 🤖 3) chiamata a OpenAI
    const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.0
      })
    });

    const result = await chatResponse.json();
    const translation = result?.choices?.[0]?.message?.content?.trim();

    if (!translation) {
      throw new Error("Traduzione vuota o non valida dal modello");
    }

    // 💾 4) salva in cache
    await supabase.from("traduzioni_categorie").insert({
      originale: text,
      lingua: finalLang,
      traduzione: translation
    });

    return new Response(JSON.stringify({ text: translation }), { headers: corsHeaders });

  } catch (e) {
    console.error("Errore traduzione categoria:", e);
    return new Response(JSON.stringify({ error: "Errore GPT" }), {
      status: 500,
      headers: corsHeaders
    });
  }
});
