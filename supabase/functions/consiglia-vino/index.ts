// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

/** =========================
 *  UTIL
 *  ========================= */

const norm = (s: string) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.wineinapp.com",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json",
};

type LangCode = "it" | "en" | "de" | "es" | "fr" | "zh" | "ko" | "ru";

const LANGS: Record<LangCode, { name: string; GRAPE: string; MOTIVE: string }> = {
  it: { name: "italiano", GRAPE: "UVAGGIO", MOTIVE: "MOTIVAZIONE" },
  en: { name: "English", GRAPE: "GRAPE", MOTIVE: "RATIONALE" },
  de: { name: "Deutsch", GRAPE: "REBSORTE", MOTIVE: "BEGRÜNDUNG" },
  es: { name: "Español", GRAPE: "UVA", MOTIVE: "MOTIVACIÓN" },
  fr: { name: "Français", GRAPE: "CÉPAGES", MOTIVE: "JUSTIFICATION" },
  zh: { name: "中文", GRAPE: "葡萄品种", MOTIVE: "理由" },
  ko: { name: "한국어", GRAPE: "포도 품종", MOTIVE: "이유" },
  ru: { name: "Русский", GRAPE: "СОРТ ВИНОГРАДА", MOTIVE: "ПРИЧИНА" },
};

function getLangCode(raw: any): LangCode {
  const code = String(raw || "it").toLowerCase();
  const fixed = code === "gb" ? "en" : code;
  switch (fixed) {
    case "it":
    case "en":
    case "de":
    case "es":
    case "fr":
    case "zh":
    case "ko":
    case "ru":
      return fixed;
    default:
      return "it";
  }
}

const ICONS = {
  boosted: "⭐",
  top: "👍",
  discovery: "✨",
  style: {
    sparkling: "🥂",
    crisp_white: "🍋",
    full_white: "🧈",
    rosato: "🌸",
    light_red: "🍒",
    structured_red: "🟤",
  },
};

/** =========================
 *  DOMAIN TYPES
 *  ========================= */

type Profile = {
  acid: number;
  tannin: number;
  body: number;
  sweet: number;
  bubbles: number;
};

type Dish = {
  fat: number;
  spice: number;
  sweet: number;
  intensity: number;
  protein:
    | "pesce"
    | "carne_rossa"
    | "carne_bianca"
    | "salumi"
    | "formaggio"
    | "veg"
    | null;
  cooking: "crudo" | "fritto" | "griglia" | "brasato" | "bollito" | null;
  acid_hint: boolean;
};

type Colore = "bianco" | "rosso" | "rosato" | "spumante" | "dolce" | "altro";

type GrapePrior = {
  display_name: string;
  profile: Profile;
  tasting_notes: string[];
  pairings: string[];
  style_hints: string[];
  text_summary: string[];
};

type AppellationPrior = {
  denom_norm: string;
  delta: Profile;
  default_color: Colore | null;
  typical_notes: string[];
  typical_pairings: string[];
  style_hints: string[];
  terroir_tags: string[];
  palate_template: string[];
};

type Priors = {
  grapesByKey: Map<string, GrapePrior>;
  appellations: { key: string; prior: AppellationPrior }[];
};

type WineTextContext = {
  grapes: string[];
  tastingNotes: string[];
  typicalNotes: string[];
  grapePairings: string[];
  appPairings: string[];
  grapeStyleHints: string[];
  appStyleHints: string[];
  terroirTags: string[];
  grapeTextSummary: string[];
  palateTemplate: string[];
};

type EnrichedWine = {
  [k: string]: any;
  prezzoNum: number;
  colore: Colore;
  nomeN: string;
  __producer: string;
  __uvTokens: Set<string>;
  __profile: Profile;
  __ctx: WineTextContext;
  __tags: Set<string>;
  __historyKey: string;
  __legacyLogKey: string;
  __q?: number;
  __scoreCore?: number;
  __isBoost?: boolean;
  __style?: string;
};

/** =========================
 *  VECTORS & RANDOM
 *  ========================= */

const toVec = (p: Profile) => [p.acid, p.tannin, p.body, p.sweet, p.bubbles];

function cosSim(a: number[], b: number[]) {
  const dot = a.reduce((s, ai, i) => s + ai * b[i], 0);
  const na = Math.sqrt(a.reduce((s, ai) => s + ai * ai, 0));
  const nb = Math.sqrt(b.reduce((s, bi) => s + bi * bi, 0));
  return na && nb ? dot / (na * nb) : 0;
}

function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** =========================
 *  STRING & TOKEN HELPERS
 *  ========================= */

const splitDishes = (input: string): string[] =>
  (input || "")
    .split(/\s*,\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);

function splitGrapes(uvaggio: string): string[] {
  const raw = (uvaggio || "")
    .toLowerCase()
    .replace(/\b(docg?|ig[pt])\b/g, " ")
    .replace(/\bclassico\b/g, " ")
    .replace(/\d+\s*%/g, " ");
  return raw
    .split(
      /[,;+\-\/&]|\b(?:e|con|blend|uvaggio|cépage|variet[aà])\b|·/g,
    )
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordCount(s: string) {
  return (s.trim().match(/\S+/g) || []).length;
}

function trimToWords(s: string, max: number) {
  const words = (s.trim().match(/\S+/g) || []).slice(0, max);
  return words.join(" ");
}

function cleanText(raw: any): string {
  if (raw == null) return "";
  return String(raw).trim();
}

function normalizeVintage(raw: any): string {
  const s = cleanText(raw);
  if (!s) return "";
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : norm(s);
}

function wineHistoryKey(w: any): string {
  const id = cleanText(w?.id);
  if (id) return `id:${id}`;

  const nome = norm(String(w?.nome || ""));
  const annata = normalizeVintage(w?.annata);
  const uvaggio = norm(String(w?.uvaggio || ""));
  return `fp:${nome}|${annata}|${uvaggio}`;
}

function extractLogWineKeys(row: any): string[] {
  if (Array.isArray(row?.vini_keys) && row.vini_keys.length) {
    return row.vini_keys.map((x: any) => cleanText(x)).filter(Boolean);
  }

  if (Array.isArray(row?.vini_ids) && row.vini_ids.length) {
    return row.vini_ids
      .map((x: any) => cleanText(x))
      .filter(Boolean)
      .map((id: string) => `id:${id}`);
  }

  if (Array.isArray(row?.vini) && row.vini.length) {
    return row.vini
      .map((x: any) => cleanText(x))
      .filter(Boolean)
      .map((nome: string) => `legacy:${norm(nome)}`);
  }

  return [];
}
/** =========================
 *  COLOR PARSING
 *  ========================= */

function coloreFromLabel(labelRaw: string): Colore {
  const s = norm(labelRaw);

  if (
    /\b(spumante|bollicine|metodo classico|classique|champagne|franciacorta|trentodoc|saten|satèn|prosecco|col fondo|colfondo|extra\s*dry|brut|pas do[sz]e|dosaggio zero)\b/
      .test(s)
  ) return "spumante";

  if (
    /\b(dolce|passito|vendemmia tardiva|late harvest|sauternes|vin santo|zibibbo passito|moscato passito)\b/
      .test(s)
  ) return "dolce";

  if (/\b(rosato|rose|ros[eè]|vino rosato|vini rosati|cerasuolo)\b/.test(s)) {
    return "rosato";
  }

  if (/\b(bianco|bianchi|vino bianco|vini bianchi|white|blanc)\b/.test(s)) {
    return "bianco";
  }

  if (/\bramato\b/.test(s)) return "bianco";

  if (/\b(rosso|rossi|vino rosso|vini rossi|red|rouge)\b/.test(s)) {
    return "rosso";
  }

  return "altro";
}

const WHITE_GRAPES = new Set([
  "chardonnay",
  "sauvignon",
  "sauvignon blanc",
  "pinot grigio",
  "pinot bianco",
  "vermentino",
  "glera",
  "greco",
  "fiano",
  "verdicchio",
  "trebbiano",
  "garganega",
  "ribolla",
  "zibibbo",
  "moscato",
  "grillo",
  "gewurztraminer",
  "traminer",
  "catarratto",
  "arvernenga",
  "cortese",
  "passerina",
  "pecorino",
  "falanghina",
  "inzolia",
  "malvasia",
  "vernaccia",
  "timorasso",
]);
const RED_GRAPES = new Set([
  "sangiovese",
  "nebbiolo",
  "barbera",
  "montepulciano",
  "aglianico",
  "primitivo",
  "negroamaro",
  "syrah",
  "cabernet",
  "cabernet sauvignon",
  "cabernet franc",
  "merlot",
  "pinot nero",
  "corvina",
  "corvinone",
  "rondinella",
  "refosco",
  "sagrantino",
  "nero d avola",
  "nero d’avola",
  "teroldego",
  "lagrein",
  "frappato",
  "dolcetto",
  "grignolino",
]);

function inferColorFromGrapes(uvaggio: string): Colore {
  const toks = splitGrapes(uvaggio).map(norm);
  const hasWhite = toks.some((t) => WHITE_GRAPES.has(t));
  const hasRed = toks.some((t) => RED_GRAPES.has(t));
  if (hasWhite && !hasRed) return "bianco";
  if (hasRed && !hasWhite) return "rosso";
  return "altro";
}

function parseDefaultColor(raw: any): Colore | null {
  if (!raw) return null;
  const s = norm(String(raw));
  if (!s) return null;
  if (/spumante|sparkling|bollicine|champagne|franciacorta|trentodoc/.test(s)) {
    return "spumante";
  }
  if (/dolce|passito|sweet|dessert/.test(s)) return "dolce";
  if (/rosato|rose|ros[eè]/.test(s)) return "rosato";
  if (/bianco|white|blanc/.test(s)) return "bianco";
  if (/rosso|red|rouge/.test(s)) return "rosso";
  return null;
}

/** =========================
 *  PIATTO PARSER (GPT + FALLBACK)
 *  ========================= */

function parseDishFallback(text: string): Dish {
  const s = (text || "").toLowerCase();
  const dish: Dish = {
    fat: 0.3,
    spice: 0,
    sweet: 0,
    intensity: 0.4,
    protein: null,
    cooking: null,
    acid_hint: false,
  };

  if (/forno|al forno|arrosto|in crosta/.test(s)) {
    dish.cooking = dish.cooking ?? "griglia";
    dish.intensity = Math.max(dish.intensity, 0.55);
  }
  if (/crudo|tartare|carpaccio/.test(s)) {
    dish.cooking = "crudo";
    dish.intensity = 0.3;
  }
  if (/fritt|impanat/.test(s)) {
    dish.cooking = "fritto";
    dish.fat = 0.7;
    dish.intensity = Math.max(dish.intensity, 0.5);
  }
  if (/griglia|brace|arrosto/.test(s)) {
    dish.cooking = "griglia";
    dish.intensity = 0.6;
  }
  if (/brasat|stracotto|stufato/.test(s)) {
    dish.cooking = "brasato";
    dish.intensity = 0.8;
    dish.fat = Math.max(dish.fat, 0.6);
  }
  if (/bollit/.test(s)) {
    dish.cooking = "bollito";
    dish.intensity = Math.max(dish.intensity, 0.45);
  }

  if (/limone|agrodolce|aceto|capperi|citric|yuzu/.test(s)) {
    dish.acid_hint = true;
  }

  if (/piccant|’nduja|nduja|peperoncino|curry|speziat/.test(s)) {
    dish.spice = 0.6;
  }

  if (
    /dolce|dessert|tiramisu|cheesecake|torta|pasticc|gelato|sorbetto/.test(s)
  ) {
    dish.sweet = 0.8;
    dish.intensity = 0.6;
  }

  if (
    /pesce|tonno|salmone|gamber|calamari|cozze|vongole|polpo|scampi|branzino|orata|spigola/
      .test(s)
  ) {
    dish.protein = "pesce";
  } else if (
    /manzo|bovino|fiorentina|tagliata|agnello|cervo|capriolo|cacciagione/
      .test(s)
  ) {
    dish.protein = "carne_rossa";
    dish.intensity = 0.8;
  } else if (
    /maiale|porchetta|salsiccia|pollo|tacchino|coniglio|anatra|oca/.test(s)
  ) {
    dish.protein = "carne_bianca";
    dish.intensity = Math.max(dish.intensity, 0.5);
  } else if (
    /salume|prosciutto|speck|salami|mortadella|culatello|bresaola/.test(s)
  ) {
    dish.protein = "salumi";
    dish.intensity = 0.6;
    dish.fat = 0.6;
  } else if (
    /formagg|parmigiano|pecorino|gorgonzola|caprino|blu|erborinat/.test(s)
  ) {
    dish.protein = "formaggio";
    dish.intensity = 0.7;
    dish.fat = 0.6;
  } else {
    dish.protein = dish.protein ?? "veg";
  }

  if (/burro|panna|carbonara|cacio e pepe|alla gricia|quattro formaggi/.test(s)) {
    dish.fat = Math.max(dish.fat, 0.6);
  }
  if (/pomodoro|rag[ùu]/.test(s)) {
    dish.intensity = Math.max(dish.intensity, 0.55);
    dish.acid_hint = true;
  }

  return dish;
}

function combineDishes(ds: Dish[]): Dish {
  if (!ds.length) {
    return {
      fat: 0.3,
      spice: 0,
      sweet: 0,
      intensity: 0.4,
      protein: null,
      cooking: null,
      acid_hint: false,
    };
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const mode = (arr: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const v of arr) if (v) m.set(v, (m.get(v) || 0) + 1);
    return (Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
      null) as any;
  };
  return {
    fat: +avg(ds.map((d) => d.fat)).toFixed(2),
    spice: +avg(ds.map((d) => d.spice)).toFixed(2),
    sweet: +avg(ds.map((d) => d.sweet)).toFixed(2),
    intensity: +avg(ds.map((d) => d.intensity)).toFixed(2),
    acid_hint: ds.some((d) => d.acid_hint),
    protein: mode(ds.map((d) => d.protein)),
    cooking: mode(ds.map((d) => d.cooking)),
  };
}

async function getDishFeatures(piattoRaw: string, openaiKey?: string): Promise<Dish> {
  const items = splitDishes(piattoRaw);
  if (!openaiKey) return combineDishes(items.map(parseDishFallback));

  const userPrompt = `
Analizza questi piatti e restituisci SOLO un ARRAY JSON, ogni oggetto con chiavi:
"protein": "pesce"|"carne_rossa"|"carne_bianca"|"salumi"|"formaggio"|"veg"|null
"cooking": "crudo"|"fritto"|"griglia"|"brasato"|"bollito"|null
"fat": 0..1, "spice": 0..1, "sweet": 0..1, "intensity": 0..1, "acid_hint": true/false
Piatti: ${items.map((s) => `"${s}"`).join(", ")}
`.trim();

  let resp: Response | null = null;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "Rispondi sempre e solo con un ARRAY JSON valido. Nessun testo prima o dopo.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch {
    return combineDishes(items.map(parseDishFallback));
  }
  if (!resp?.ok) return combineDishes(items.map(parseDishFallback));

  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content || "";
  let arr: any[] = [];
  try {
    if (content.trim().startsWith("[")) arr = JSON.parse(content);
    else {
      const m = content.match(/\[[\s\S]*\]/);
      arr = m ? JSON.parse(m[0]) : [];
    }
  } catch {
    arr = [];
  }

  const toDish = (r: any): Dish => ({
    protein: ([
      "pesce",
      "carne_rossa",
      "carne_bianca",
      "salumi",
      "formaggio",
      "veg",
    ].includes(r?.protein))
      ? r.protein
      : null,
    cooking: (["crudo", "fritto", "griglia", "brasato", "bollito"].includes(
      r?.cooking,
    ))
      ? r.cooking
      : null,
    fat: clamp01(Number(r?.fat ?? 0.3)),
    spice: clamp01(Number(r?.spice ?? 0)),
    sweet: clamp01(Number(r?.sweet ?? 0)),
    intensity: clamp01(Number(r?.intensity ?? 0.4)),
    acid_hint: !!r?.acid_hint,
  });

  const dishes: Dish[] = Array.isArray(arr) ? arr.map(toDish) : [];
  return dishes.length
    ? combineDishes(dishes)
    : combineDishes(items.map(parseDishFallback));
}

