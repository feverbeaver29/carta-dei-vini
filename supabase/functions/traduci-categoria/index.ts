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

// 📚 2) prompt unico: rileva lingua originale + traduce nella lingua target
const langNames: Record<string, string> = {
  it: "Italian",
  en: "English",
  fr: "French",
  de: "German",
  es: "Spanish",
  zh: "Chinese",
  ko: "Korean",
  ru: "Russian"
};

const targetLangName = langNames[finalLang] || "English";

const systemPrompt = `
You are a professional translator for a digital wine list used by restaurants.

The restaurant can write category names freely in any language.
Your job is:
1. Detect the source language of the category.
2. Translate the category into the requested target language.
3. If the source language is already the target language, return the same category, only fixing capitalization if needed.
4. Never translate into a third language.
5. Keep wine regions, appellations and proper nouns unchanged when appropriate.
6. Return only valid JSON.

Examples:
- Input: "RED WINES", target: "en" -> "Red wines"
- Input: "RED WINES", target: "it" -> "Vini rossi"
- Input: "VINS ROUGES", target: "en" -> "Red wines"
- Input: "Champagne", target: "it" -> "Champagne"
- Input: "Our cellar selection", target: "it" -> "La nostra selezione di cantina"

Return JSON in this format:
{
  "source_lang": "it|en|fr|de|es|zh|ko|ru|unknown",
  "text": "translated category",
  "confidence": 0.0
}
`;

const userPrompt = JSON.stringify({
  category: text,
  target_lang: finalLang,
  target_language_name: targetLangName
});

// 🤖 3) chiamata a OpenAI
const chatResponse = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENAI_API_KEY}`
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  })
});

const result = await chatResponse.json();
const raw = result?.choices?.[0]?.message?.content?.trim();

if (!raw) {
  throw new Error("Risposta vuota dal modello");
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  throw new Error("JSON non valido dal modello: " + raw);
}

const translation = String(parsed?.text || "").trim();

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
