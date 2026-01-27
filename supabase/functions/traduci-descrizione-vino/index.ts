// supabase/functions/traduci-descrizione-vino/index.ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.24.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.wineinapp.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY")!,
});

// ---------- util ----------

function norm(s?: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type SupportedLang = "it" | "en" | "fr" | "de" | "es" | "zh" | "ru" | "ko";

function normalizeLang(raw?: string | null): SupportedLang {
  const s = (raw || "it").toLowerCase();
  const map: Record<string, SupportedLang> = {
    it: "it",
    en: "en",
    gb: "en",
    fr: "fr",
    de: "de",
    es: "es",
    zh: "zh",
    "zh-cn": "zh",
    cn: "zh",
    ru: "ru",
    ko: "ko",
    kr: "ko",
  };
  return map[s] ?? "it";
}

type MiniCard = {
  hook: string;
  palate: string;
  notes: string[];
  pairings: string[];
  emojis?: any;
};

type LangTranslation = {
  descrizione: string;
  scheda: MiniCard;
};

type LangTranslationsMap = Partial<Record<SupportedLang, LangTranslation>>;

/**
 * Chiamata GPT che dalla descrizione italiana + mini-card
 * produce le traduzioni per tutte le lingue supportate.
 */
async function generaTraduzioniMultiLingua(
  descrizioneIt: string,
  miniCardIt: MiniCard,
): Promise<LangTranslationsMap> {
  if (!descrizioneIt.trim()) return {};

  const system = `
Sei un traduttore professionale specializzato in testi di vino ed enogastronomia.

Ti fornirò:
- una descrizione completa di un vino in italiano ("descrizione_it");
- una mini-card in italiano ("mini_card_it") con:
  - "hook": breve frase di apertura
  - "palate": descrizione del sorso
  - "notes": 2–6 note aromatiche
  - "pairings": 2–6 abbinamenti

Devi restituire SOLO un JSON con questa struttura:

{
  "en": {
    "descrizione": "...testo in inglese...",
    "scheda": {
      "hook": "...",
      "palate": "...",
      "notes": ["...", "..."],
      "pairings": ["...", "..."]
    }
  },
  "fr": { ... },
  "de": { ... },
  "es": { ... },
  "zh": { ... },   // cinese semplificato
  "ru": { ... },
  "ko": { ... }
}

Regole:
- Stile professionale da carta dei vini, senza marketing aggressivo.
- Traduzione naturale, non parola-per-parola.
- "notes" e "pairings" devono essere liste di stringhe nella lingua di destinazione.
- Mantieni la struttura del testo (hook + palate) e il senso originale.
- Non aggiungere campi diversi da quelli indicati.
`.trim();

  const payload = {
    descrizione_it: descrizioneIt,
    mini_card_it: {
      hook: miniCardIt.hook,
      palate: miniCardIt.palate,
      notes: miniCardIt.notes || [],
      pairings: miniCardIt.pairings || [],
    },
  };

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content ?? "";
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return {};

  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch {
    return {};
  }

  const langs: SupportedLang[] = ["en", "fr", "de", "es", "zh", "ru", "ko"];
  const result: LangTranslationsMap = {};

  for (const l of langs) {
    const v = parsed?.[l];
    if (!v) continue;

    const s = v.scheda ?? {};
    const hook = String(s.hook ?? miniCardIt.hook);
    const palate = String(s.palate ?? miniCardIt.palate);
    const notes = Array.isArray(s.notes)
      ? s.notes.map((x: any) => String(x))
      : miniCardIt.notes || [];
    const pairings = Array.isArray(s.pairings)
      ? s.pairings.map((x: any) => String(x))
      : miniCardIt.pairings || [];

    result[l] = {
      descrizione: String(v.descrizione ?? "").trim() || descrizioneIt,
      scheda: {
        hook,
        palate,
        notes,
        pairings,
        emojis: miniCardIt.emojis || { notes: {}, pairings: {} },
      },
    };
  }

  return result;
}

// URL base delle edge function
const FUNCTIONS_BASE =
  Deno.env.get("SUPABASE_URL")!.replace(".supabase.co", ".functions.supabase.co");

/**
 * Assicura che esista la riga base in italiano in descrizioni_vini.
 * Se non esiste, chiama la funzione "descrizione-vino" per crearla.
 */
async function ensureBaseRow(params: {
  nome: string;
  annata: string | number | null;
  uvaggio?: string | null;
  categoria?: string | null;
  sottocategoria?: string | null;
  ristorante_id: string;
}) {
  const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } =
    params;

  const fingerprint = [
    norm(nome),
    annata ?? "",
    norm(uvaggio),
    norm(categoria),
    norm(sottocategoria),
    ristorante_id ?? "",
  ].join("|");

  // 1) prova a leggere dalla cache
  let { data: row, error } = await supabase
    .from("descrizioni_vini")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (!error && row) {
    return { row, fingerprint };
  }

  // 2) se non esiste, chiama descrizione-vino per generarla
  const descrFnUrl = `${FUNCTIONS_BASE}/descrizione-vino`;
  const body = {
    nome,
    annata,
    uvaggio,
    categoria,
    sottocategoria,
    ristorante_id,
  };

  const res = await fetch(descrFnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // uso la service role perché sono dentro alle edge function
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`descrizione-vino HTTP ${res.status}: ${txt}`);
  }

  // 3) rileggo la riga appena creata
  const { data: row2, error: err2 } = await supabase
    .from("descrizioni_vini")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (err2 || !row2) {
    throw new Error("Impossibile recuperare descrizione_vini dopo descrizione-vino");
  }

  return { row: row2, fingerprint };
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
    const {
      nome,
      annata,
      uvaggio,
      categoria,
      sottocategoria,
      ristorante_id,
      lang,
    } = await req.json();

    if (!nome || !ristorante_id) {
      return new Response(
        JSON.stringify({ ok: false, error: "Mancano nome o ristorante_id" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const targetLang = normalizeLang(lang);
    const { row: baseRow } = await ensureBaseRow({
      nome,
      annata: annata ?? null,
      uvaggio,
      categoria,
      sottocategoria,
      ristorante_id,
    });

    // normalizza colonne italiane se ancora vuote
    const descrIt: string =
      baseRow.descrizione_it || baseRow.descrizione || "";
    const schedaIt: MiniCard =
      baseRow.scheda_it || baseRow.scheda || {
        hook: "",
        palate: "",
        notes: [],
        pairings: [],
        emojis: { notes: {}, pairings: {} },
      };

    // se non c'è proprio niente in italiano, errore "pulito"
    if (!descrIt.trim()) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Descrizione italiana mancante, impossibile tradurre.",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // assicuro che descrizione_it / scheda_it siano salvate
    try {
      const upd: any = {};
      if (!baseRow.descrizione_it) upd.descrizione_it = descrIt;
      if (!baseRow.scheda_it) upd.scheda_it = schedaIt;
      if (Object.keys(upd).length > 0) {
        await supabase
          .from("descrizioni_vini")
          .update(upd)
          .eq("id", baseRow.id);
      }
    } catch (_e) {
      // non è critico, posso ignorare
    }

    // se chiedo "it" → ritorno subito italiano
    // MA se mancano traduzioni per altre lingue,
    // faccio partire la generazione in background
    if (targetLang === "it") {
      const langs: SupportedLang[] = ["en", "fr", "de", "es", "zh", "ru", "ko"];
      const missing = langs.filter((l) => {
        const dk = `descrizione_${l}`;
        const sk = `scheda_${l}`;
        return !baseRow[dk] || !baseRow[sk];
      });

      if (missing.length > 0) {
        // fire & forget (non blocco la risposta)
        generaTraduzioniMultiLingua(descrIt, schedaIt)
          .then(async (map) => {
            if (!map || Object.keys(map).length === 0) return;
            const update: any = {};

            for (const l of langs) {
              const tl = map[l];
              if (!tl) continue;
              update[`descrizione_${l}`] = tl.descrizione;
              update[`scheda_${l}`] = tl.scheda;
            }

            if (Object.keys(update).length > 0) {
              await supabase
                .from("descrizioni_vini")
                .update(update)
                .eq("id", baseRow.id);
            }
          })
          .catch((e) =>
            console.error("Errore background traduzioni:", e)
          );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          lang: "it",
          descrizione: descrIt,
          mini_card: schedaIt,
          cached: true,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // --- lingue ≠ it ---

    const descrKey = `descrizione_${targetLang}`;
    const schedaKey = `scheda_${targetLang}`;

    // se è già tradotto → ritorno subito
    if (baseRow[descrKey] && baseRow[schedaKey]) {
      return new Response(
        JSON.stringify({
          ok: true,
          lang: targetLang,
          descrizione: baseRow[descrKey],
          mini_card: baseRow[schedaKey],
          cached: true,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // altrimenti genero TUTTE le lingue in un colpo solo
    const translations = await generaTraduzioniMultiLingua(descrIt, schedaIt);

    const langsAll: SupportedLang[] = ["en", "fr", "de", "es", "zh", "ru", "ko"];
    const update: any = {};

    for (const l of langsAll) {
      const tl = translations[l];
      if (!tl) continue;
      update[`descrizione_${l}`] = tl.descrizione;
      update[`scheda_${l}`] = tl.scheda;
    }

    if (Object.keys(update).length > 0) {
      // salvo in DB
      await supabase
        .from("descrizioni_vini")
        .update(update)
        .eq("id", baseRow.id);
    }

    const out = translations[targetLang];
    const outDescr = out?.descrizione || descrIt;
    const outScheda = out?.scheda || schedaIt;

    return new Response(
      JSON.stringify({
        ok: true,
        lang: targetLang,
        descrizione: outDescr,
        mini_card: outScheda,
        cached: false,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    console.error("traduci-descrizione-vino error", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});