/** =========================
 *  PRIORS LOADING
 *  ========================= */

function toStringArray(raw: any): string[] {
  if (raw == null) return [];

  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }

  const s = String(raw).trim();
  if (!s || s.toLowerCase() === "nan") return [];

  // JSON array vero
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr)
        ? arr.map((x) => String(x).trim()).filter(Boolean)
        : [];
    } catch {
      // continua sotto
    }
  }

  // PostgreSQL array testuale: {"a","b","c"}
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];

    const out: string[] = [];
    let buf = "";
    let inQuotes = false;
    let escaped = false;

    for (const ch of inner) {
      if (escaped) {
        buf += ch;
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (ch === "," && !inQuotes) {
        const item = buf.trim().replace(/^"+|"+$/g, "").trim();
        if (item) out.push(item);
        buf = "";
        continue;
      }

      buf += ch;
    }

    const last = buf.trim().replace(/^"+|"+$/g, "").trim();
    if (last) out.push(last);

    return out.filter(Boolean);
  }

  return [s];
}

async function loadPriors(headers: Record<string, string>): Promise<Priors> {
  const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";

  const gpRes = await fetch(
    `${supabaseUrl}/rest/v1/grape_profiles?select=display_name,grape_norm,acid,tannin,body,sweet,bubbles,synonyms,tasting_notes,pairings,style_hints,text_summary`,
    { headers },
  );
  if (!gpRes.ok) throw new Error(`grape_profiles ${gpRes.status}`);
  const grapeRows = await gpRes.json();

  const grapesByKey = new Map<string, GrapePrior>();
  for (const r of grapeRows) {
    const profile: Profile = {
      acid: Number(r.acid ?? 0.5),
      tannin: Number(r.tannin ?? 0.3),
      body: Number(r.body ?? 0.5),
      sweet: Number(r.sweet ?? 0),
      bubbles: Number(r.bubbles ?? 0),
    };
    const gp: GrapePrior = {
      display_name: String(r.display_name || r.grape_norm || ""),
      profile,
      tasting_notes: toStringArray(r.tasting_notes),
      pairings: toStringArray(r.pairings),
      style_hints: toStringArray(r.style_hints),
      text_summary: toStringArray(r.text_summary),
    };
    const primary = norm(String(r.grape_norm || r.display_name || ""));
    if (primary) grapesByKey.set(primary, gp);
    for (const syn of (r.synonyms || [])) {
      const k = norm(String(syn));
      if (k) grapesByKey.set(k, gp);
    }
  }

  const apRes = await fetch(
    `${supabaseUrl}/rest/v1/appellation_priors?select=denom_norm,synonyms,delta_acid,delta_tannin,delta_body,delta_sweet,delta_bubbles,default_color,typical_notes,typical_pairings,style_hints,terroir_tags,palate_template`,
    { headers },
  );
  const appRows = apRes.ok ? await apRes.json() : [];

  const appellations: { key: string; prior: AppellationPrior }[] = [];
  for (const r of (appRows || [])) {
    const delta: Profile = {
      acid: Number(r.delta_acid || 0),
      tannin: Number(r.delta_tannin || 0),
      body: Number(r.delta_body || 0),
      sweet: Number(r.delta_sweet || 0),
      bubbles: Number(r.delta_bubbles || 0),
    };
    const prior: AppellationPrior = {
      denom_norm: String(r.denom_norm || ""),
      delta,
      default_color: parseDefaultColor(r.default_color),
      typical_notes: toStringArray(r.typical_notes),
      typical_pairings: toStringArray(r.typical_pairings),
      style_hints: toStringArray(r.style_hints),
      terroir_tags: toStringArray(r.terroir_tags),
      palate_template: toStringArray(r.palate_template),
    };

    const mainKey = norm(String(r.denom_norm || ""));
    if (mainKey) appellations.push({ key: mainKey, prior });
    for (const syn of (r.synonyms || [])) {
      const k = norm(String(syn));
      if (k) appellations.push({ key: k, prior });
    }
  }

  return { grapesByKey, appellations };
}

/** =========================
 *  PROFILE FROM WINE + CONTEXT
 *  ========================= */

function enforceColorGuardRails(base: Profile, colore: Colore): Profile {
  let p = { ...base };
  switch (colore) {
    case "spumante":
      p = {
        ...p,
        bubbles: 1,
        acid: Math.max(p.acid, 0.6),
        tannin: Math.min(p.tannin, 0.25),
      };
      break;
    case "bianco":
      p = {
        ...p,
        tannin: Math.min(p.tannin, 0.25),
      };
      break;
    case "rosato":
      p = {
        ...p,
        tannin: Math.min(p.tannin, 0.45),
      };
      break;
    case "rosso":
      p = { ...p, bubbles: 0 };
      break;
    case "dolce":
      p = { ...p, sweet: Math.max(p.sweet, 0.6) };
      break;
  }
  return {
    acid: clamp01(p.acid),
    tannin: clamp01(p.tannin),
    body: clamp01(p.body),
    sweet: clamp01(p.sweet),
    bubbles: clamp01(p.bubbles),
  };
}

function buildTags(ctx: WineTextContext, colore: Colore): Set<string> {
  const tags = new Set<string>();
  const addArr = (arr: string[]) => {
    for (const s of arr || []) {
      const toks = norm(String(s)).split(" ");
      toks.forEach((t) => t && tags.add(t));
    }
  };
  addArr(ctx.tastingNotes);
  addArr(ctx.typicalNotes);
  addArr(ctx.grapeStyleHints);
  addArr(ctx.appStyleHints);
  addArr(ctx.terroirTags);
  addArr(ctx.palateTemplate);
  ctx.grapes.forEach((g) => tags.add(norm(g)));
  tags.add(colore);
  return tags;
}

type UvPart = { key: string; weight: number; display?: string };

function parseUvaggioWeighted(uvaggioRaw: string, priors: Priors): UvPart[] {
  const s0 = (uvaggioRaw || "")
    .replace(/\.+$/g, "")
    .replace(/biologico/gi, " ")
    .replace(/nelle variet[àa]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s0) return [];

  const chunks = s0
    .split(/[,;\/&+]|(?:\s+e\s+)|(?:\s+ed\s+)/gi)
    .map((x) => x.trim())
    .filter(Boolean);

  const temp: { key: string; pct?: number; display?: string }[] = [];

  for (const c of chunks) {
    const m = c.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const pct = m ? parseFloat(m[1].replace(",", ".")) : undefined;

    const name = norm(c.replace(/(\d+(?:[.,]\d+)?)\s*%/g, " "))
      .replace(/\b(varieta|varieta|uve|uvaggio|blend)\b/g, "")
      .trim();

    if (!name) continue;

    const gp = priors.grapesByKey.get(name);
    if (gp) {
      temp.push({ key: name, pct, display: gp.display_name });
      continue;
    }

    let foundKey = "";
    for (const k of priors.grapesByKey.keys()) {
      if (k.length >= 4 && name.includes(k)) {
        foundKey = k;
        break;
      }
    }
    if (foundKey) {
      const gp2 = priors.grapesByKey.get(foundKey);
      temp.push({ key: foundKey, pct, display: gp2?.display_name });
    }
  }

  if (!temp.length) return [];

  const withPct = temp.filter((x) => typeof x.pct === "number" && !isNaN(x.pct!));
  const withoutPct = temp.filter((x) => x.pct == null);

  if (withPct.length === 0) {
    const w = 1 / temp.length;
    return temp.map((x) => ({ key: x.key, weight: w, display: x.display }));
  }

  const sumPct = withPct.reduce((a, x) => a + (x.pct || 0), 0);
  const rem = Math.max(0, 100 - sumPct);
  const fill = withoutPct.length ? (rem / withoutPct.length) : 0;

  const parts = temp.map((x) => ({
    key: x.key,
    display: x.display,
    weight: ((x.pct ?? fill) / 100),
  }));

  const S = parts.reduce((a, p) => a + p.weight, 0) || 1;
  return parts
    .map((p) => ({ ...p, weight: p.weight / S }))
    .filter((p) => p.weight > 0.0001)
    .sort((a, b) => b.weight - a.weight);
}

function profileAndContextFromWine(
  w: any,
  priors: Priors,
  coloreCategoria: Colore,
): { profile: Profile; colore: Colore; ctx: WineTextContext } {
  const uvParts = parseUvaggioWeighted(String(w.uvaggio || ""), priors);
  const uvTokens = uvParts.map((p) => p.key);

  const found: { gp: GrapePrior; w: number }[] = [];
  for (const part of uvParts) {
    const gp = priors.grapesByKey.get(part.key);
    if (gp) found.push({ gp, w: part.weight });
  }

  let profile: Profile;
  if (found.length) {
    const sumW = found.reduce((a, x) => a + x.w, 0) || 1;
    const agg = found.reduce((a, x) => ({
      acid: a.acid + x.gp.profile.acid * (x.w / sumW),
      tannin: a.tannin + x.gp.profile.tannin * (x.w / sumW),
      body: a.body + x.gp.profile.body * (x.w / sumW),
      sweet: a.sweet + x.gp.profile.sweet * (x.w / sumW),
      bubbles: Math.max(a.bubbles, x.gp.profile.bubbles),
    }), { acid: 0, tannin: 0, body: 0, sweet: 0, bubbles: 0 });

    profile = {
      acid: +agg.acid.toFixed(2),
      tannin: +agg.tannin.toFixed(2),
      body: +agg.body.toFixed(2),
      sweet: +agg.sweet.toFixed(2),
      bubbles: agg.bubbles > 0 ? 1 : 0,
    };
  } else {
    profile = { acid: 0.55, tannin: 0.35, body: 0.52, sweet: 0, bubbles: 0 };
  }

  const ctx: WineTextContext = {
    grapes: [],
    tastingNotes: [],
    typicalNotes: [],
    grapePairings: [],
    appPairings: [],
    grapeStyleHints: [],
    appStyleHints: [],
    terroirTags: [],
    grapeTextSummary: [],
    palateTemplate: [],
  };

  for (const { gp } of found) {
    if (gp.display_name) ctx.grapes.push(gp.display_name);
    ctx.tastingNotes.push(...toStringArray(gp.tasting_notes));
    ctx.grapePairings.push(...toStringArray(gp.pairings));
    ctx.grapeStyleHints.push(...toStringArray(gp.style_hints));
    ctx.grapeTextSummary.push(...toStringArray(gp.text_summary));
  }

  const bag = norm(
    `${w.sottocategoria || ""} ${w.categoria || ""} ${w.nome || ""}`,
  );

  const matches: { w: number; prior: AppellationPrior }[] = [];
  for (const { key, prior } of priors.appellations) {
    if (!key) continue;
    if (bag.includes(key)) {
      let spec = 0.3;
      if (/\bdocg\b/.test(bag)) spec = 1.0;
      else if (/\bdoc\b/.test(bag)) spec = 0.7;
      else if (/\big[pt]\b/.test(bag)) spec = 0.4;
      matches.push({ w: spec, prior });
    }
  }

  let colorFromApp: Colore | null = null;
  if (matches.length) {
    const W = matches.reduce((s, m) => s + m.w, 0) || 1;
    const aggDelta = matches.reduce(
      (a, m) => ({
        acid: a.acid + m.prior.delta.acid * (m.w / W),
        tannin: a.tannin + m.prior.delta.tannin * (m.w / W),
        body: a.body + m.prior.delta.body * (m.w / W),
        sweet: a.sweet + m.prior.delta.sweet * (m.w / W),
        bubbles: Math.max(
          a.bubbles,
          m.prior.delta.bubbles > 0 ? 1 : 0,
        ),
      }),
      { acid: 0, tannin: 0, body: 0, sweet: 0, bubbles: 0 },
    );

    profile = {
      acid: clamp01(profile.acid + aggDelta.acid),
      tannin: clamp01(profile.tannin + aggDelta.tannin),
      body: clamp01(profile.body + aggDelta.body),
      sweet: clamp01(profile.sweet + aggDelta.sweet),
      bubbles: Math.max(profile.bubbles, aggDelta.bubbles),
    };

    for (const { prior } of matches) {
      if (!colorFromApp && prior.default_color) {
        colorFromApp = prior.default_color;
      }
      ctx.typicalNotes.push(...(prior.typical_notes || []));
      ctx.appPairings.push(...(prior.typical_pairings || []));
      ctx.appStyleHints.push(...(prior.style_hints || []));
      ctx.terroirTags.push(...(prior.terroir_tags || []));
      ctx.palateTemplate.push(...(prior.palate_template || []));
    }
  }

  let colore: Colore = coloreCategoria;
  if (colore === "altro" && colorFromApp) {
    colore = colorFromApp;
  }
  if (colore === "altro") {
    const byGrape = inferColorFromGrapes(String(w.uvaggio || ""));
    if (byGrape !== "altro") colore = byGrape;
  }

  profile = enforceColorGuardRails(profile, colore);

  return { profile, colore, ctx };
}

/** =========================
 *  MATCHING
 *  ========================= */

function matchScore(
  profile: Profile,
  dish: Dish,
  wineCtx: WineTextContext,
  piattoNorm: string,
): number {
  let sc = 0;

  sc += (dish.fat * (profile.acid * 1.0 + profile.bubbles * 0.6));

  if (dish.protein === "pesce" || dish.cooking === "crudo") {
    sc += (profile.acid * 1.35) - (profile.tannin * 1.0);
    if (dish.acid_hint && dish.cooking !== "fritto") {
      sc += profile.acid * 0.25;
      sc -= profile.bubbles * 0.35;
    }
  }

  if (dish.cooking === "fritto") {
    sc += profile.bubbles * 1.3 + profile.acid * 0.8;
  }

  if (dish.protein === "carne_rossa" || dish.cooking === "brasato") {
    sc += profile.tannin * 1.8 + profile.body * 1.35 - profile.bubbles * 0.8;
    if (profile.tannin >= 0.6 && profile.body >= 0.6) sc += 0.15;
  }

  if (dish.spice > 0) {
    sc += profile.sweet * 1.0 - profile.tannin * 0.8 - profile.body * 0.4;
  }

  if (dish.protein === "formaggio") {
    sc += profile.body * 0.6 + profile.acid * 0.2 -
      Math.max(0, profile.tannin - 0.5) * 0.3;
  }

  if (dish.protein === "salumi") {
    sc += profile.acid * 0.35 +
      Math.max(0, 0.55 - profile.tannin) * 0.4 +
      Math.max(0, 0.6 - profile.body) * 0.2 -
      profile.bubbles * 0.4;
  }

  if (dish.protein === "veg" && dish.cooking !== "fritto") {
    sc += profile.acid * 0.45 -
      Math.max(0, profile.tannin - 0.25) * 0.6 -
      profile.bubbles * 0.15;
  }

  if (dish.protein === "veg" && dish.intensity >= 0.55) {
    sc += Math.max(
      0.1,
      0.35 - Math.max(0, profile.tannin - 0.55) * 0.4,
    ) + profile.body * 0.2;
  }

  if (dish.protein === "carne_bianca" && dish.cooking === "griglia") {
    sc += profile.body * 0.4 -
      Math.max(0, profile.tannin - 0.4) * 0.5 -
      profile.bubbles * 0.2;
  }

  if (dish.sweet > 0) sc += profile.sweet * 1.5;
  if (dish.acid_hint) sc += profile.acid * 0.8;
  sc += (1 - Math.abs(dish.intensity - profile.body)) * 0.6;

  if (
    (dish.protein === "pesce" || dish.cooking === "crudo") &&
    profile.tannin >= 0.65
  ) {
    sc -= 0.4 * (profile.tannin - 0.65);
  }

  const dishTokens = new Set(piattoNorm.split(" ").filter(Boolean));

  const pairingTexts = [
    ...(wineCtx.grapePairings || []),
    ...(wineCtx.appPairings || []),
  ];
  let pairingHits = 0;
  for (const p of pairingTexts) {
    const ptoks = new Set(norm(String(p)).split(" ").filter(Boolean));
    let inter = 0;
    for (const t of ptoks) if (dishTokens.has(t)) inter++;
    if (inter >= 2 || (ptoks.size === 1 && inter === 1)) {
      pairingHits++;
    }
  }
  if (pairingHits > 0) {
    sc += 0.1 * Math.min(pairingHits, 3);
  }

  const styleAll = norm(
    [
      ...(wineCtx.grapeStyleHints || []),
      ...(wineCtx.appStyleHints || []),
      ...(wineCtx.terroirTags || []),
      ...(wineCtx.grapeTextSummary || []),
      ...(wineCtx.palateTemplate || []),
    ].join(" "),
  );

  const richDish = dish.fat >= 0.6 || dish.intensity >= 0.7 ||
    dish.cooking === "brasato";
  const delicateDish = dish.intensity <= 0.45 && dish.fat <= 0.4 &&
    (dish.protein === "pesce" || dish.protein === "veg");
  const spicyDish = dish.spice > 0.4;

  if (richDish) {
    if (
      /(struttura|importante|rovere|barrique|potente|corposo|longevit)/.test(
        styleAll,
      )
    ) {
      sc += 0.05;
    }
  }
  if (delicateDish) {
    if (/(teso|snello|fresco|mineral|salino|gastronomic)/.test(styleAll)) {
      sc += 0.05;
    }
  }
  if (spicyDish) {
    if (/(morbido|rotondo|dolcezza|glicerico|avvolgente)/.test(styleAll)) {
      sc += 0.03;
    }
  }
  if (
    (dish.protein === "pesce" || dish.protein === "veg") &&
    /(marittimo|vulcanic|costa|sapido)/.test(styleAll)
  ) {
    sc += 0.03;
  }

  return sc;
}

/** =========================
 *  MOTIVAZIONE TESTUALE MULTILINGUA
 *  ========================= */

type MotivationPoolKey =
  | "red_meat"
  | "white_meat"
  | "fish"
  | "cured_meat"
  | "cheese"
  | "veg"
  | "bubbles_fat"
  | "fresh_fat"
  | "spicy_soft"
  | "spicy_fresh"
  | "acid_hint"
  | "rich_body"
  | "delicate_light";

type SommelierLocale = {
  and: string;
  noteLead: string;
  intros: string[];
  closers: string[];
  lines: Record<MotivationPoolKey, string[]>;
};

const SOMM_TEXT: Record<LangCode, SommelierLocale> = {
  it: {
    and: "e",
    noteLead: "ti porta",
    intros: [
      "Io lo sceglierei perché",
      "È un abbinamento che funziona perché",
      "Qui ci sta benissimo",
      "Se vuoi andare sul sicuro",
      "Secondo me è centrato perché",
      "Da sommelier te lo dico",
      "Se vuoi un sorso giusto",
      "È una scelta elegante perché",
    ],
    closers: [
      "Da tavola vera",
      "Molto gastronomico",
      "Bevibilità altissima",
      "Equilibrio e pulizia",
      "Sorso preciso, finale pulito",
      "Scorrevole e centrato",
    ],
    lines: {
      red_meat: [
        "Sta al passo con la succulenza e la lunga cottura senza perdere ritmo",
        "Tiene testa al piatto e lo accompagna fino in fondo, boccone dopo boccone",
        "Fa da struttura al piatto: sostiene la carne e pulisce il finale",
        "È centrato: regge la parte intensa senza diventare pesante",
      ],
      white_meat: [
        "Accompagna la carne bianca con equilibrio senza coprire i sapori",
        "È un abbinamento morbido: sostiene il piatto ma resta elegante",
        "Sta bene perché non appesantisce e lascia il boccone pulito",
        "Rispetta la delicatezza ma dà comunque soddisfazione al sorso",
      ],
      fish: [
        "È preciso sul pesce: resta armonico e non indurisce il boccone",
        "Sul crudo funziona perché è pulito e ti lascia la bocca fresca",
        "Sta bene perché accompagna senza coprire la delicatezza del piatto",
        "È un sorso pulito, dritto e molto gastronomico",
      ],
      cured_meat: [
        "Con i salumi funziona perché ti pulisce la bocca e invoglia l’assaggio successivo",
        "È perfetto per i salumi: alleggerisce il grasso e resta scorrevole",
        "Fa da reset tra un boccone e l’altro",
        "Tiene insieme sapidità e grassezza con naturalezza",
      ],
      cheese: [
        "Con il formaggio regge sapidità e maturazione senza impastare",
        "Sta bene perché accompagna la cremosità e chiude pulito",
        "Sostiene il gusto del formaggio e resta equilibrato",
        "Si incastra bene con la sapidità e rende il sorso più invitante",
      ],
      veg: [
        "Resta agile e gastronomico: sostiene il sapore ma lascia il piatto protagonista",
        "È un abbinamento pulito: accompagna e non invade",
        "Sta bene perché dà slancio senza coprire i dettagli",
        "Rispetta i sapori e rende il boccone più leggero",
      ],
      bubbles_fat: [
        "La bollicina pulisce il palato e rende il boccone più leggero",
        "Con il fritto è perfetto: bollicina e freschezza fanno reset",
        "La bollicina sgrassa e ti prepara subito al boccone successivo",
      ],
      fresh_fat: [
        "Ha lo slancio giusto per sgrassare e tenere il palato vivo",
        "Ripulisce bene e rende il boccone più leggero",
        "Dà freschezza e ti invita al sorso successivo",
      ],
      spicy_soft: [
        "Ha una punta di morbidezza che fa da cuscino al piccante",
        "La morbidezza smussa il piccante e rende il sorso più rotondo",
        "Ha quel minimo di dolcezza che spegne il fuoco e rilancia il gusto",
      ],
      spicy_fresh: [
        "Non spinge sul calore: accompagna il piccante senza farlo salire",
        "Resta fresco e lineare: non amplifica la speziatura",
        "Tiene il piccante in equilibrio senza asciugare troppo la bocca",
      ],
      acid_hint: [
        "Si aggancia bene alla parte più fresca del piatto e lo rende più armonico",
        "Dialoga con l’acidità del piatto e tiene il sorso dritto",
        "Sulla componente acida resta pulito e non si scompone",
      ],
      rich_body: [
        "Ha abbastanza spalla per non farsi mettere in ombra",
        "Resta presente anche con un piatto importante",
        "Ha struttura sufficiente per reggere il boccone",
      ],
      delicate_light: [
        "È snello: non invade e ti lascia gustare i dettagli del piatto",
        "Resta leggero e preciso: accompagna senza coprire",
        "Ha un profilo fine: valorizza il piatto senza alzare la voce",
      ],
    },
  },

  en: {
    and: "and",
    noteLead: "it brings",
    intros: [
      "I’d choose it because",
      "This pairing works because",
      "It fits beautifully here",
      "If you want to play it safe",
      "To me it’s spot on because",
      "From a sommelier’s point of view",
      "If you want the right sip",
      "It’s an elegant choice because",
    ],
    closers: [
      "Very food-friendly",
      "Highly drinkable",
      "Clean and balanced",
      "Precise sip, clean finish",
      "Smooth and well judged",
    ],
    lines: {
      red_meat: [
        "It keeps up with the richness and long cooking without losing energy",
        "It stands up to the dish and carries it through every bite",
        "It gives the dish structure: it supports the meat and cleans the finish",
        "It handles the intensity without becoming heavy",
      ],
      white_meat: [
        "It complements white meat with balance, without covering the flavours",
        "It supports the dish while staying elegant",
        "It works well because it keeps the bite clean and flowing",
        "It respects the delicacy of the dish but still gives satisfaction in the glass",
      ],
      fish: [
        "It is precise with fish: harmonious and never harsh on the palate",
        "With raw dishes it works because it stays clean and leaves the mouth fresh",
        "It supports the dish without covering its delicacy",
        "It is a clean, straight and very food-friendly sip",
      ],
      cured_meat: [
        "With cured meats it cleans the palate and makes the next bite more inviting",
        "It lightens the richness and stays very drinkable",
        "It works like a reset between bites",
        "It keeps saltiness and richness in balance naturally",
      ],
      cheese: [
        "With cheese it handles both saltiness and maturation without becoming heavy",
        "It supports the creamy texture and finishes clean",
        "It carries the flavour of the cheese while staying balanced",
        "It fits the savoury side of the dish and makes the sip more inviting",
      ],
      veg: [
        "It stays agile and food-friendly: it supports the flavour while leaving the dish in the spotlight",
        "It is a clean pairing: supportive, never invasive",
        "It gives lift without covering the details",
        "It respects the flavours and makes the bite feel lighter",
      ],
      bubbles_fat: [
        "The bubbles cleanse the palate and make each bite feel lighter",
        "With fried food it is spot on: bubbles and freshness reset the palate",
        "The bubbles cut through richness and prepare the mouth for the next bite",
      ],
      fresh_fat: [
        "It has the right lift to cut through richness and keep the palate lively",
        "It cleans the mouth nicely and makes the bite feel lighter",
        "Its freshness keeps the sip energetic and inviting",
      ],
      spicy_soft: [
        "It has a touch of softness that cushions the heat",
        "Its softness rounds off the spicy edges and keeps the sip smoother",
        "There is just enough softness to calm the spice and keep the pairing comfortable",
      ],
      spicy_fresh: [
        "It does not push the heat further: it supports spice without amplifying it",
        "It stays fresh and linear so the spice does not take over",
        "It keeps the heat under control without drying the palate",
      ],
      acid_hint: [
        "It connects nicely with the fresher side of the dish and makes the pairing more harmonious",
        "It mirrors the dish’s acidity and keeps the sip focused",
        "On the acidic side of the dish it stays clean and composed",
      ],
      rich_body: [
        "It has enough structure not to be overshadowed",
        "It stays present even with a powerful dish",
        "It has the shoulders needed to carry the bite",
      ],
      delicate_light: [
        "It stays slender and precise, so the delicate details of the dish remain clear",
        "It is light on its feet: supportive without covering anything",
        "Its finer profile lets the dish stay at the centre",
      ],
    },
  },

  fr: {
    and: "et",
    noteLead: "il apporte",
    intros: [
      "Je le choisirais parce que",
      "Cet accord fonctionne parce que",
      "Ici, il va très bien",
      "Si vous voulez jouer la sécurité",
      "À mon avis, c’est très juste parce que",
      "D’un point de vue de sommelier",
    ],
    closers: [
      "Très gastronomique",
      "Grande buvabilité",
      "Équilibre et netteté",
      "Sensation précise, finale propre",
    ],
    lines: {
      red_meat: [
        "Il suit très bien la richesse du plat et les longues cuissons sans perdre son élan",
        "Il tient le plat jusqu’au bout, bouchée après bouchée",
        "Il donne de la structure à l’accord et nettoie bien la finale",
      ],
      white_meat: [
        "Il accompagne la viande blanche avec équilibre sans couvrir les saveurs",
        "Il soutient le plat tout en restant élégant",
        "Il fonctionne bien parce qu’il laisse une bouche propre et fluide",
      ],
      fish: [
        "Il est précis avec le poisson et respecte sa délicatesse",
        "Sur un plat cru, il reste net et laisse la bouche fraîche",
        "Il accompagne sans dominer les détails les plus fins du plat",
      ],
      cured_meat: [
        "Avec la charcuterie, il nettoie le palais et donne envie à la bouchée suivante",
        "Il allège la matière grasse et reste très digeste",
        "Il agit comme un vrai reset entre les bouchées",
      ],
      cheese: [
        "Avec le fromage, il gère bien la sapidité et la matière sans alourdir",
        "Il accompagne la texture crémeuse et finit net",
        "Il soutient bien le goût du fromage tout en gardant l’équilibre",
      ],
      veg: [
        "Il reste agile et gastronomique : il accompagne sans envahir",
        "C’est un accord propre et précis",
        "Il donne de l’élan sans couvrir les détails du plat",
      ],
      bubbles_fat: [
        "Les bulles nettoient le palais et allègent chaque bouchée",
        "Avec le frit, c’est très juste : bulles et fraîcheur remettent tout en place",
        "Les bulles dégraissent et préparent immédiatement à la bouchée suivante",
      ],
      fresh_fat: [
        "Il a l’élan qu’il faut pour dégraisser et garder le palais vivant",
        "Il nettoie bien la bouche et rend la bouchée plus légère",
        "Sa fraîcheur rend le sip plus dynamique et invitant",
      ],
      spicy_soft: [
        "Il a une petite rondeur qui adoucit le piquant",
        "Sa douceur arrondit les angles de l’épice",
        "Il a juste ce qu’il faut de moelleux pour calmer la chaleur",
      ],
      spicy_fresh: [
        "Il accompagne l’épice sans la pousser davantage",
        "Il reste frais et linéaire sans amplifier la sensation de chaleur",
        "Il garde le piquant sous contrôle sans assécher la bouche",
      ],
      acid_hint: [
        "Il dialogue bien avec la fraîcheur du plat et rend l’ensemble plus harmonieux",
        "Il répond à l’acidité du plat et garde le sip bien droit",
        "Sur la partie acide, il reste net et en place",
      ],
      rich_body: [
        "Il a assez d’épaule pour ne pas se faire dominer par le plat",
        "Il reste présent même avec un plat important",
        "Il a la structure nécessaire pour tenir la bouchée",
      ],
      delicate_light: [
        "Il reste fin et précis sans couvrir les détails du plat",
        "Il accompagne avec légèreté et mesure",
        "Son profil plus délicat laisse le plat au centre",
      ],
    },
  },

  es: {
    and: "y",
    noteLead: "te lleva a",
    intros: [
      "Yo lo elegiría porque",
      "Este maridaje funciona porque",
      "Aquí encaja muy bien",
      "Si quieres ir sobre seguro",
      "Para mí está muy bien centrado porque",
      "Desde un punto de vista de sumiller",
    ],
    closers: [
      "Muy gastronómico",
      "Gran facilidad de trago",
      "Equilibrio y limpieza",
      "Trago preciso, final limpio",
    ],
    lines: {
      red_meat: [
        "Acompaña muy bien la jugosidad y la cocción larga sin perder ritmo",
        "Le planta cara al plato y lo acompaña hasta el final",
        "Da estructura al conjunto: sostiene la carne y limpia el final",
      ],
      white_meat: [
        "Acompaña la carne blanca con equilibrio sin tapar los sabores",
        "Sostiene el plato manteniéndose elegante",
        "Funciona porque deja el bocado limpio y fluido",
      ],
      fish: [
        "Es preciso con el pescado y respeta su delicadeza",
        "Con platos crudos funciona porque se mantiene limpio y refresca la boca",
        "Acompaña sin imponerse sobre la parte más fina del plato",
      ],
      cured_meat: [
        "Con los embutidos limpia la boca y prepara bien el siguiente bocado",
        "Aligera la grasa y se bebe con facilidad",
        "Funciona como un reset entre bocados",
      ],
      cheese: [
        "Con el queso aguanta bien la sapidez y la textura sin hacerse pesado",
        "Acompaña la cremosidad y termina limpio",
        "Sostiene bien el sabor del queso y mantiene el equilibrio",
      ],
      veg: [
        "Se mantiene ágil y gastronómico: acompaña sin invadir",
        "Es un maridaje limpio y preciso",
        "Da impulso sin tapar los detalles del plato",
      ],
      bubbles_fat: [
        "La burbuja limpia el paladar y hace cada bocado más ligero",
        "Con fritos es perfecto: burbuja y frescura ponen todo en orden",
        "La burbuja corta la grasa y prepara enseguida el siguiente bocado",
      ],
      fresh_fat: [
        "Tiene la frescura necesaria para cortar la grasa y mantener vivo el paladar",
        "Limpia bien la boca y hace el bocado más ligero",
        "Su frescura mantiene el trago dinámico e invitante",
      ],
      spicy_soft: [
        "Tiene un punto de suavidad que amortigua el picante",
        "La suavidad redondea los bordes de la especia",
        "Tiene justo la dulzura necesaria para calmar el picante",
      ],
      spicy_fresh: [
        "Acompaña el picante sin intensificarlo",
        "Se mantiene fresco y lineal sin amplificar la sensación de calor",
        "Mantiene el picante bajo control sin secar el paladar",
      ],
      acid_hint: [
        "Se engancha muy bien con la parte más fresca del plato y lo vuelve más armónico",
        "Dialoga con la acidez del plato y mantiene el trago recto",
        "Con la parte ácida se mantiene limpio y ordenado",
      ],
      rich_body: [
        "Tiene suficiente estructura para no quedar tapado",
        "Se mantiene presente incluso con un plato importante",
        "Tiene el cuerpo necesario para sostener el bocado",
      ],
      delicate_light: [
        "Se mantiene fino y preciso sin cubrir los matices del plato",
        "Acompaña con ligereza y medida",
        "Su perfil más delicado deja al plato en el centro",
      ],
    },
  },

  de: {
    and: "und",
    noteLead: "es bringt",
    intros: [
      "Ich würde ihn wählen, weil",
      "Diese Kombination funktioniert, weil",
      "Hier passt er sehr gut",
      "Wenn du auf Nummer sicher gehen willst",
      "Für mich ist das sehr stimmig, weil",
      "Aus Sicht des Sommeliers",
    ],
    closers: [
      "Sehr gastronomisch",
      "Hohe Trinkigkeit",
      "Balance und Klarheit",
      "Präziser Schluck, sauberes Finale",
    ],
    lines: {
      red_meat: [
        "Er hält mit Saftigkeit und langer Garzeit mit, ohne an Spannung zu verlieren",
        "Er trägt das Gericht Bissen für Bissen bis ins Finale",
        "Er gibt dem Gericht Struktur: unterstützt das Fleisch und räumt den Nachhall auf",
      ],
      white_meat: [
        "Er begleitet helles Fleisch ausgewogen, ohne die Aromen zu überdecken",
        "Er stützt das Gericht und bleibt dabei elegant",
        "Er funktioniert gut, weil er den Bissen sauber und fließend hält",
      ],
      fish: [
        "Er ist beim Fisch sehr präzise und respektiert seine Feinheit",
        "Bei rohen Gerichten bleibt er sauber und hält den Mund frisch",
        "Er begleitet, ohne die zarten Details des Gerichts zu überdecken",
      ],
      cured_meat: [
        "Zu Wurstwaren reinigt er den Gaumen und macht Lust auf den nächsten Bissen",
        "Er nimmt der Fettigkeit die Schwere und bleibt sehr trinkig",
        "Er wirkt wie ein Reset zwischen den Bissen",
      ],
      cheese: [
        "Mit Käse trägt er Salz und Reife gut, ohne schwer zu werden",
        "Er begleitet die Cremigkeit und endet sauber",
        "Er stützt den Geschmack des Käses und bleibt ausgewogen",
      ],
      veg: [
        "Er bleibt agil und gastronomisch: begleitet, ohne sich aufzudrängen",
        "Das ist eine saubere und präzise Kombination",
        "Er bringt Zug hinein, ohne die Details des Gerichts zu verdecken",
      ],
      bubbles_fat: [
        "Die Perlage reinigt den Gaumen und macht jeden Bissen leichter",
        "Zu Frittiertem ist das sehr treffend: Perlage und Frische setzen alles zurück",
        "Die Perlage nimmt Fett weg und bereitet direkt auf den nächsten Bissen vor",
      ],
      fresh_fat: [
        "Er hat genau den richtigen Zug, um Fettigkeit zu schneiden und den Gaumen wach zu halten",
        "Er reinigt den Mund gut und macht den Bissen leichter",
        "Seine Frische hält den Schluck lebendig und einladend",
      ],
      spicy_soft: [
        "Er hat einen Hauch von Weichheit, der die Schärfe abfedert",
        "Die weiche Seite rundet die scharfen Kanten ab",
        "Er bringt gerade genug Sanftheit mit, um die Schärfe angenehmer zu machen",
      ],
      spicy_fresh: [
        "Er treibt die Schärfe nicht weiter nach oben",
        "Er bleibt frisch und geradlinig, ohne die Würze zu verstärken",
        "Er hält die Schärfe unter Kontrolle, ohne den Gaumen auszutrocknen",
      ],
      acid_hint: [
        "Er verbindet sich schön mit der frischeren Seite des Gerichts und macht das Ganze harmonischer",
        "Er greift die Säure des Gerichts auf und hält den Schluck fokussiert",
        "Mit der säurebetonten Seite bleibt er sauber und gefasst",
      ],
      rich_body: [
        "Er hat genug Schulter, um nicht vom Gericht überdeckt zu werden",
        "Er bleibt auch bei einem kräftigen Gericht präsent",
        "Er hat genug Struktur, um den Bissen zu tragen",
      ],
      delicate_light: [
        "Er bleibt schlank und präzise, ohne die feinen Details des Gerichts zu verdecken",
        "Er begleitet leichtfüßig und mit Maß",
        "Sein feineres Profil lässt dem Gericht die Hauptrolle",
      ],
    },
  },

  zh: {
    and: "和",
    noteLead: "它会带出",
    intros: [
      "我会选它，因为",
      "这个搭配之所以成立，是因为",
      "放在这里它很合适，因为",
      "如果你想稳一点，这支很合适，因为",
      "以侍酒师的角度看，它很到位，因为",
    ],
    closers: [
      "很有餐桌感",
      "非常适合配餐",
      "平衡而干净",
      "入口精准，收尾利落",
    ],
    lines: {
      red_meat: [
        "它能跟上菜肴的浓郁感和长时间烹调的厚度",
        "它能稳稳托住肉感，并把尾段收得更干净",
        "面对强度较高的菜，它不会被压住",
      ],
      white_meat: [
        "它能平衡地衬托白肉，不会盖住菜本身的味道",
        "它能支撑菜肴，同时保持优雅和流畅",
        "它让口感更整洁，不会显得沉重",
      ],
      fish: [
        "它对鱼类菜肴很精准，不会破坏细腻感",
        "用于生食时，它会显得干净、利落，而且让口腔更清爽",
        "它能陪衬菜肴，而不会抢走细节",
      ],
      cured_meat: [
        "搭配冷切时，它能清口，也会让下一口更想继续吃",
        "它能减轻油脂感，同时保持顺口",
        "它像一次很自然的味觉重置",
      ],
      cheese: [
        "搭配奶酪时，它能接住咸香和质地，而不显厚重",
        "它能陪衬奶酪的绵密感，同时把收尾带干净",
        "它能托住奶酪风味，又保持整体平衡",
      ],
      veg: [
        "它灵活又有配餐感：能衬托味道，但不会压过菜本身",
        "这是一个干净、利落的搭配",
        "它能给菜增加张力，却不会盖住细节",
      ],
      bubbles_fat: [
        "气泡能清理口腔，让每一口都更轻盈",
        "配油炸时很准确：气泡和清新感能把口腔重新整理干净",
        "气泡能化解油脂，并立刻为下一口做好准备",
      ],
      fresh_fat: [
        "它有足够的清爽度来化解油脂，让口腔保持活力",
        "它能把口腔清理干净，让食物显得更轻",
        "它的清新感会让下一口更有吸引力",
      ],
      spicy_soft: [
        "它带一点柔和感，能缓冲辣度",
        "它的柔顺能把辛辣的棱角磨圆",
        "它有恰到好处的柔和度，让辣感更舒服",
      ],
      spicy_fresh: [
        "它不会把辣度继续往上推",
        "它保持清爽和线条感，不会放大辛辣感",
        "它能控制辣感，同时不让口腔变干",
      ],
      acid_hint: [
        "它能很好地接住菜里更清新的酸感，让整体更和谐",
        "它能呼应菜肴中的酸度，让酒感更集中",
        "面对酸度时，它依旧干净而稳定",
      ],
      rich_body: [
        "它有足够的骨架，不会被重口味菜压住",
        "即使面对强烈的菜式，它依然有存在感",
        "它有足够的结构去撑住这一口",
      ],
      delicate_light: [
        "它轻盈而精准，不会盖住菜肴细微的层次",
        "它陪衬得很克制，也很干净",
        "它更细致的轮廓能让菜始终站在中心",
      ],
    },
  },

  ko: {
    and: "그리고",
    noteLead: "이 와인은",
    intros: [
      "제가 이걸 고르겠는 이유는",
      "이 페어링이 잘 맞는 이유는",
      "여기서는 이 와인이 잘 맞는데, 그 이유는",
      "무난하게 가고 싶다면 이 선택이 좋은데, 이유는",
      "소믈리에 관점에서 보면 꽤 정확한 선택인데, 이유는",
    ],
    closers: [
      "식탁에서 정말 잘 맞아요",
      "매우 푸드 프렌들리합니다",
      "균형감이 좋고 깔끔합니다",
      "한 모금이 정확하고 마무리가 깨끗합니다",
    ],
    lines: {
      red_meat: [
        "진한 풍미와 오래 끓인 결을 충분히 받쳐 줍니다",
        "고기의 힘을 잘 받아 주면서 피니시를 깔끔하게 정리합니다",
        "강한 요리와 만나도 밀리지 않습니다",
      ],
      white_meat: [
        "흰 육류의 섬세함을 가리지 않으면서 균형 있게 받쳐 줍니다",
        "요리를 지탱하면서도 우아함을 유지합니다",
        "입안을 무겁게 만들지 않고 흐름을 좋게 가져갑니다",
      ],
      fish: [
        "생선 요리에 매우 정확하게 맞고 섬세함을 해치지 않습니다",
        "생선회나 크루도류와도 깔끔하고 상쾌하게 이어집니다",
        "요리의 디테일을 덮지 않고 자연스럽게 따라갑니다",
      ],
      cured_meat: [
        "샤퀴테리와 함께하면 입안을 정리해 주고 다음 한입을 더 당기게 합니다",
        "기름진 느낌을 가볍게 만들면서도 마시기 편합니다",
        "한입 한입 사이를 정리해 주는 역할을 합니다",
      ],
      cheese: [
        "치즈의 짭짤함과 질감을 잘 받아 주면서도 무거워지지 않습니다",
        "크리미한 질감을 받쳐 주고 마무리는 깔끔합니다",
        "치즈 풍미를 살리면서도 전체 균형을 유지합니다",
      ],
      veg: [
        "가볍고 음식 친화적이라 요리를 받쳐 주되 앞서 나가지 않습니다",
        "깨끗하고 정확한 페어링입니다",
        "디테일을 덮지 않으면서 흐름을 살려 줍니다",
      ],
      bubbles_fat: [
        "버블이 입안을 정리해 주고 한입을 더 가볍게 느끼게 합니다",
        "튀김과 특히 잘 맞는데, 버블과 산뜻함이 입안을 리셋해 줍니다",
        "버블이 기름기를 덜어 내고 다음 한입을 준비시켜 줍니다",
      ],
      fresh_fat: [
        "기름진 느낌을 끊어 주고 입안을 살아 있게 만드는 산뜻함이 있습니다",
        "입안을 잘 정리해 주고 한입을 더 가볍게 만듭니다",
        "신선한 느낌이 다음 모금을 더 끌리게 합니다",
      ],
      spicy_soft: [
        "약간의 부드러움이 매운맛을 완충해 줍니다",
        "부드러운 결이 매운 느낌의 모서리를 둥글게 만듭니다",
        "매운맛을 편안하게 받아 주는 여유가 있습니다",
      ],
      spicy_fresh: [
        "매운맛을 더 끌어올리지 않습니다",
        "신선하고 직선적인 느낌을 유지하면서 자극을 과하게 키우지 않습니다",
        "매운맛을 조절하면서도 입안을 마르게 만들지 않습니다",
      ],
      acid_hint: [
        "요리의 산미와 잘 연결되어 전체를 더 조화롭게 만듭니다",
        "산도를 받아 주면서 한 모금의 중심을 잡아 줍니다",
        "산미가 있는 요소와 만나도 깔끔하고 안정적입니다",
      ],
      rich_body: [
        "강한 요리에 눌리지 않을 만큼 충분한 구조감이 있습니다",
        "힘 있는 요리와 만나도 존재감이 유지됩니다",
        "한입을 받쳐 줄 만한 골격이 있습니다",
      ],
      delicate_light: [
        "가볍고 정밀해서 요리의 섬세한 결을 가리지 않습니다",
        "절제된 방식으로 따라가면서도 깔끔합니다",
        "더 섬세한 프로필이라 요리가 중심에 남습니다",
      ],
    },
  },

  ru: {
    and: "и",
    noteLead: "он раскрывает",
    intros: [
      "Я бы выбрал его, потому что",
      "Это сочетание работает, потому что",
      "Здесь он очень уместен, потому что",
      "Если хочется пойти по надёжному пути, то это хороший выбор, потому что",
      "С точки зрения сомелье это очень точное попадание, потому что",
    ],
    closers: [
      "Очень гастрономично",
      "Пьётся очень легко",
      "Баланс и чистота",
      "Точный глоток, чистый финал",
    ],
    lines: {
      red_meat: [
        "Он уверенно держит насыщенность блюда и длительное приготовление",
        "Он поддерживает мясо и делает финал чище",
        "Даже с ярким блюдом он не теряется",
      ],
      white_meat: [
        "Он сопровождает белое мясо сбалансированно и не перекрывает вкус блюда",
        "Он поддерживает блюдо, оставаясь при этом элегантным",
        "Он делает глоток более чистым и плавным",
      ],
      fish: [
        "С рыбой он очень точен и уважает её деликатность",
        "С сырыми блюдами он работает чисто и освежает рот",
        "Он сопровождает блюдо, не забирая на себя его тонкие детали",
      ],
      cured_meat: [
        "С мясными деликатесами он очищает рот и делает следующий кусок ещё желаннее",
        "Он облегчает жирность и остаётся очень питким",
        "Он работает как естественный reset между кусками",
      ],
      cheese: [
        "С сыром он хорошо выдерживает солоноватость и текстуру, не становясь тяжёлым",
        "Он поддерживает сливочность и заканчивается чисто",
        "Он держит вкус сыра и при этом остаётся в балансе",
      ],
      veg: [
        "Он остаётся лёгким и гастрономичным: сопровождает, но не доминирует",
        "Это чистое и точное сочетание",
        "Он добавляет динамику, не перекрывая детали блюда",
      ],
      bubbles_fat: [
        "Пузырьки очищают нёбо и делают каждый кусок легче",
        "С жареным это особенно точно: пузырьки и свежесть словно обнуляют рот",
        "Пузырьки снимают жирность и сразу готовят к следующему кусочку",
      ],
      fresh_fat: [
        "У него как раз та свежесть, которая убирает жирность и держит нёбо живым",
        "Он хорошо очищает рот и делает укус легче",
        "Его свежесть делает следующий глоток ещё более привлекательным",
      ],
      spicy_soft: [
        "В нём есть мягкость, которая смягчает остроту",
        "Его округлость сглаживает острые края специи",
        "В нём достаточно мягкости, чтобы сделать остроту комфортнее",
      ],
      spicy_fresh: [
        "Он не усиливает жар блюда",
        "Он остаётся свежим и прямым, не разгоняя остроту",
        "Он держит остроту под контролем и не сушит рот",
      ],
      acid_hint: [
        "Он хорошо связывается с более свежей и кислой частью блюда и делает сочетание гармоничнее",
        "Он отвечает на кислотность блюда и держит глоток собранным",
        "С кислотной частью блюда он остаётся чистым и устойчивым",
      ],
      rich_body: [
        "У него достаточно плеча, чтобы не потеряться рядом с мощным блюдом",
        "Он остаётся заметным даже с насыщенным блюдом",
        "У него хватает структуры, чтобы выдержать укус",
      ],
      delicate_light: [
        "Он остаётся тонким и точным, не перекрывая деликатные детали блюда",
        "Он сопровождает легко и с мерой",
        "Его более тонкий профиль оставляет блюдо в центре внимания",
      ],
    },
  },
};

function getSommelierLocale(lang: LangCode): SommelierLocale {
  return SOMM_TEXT[lang] || SOMM_TEXT.it;
}

function lowerFirst(s: string) {
  s = (s || "").trim();
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function pickUnique(arr: string[], n: number, rand: () => number) {
  const clean = (arr || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const filtered = clean.filter((s) => {
    const wc = wordCount(s);
    return wc >= 1 && wc <= 6;
  });

  const pool = (filtered.length ? filtered : clean).slice(0, 40);
  const out: string[] = [];
  const used = new Set<string>();

  for (let i = 0; i < 80 && out.length < n && pool.length; i++) {
    const idx = Math.floor(rand() * pool.length);
    const v = pool[idx];
    pool.splice(idx, 1);
    const k = norm(v);
    if (!k || used.has(k)) continue;
    used.add(k);
    out.push(v);
  }
  return out;
}

function joinNice(list: string[], lang: LangCode = "it") {
  if (!list.length) return "";

  if (lang === "zh") {
    if (list.length === 1) return list[0];
    if (list.length === 2) return `${list[0]}${SOMM_TEXT.zh.and}${list[1]}`;
    return `${list.slice(0, -1).join("、")}${SOMM_TEXT.zh.and}${list[list.length - 1]}`;
  }

  const andWord = getSommelierLocale(lang).and || "e";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${andWord} ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} ${andWord} ${list[list.length - 1]}`;
}

function pickOne(arr: string[], rand: () => number) {
  if (!arr || arr.length === 0) return "";
  return arr[Math.floor(rand() * arr.length)];
}

function sentenceEnd(lang: LangCode) {
  return lang === "zh" ? "。" : ".";
}

function sentenceJoin(lang: LangCode) {
  return lang === "zh" ? "" : " ";
}

function stripEndPunct(s: string) {
  return (s || "").trim().replace(/[.!?。！？؛;]+$/u, "").trim();
}

function finalizeSentence(s: string, lang: LangCode) {
  const clean = stripEndPunct(s);
  if (!clean) return "";
  return clean + sentenceEnd(lang);
}

function joinSentences(parts: string[], lang: LangCode) {
  const clean = parts.map(stripEndPunct).filter(Boolean);
  if (!clean.length) return "";
  return clean.map((p) => finalizeSentence(p, lang)).join(sentenceJoin(lang));
}

function trimConnectorEnd(final: string, lang: LangCode) {
  let out = final.trim().replace(/[;；]\s*$/u, "").trim();

  switch (lang) {
    case "it":
      out = out.replace(/\b(e|ed)\s*$/iu, "").trim();
      break;
    case "en":
      out = out.replace(/\b(and)\s*$/iu, "").trim();
      break;
    case "fr":
      out = out.replace(/\b(et)\s*$/iu, "").trim();
      break;
    case "es":
      out = out.replace(/\b(y|e)\s*$/iu, "").trim();
      break;
    case "de":
      out = out.replace(/\b(und)\s*$/iu, "").trim();
      break;
    case "ru":
      out = out.replace(/\b(и)\s*$/iu, "").trim();
      break;
    default:
      break;
  }

  return out.trim();
}

function shouldUseRawNotesInMotivation(lang: LangCode) {
  return lang === "it";
}

function buildPairingCore(
  profile: Profile,
  dish: Dish,
  rand: () => number,
  lang: LangCode,
) {
  const S = getSommelierLocale(lang);
  const lines: string[] = [];

  const isRich = dish.fat >= 0.6 || dish.intensity >= 0.7 || dish.cooking === "brasato";
  const isDelicate = dish.intensity <= 0.45 && dish.fat <= 0.4;
  const isSpicy = dish.spice >= 0.45;

  const hasBubbles = profile.bubbles >= 0.9;
  const feelsFresh = profile.acid >= 0.6 || hasBubbles;
  const hasShoulder = profile.body >= 0.6;
  const isSoft = profile.sweet >= 0.12;

  if (dish.protein === "carne_rossa" || dish.cooking === "brasato") {
    lines.push(pickOne(S.lines.red_meat, rand));
  } else if (dish.protein === "carne_bianca") {
    lines.push(pickOne(S.lines.white_meat, rand));
  } else if (dish.protein === "pesce" || dish.cooking === "crudo") {
    lines.push(pickOne(S.lines.fish, rand));
  } else if (dish.protein === "salumi") {
    lines.push(pickOne(S.lines.cured_meat, rand));
  } else if (dish.protein === "formaggio") {
    lines.push(pickOne(S.lines.cheese, rand));
  } else {
    lines.push(pickOne(S.lines.veg, rand));
  }

  if (dish.cooking === "fritto" || dish.fat >= 0.6) {
    if (hasBubbles) {
      lines.push(pickOne(S.lines.bubbles_fat, rand));
    } else if (feelsFresh) {
      lines.push(pickOne(S.lines.fresh_fat, rand));
    }
  }

  if (isSpicy && rand() < 0.9) {
    if (isSoft) {
      lines.push(pickOne(S.lines.spicy_soft, rand));
    } else {
      lines.push(pickOne(S.lines.spicy_fresh, rand));
    }
  }

  if (dish.acid_hint && rand() < 0.75) {
    lines.push(pickOne(S.lines.acid_hint, rand));
  }

  if (isRich && hasShoulder) {
    lines.push(pickOne(S.lines.rich_body, rand));
  }

  if (isDelicate && !hasShoulder && rand() < 0.85) {
    lines.push(pickOne(S.lines.delicate_light, rand));
  }

  const pool = Array.from(new Set(lines.filter(Boolean)));
  const chosen: string[] = [];
  while (chosen.length < 2 && pool.length) {
    const idx = Math.floor(rand() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }

  return joinSentences(chosen, lang);
}

function buildMotivation(
  profile: Profile,
  dish: Dish,
  ctx: WineTextContext,
  rand: () => number,
  lang: LangCode,
): string {
  const S = getSommelierLocale(lang);
  const core = lowerFirst(buildPairingCore(profile, dish, rand, lang));
  const useRawNotes = shouldUseRawNotesInMotivation(lang);

  const rawNotes = useRawNotes
    ? pickUnique(
      [...(ctx.tastingNotes || []), ...(ctx.typicalNotes || [])],
      4,
      rand,
    ).map((s) => trimToWords(s, 4))
    : [];

  const notes: string[] = [];
  const seen = new Set<string>();
  for (const n of rawNotes) {
    const k = norm(n).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    notes.push(n);
    if (notes.length >= 2) break;
  }

  const hasNotes = notes.length > 0;

  const intro = pickOne(S.intros, rand) || SOMM_TEXT.it.intros[0];
  const spacer = lang === "zh" ? "" : " ";
  const notePart = hasNotes
    ? (lang === "zh"
      ? `${S.noteLead}${joinNice(notes, lang)}`
      : `${S.noteLead}${spacer}${joinNice(notes, lang)}`)
    : "";

  let text = "";
  if (hasNotes) {
    text = lang === "zh"
      ? `${intro}${notePart}；${core}`
      : `${intro}${spacer}${notePart};${spacer}${core}`;
  } else {
    text = `${intro}${spacer}${core}`;
  }

  text = text.replace(/\s+/g, " ").trim();

  let final = text;

  if (lang !== "zh" && wordCount(final) > 34) {
    const sents = final.split(/(?<=[.!?])\s+/).filter(Boolean);
    let acc = "";
    for (const s of sents) {
      const candidate = acc ? `${acc} ${s}` : s;
      if (wordCount(candidate) <= 34) acc = candidate;
      else break;
    }
    final = acc || trimToWords(sents[0] || final, 34);
  }

  final = trimConnectorEnd(final, lang);

  if (rand() < 0.28) {
    const c = pickOne(S.closers, rand);
    if (c) {
      if (lang === "zh") {
        final = `${stripEndPunct(final)}。${stripEndPunct(c)}。`;
      } else if (wordCount(final) <= 28) {
        final = `${stripEndPunct(final)}. ${stripEndPunct(c)}.`;
      }
    }
  }

  if (lang === "zh") {
    final = final.replace(/\.\s*/g, "。").replace(/!+/g, "！").replace(/\?+/g, "？");
    return finalizeSentence(final, lang);
  }

  return finalizeSentence(final, lang);
}

/** =========================
 *  ROTAZIONE & MMR
 *  ========================= */

function jaccard(a?: Set<string>, b?: Set<string>) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

function mmrScore(cand: EnrichedWine, chosen: EnrichedWine[], lambda = 0.65) {
  if (!chosen.length) return cand.__scoreCore ?? 0;
  const simProfile = Math.max(
    ...chosen.map((ch) => cosSim(toVec(cand.__profile), toVec(ch.__profile))),
  );
  const simUv = Math.max(
    ...chosen.map((ch) => jaccard(cand.__uvTokens, ch.__uvTokens)),
  );
  const simTags = Math.max(
    ...chosen.map((ch) => jaccard(cand.__tags, ch.__tags)),
  );
  const pen = Math.max(simProfile, simUv, simTags);
  return lambda * (cand.__scoreCore ?? 0) - (1 - lambda) * pen;
}

function mainGrapeOf(w: EnrichedWine): string {
  const arr = Array.from(w.__uvTokens || []);
  if (arr.length) return arr[0];
  const bag = `${w.sottocategoria || ""} ${w.categoria || ""} ${w.nome || ""}`
    .toLowerCase();
  const m = bag.match(
    /\b(barbera|nebbiolo|sangiovese|merlot|cabernet|syrah|pinot\s+nero|pinot\s+grigio|chardonnay|vermentino|greco|fiano|verdicchio|zibibbo|grillo|glera|sagrantino|aglianico|primitivo|nero d.?avola|corvina|trebbiano)\b/,
  );
  return m ? norm(m[0]) : "";
}

function computeWanted(rangeString: any, n: number): number {
  let min = 2;
  let max = 3;
  if (typeof rangeString === "string") {
    const m = rangeString.match(/(\d+)\s*-\s*(\d+)/);
    if (m) {
      min = parseInt(m[1]) || min;
      max = parseInt(m[2]) || max;
    } else {
      const single = parseInt(rangeString);
      if (!isNaN(single)) {
        min = single;
        max = single;
      }
    }
  }
  min = Math.max(1, min);
  max = Math.max(min, max);
  if (n <= 0) return 0;
  if (n <= min) return n;
  return Math.min(max, n);
}

/** =========================
 *  SERVE
 *  ========================= */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      vini,
      piatto,
      ristorante_id,
      prezzo_massimo,
      colori,
      lang,
    } = body;

    if (!Array.isArray(vini) || vini.length === 0) {
      return new Response(
        JSON.stringify({ error: "Nessun vino nel sistema." }),
        { status: 400, headers: corsHeaders },
      );
    }
    if (!piatto) {
      return new Response(
        JSON.stringify({ error: "Manca il nome del piatto." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const coloriNorm: Colore[] = Array.isArray(colori) && colori.length
      ? colori.map((c: string) => coloreFromLabel(String(c || "")))
      : [];
    const coloriSet = new Set(coloriNorm.filter((c) => c !== "altro"));

    const safeCode = getLangCode(lang);
    const L = LANGS[safeCode] || LANGS.it;

    const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Missing Supabase service role key." }),
        { status: 500, headers: corsHeaders },
      );
    }
    const headers = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    };

    const infoRes = await fetch(
      `${supabaseUrl}/rest/v1/ristoranti?id=eq.${ristorante_id}&select=sommelier_range,sommelier_boost_multi`,
      { headers },
    );
    const [info] = await infoRes.json();
    const rangeStr = info?.sommelier_range || "2-3";

    let boostRawList: string[] = [];
    try {
      boostRawList = JSON.parse(info?.sommelier_boost_multi || "[]");
    } catch {
      boostRawList = [];
    }
    const boostRawSet = new Set<string>(
      (boostRawList || []).map((x) => String(x)),
    );
    const boostNormSet = new Set<string>(
      (boostRawList || []).map((x) => norm(String(x))),
    );

    const priors = await loadPriors(headers);

    let recentLog: any[] = [];
    try {
      const recentRes = await fetch(
        `${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&order=creato_il.desc&limit=300`,
        { headers },
      );
      if (recentRes.ok) recentLog = await recentRes.json();
    } catch {
      recentLog = [];
    }

    const COOL_N = 80;
    const coolList: string[] = [];

    for (const r of recentLog) {
      const keys = extractLogWineKeys(r);
      for (const key of keys) {
        if (!coolList.includes(key)) coolList.push(key);
        if (coolList.length >= COOL_N) break;
      }
      if (coolList.length >= COOL_N) break;
    }

    const coolSet = new Set(coolList);

    const nowMs = Date.now();
    const HALF_LIFE_H = 48;
    const LAMBDA_DECAY = Math.log(2) / (HALF_LIFE_H * 3600 * 1000);
    const decay = (ts: string) => {
      const t = new Date(ts).getTime();
      const dt = Math.max(0, nowMs - (isNaN(t) ? nowMs : t));
      return Math.exp(-LAMBDA_DECAY * dt);
    };

        const expByWine: Record<string, number> = {};

    recentLog.forEach((r) => {
      const weight = decay(String(r.creato_il || ""));
      const keys = extractLogWineKeys(r);

      keys.forEach((key: string) => {
        expByWine[key] = (expByWine[key] || 0) + weight;
      });
    });

    const day = new Date().toISOString().slice(0, 10);
    const rng = mulberry32(
      hashStringToSeed(`${ristorante_id}|${norm(piatto)}|${day}`),
    );

    const dish = await getDishFeatures(piatto, Deno.env.get("OPENAI_API_KEY"));
    const piattoNorm = norm(piatto);

    const wines0: EnrichedWine[] = vini
      .filter((v: any) => v?.visibile !== false)
      .map((v: any) => {
        const prezzoNum = parseFloat(
          String(v.prezzo || "")
            .replace(/[^\d.,]/g, "")
            .replace(",", "."),
        ) || 0;

        const coloreCat = coloreFromLabel(String(v.categoria || ""));
        const nomeN = norm(v.nome);
        const producerRaw = String(v.nome || "").split("|")[0];
        const __producer = norm(producerRaw);
        const __uvTokens = new Set(
          splitGrapes(String(v.uvaggio || "")).map(norm),
        );

        const __historyKey = wineHistoryKey(v);
        const __legacyLogKey = `legacy:${nomeN}`;

        return {
          ...v,
          prezzoNum,
          colore: coloreCat,
          nomeN,
          __producer,
          __uvTokens,
          __historyKey,
          __legacyLogKey,
        } as EnrichedWine;
      })
      .filter((v) =>
        !prezzo_massimo || v.prezzoNum <= Number(prezzo_massimo)
      )
      .filter((v) => coloriSet.size ? coloriSet.has(v.colore) : true);

    if (!wines0.length) {
      return new Response(
        JSON.stringify({ error: "Nessun vino filtrato compatibile." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const enriched: EnrichedWine[] = wines0.map((w) => {
      const { profile, colore, ctx } = profileAndContextFromWine(
        w,
        priors,
        w.colore,
      );
      const __tags = buildTags(ctx, colore);
      return {
        ...w,
        colore,
        __profile: profile,
        __ctx: ctx,
        __tags,
      };
    });

    const wanted = computeWanted(rangeStr, enriched.length) || 1;

    const mVals = enriched.map((w) =>
      matchScore(w.__profile, dish, w.__ctx, piattoNorm)
    );
    const mMin = Math.min(...mVals);
    const mMax = Math.max(...mVals);
    const mRange = (mMax - mMin) || 1;
    const mNorm = (m: number) => (m - mMin) / mRange;

    const totalViews = Object.values(expByWine).reduce((a, b) => a + b, 0) || 1;
    const C = 0.30;

    const baseList: EnrichedWine[] = enriched.map((w, idx) => {
      const q = mNorm(mVals[idx]);

      const views =
        (expByWine[w.__historyKey] || 0) +
        (expByWine[w.__legacyLogKey] || 0);

      const explore = C *
        Math.sqrt(Math.log(totalViews + Math.E) / (views + 1));

      const blended = 0.82 * q + 0.18 * explore;

      const exposurePenalty = -0.1 *
        Math.pow((views / (totalViews || 1)), 0.7);

      const cooldownPenalty =
        (coolSet.has(w.__historyKey) || coolSet.has(w.__legacyLogKey))
          ? -0.25
          : 0;
      const jitter = (rng() - 0.5) * 0.02;

      const idKey = w.id ? String(w.id) : "";
      const isBoost =
        (idKey && boostRawSet.has(idKey)) || boostNormSet.has(w.nomeN);
      const boostBonus = isBoost ? 0.12 : 0;

      const scoreRaw =
        blended + exposurePenalty + cooldownPenalty + jitter + boostBonus;

      return {
        ...w,
        __q: q,
        __scoreCore: clamp01(scoreRaw),
        __isBoost: isBoost,
      };
    });

    const sorted = [...baseList].sort((a, b) =>
      (b.__scoreCore ?? 0) - (a.__scoreCore ?? 0)
    );

    const capByProd = 1;
    const capBySub = 1;
    const capByGrape = wanted <= 3 ? 1 : 2;

    const usedByProd = new Map<string, number>();
    const usedBySub = new Map<string, number>();
    const usedByGrape = new Map<string, number>();

    const chosen: EnrichedWine[] = [];

    const catastrophicMismatch = (w: EnrichedWine): boolean => {
      const p = w.__profile;
      if (
        (dish.protein === "pesce" || dish.cooking === "crudo") &&
        w.colore === "rosso" &&
        p.tannin >= 0.8 &&
        p.sweet <= 0.05
      ) return true;
      if (dish.sweet > 0.4 && p.sweet < 0.25) return true;
      if (dish.spice > 0.6 && p.tannin > 0.8 && p.sweet <= 0.05) return true;
      return false;
    };

    const canAddWine = (w: EnrichedWine): boolean => {
      const prod = w.__producer;
      const sub = norm(String(w.sottocategoria || ""));
      const grape = mainGrapeOf(w);
      if ((usedByProd.get(prod) || 0) >= capByProd) return false;
      if (sub && (usedBySub.get(sub) || 0) >= capBySub) return false;
      if (grape && (usedByGrape.get(grape) || 0) >= capByGrape) return false;
      return true;
    };

    const registerWine = (w: EnrichedWine) => {
      const prod = w.__producer;
      const sub = norm(String(w.sottocategoria || ""));
      const grape = mainGrapeOf(w);
      usedByProd.set(prod, (usedByProd.get(prod) || 0) + 1);
      if (sub) usedBySub.set(sub, (usedBySub.get(sub) || 0) + 1);
      if (grape) usedByGrape.set(grape, (usedByGrape.get(grape) || 0) + 1);
    };

    const boostCandidates = sorted.filter((w) => w.__isBoost);
    if (boostCandidates.length) {
      const goodBoost = boostCandidates.find((w) =>
        !catastrophicMismatch(w) && (w.__q ?? 0) >= 0.4
      ) || boostCandidates[0];
      if (goodBoost && canAddWine(goodBoost) && !catastrophicMismatch(goodBoost)) {
        chosen.push(goodBoost);
        registerWine(goodBoost);
      }
    }

        const neverSeen = sorted.filter((w) =>
      ((expByWine[w.__historyKey] || 0) + (expByWine[w.__legacyLogKey] || 0)) === 0 &&
      !catastrophicMismatch(w)
    );
    for (const w of neverSeen) {
      if (chosen.length >= Math.min(2, wanted)) break;
            if (chosen.some((c) => c.__historyKey === w.__historyKey)) continue;
      if (!canAddWine(w)) continue;
      chosen.push(w);
      registerWine(w);
    }

    const already = new Set(chosen.map((w) => w.__historyKey));
    const pool = sorted.filter((w) => !already.has(w.__historyKey));

    while (chosen.length < wanted && pool.length) {
      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        if (catastrophicMismatch(cand)) continue;
        if (!canAddWine(cand)) continue;
        const score = mmrScore(cand, chosen, 0.65);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const chosenOne = pool.splice(bestIdx, 1)[0];
      chosen.push(chosenOne);
      registerWine(chosenOne);
    }

    const finalChosen = chosen.slice(0, wanted);

    function styleOf(colore: Colore, p: Profile):
      | "sparkling"
      | "crisp_white"
      | "full_white"
      | "rosato"
      | "light_red"
      | "structured_red" {
      if (colore === "spumante" || p.bubbles >= 0.9) return "sparkling";
      if (colore === "rosato") return "rosato";
      if (colore === "bianco") {
        return (p.body > 0.55 || p.sweet > 0.15)
          ? "full_white"
          : "crisp_white";
      }
      return (p.tannin <= 0.5 && p.body <= 0.6)
        ? "light_red"
        : "structured_red";
    }

    const topByScore = [...finalChosen].sort((a, b) =>
      (b.__scoreCore ?? 0) - (a.__scoreCore ?? 0)
    ).slice(0, Math.min(2, finalChosen.length));
        const topSet = new Set(topByScore.map((w) => w.__historyKey));

    let discoveryWine: EnrichedWine | null = null;
    let worstAvgSim = Infinity;
    for (const cand of finalChosen) {
      if (topSet.has(cand.__historyKey)) continue;
      let avgSim = 0;
      let count = 0;
      for (const other of finalChosen) {
        if (other === cand) continue;
        const sim = cosSim(
          toVec(cand.__profile),
          toVec(other.__profile),
        );
        avgSim += sim;
        count++;
      }
      if (count > 0) avgSim /= count;
      if (avgSim < worstAvgSim) {
        worstAvgSim = avgSim;
        discoveryWine = cand;
      }
    }
    const discoverySet = new Set<string>(
      discoveryWine ? [discoveryWine.__historyKey] : [],
    );

    const out = finalChosen.map((w) => {
      const grape = (w.uvaggio && String(w.uvaggio).trim())
        ? String(w.uvaggio).trim()
        : "N.D.";
      const wineRng = mulberry32(
        hashStringToSeed(`${ristorante_id}|${norm(piatto)}|${day}|${w.nomeN}`),
      );

      const motive = buildMotivation(w.__profile, dish, w.__ctx, wineRng, safeCode);
      const __style = styleOf(w.colore, w.__profile);

      return {
        ...w,
        __style,
        grape,
        motive,
      };
    });

    console.log(
      "PICKED",
      {
        piatto,
        lang: safeCode,
        seed: `${ristorante_id}|${norm(piatto)}|${day}`,
        picks: out.map((x) => ({
          nome: x.nome,
          colore: x.colore,
          q: +Number(x.__q ?? 0).toFixed(3),
          base: +Number(x.__scoreCore ?? 0).toFixed(3),
          style: x.__style,
          grape: x.grape,
          motive: x.motive,
          prof: x.__profile,
        })),
      },
    );

    try {
      await fetch(`${supabaseUrl}/rest/v1/consigliati_log`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          ristorante_id,
          piatto,
          vini: out.map((w) => w.nome),
          vini_ids: out.map((w) => w.id).filter(Boolean),
          vini_keys: out.map((w) => w.__historyKey).filter(Boolean),
          boost_inclusi: out.some((w) => w.__isBoost),
          sottocategoria: out[0]?.sottocategoria || null,
        }),
      });
    } catch {
      // non bloccare la risposta se il log fallisce
    }

    const rows = out.map((w) => {
      const isBoost = !!w.__isBoost;
      const parts = [
        isBoost ? ICONS.boosted : "",
        topSet.has(w.__historyKey) ? ICONS.top : "",
        discoverySet.has(w.__historyKey) ? ICONS.discovery : "",
        ICONS.style[w.__style as keyof typeof ICONS.style] || "",
      ].filter(Boolean);
      const prefix = parts.join(" ");
      return `- ${prefix} ${w.nome}
  ${L.GRAPE}: ${w.grape}
  ${L.MOTIVE}: ${w.motive}`;
    });

    return new Response(
      JSON.stringify({ suggestion: rows.join("\n\n") }),
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("❌ Errore consiglia-vino:", err);
    return new Response(
      JSON.stringify({ error: "Errore interno", detail: err?.message }),
      { status: 500, headers: corsHeaders },
    );
  }
});