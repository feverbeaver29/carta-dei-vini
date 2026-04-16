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
  succulence: number;
  sapidity: number;
  aromaticity: number;
  persistence: number;
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

type WineScheda = {
  hook: string;
  notes: string[];
  palate: string;
  pairings: string[];
};

type ReasonCode =
  | "cuts_fat"
  | "bubbles_cleanse"
  | "handles_succulence"
  | "matches_intensity"
  | "fresh_on_acid"
  | "softens_spice"
  | "does_not_overwhelm"
  | "supports_fish"
  | "supports_cheese"
  | "supports_cured_meat"
  | "supports_red_meat"
  | "supports_white_meat"
  | "supports_veg";

type PairingReason = {
  code: ReasonCode;
  strength: number;
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

  descNotes: string[];
  descPairings: string[];
  descHook: string[];
  descPalate: string[];
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
  __reasons?: PairingReason[];
  __q?: number;
  __scoreCore?: number;
  __isBoost?: boolean;
  __style?: string;
};

type DishBaseRow = {
  slug: string;
  canonical_name: string;
  display_name: string;
  base_family: string;
  protein: Dish["protein"];
  cooking: Dish["cooking"];
  fat: number;
  spice: number;
  sweet: number;
  intensity: number;
  succulence: number;
  sapidity: number;
  aromaticity: number;
  persistence: number;
  acid_hint: boolean;
  accent_tags: string[];
};

type DishAliasRow = {
  alias_text: string;
  alias_norm: string;
  dish_base_slug: string;
  confidence: number;
  alias_type: string;
};

type DishModifierRow = {
  modifier_text: string;
  modifier_norm: string;
  modifier_type: string;
  set_cooking: Dish["cooking"] | null;
  set_protein: Dish["protein"] | null;
  delta_fat: number;
  delta_spice: number;
  delta_sweet: number;
  delta_intensity: number;
  delta_succulence: number;
  delta_sapidity: number;
  delta_aromaticity: number;
  delta_persistence: number;
  set_acid_hint: boolean | null;
  accent_tags: string[];
  applies_to_proteins: string[];
  applies_to_cookings: string[];
  applies_to_base_families: string[];
  priority: number;
};

type DishKnowledge = {
  basesBySlug: Map<string, DishBaseRow>;
  aliases: DishAliasRow[];
  modifiers: DishModifierRow[];
};

type DishResolution = {
  dish: Dish;
  source: "knowledge" | "fallback";
  matched_base_slug: string | null;
  matched_base_name: string | null;
  matched_alias: string | null;
  matched_modifiers: string[];
  accent_tags: string[];
  base_family: string | null;
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

function normalizeFingerprintPart(raw: any): string {
  return cleanText(raw)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDescrizioneFingerprint(w: any, ristoranteId: string): string {
  return [
    normalizeFingerprintPart(w?.nome),
    normalizeVintage(w?.annata),
    normalizeFingerprintPart(w?.uvaggio),
    normalizeFingerprintPart(w?.categoria),
    normalizeFingerprintPart(w?.sottocategoria),
    cleanText(ristoranteId),
  ].join("|");
}

function emptyWineScheda(): WineScheda {
  return {
    hook: "",
    notes: [],
    palate: "",
    pairings: [],
  };
}

function parseWineScheda(raw: any): WineScheda {
  if (!raw) return emptyWineScheda();

  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return emptyWineScheda();
    }
  }

  return {
    hook: cleanText(obj?.hook),
    notes: Array.isArray(obj?.notes)
      ? obj.notes.map((x: any) => cleanText(x)).filter(Boolean)
      : [],
    palate: cleanText(obj?.palate),
    pairings: Array.isArray(obj?.pairings)
      ? obj.pairings.map((x: any) => cleanText(x)).filter(Boolean)
      : [],
  };
}

function pickSchedaRawForLang(row: any, lang: LangCode): any {
  const localized = row?.[`scheda_${lang}`];
  return localized || row?.scheda_it || row?.scheda || null;
}

function parsePersistedProfile(raw: any): any | null {
  if (!raw) return null;

  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!obj?.core) return null;
  return obj;
}

function hasUsefulScheda(s: WineScheda): boolean {
  return !!(s.hook || s.palate || s.notes.length || s.pairings.length);
}

function mergeSchedaIntoContext(
  ctx: WineTextContext,
  scheda?: WineScheda | null,
): WineTextContext {
  if (!scheda) return ctx;

  return {
    ...ctx,
    descNotes: [...ctx.descNotes, ...scheda.notes],
    descPairings: [...ctx.descPairings, ...scheda.pairings],
    descHook: [...ctx.descHook, ...(scheda.hook ? [scheda.hook] : [])],
    descPalate: [...ctx.descPalate, ...(scheda.palate ? [scheda.palate] : [])],
  };
}

async function loadDescrizioniByFingerprint(
  headers: Record<string, string>,
  ristoranteId: string,
  wines: any[],
  lang: LangCode,
): Promise<Map<string, any>> {
  const wanted = new Set(
    (wines || [])
      .map((w) => buildDescrizioneFingerprint(w, ristoranteId))
      .filter(Boolean),
  );

  if (!wanted.size) return new Map();

  const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
  const selectCols = [
    "fingerprint",
    "wine_id",
    "catalog_wine_id",
    "sommelier_profile",
    "scheda",
    "scheda_it",
    "scheda_en",
    "scheda_de",
    "scheda_fr",
    "scheda_es",
    "scheda_zh",
    "scheda_ko",
    "scheda_ru",
  ].join(",");

  const res = await fetch(
    `${supabaseUrl}/rest/v1/descrizioni_vini?ristorante_id=eq.${ristoranteId}&select=${selectCols}&limit=1000`,
    { headers },
  );

  if (!res.ok) return new Map();

  const rows = await res.json();
  const map = new Map<string, any>();

  for (const row of rows || []) {
    const fp = cleanText(row?.fingerprint);
    if (!fp || !wanted.has(fp)) continue;
    map.set(fp, row);
  }

  return map;
}

function getMotivationNotesPool(ctx: WineTextContext, lang: LangCode): string[] {
  if (lang === "it") {
    return [
      ...(ctx.descNotes || []),
      ...(ctx.tastingNotes || []),
      ...(ctx.typicalNotes || []),
    ];
  }

  return [...(ctx.descNotes || [])];
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
    succulence: 0.3,
    sapidity: 0.25,
    aromaticity: 0.35,
    persistence: 0.35,
    protein: null,
    cooking: null,
    acid_hint: false,
  };

  // cotture
  if (/crudo|tartare|carpaccio|ceviche/.test(s)) {
    dish.cooking = "crudo";
    dish.intensity = 0.3;
    dish.succulence = Math.max(dish.succulence, 0.35);
    dish.persistence = Math.max(dish.persistence, 0.25);
  }

  if (/fritt|impanat/.test(s)) {
    dish.cooking = "fritto";
    dish.fat = Math.max(dish.fat, 0.7);
    dish.intensity = Math.max(dish.intensity, 0.5);
    dish.sapidity = Math.max(dish.sapidity, 0.35);
    dish.persistence = Math.max(dish.persistence, 0.45);
  }

  if (/griglia|brace|arrosto/.test(s)) {
    dish.cooking = "griglia";
    dish.intensity = Math.max(dish.intensity, 0.6);
    dish.aromaticity = Math.max(dish.aromaticity, 0.45);
    dish.persistence = Math.max(dish.persistence, 0.5);
  }

  if (/brasat|stracotto|stufato|spezzatino|ragu|ragù|peposo/.test(s)) {
    dish.cooking = "brasato";
    dish.intensity = Math.max(dish.intensity, 0.8);
    dish.fat = Math.max(dish.fat, 0.55);
    dish.succulence = Math.max(dish.succulence, 0.7);
    dish.persistence = Math.max(dish.persistence, 0.75);
    dish.aromaticity = Math.max(dish.aromaticity, 0.55);
  }

  if (/bollit/.test(s)) {
    dish.cooking = "bollito";
    dish.intensity = Math.max(dish.intensity, 0.45);
    dish.succulence = Math.max(dish.succulence, 0.4);
  }

  if (/forno|al forno|in crosta/.test(s)) {
    dish.intensity = Math.max(dish.intensity, 0.55);
    dish.persistence = Math.max(dish.persistence, 0.5);
    dish.aromaticity = Math.max(dish.aromaticity, 0.42);
  }

  // acidità / freschezza del piatto
  if (/limone|agrodolce|aceto|capperi|citric|yuzu|pomodoro|arancia|agrum/.test(s)) {
    dish.acid_hint = true;
  }

  // piccante / speziato
  if (/piccant|’nduja|nduja|peperoncino|curry|harissa/.test(s)) {
    dish.spice = Math.max(dish.spice, 0.6);
    dish.aromaticity = Math.max(dish.aromaticity, 0.55);
  }

  // tendenza dolce
  if (
    /dolce|dessert|tiramisu|cheesecake|torta|pasticc|gelato|sorbetto/.test(s)
  ) {
    dish.sweet = Math.max(dish.sweet, 0.8);
    dish.intensity = Math.max(dish.intensity, 0.6);
    dish.persistence = Math.max(dish.persistence, 0.55);
  }

  // proteine
  if (
    /pesce|tonno|salmone|gamber|calamari|cozze|vongole|polpo|scampi|branzino|orata|spigola|baccala|baccalà/.test(s)
  ) {
    dish.protein = "pesce";
    dish.succulence = Math.max(dish.succulence, 0.35);
    dish.sapidity = Math.max(dish.sapidity, 0.3);
  } else if (
    /manzo|bovino|fiorentina|tagliata|agnello|cervo|capriolo|cacciagione|guancia|cinghiale|peposo/.test(s)
  ) {
    dish.protein = "carne_rossa";
    dish.intensity = Math.max(dish.intensity, 0.8);
    dish.succulence = Math.max(dish.succulence, 0.7);
    dish.persistence = Math.max(dish.persistence, 0.7);
  } else if (
    /anatra|oca/.test(s)
  ) {
    dish.protein = "carne_bianca";
    dish.fat = Math.max(dish.fat, 0.65);
    dish.intensity = Math.max(dish.intensity, 0.75);
    dish.succulence = Math.max(dish.succulence, 0.65);
    dish.persistence = Math.max(dish.persistence, 0.65);
    dish.aromaticity = Math.max(dish.aromaticity, 0.5);
  } else if (
    /maiale|porchetta|salsiccia|pollo|tacchino|coniglio/.test(s)
  ) {
    dish.protein = "carne_bianca";
    dish.intensity = Math.max(dish.intensity, 0.55);
    dish.succulence = Math.max(dish.succulence, 0.45);
  } else if (
    /salume|prosciutto|speck|salami|mortadella|culatello|bresaola/.test(s)
  ) {
    dish.protein = "salumi";
    dish.intensity = Math.max(dish.intensity, 0.6);
    dish.fat = Math.max(dish.fat, 0.6);
    dish.sapidity = Math.max(dish.sapidity, 0.65);
    dish.persistence = Math.max(dish.persistence, 0.5);
  } else if (
    /formagg|parmigiano|pecorino|gorgonzola|caprino|blu|erborinat|comte|comté|brie|taleggio/.test(s)
  ) {
    dish.protein = "formaggio";
    dish.intensity = Math.max(dish.intensity, 0.7);
    dish.fat = Math.max(dish.fat, 0.6);
    dish.sapidity = Math.max(dish.sapidity, 0.65);
    dish.persistence = Math.max(dish.persistence, 0.6);
  } else {
    dish.protein = dish.protein ?? "veg";
  }

  // elementi grassi / cremosi
  if (/burro|panna|carbonara|cacio e pepe|alla gricia|quattro formaggi|crema|maionese/.test(s)) {
    dish.fat = Math.max(dish.fat, 0.6);
    dish.persistence = Math.max(dish.persistence, 0.55);
  }

  // sapidità
  if (/acciug|alici|capperi|olive|pecorino|parmigiano|grana|soia|miso|colatura|bottarga/.test(s)) {
    dish.sapidity = Math.max(dish.sapidity, 0.65);
  }

  // aromaticità
  if (/pepe|pepe nero|ginepro|rosmarino|salvia|timo|origano|curry|curcuma|zenzero|aglio|cipolla|erbe|erbe aromatiche|tartufo|funghi/.test(s)) {
    dish.aromaticity = Math.max(dish.aromaticity, 0.65);
  }

  // pomodoro / ragù
  if (/pomodoro|ragu|ragù/.test(s)) {
    dish.intensity = Math.max(dish.intensity, 0.6);
    dish.acid_hint = true;
    dish.succulence = Math.max(dish.succulence, 0.55);
    dish.persistence = Math.max(dish.persistence, 0.6);
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
      succulence: 0.3,
      sapidity: 0.25,
      aromaticity: 0.35,
      persistence: 0.35,
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
    succulence: +avg(ds.map((d) => d.succulence)).toFixed(2),
    sapidity: +avg(ds.map((d) => d.sapidity)).toFixed(2),
    aromaticity: +avg(ds.map((d) => d.aromaticity)).toFixed(2),
    persistence: +avg(ds.map((d) => d.persistence)).toFixed(2),
    acid_hint: ds.some((d) => d.acid_hint),
    protein: mode(ds.map((d) => d.protein)),
    cooking: mode(ds.map((d) => d.cooking)),
  };
}

function applyDishOverrides(piattoRaw: string, input: Dish): Dish {
  const s = norm(piattoRaw);
  const d: Dish = { ...input };

  const hasFish = /\b(pesce|gamber|gamberi|scampi|cozze|vongole|calamari|polpo|salmone|tonno|mare)\b/.test(s);
  const hasRedMeat = /\b(manzo|bovino|fiorentina|tagliata|agnello|cervo|capriolo|cacciagione|guancia|cinghiale|peposo|brasato|stracotto)\b/.test(s);
  const hasWhiteMeat = /\b(maiale|porchetta|salsiccia|pollo|tacchino|coniglio|anatra|oca)\b/.test(s);
  const hasAnyMeat = hasRedMeat || hasWhiteMeat;

  const isPastaLike = /\b(tortello|tortelli|tortellini|ravioli|gnocchi|tagliatelle|pappardelle|lasagne|risotto|pasta)\b/.test(s);
  const hasButterSauce = /\b(burro|burro e salvia|salvia|mantecato)\b/.test(s);
  const hasCheeseLike = /\b(formaggio|parmigiano|grana|pecorino|cacio|burro)\b/.test(s);

  if (isPastaLike && !hasFish && !hasAnyMeat) {
    d.protein = hasCheeseLike ? "formaggio" : "veg";
    d.intensity = Math.min(d.intensity, 0.62);
  }

  if (hasButterSauce) {
    d.fat = Math.max(d.fat, 0.68);
    d.sapidity = Math.max(d.sapidity, 0.35);
    d.aromaticity = /\bsalvia\b/.test(s) ? Math.max(d.aromaticity, 0.5) : d.aromaticity;

    if (!hasFish && !hasAnyMeat) {
      d.protein = "formaggio";
    }
  }

  if (/\b(ragu|ragù)\b/.test(s)) {
    d.succulence = Math.max(d.succulence, 0.55);
    d.persistence = Math.max(d.persistence, 0.58);

    if (!/\bbianco\b/.test(s)) {
      d.acid_hint = true;
    }

    if (hasAnyMeat || hasRedMeat) {
      d.protein = "carne_rossa";
    }
  }

  if (/\b(tortello burro e salvia|tortelli burro e salvia|ravioli burro e salvia)\b/.test(s)) {
    d.protein = "formaggio";
    d.fat = Math.max(d.fat, 0.7);
    d.intensity = Math.min(d.intensity, 0.58);
    d.spice = Math.min(d.spice, 0.12);
  }

  return d;
}

function enforceDishIdentity(piattoRaw: string, input: Dish): Dish {
  const s = norm(piattoRaw);
  const d: Dish = { ...input };

  const isFish = /\b(baccala|baccalà|stoccafisso|pesce|orata|branzino|spigola|tonno|salmone|gamber|gamberi|scampi|cozze|vongole|calamari|polpo|seppie|mare)\b/.test(s);
  const isRedMeat = /\b(manzo|tagliata|fiorentina|peposo|brasato|guancia|cinghiale|ragu|ragù)\b/.test(s);

  if (isFish) {
    d.protein = "pesce";
    d.intensity = Math.min(d.intensity, 0.62);
    d.succulence = Math.min(Math.max(d.succulence, 0.35), 0.55);
    if (/\bfritt/.test(s)) d.cooking = "fritto";
  }

  if (/\b(livornese|pomodoro|pomarola)\b/.test(s)) {
    d.acid_hint = true;
  }

  if (isRedMeat) {
    d.protein = "carne_rossa";
  }

  return d;
}

async function getDishFeatures(piattoRaw: string, openaiKey?: string): Promise<Dish> {
  const items = splitDishes(piattoRaw);
  if (!openaiKey) return combineDishes(items.map(parseDishFallback));

  const userPrompt = `
Analizza questi piatti e restituisci SOLO un ARRAY JSON valido.
Per ogni piatto usa queste chiavi:
"protein": "pesce"|"carne_rossa"|"carne_bianca"|"salumi"|"formaggio"|"veg"|null
"cooking": "crudo"|"fritto"|"griglia"|"brasato"|"bollito"|null
"fat": 0..1
"spice": 0..1
"sweet": 0..1
"intensity": 0..1
"succulence": 0..1
"sapidity": 0..1
"aromaticity": 0..1
"persistence": 0..1
"acid_hint": true/false

Valuta il piatto in senso sensoriale da sommelier, non nutrizionale.
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
    succulence: clamp01(Number(r?.succulence ?? 0.3)),
    sapidity: clamp01(Number(r?.sapidity ?? 0.25)),
    aromaticity: clamp01(Number(r?.aromaticity ?? 0.35)),
    persistence: clamp01(Number(r?.persistence ?? 0.35)),
    acid_hint: !!r?.acid_hint,
  });

  const dishes: Dish[] = Array.isArray(arr) ? arr.map(toDish) : [];
  return dishes.length
    ? combineDishes(dishes)
    : combineDishes(items.map(parseDishFallback));
}

/** =========================
 *  DISH KNOWLEDGE TABLES
 *  ========================= */

function normalizeSearchText(raw: any): string {
  return norm(String(raw || ""))
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesPhrase(haystack: string, needle: string): boolean {
  const h = normalizeSearchText(haystack);
  const n = normalizeSearchText(needle);
  if (!h || !n) return false;
  return (` ${h} `).includes(` ${n} `);
}

function dishFromBaseRow(row: DishBaseRow): Dish {
  return {
    fat: clamp01(Number(row.fat ?? 0.3)),
    spice: clamp01(Number(row.spice ?? 0)),
    sweet: clamp01(Number(row.sweet ?? 0)),
    intensity: clamp01(Number(row.intensity ?? 0.4)),
    succulence: clamp01(Number(row.succulence ?? 0.3)),
    sapidity: clamp01(Number(row.sapidity ?? 0.25)),
    aromaticity: clamp01(Number(row.aromaticity ?? 0.35)),
    persistence: clamp01(Number(row.persistence ?? 0.35)),
    protein: row.protein ?? null,
    cooking: row.cooking ?? null,
    acid_hint: !!row.acid_hint,
  };
}

function applyModifierToDish(dish: Dish, mod: DishModifierRow): Dish {
  const out: Dish = { ...dish };

  if (mod.set_cooking) out.cooking = mod.set_cooking;
  if (mod.set_protein) out.protein = mod.set_protein;

  out.fat = clamp01(out.fat + Number(mod.delta_fat || 0));
  out.spice = clamp01(out.spice + Number(mod.delta_spice || 0));
  out.sweet = clamp01(out.sweet + Number(mod.delta_sweet || 0));
  out.intensity = clamp01(out.intensity + Number(mod.delta_intensity || 0));
  out.succulence = clamp01(out.succulence + Number(mod.delta_succulence || 0));
  out.sapidity = clamp01(out.sapidity + Number(mod.delta_sapidity || 0));
  out.aromaticity = clamp01(out.aromaticity + Number(mod.delta_aromaticity || 0));
  out.persistence = clamp01(out.persistence + Number(mod.delta_persistence || 0));

  if (mod.set_acid_hint !== null && mod.set_acid_hint !== undefined) {
    out.acid_hint = !!mod.set_acid_hint;
  }

  return out;
}

function modifierAppliesToDish(
  mod: DishModifierRow,
  dish: Dish,
  baseFamily: string | null,
): boolean {
  const proteins = (mod.applies_to_proteins || []).map(normalizeSearchText).filter(Boolean);
  const cookings = (mod.applies_to_cookings || []).map(normalizeSearchText).filter(Boolean);
  const families = (mod.applies_to_base_families || []).map(normalizeSearchText).filter(Boolean);

  if (proteins.length) {
    if (!dish.protein) return false;
    if (!proteins.includes(normalizeSearchText(dish.protein))) return false;
  }

  if (cookings.length) {
    if (!dish.cooking) return false;
    if (!cookings.includes(normalizeSearchText(dish.cooking))) return false;
  }

  if (families.length) {
    const fam = normalizeSearchText(baseFamily || "");
    if (!fam || !families.includes(fam)) return false;
  }

  return true;
}

function scoreAliasHit(a: DishAliasRow): number {
  const typeBonus =
    a.alias_type === "canonical" ? 0.08
      : a.alias_type === "regional" ? 0.05
      : a.alias_type === "menu" ? 0.03
      : 0;

  return (a.alias_norm.length * 0.01) + Number(a.confidence || 0) + typeBonus;
}

function pickBestDishAlias(
  piattoNorm: string,
  knowledge: DishKnowledge,
): DishAliasRow | null {
  const hits = knowledge.aliases.filter((a) => includesPhrase(piattoNorm, a.alias_norm));
  if (!hits.length) return null;
  hits.sort((a, b) => scoreAliasHit(b) - scoreAliasHit(a));
  return hits[0] || null;
}

function pickBestDishBaseFromName(
  piattoNorm: string,
  knowledge: DishKnowledge,
): DishBaseRow | null {
  const rows = Array.from(knowledge.basesBySlug.values());

  const hits = rows.filter((b) =>
    includesPhrase(piattoNorm, b.canonical_name) ||
    includesPhrase(piattoNorm, b.display_name)
  );

  if (!hits.length) return null;

  hits.sort((a, b) => {
    const la = Math.max(a.canonical_name.length, a.display_name.length);
    const lb = Math.max(b.canonical_name.length, b.display_name.length);
    return lb - la;
  });

  return hits[0] || null;
}

async function loadDishKnowledge(headers: Record<string, string>): Promise<DishKnowledge> {
  const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";

  const [basesRes, aliasesRes, modifiersRes] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/dish_bases?is_active=eq.true&select=slug,canonical_name,display_name,base_family,protein,cooking,fat,spice,sweet,intensity,succulence,sapidity,aromaticity,persistence,acid_hint,accent_tags`,
      { headers },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/dish_aliases?select=alias_text,alias_norm,dish_base_slug,confidence,alias_type`,
      { headers },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/dish_modifiers?select=modifier_text,modifier_norm,modifier_type,set_cooking,set_protein,delta_fat,delta_spice,delta_sweet,delta_intensity,delta_succulence,delta_sapidity,delta_aromaticity,delta_persistence,set_acid_hint,accent_tags,applies_to_proteins,applies_to_cookings,applies_to_base_families,priority`,
      { headers },
    ),
  ]);

  if (!basesRes.ok) throw new Error(`dish_bases ${basesRes.status}`);
  if (!aliasesRes.ok) throw new Error(`dish_aliases ${aliasesRes.status}`);
  if (!modifiersRes.ok) throw new Error(`dish_modifiers ${modifiersRes.status}`);

  const basesJson = await basesRes.json();
  const aliasesJson = await aliasesRes.json();
  const modifiersJson = await modifiersRes.json();

  const baseRows: DishBaseRow[] = (basesJson || []).map((r: any) => ({
    slug: String(r.slug || ""),
    canonical_name: String(r.canonical_name || ""),
    display_name: String(r.display_name || ""),
    base_family: String(r.base_family || ""),
    protein: (r.protein ?? null) as Dish["protein"],
    cooking: (r.cooking ?? null) as Dish["cooking"],
    fat: Number(r.fat ?? 0.3),
    spice: Number(r.spice ?? 0),
    sweet: Number(r.sweet ?? 0),
    intensity: Number(r.intensity ?? 0.4),
    succulence: Number(r.succulence ?? 0.3),
    sapidity: Number(r.sapidity ?? 0.25),
    aromaticity: Number(r.aromaticity ?? 0.35),
    persistence: Number(r.persistence ?? 0.35),
    acid_hint: !!r.acid_hint,
    accent_tags: toStringArray(r.accent_tags),
  }));

  const aliases: DishAliasRow[] = (aliasesJson || []).map((r: any) => ({
    alias_text: String(r.alias_text || ""),
    alias_norm: normalizeSearchText(r.alias_norm || r.alias_text || ""),
    dish_base_slug: String(r.dish_base_slug || ""),
    confidence: Number(r.confidence ?? 0.9),
    alias_type: String(r.alias_type || "variant"),
  }))
    .filter((r: DishAliasRow) => r.alias_norm && r.dish_base_slug)
    .sort((a: DishAliasRow, b: DishAliasRow) =>
      scoreAliasHit(b) - scoreAliasHit(a)
    );

  const modifiers: DishModifierRow[] = (modifiersJson || []).map((r: any) => ({
    modifier_text: String(r.modifier_text || ""),
    modifier_norm: normalizeSearchText(r.modifier_norm || r.modifier_text || ""),
    modifier_type: String(r.modifier_type || ""),
    set_cooking: (r.set_cooking ?? null) as Dish["cooking"],
    set_protein: (r.set_protein ?? null) as Dish["protein"],
    delta_fat: Number(r.delta_fat ?? 0),
    delta_spice: Number(r.delta_spice ?? 0),
    delta_sweet: Number(r.delta_sweet ?? 0),
    delta_intensity: Number(r.delta_intensity ?? 0),
    delta_succulence: Number(r.delta_succulence ?? 0),
    delta_sapidity: Number(r.delta_sapidity ?? 0),
    delta_aromaticity: Number(r.delta_aromaticity ?? 0),
    delta_persistence: Number(r.delta_persistence ?? 0),
    set_acid_hint: r.set_acid_hint === null || r.set_acid_hint === undefined
      ? null
      : !!r.set_acid_hint,
    accent_tags: toStringArray(r.accent_tags),
    applies_to_proteins: toStringArray(r.applies_to_proteins),
    applies_to_cookings: toStringArray(r.applies_to_cookings),
    applies_to_base_families: toStringArray(r.applies_to_base_families),
    priority: Number(r.priority ?? 100),
  }))
    .filter((r: DishModifierRow) => r.modifier_norm)
    .sort((a: DishModifierRow, b: DishModifierRow) =>
      (a.priority - b.priority) ||
      (b.modifier_norm.length - a.modifier_norm.length)
    );

  const basesBySlug = new Map<string, DishBaseRow>();
  for (const row of baseRows) {
    if (row.slug) basesBySlug.set(row.slug, row);
  }

  return { basesBySlug, aliases, modifiers };
}

let DISH_KNOWLEDGE_CACHE: DishKnowledge | null = null;
let DISH_KNOWLEDGE_CACHE_AT = 0;

async function loadDishKnowledgeCached(
  headers: Record<string, string>,
): Promise<DishKnowledge> {
  const now = Date.now();
  if (DISH_KNOWLEDGE_CACHE && (now - DISH_KNOWLEDGE_CACHE_AT) < 10 * 60 * 1000) {
    return DISH_KNOWLEDGE_CACHE;
  }

  const fresh = await loadDishKnowledge(headers);
  DISH_KNOWLEDGE_CACHE = fresh;
  DISH_KNOWLEDGE_CACHE_AT = now;
  return fresh;
}

function resolveDishFromKnowledge(
  piattoRaw: string,
  knowledge: DishKnowledge,
): DishResolution {
  const piattoNorm = normalizeSearchText(piattoRaw);

  const aliasHit = pickBestDishAlias(piattoNorm, knowledge);
  let baseRow = aliasHit
    ? (knowledge.basesBySlug.get(aliasHit.dish_base_slug) || null)
    : pickBestDishBaseFromName(piattoNorm, knowledge);

  if (!baseRow) {
    const fallbackDish = enforceDishIdentity(
      piattoRaw,
      applyDishOverrides(piattoRaw, parseDishFallback(piattoRaw)),
    );

    return {
      dish: fallbackDish,
      source: "fallback",
      matched_base_slug: null,
      matched_base_name: null,
      matched_alias: null,
      matched_modifiers: [],
      accent_tags: [],
      base_family: null,
    };
  }

let dish = dishFromBaseRow(baseRow);
const matchedModifiers: string[] = [];
const usedModifierNorms = new Set<string>();
const coveredModifierNorms: string[] = [];
const accentTags = [...(baseRow.accent_tags || [])];

const baseText = normalizeSearchText(
  [
    String(baseRow.slug || "").replace(/-/g, " "),
    baseRow.canonical_name || "",
    baseRow.display_name || "",
  ].join(" "),
);

for (const mod of knowledge.modifiers) {
  if (!includesPhrase(piattoNorm, mod.modifier_norm)) continue;
  if (usedModifierNorms.has(mod.modifier_norm)) continue;

  // se il modifier è già "dentro" il piatto base, non lo riapplico
  if (includesPhrase(baseText, mod.modifier_norm)) continue;

  // se è già coperto da un modifier più lungo scelto prima, non lo riapplico
  if (coveredModifierNorms.some((prev) => includesPhrase(prev, mod.modifier_norm))) continue;

  if (!modifierAppliesToDish(mod, dish, baseRow.base_family)) continue;

  dish = applyModifierToDish(dish, mod);
  matchedModifiers.push(mod.modifier_text);
  usedModifierNorms.add(mod.modifier_norm);
  coveredModifierNorms.push(mod.modifier_norm);
  accentTags.push(...(mod.accent_tags || []));
}

  const finalDish = enforceDishIdentity(
    piattoRaw,
    applyDishOverrides(piattoRaw, dish),
  );

  const accentUnique = Array.from(
    new Set(
      accentTags
        .map((x) => normalizeSearchText(x))
        .filter(Boolean),
    ),
  );

  return {
    dish: finalDish,
    source: "knowledge",
    matched_base_slug: baseRow.slug,
    matched_base_name: baseRow.display_name || baseRow.canonical_name,
    matched_alias: aliasHit?.alias_text || baseRow.display_name || baseRow.canonical_name,
    matched_modifiers: matchedModifiers,
    accent_tags: accentUnique,
    base_family: baseRow.base_family || null,
  };
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

let PRIORS_CACHE: Priors | null = null;
let PRIORS_CACHE_AT = 0;

async function loadPriorsCached(headers: Record<string, string>): Promise<Priors> {
  const now = Date.now();
  if (PRIORS_CACHE && (now - PRIORS_CACHE_AT) < 10 * 60 * 1000) {
    return PRIORS_CACHE;
  }

  const fresh = await loadPriors(headers);
  PRIORS_CACHE = fresh;
  PRIORS_CACHE_AT = now;
  return fresh;
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

  addArr(ctx.descNotes);
  addArr(ctx.descPairings);
  addArr(ctx.descHook);
  addArr(ctx.descPalate);
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

    descNotes: [],
    descPairings: [],
    descHook: [],
    descPalate: [],
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
function buildReasonCodes(
  profile: Profile,
  dish: Dish,
  wineCtx: WineTextContext,
): PairingReason[] {
  const reasons: PairingReason[] = [];

  const push = (code: ReasonCode, strength: number) => {
    if (strength <= 0) return;

    const value = +strength.toFixed(3);
    const existing = reasons.find((r) => r.code === code);

    if (existing) {
      existing.strength = Math.max(existing.strength, value);
      return;
    }

    reasons.push({ code, strength: value });
  };

  if (dish.fat >= 0.45 && profile.bubbles >= 0.9) {
    push("bubbles_cleanse", dish.fat * 0.9 + profile.bubbles * 0.4);
  }

  if (dish.fat >= 0.4 && profile.acid >= 0.58) {
    push("cuts_fat", dish.fat * 0.8 + profile.acid * 0.5);
  }

  if (dish.succulence >= 0.45 && (profile.tannin >= 0.45 || profile.body >= 0.58)) {
    push(
      "handles_succulence",
      dish.succulence * 0.8 + profile.tannin * 0.5 + profile.body * 0.3,
    );
  }

  const intensityFit = 1 - Math.abs(dish.intensity - profile.body);
  if (intensityFit >= 0.7) {
    push("matches_intensity", intensityFit);
  }

  if (dish.acid_hint && profile.acid >= 0.58) {
    push("fresh_on_acid", profile.acid * 0.8);
  }

  if (dish.spice >= 0.4 && (profile.sweet >= 0.08 || profile.tannin <= 0.45)) {
    push(
      "softens_spice",
      dish.spice * 0.6 + profile.sweet * 0.8 + Math.max(0, 0.5 - profile.tannin),
    );
  }

if (
  (dish.protein === "pesce" || dish.cooking === "crudo") &&
  profile.tannin <= 0.45
) {
  push(
    "supports_fish",
    profile.acid * 0.55 +
      Math.max(0, 0.5 - profile.tannin) +
      profile.bubbles * 0.2,
  );
}

  if (
    dish.intensity <= 0.45 &&
    dish.fat <= 0.4 &&
    profile.body <= 0.55 &&
    profile.tannin <= 0.45
  ) {
    push("does_not_overwhelm", 0.7 - Math.max(0, profile.body - 0.45));
  }

  if (dish.protein === "formaggio") {
    push("supports_cheese", profile.body * 0.5 + profile.acid * 0.3);
  }

  if (dish.protein === "salumi") {
    push("supports_cured_meat", profile.acid * 0.5 + Math.max(0, 0.55 - profile.tannin));
  }

  if (dish.protein === "carne_rossa") {
    push("supports_red_meat", profile.tannin * 0.7 + profile.body * 0.5);
  }

  if (dish.protein === "carne_bianca") {
    push("supports_white_meat", profile.body * 0.4 + profile.acid * 0.3);
  }

  if (dish.protein === "veg") {
    push("supports_veg", profile.acid * 0.4 + Math.max(0, 0.45 - profile.tannin));
  }

  const styleAll = norm(
    [
      ...(wineCtx.grapeStyleHints || []),
      ...(wineCtx.appStyleHints || []),
      ...(wineCtx.descHook || []),
      ...(wineCtx.descPalate || []),
    ].join(" "),
  );

  if (
    /(teso|snello|fresco|mineral|salino|fine|elegante|vibrante|slanciato)/.test(styleAll) &&
    dish.intensity <= 0.5
  ) {
    push("does_not_overwhelm", 0.35);
  }

  return reasons.sort((a, b) => b.strength - a.strength).slice(0, 4);
}

function matchScore(
  profile: Profile,
  dish: Dish,
  wineCtx: WineTextContext,
  piattoNorm: string,
  dishTags: Set<string>,
): number {
  let sc = 0;
  const isPaellaLike = /\b(paella|fideua|fideuà)\b/.test(piattoNorm);

const isSeaRiceLike =
  (
    /\b(paella|fideua|fideuà|risotto|riso|arroz)\b/.test(piattoNorm) &&
    /\b(pesce|gamber|gamberi|scampi|cozze|vongole|calamari|polpo|seppie|mare)\b/.test(piattoNorm)
  ) ||
  (isPaellaLike && dish.protein === "pesce");

const isMixedSeaSpice =
  isPaellaLike ||
  (
    isSeaRiceLike &&
    (dish.spice >= 0.2 || dish.acid_hint || dish.sapidity >= 0.4)
  );

  // basi sensoriali nuove
  sc += dish.fat * (profile.acid * 1.0 + profile.bubbles * 0.6);
  sc += dish.succulence * (profile.tannin * 0.9 + profile.body * 0.35);
  sc += dish.sapidity * (profile.acid * 0.55 + profile.bubbles * 0.25);
  sc += dish.persistence * (profile.body * 0.45);

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

  if (dish.protein === "carne_rossa") {
    sc += profile.tannin * 1.8 + profile.body * 1.35 - profile.bubbles * 0.8;
    if (profile.tannin >= 0.6 && profile.body >= 0.6) sc += 0.15;
  } else if (dish.cooking === "brasato" && dish.protein !== "pesce") {
    sc += profile.body * 0.25;
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

    const isDelicatePasta =
    /\b(tortello|tortelli|tortellini|ravioli|gnocchi|tagliatelle|pappardelle|risotto|pasta)\b/.test(piattoNorm) &&
    dish.protein !== "carne_rossa" &&
    dish.protein !== "pesce" &&
    dish.cooking !== "brasato";

  if (isDelicatePasta) {
    sc += profile.bubbles * 0.65 + profile.acid * 0.25;
    sc -= Math.max(0, profile.tannin - 0.45) * 1.1;
    sc -= Math.max(0, profile.body - 0.7) * 0.35;
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
    ...(wineCtx.descPairings || []),
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
      ...(wineCtx.descHook || []),
      ...(wineCtx.descPalate || []),
    ].join(" "),
  );

    const noteBag = norm(
    [
      ...(wineCtx.tastingNotes || []),
      ...(wineCtx.typicalNotes || []),
      ...(wineCtx.descNotes || []),
      ...(wineCtx.descHook || []),
      ...(wineCtx.descPalate || []),
      ...(wineCtx.appStyleHints || []),
      ...(wineCtx.grapeStyleHints || []),
    ].join(" "),
  );

  const hasDishTag = (tag: string) => dishTags.has(normalizeSearchText(tag));

  if (hasDishTag("tartufo") || hasDishTag("funghi") || hasDishTag("porcini")) {
    if (/(tartufo|terra|sottobosco|fungh|cuoio|grafite|balsam)/.test(noteBag)) {
      sc += 0.12;
    }
  }

  if (hasDishTag("pepe") || hasDishTag("pepato")) {
    if (/(pepe|pepato|spezi|balsam)/.test(noteBag)) {
      sc += 0.08;
    }
  }

  if (hasDishTag("pomodoro") || hasDishTag("agrumi") || hasDishTag("acidulo")) {
    sc += profile.acid * 0.12;
  }

  if (
    hasDishTag("erbe") ||
    hasDishTag("rosmarino") ||
    hasDishTag("salvia") ||
    hasDishTag("timo")
  ) {
    if (/(erbe|balsam|rosmarino|salvia|timo)/.test(noteBag)) {
      sc += 0.06;
    }
  }

  if (hasDishTag("arrosto")) {
  // premio vini che dialogano con note da arrosto / erbe / spezie fini
  if (/(arrost|erbe|balsam|nocciol|spezi|fum|affumicat)/.test(noteBag)) {
    sc += 0.08;
  }

  // su un arrosto di carne bianca premio bianchi strutturati e rossi leggeri/medi,
  // ma riduco un po' le bollicine "solo detergenti"
  if (dish.protein === "carne_bianca") {
    if (profile.body >= 0.48 && profile.body <= 0.72) sc += 0.05;
    if (profile.tannin >= 0.18 && profile.tannin <= 0.58) sc += 0.05;
    if (profile.bubbles >= 0.9 && profile.body < 0.5) sc -= 0.06;
  }
}

  if (
    hasDishTag("burro") ||
    hasDishTag("cremoso") ||
    hasDishTag("mantecato")
  ) {
    if (profile.acid >= 0.55 && profile.tannin <= 0.35) {
      sc += 0.08;
    }
    if (dish.protein !== "carne_rossa" && profile.tannin >= 0.55) {
      sc -= 0.08;
    }
  }

  const richDish = dish.fat >= 0.6 || dish.intensity >= 0.7 ||
    dish.cooking === "brasato";
  const delicateDish = dish.intensity <= 0.45 && dish.fat <= 0.4 &&
    (dish.protein === "pesce" || dish.protein === "veg");
  const spicyDish = dish.spice > 0.4;
  const aromaticDish = dish.aromaticity >= 0.55;
  const persistentDish = dish.persistence >= 0.65;
  const saltyDish = dish.sapidity >= 0.55;

  if (richDish) {
    if (
      /(struttura|importante|rovere|barrique|potente|corposo|longevit|avvolgente|polpos|fitto|profondo|strutturat)/.test(
        styleAll,
      )
    ) {
      sc += 0.05;
    }
  }

  if (delicateDish) {
    if (
      /(teso|snello|fresco|mineral|salino|gastronomic|fine|elegante|vibrante|legger|slanciato)/.test(
        styleAll,
      )
    ) {
      sc += 0.05;
    }
  }

  if (spicyDish) {
    if (
      /(morbido|rotondo|dolcezza|glicerico|avvolgente|setoso|soffice)/.test(
        styleAll,
      )
    ) {
      sc += 0.03;
    }
  }

  if (aromaticDish) {
    if (
      /(balsam|spezi|pepper|pepato|erbe|herb|floreal|floral|violet|violetta|agrum|citrus|anice|liquir|grafite|graphite|fum|smoke)/.test(
        styleAll,
      )
    ) {
      sc += 0.06;
    }
  }

  if (saltyDish) {
    if (/(salino|sapido|mineral|marine|marittimo|costa|vulcanic)/.test(styleAll)) {
      sc += 0.04;
    }
  }

  if (persistentDish) {
    if (
      /(lungo|persisten|profondo|struttura|corposo|fitto|ampio|avvolgente)/.test(
        styleAll,
      )
    ) {
      sc += 0.05;
    }
  }

  if (
    (dish.protein === "pesce" || dish.protein === "veg") &&
    /(marittimo|vulcanic|costa|sapido)/.test(styleAll)
  ) {
    sc += 0.03;
  }

  if (isMixedSeaSpice) {
  if (profile.bubbles >= 0.9) {
    sc += 0.18;
  }

  if (profile.acid >= 0.58 && profile.tannin <= 0.35) {
    sc += 0.12;
  }

  if (profile.tannin >= 0.45) {
    sc -= 0.12 + Math.max(0, profile.tannin - 0.45) * 0.45;
  }

  if (profile.body >= 0.72 && profile.bubbles < 0.9) {
    sc -= 0.08;
  }
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

type PairingBand = "high" | "medium" | "fallback";

const CONFIDENCE_TEXT: Record<
  LangCode,
  Record<PairingBand, string>
> = {
  it: {
    high: "Abbinamento molto centrato",
    medium: "Abbinamento convincente",
    fallback: "Scelta più coerente disponibile",
  },
  en: {
    high: "Excellent pairing",
    medium: "Convincing pairing",
    fallback: "Most coherent option available",
  },
  fr: {
    high: "Accord très juste",
    medium: "Accord convaincant",
    fallback: "Choix le plus cohérent disponible",
  },
  de: {
    high: "Sehr stimmige Kombination",
    medium: "Überzeugende Kombination",
    fallback: "Die stimmigste verfügbare Wahl",
  },
  es: {
    high: "Maridaje muy centrado",
    medium: "Maridaje convincente",
    fallback: "La opción más coherente disponible",
  },
  zh: {
    high: "非常贴切的搭配",
    medium: "比较稳妥的搭配",
    fallback: "酒单里相对最合适的选择",
  },
  ko: {
    high: "아주 정확한 페어링",
    medium: "설득력 있는 페어링",
    fallback: "와인 리스트에서 가장 무난하게 맞는 선택",
  },
  ru: {
    high: "Очень точное сочетание",
    medium: "Убедительное сочетание",
    fallback: "Самый уместный вариант из доступных",
  },
};

function getConfidenceLabel(lang: LangCode, band: PairingBand): string {
  return CONFIDENCE_TEXT[lang]?.[band] || CONFIDENCE_TEXT.it[band];
}

function getPairingBand(params: {
  q: number;
  reasonStrength: number;
  leaderQ: number;
  secondQ: number;
  index: number;
}): PairingBand {
  const { q, reasonStrength, leaderQ, secondQ, index } = params;
  const gapFromLeader = leaderQ - q;
  const leaderGap = Math.max(0, leaderQ - secondQ);

  // top pick davvero forte
  if (
    index === 0 &&
    q >= 0.78 &&
    reasonStrength >= 1.15 &&
    leaderGap >= 0.08
  ) {
    return "high";
  }

  // pick comunque buono / centrato
  if (
    q >= 0.58 &&
    reasonStrength >= 0.75 &&
    gapFromLeader <= 0.16
  ) {
    return "medium";
  }

  // tutto il resto = migliore scelta disponibile ma non perfetta
  return "fallback";
}

function prependConfidenceLabel(
  motive: string,
  lang: LangCode,
  band: PairingBand,
): string {
  const label = getConfidenceLabel(lang, band).trim();
  const text = (motive || "").trim();

  if (!label) return text;
  if (!text) return label;

  if (lang === "zh") return `${label}：${text}`;
  return `${label}: ${text}`;
}

function lowerFirst(s: string) {
  s = (s || "").trim();
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function upperFirst(s: string) {
  s = (s || "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
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
  const clean = parts
    .map(stripEndPunct)
    .filter(Boolean)
    .map((p) => (lang === "zh" ? p : upperFirst(p)));

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

const REASON_TEXT: Record<
  LangCode,
  Record<ReasonCode, string[]>
> = {
  it: {
    cuts_fat: [
      "ha freschezza sufficiente per ripulire il grasso",
      "sgrassa bene il boccone e tiene il palato vivo",
    ],
    bubbles_cleanse: [
      "la bollicina pulisce il palato con precisione",
      "la spuma rimette in equilibrio il boccone successivo",
    ],
    handles_succulence: [
      "ha la struttura giusta per la succulenza del piatto",
      "regge bene la parte succosa senza perdere slancio",
    ],
    matches_intensity: [
      "ha un peso gustativo centrato sul piatto",
      "ha intensità coerente con il boccone",
    ],
    fresh_on_acid: [
      "dialoga bene con la componente acida",
      "resta dritto anche sulla parte più fresca del piatto",
    ],
    softens_spice: [
      "non irrigidisce il piccante",
      "accompagna la speziatura senza alzarne il calore",
    ],
    does_not_overwhelm: [
      "non copre i dettagli del piatto",
      "resta misurato e lascia spazio al boccone",
    ],
    supports_fish: [
      "sul pesce resta armonico e pulito",
      "accompagna il pesce senza indurire il boccone",
    ],
    supports_cheese: [
      "regge bene sapidità e consistenza del formaggio",
      "ha tenuta sufficiente per il formaggio senza impastare",
    ],
    supports_cured_meat: [
      "funziona bene con la sapidità dei salumi",
      "pulisce bene la bocca tra un assaggio e l’altro",
    ],
    supports_red_meat: [
      "ha spalla sufficiente per la carne rossa",
      "sostiene bene la parte intensa e carnosa",
    ],
    supports_white_meat: [
      "accompagna bene la carne bianca senza appesantire",
      "sta bene sulla carne bianca con equilibrio",
    ],
    supports_veg: [
      "resta gastronomico anche su un piatto vegetale",
      "accompagna il vegetale senza invadere",
    ],
  },

  en: {
    cuts_fat: [
      "it has enough freshness to cleanse the richness",
      "it cuts through the richer side of the dish cleanly",
    ],
    bubbles_cleanse: [
      "the bubbles cleanse the palate precisely",
      "the sparkle resets the palate between bites",
    ],
    handles_succulence: [
      "it has the structure needed for the dish’s succulence",
      "it carries the juicy side of the dish without losing shape",
    ],
    matches_intensity: [
      "its weight on the palate matches the dish well",
      "its intensity feels well aligned with the bite",
    ],
    fresh_on_acid: [
      "it works well with the dish’s acidity",
      "it stays focused on the fresher side of the plate",
    ],
    softens_spice: [
      "it does not harden the spicy edge",
      "it supports the spice without making it hotter",
    ],
    does_not_overwhelm: [
      "it does not cover the dish’s finer details",
      "it stays measured and lets the bite stay clear",
    ],
    supports_fish: [
      "it stays clean and harmonious with fish",
      "it supports fish without hardening the palate",
    ],
    supports_cheese: [
      "it handles the savoury richness of cheese well",
      "it has enough hold for cheese without becoming heavy",
    ],
    supports_cured_meat: [
      "it works well with the savoury side of cured meats",
      "it cleans the palate nicely between bites",
    ],
    supports_red_meat: [
      "it has enough shoulder for red meat",
      "it supports the dish’s deeper meat character well",
    ],
    supports_white_meat: [
      "it accompanies white meat without weighing it down",
      "it works with white meat in a balanced way",
    ],
    supports_veg: [
      "it stays food-friendly on a vegetable dish",
      "it supports the vegetable profile without taking over",
    ],
  },

  es: {
    cuts_fat: [
      "tiene la frescura suficiente para limpiar la grasa",
      "limpia bien la parte más grasa del bocado y mantiene el paladar vivo",
    ],
    bubbles_cleanse: [
      "la burbuja limpia el paladar con precisión",
      "la espuma reequilibra el paladar entre un bocado y otro",
    ],
    handles_succulence: [
      "tiene la estructura adecuada para la suculencia del plato",
      "soporta bien la parte jugosa sin perder impulso",
    ],
    matches_intensity: [
      "su peso en boca encaja bien con el plato",
      "su intensidad está bien alineada con el bocado",
    ],
    fresh_on_acid: [
      "dialoga bien con la parte ácida del plato",
      "se mantiene recto incluso en la parte más fresca del plato",
    ],
    softens_spice: [
      "no endurece el picante",
      "acompaña el especiado sin aumentar el calor",
    ],
    does_not_overwhelm: [
      "no tapa los matices del plato",
      "se mantiene medido y deja espacio al bocado",
    ],
    supports_fish: [
      "con el pescado se mantiene armónico y limpio",
      "acompaña el pescado sin endurecer el bocado",
    ],
    supports_cheese: [
      "soporta bien la sapidez y la textura del queso",
      "tiene suficiente firmeza para el queso sin volverse pesado",
    ],
    supports_cured_meat: [
      "funciona bien con la sapidez de los embutidos",
      "limpia bien la boca entre un bocado y otro",
    ],
    supports_red_meat: [
      "tiene suficiente estructura para la carne roja",
      "sostiene bien la parte intensa y carnosa del plato",
    ],
    supports_white_meat: [
      "acompaña bien la carne blanca sin recargarla",
      "queda bien con la carne blanca de forma equilibrada",
    ],
    supports_veg: [
      "sigue siendo gastronómico también con un plato vegetal",
      "acompaña el perfil vegetal sin invadirlo",
    ],
  },

  fr: {
    cuts_fat: [
      "il a assez de fraîcheur pour nettoyer le gras",
      "il allège bien la partie la plus riche du plat et garde le palais net",
    ],
    bubbles_cleanse: [
      "la bulle nettoie le palais avec précision",
      "la mousse remet le palais en équilibre entre deux bouchées",
    ],
    handles_succulence: [
      "il a la structure qu’il faut pour la succulence du plat",
      "il tient bien la partie juteuse sans perdre son élan",
    ],
    matches_intensity: [
      "son poids en bouche est juste par rapport au plat",
      "son intensité est cohérente avec la bouchée",
    ],
    fresh_on_acid: [
      "il dialogue bien avec la composante acide du plat",
      "il reste droit même sur la partie la plus fraîche de l’assiette",
    ],
    softens_spice: [
      "il ne durcit pas le piquant",
      "il accompagne les épices sans en augmenter la chaleur",
    ],
    does_not_overwhelm: [
      "il ne couvre pas les détails du plat",
      "il reste mesuré et laisse de la place à la bouchée",
    ],
    supports_fish: [
      "avec le poisson, il reste harmonieux et net",
      "il accompagne le poisson sans durcir la bouche",
    ],
    supports_cheese: [
      "il tient bien face à la sapidité et à la texture du fromage",
      "il a assez de tenue pour le fromage sans alourdir",
    ],
    supports_cured_meat: [
      "il fonctionne bien avec la sapidité des charcuteries",
      "il nettoie bien la bouche entre deux bouchées",
    ],
    supports_red_meat: [
      "il a assez d’épaule pour la viande rouge",
      "il soutient bien la partie intense et charnue du plat",
    ],
    supports_white_meat: [
      "il accompagne bien la viande blanche sans l’alourdir",
      "il va bien avec la viande blanche avec équilibre",
    ],
    supports_veg: [
      "il reste gastronomique même sur un plat végétal",
      "il accompagne le végétal sans prendre le dessus",
    ],
  },

  de: {
    cuts_fat: [
      "er hat genug Frische, um das Fett sauber aufzufangen",
      "er nimmt dem reicheren Bissen die Schwere und hält den Gaumen lebendig",
    ],
    bubbles_cleanse: [
      "die Perlage reinigt den Gaumen präzise",
      "der Mousseux bringt den Gaumen zwischen den Bissen wieder ins Gleichgewicht",
    ],
    handles_succulence: [
      "er hat die richtige Struktur für die Saftigkeit des Gerichts",
      "er trägt die saftige Komponente gut, ohne an Spannung zu verlieren",
    ],
    matches_intensity: [
      "sein Gewicht am Gaumen passt gut zum Gericht",
      "seine Intensität ist stimmig zum Bissen",
    ],
    fresh_on_acid: [
      "er harmoniert gut mit der Säure des Gerichts",
      "er bleibt auch bei der frischeren Seite des Tellers klar und präzise",
    ],
    softens_spice: [
      "er verhärtet die Schärfe nicht",
      "er begleitet die Würze, ohne die Hitze zu steigern",
    ],
    does_not_overwhelm: [
      "er überdeckt die feineren Details des Gerichts nicht",
      "er bleibt zurückhaltend und lässt dem Bissen Raum",
    ],
    supports_fish: [
      "zum Fisch bleibt er harmonisch und sauber",
      "er begleitet Fisch, ohne den Eindruck im Mund zu verhärten",
    ],
    supports_cheese: [
      "er trägt Würze und Textur von Käse gut",
      "er hat genug Halt für Käse, ohne schwer zu wirken",
    ],
    supports_cured_meat: [
      "er funktioniert gut mit der Würze von Wurstwaren",
      "er reinigt den Mund schön zwischen den Bissen",
    ],
    supports_red_meat: [
      "er hat genug Schulter für rotes Fleisch",
      "er stützt die intensive und fleischige Seite des Gerichts gut",
    ],
    supports_white_meat: [
      "er begleitet helles Fleisch gut, ohne es zu beschweren",
      "er passt ausgewogen zu hellem Fleisch",
    ],
    supports_veg: [
      "er bleibt auch bei einem Gemüsegericht sehr gastronomisch",
      "er begleitet das Pflanzliche, ohne sich in den Vordergrund zu drängen",
    ],
  },

  zh: {
    cuts_fat: [
      "它有足够的清新感来化解油脂感",
      "它能很好地削减菜肴中较丰厚的油润感，让口腔保持清爽",
    ],
    bubbles_cleanse: [
      "气泡能够精准地清洁口腔",
      "细腻的泡沫能在每一口之间让味蕾重新平衡",
    ],
    handles_succulence: [
      "它具备应对菜肴多汁感所需的结构",
      "它能承接菜肴的多汁部分，同时不失去节奏感",
    ],
    matches_intensity: [
      "它在口中的重量感与菜肴很匹配",
      "它的强度与这一口食物十分协调",
    ],
    fresh_on_acid: [
      "它与菜肴中的酸度配合得很好",
      "即使面对菜肴更清爽、更酸鲜的一面，它也依然稳定",
    ],
    softens_spice: [
      "它不会让辣感变得更生硬",
      "它能陪衬香料感，而不会把辣度推得更高",
    ],
    does_not_overwhelm: [
      "它不会盖住菜肴更细腻的层次",
      "它保持分寸，给每一口食物留下空间",
    ],
    supports_fish: [
      "搭配鱼类时，它依然和谐而干净",
      "它能陪衬鱼肉，而不会让口感变硬",
    ],
    supports_cheese: [
      "它能很好承接奶酪的咸鲜感和质地",
      "它对奶酪有足够支撑力，同时不会显得厚重",
    ],
    supports_cured_meat: [
      "它与腌制肉类的咸鲜风味很合拍",
      "它能在每一口之间很好地清洁口腔",
    ],
    supports_red_meat: [
      "它有足够的支撑力来搭配红肉",
      "它能很好承托菜肴浓郁而富有肉感的一面",
    ],
    supports_white_meat: [
      "它能很好搭配白肉，同时不会显得沉重",
      "它与白肉的配合平衡而自然",
    ],
    supports_veg: [
      "即使搭配蔬菜类菜肴，它也依然很适合餐桌",
      "它能衬托蔬菜风味，而不会喧宾夺主",
    ],
  },

  ko: {
    cuts_fat: [
      "기름진 느낌을 정리해 줄 만큼 충분한 산뜻함이 있습니다",
      "더 풍부한 기름기를 깔끔하게 잘라 주며 입안을 생기 있게 유지합니다",
    ],
    bubbles_cleanse: [
      "버블이 입안을 정교하게 정리해 줍니다",
      "기포감이 한 입 한 입 사이의 미각을 다시 균형 있게 맞춰 줍니다",
    ],
    handles_succulence: [
      "요리의 육즙감을 받아줄 만큼 구조감이 있습니다",
      "촉촉하고 육즙 있는 부분을 잘 받치면서도 흐트러지지 않습니다",
    ],
    matches_intensity: [
      "입안에서의 무게감이 요리와 잘 맞습니다",
      "강도가 한 입의 인상과 잘 어울립니다",
    ],
    fresh_on_acid: [
      "요리의 산미 요소와 잘 어울립니다",
      "더 산뜻하고 신선한 부분에서도 흐트러지지 않고 곧게 갑니다",
    ],
    softens_spice: [
      "매운 느낌을 더 거칠게 만들지 않습니다",
      "향신료의 느낌을 받쳐 주면서도 열감을 더 키우지 않습니다",
    ],
    does_not_overwhelm: [
      "요리의 섬세한 디테일을 덮지 않습니다",
      "절제된 인상을 유지해 한 입의 표현을 살려 줍니다",
    ],
    supports_fish: [
      "생선과 함께했을 때 조화롭고 깔끔합니다",
      "생선을 받쳐 주면서도 입안의 인상을 거칠게 만들지 않습니다",
    ],
    supports_cheese: [
      "치즈의 짭짤함과 질감을 잘 받아 줍니다",
      "치즈를 감당할 충분한 힘이 있으면서도 무겁게 가지 않습니다",
    ],
    supports_cured_meat: [
      "염장육의 감칠맛과 짠맛에 잘 어울립니다",
      "한 입 한 입 사이 입안을 깔끔하게 정리해 줍니다",
    ],
    supports_red_meat: [
      "붉은 고기를 받쳐 줄 충분한 힘이 있습니다",
      "요리의 진하고 육감적인 면을 잘 지탱해 줍니다",
    ],
    supports_white_meat: [
      "흰 고기를 무겁게 만들지 않으면서 잘 어울립니다",
      "흰 고기와 균형 있게 잘 맞습니다",
    ],
    supports_veg: [
      "채소 중심의 요리에서도 음식 친화적으로 잘 작동합니다",
      "채소의 성격을 살리면서도 앞서 나가지 않습니다",
    ],
  },

  ru: {
    cuts_fat: [
      "у него достаточно свежести, чтобы хорошо очищать жирность",
      "он чисто срезает более жирную сторону блюда и сохраняет нёбо живым",
    ],
    bubbles_cleanse: [
      "пузырьки точно очищают нёбо",
      "игра пузырьков возвращает баланса между глотками и кусочками",
    ],
    handles_succulence: [
      "у него есть нужная структура для сочности блюда",
      "он хорошо держит сочную сторону блюда, не теряя собранности",
    ],
    matches_intensity: [
      "его вес во вкусе хорошо соответствует блюду",
      "его интенсивность хорошо совпадает с характером кусочка",
    ],
    fresh_on_acid: [
      "он хорошо работает с кислотной составляющей блюда",
      "он остаётся собранным даже на более свежей и кислой стороне тарелки",
    ],
    softens_spice: [
      "он не делает остроту жёстче",
      "он сопровождает специи, не усиливая жар",
    ],
    does_not_overwhelm: [
      "он не перекрывает более тонкие детали блюда",
      "он остаётся сдержанным и оставляет место самому блюду",
    ],
    supports_fish: [
      "с рыбой он остаётся гармоничным и чистым",
      "он сопровождает рыбу, не утяжеляя ощущение во рту",
    ],
    supports_cheese: [
      "он хорошо справляется с солоноватостью и текстурой сыра",
      "у него достаточно опоры для сыра, но без тяжести",
    ],
    supports_cured_meat: [
      "он хорошо работает с солоноватым характером мясных деликатесов",
      "он хорошо очищает рот между кусочками",
    ],
    supports_red_meat: [
      "у него достаточно опоры для красного мяса",
      "он хорошо поддерживает более насыщенную и мясистую сторону блюда",
    ],
    supports_white_meat: [
      "он хорошо сопровождает белое мясо, не утяжеляя его",
      "он сочетается с белым мясом уравновешенно",
    ],
    supports_veg: [
      "он остаётся гастрономичным и с овощным блюдом",
      "он поддерживает овощной профиль, не перетягивая внимание на себя",
    ],
  },
};

function getReasonTexts(lang: LangCode, code: ReasonCode): string[] {
  const local = REASON_TEXT[lang];

  if (local && Object.keys(local).length && local[code]?.length) {
    return local[code];
  }

  if ((lang === "it" || lang === "en") && REASON_TEXT[lang]?.[code]?.length) {
    return REASON_TEXT[lang][code];
  }

  return [];
}

const REASON_BUCKET: Record<ReasonCode, string> = {
  cuts_fat: "freshness",
  bubbles_cleanse: "bubbles",
  handles_succulence: "structure",
  matches_intensity: "weight",
  fresh_on_acid: "freshness",
  softens_spice: "spice",
  does_not_overwhelm: "delicacy",
  supports_fish: "protein",
  supports_cheese: "protein",
  supports_cured_meat: "protein",
  supports_red_meat: "protein",
  supports_white_meat: "protein",
  supports_veg: "protein",
};

function pickReasonLines(
  reasons: PairingReason[],
  lang: LangCode,
  rand: () => number,
): string[] {
  const out: string[] = [];
  const usedBuckets = new Set<string>();

  for (const r of reasons || []) {
    const bucket = REASON_BUCKET[r.code];
    if (bucket && usedBuckets.has(bucket)) continue;

    const arr = getReasonTexts(lang, r.code);
    if (!arr.length) continue;

    out.push(pickOne(arr, rand));
    if (bucket) usedBuckets.add(bucket);

    if (out.length >= 2) break;
  }

  return out;
}

function noteScoreForWine(
  note: string,
  colore: Colore,
  profile: Profile,
): number {
  const s = norm(note);
  if (!s) return -999;

  const whiteFresh =
    /(limone|lime|cedro|pompelmo|agrum|mela|pera|pesca|pesca bianca|albicocc|albicocca|fiori bianchi|fiori di campo|biancospino|gelsomino|sambuco|idrocarburo|mineral|gessos|salin|mandorla)\b/u;

  const sparklingSet =
    /(crosta di pane|brioche|lievito|spuma|mousse|mineral|gessos|agrum|mela|pera|limone)\b/u;

  const redFresh =
    /(fragola|lampone|ciliegia|amarena|melograno|rosa|violetta|pepe|erbe mediterranee|balsamico leggero)\b/u;

  const redDeep =
    /(prugna|mora|cassis|ribes nero|tabacco|cuoio|grafite|catrame|cioccolato|cacao|liquirizia|balsamico|sottobosco|funghi|terra|spezie scure)\b/u;

  let score = 0.05;

  if (colore === "spumante") {
    if (sparklingSet.test(s)) score += 1.1;
    if (whiteFresh.test(s)) score += 0.45;
    if (redDeep.test(s)) score -= 1.1;
  } else if (colore === "bianco") {
    if (whiteFresh.test(s)) score += 1.0;
    if (sparklingSet.test(s)) score += 0.15;
    if (redDeep.test(s)) score -= 1.0;
  } else if (colore === "rosato") {
    if (whiteFresh.test(s)) score += 0.5;
    if (redFresh.test(s)) score += 0.8;
    if (redDeep.test(s)) score -= 0.55;
  } else if (colore === "rosso") {
    if (redFresh.test(s)) score += profile.body <= 0.6 ? 1.0 : 0.6;
    if (redDeep.test(s)) score += profile.body > 0.6 || profile.tannin > 0.55 ? 1.0 : 0.55;
    if (whiteFresh.test(s)) score -= 1.15;
    if (sparklingSet.test(s)) score -= 0.6;
  }

  if (wordCount(s) > 5) score -= 0.15;
  return score;
}

function pickMotivationNotes(
  ctx: WineTextContext,
  colore: Colore,
  profile: Profile,
  lang: LangCode,
  rand: () => number,
): string[] {
  const pool = getMotivationNotesPool(ctx, lang)
    .map((s) => trimToWords(s, 4))
    .filter(Boolean);

  const ranked = pool
    .map((note) => ({
      note,
      score: noteScoreForWine(note, colore, profile) + rand() * 0.03,
    }))
    .filter((x) => x.score > 0.08)
    .sort((a, b) => b.score - a.score);

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of ranked) {
    const k = norm(item.note)
      .replace(/[^\p{L}\p{N} ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item.note);
    if (out.length >= 2) break;
  }

  if (out.length) return out;

  return pickUnique(pool, 2, rand).map((s) => trimToWords(s, 4));
}

function buildMotivation(
  colore: Colore,
  profile: Profile,
  dish: Dish,
  ctx: WineTextContext,
  reasons: PairingReason[],
  rand: () => number,
  lang: LangCode,
): string {
  const S = getSommelierLocale(lang);
  const core = lowerFirst(buildPairingCore(profile, dish, rand, lang));
const coreSentence = lang === "zh" ? core : upperFirst(core);
const reasonLines = pickReasonLines(reasons || [], lang, rand);

const rawNotes = pickMotivationNotes(
  ctx,
  colore,
  profile,
  lang,
  rand,
);

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

const reasonText = joinSentences(reasonLines, lang);

let text = "";
if (hasNotes && reasonText) {
  text = lang === "zh"
    ? `${intro}${notePart}；${reasonText}；${core}`
    : `${intro}${spacer}${notePart};${spacer}${reasonText}${spacer}${coreSentence}`;
} else if (hasNotes) {
  text = lang === "zh"
    ? `${intro}${notePart}；${core}`
    : `${intro}${spacer}${notePart};${spacer}${core}`;
} else if (reasonText) {
  text = lang === "zh"
    ? `${intro}${reasonText}；${core}`
    : `${intro}${spacer}${reasonText}${spacer}${coreSentence}`;
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

    const priors = await loadPriorsCached(headers);
    const dishKnowledge = await loadDishKnowledgeCached(headers);

    let recentLog: any[] = [];
    try {
      const recentRes = await fetch(
  `${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&select=creato_il,vini_keys,vini_ids,vini&order=creato_il.desc&limit=120`,
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

const slot6h = Math.floor(Date.now() / (1000 * 60 * 60 * 6));
const baseSeed = `${ristorante_id}|${norm(piatto)}|slot:${slot6h}`;

const rng = mulberry32(
  hashStringToSeed(baseSeed),
);

const dishResolved = resolveDishFromKnowledge(piatto, dishKnowledge);
const dish = dishResolved.dish;
const piattoNorm = normalizeSearchText(piatto);
const dishTags = new Set(
  (dishResolved.accent_tags || [])
    .map((x) => normalizeSearchText(x))
    .filter(Boolean),
);

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

    const descrizioniMap = await loadDescrizioniByFingerprint(
      headers,
      ristorante_id,
      wines0,
      safeCode,
    );

const enriched: EnrichedWine[] = wines0.map((w) => {
  const fallback = profileAndContextFromWine(
    w,
    priors,
    w.colore,
  );

  const fp = buildDescrizioneFingerprint(w, ristorante_id);
  const cacheRow = descrizioniMap.get(fp);

  const scheda = cacheRow
    ? parseWineScheda(pickSchedaRawForLang(cacheRow, safeCode))
    : emptyWineScheda();

  const persisted = parsePersistedProfile(cacheRow?.sommelier_profile);

  const mergedCtxBase = mergeSchedaIntoContext(fallback.ctx, scheda);

  const mergedCtx = persisted
    ? {
        ...mergedCtxBase,
        descNotes: [
          ...mergedCtxBase.descNotes,
          ...((persisted.signature_notes || []).map((x: any) => String(x))),
        ],
        descPairings: [
          ...mergedCtxBase.descPairings,
          ...((persisted.pairing_tags || []).map((x: any) => String(x))),
        ],
      }
    : mergedCtxBase;

  const finalColor = persisted?.color
    ? coloreFromLabel(String(persisted.color))
    : fallback.colore;

  const finalProfile = persisted?.core
    ? {
        acid: clamp01(Number(persisted.core.acid ?? fallback.profile.acid)),
        tannin: clamp01(Number(persisted.core.tannin ?? fallback.profile.tannin)),
        body: clamp01(Number(persisted.core.body ?? fallback.profile.body)),
        sweet: clamp01(Number(persisted.core.sweet ?? fallback.profile.sweet)),
        bubbles: clamp01(Number(persisted.core.bubbles ?? fallback.profile.bubbles)),
      }
    : fallback.profile;

  const __tags = buildTags(mergedCtx, finalColor);
  const __reasons = buildReasonCodes(finalProfile, dish, mergedCtx);

  return {
    ...w,
    colore: finalColor,
    __profile: finalProfile,
    __ctx: mergedCtx,
    __tags,
    __reasons,
  };
});

    const wanted = computeWanted(rangeStr, enriched.length) || 1;

const mVals = enriched.map((w) =>
  matchScore(w.__profile, dish, w.__ctx, piattoNorm, dishTags)
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

const reasonBonus = Math.min(
  0.08,
  (w.__reasons || []).slice(0, 2).reduce((s, r) => s + r.strength, 0) * 0.03,
);

const scoreRaw =
  blended + exposurePenalty + cooldownPenalty + jitter + boostBonus + reasonBonus;

      return {
        ...w,
        __q: q,
        __scoreCore: clamp01(scoreRaw),
        __isBoost: isBoost,
      };
    });

    const sorted = [...baseList].sort((a, b) =>
  ((b.__scoreCore ?? 0) - (a.__scoreCore ?? 0)) ||
  ((b.__q ?? 0) - (a.__q ?? 0))
);

const pairingSorted = [...baseList].sort((a, b) =>
  ((b.__q ?? 0) - (a.__q ?? 0)) ||
  ((b.__scoreCore ?? 0) - (a.__scoreCore ?? 0))
);

const capByProd = 1;
const capBySub = 1;
const capByGrape = 1;

const usedByProd = new Map<string, number>();
const usedBySub = new Map<string, number>();
const usedByGrape = new Map<string, number>();

const chosen: EnrichedWine[] = [];
const explorationKeys = new Set<string>();

const catastrophicMismatch = (w: EnrichedWine): boolean => {
  const p = w.__profile;

  if (dish.protein === "pesce" || dish.cooking === "crudo") {
    if (w.colore === "rosso" && (p.tannin >= 0.45 || p.body >= 0.62)) return true;
    if (w.colore === "rosso" && dish.acid_hint) return true;
  }

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

const alreadyChosen = (w: EnrichedWine) =>
  chosen.some((c) => c.__historyKey === w.__historyKey);

const addChosen = (w: EnrichedWine, isExploration = false): boolean => {
  if (!w) return false;
  if (alreadyChosen(w)) return false;

  chosen.push(w);
  registerWine(w);

  if (isExploration) {
    explorationKeys.add(w.__historyKey);
  }

  return true;
};

// 1) TOP 1: il pairing più giusto possibile
const topPairing = pairingSorted.find((w) =>
  !catastrophicMismatch(w) && canAddWine(w)
);

if (topPairing) {
  addChosen(topPairing);
}

const leaderPairingQ = topPairing?.__q ?? 0;
const boostFloorQ = Math.max(0.30, leaderPairingQ - 0.28);

const bestBoost = pairingSorted.find((w) =>
  w.__isBoost &&
  !alreadyChosen(w) &&
  !catastrophicMismatch(w) &&
  canAddWine(w) &&
  (w.__q ?? 0) >= boostFloorQ
);

// 2) SLOT 2: pairing molto fedele, ma se il boost è quasi allo stesso livello lo facciamo entrare
if (chosen.length < Math.min(2, wanted)) {
const secondPairing = pairingSorted.find((w) =>
  !alreadyChosen(w) &&
  !catastrophicMismatch(w) &&
  canAddWine(w) &&
  (w.__q ?? 0) >= Math.max(0.35, leaderPairingQ - 0.08)
);

  const useBoostInSecondSlot =
    !!bestBoost &&
    (
      !secondPairing ||
      (bestBoost.__q ?? 0) >= ((secondPairing.__q ?? 0) - 0.05)
    );

  if (useBoostInSecondSlot && bestBoost) {
    addChosen(bestBoost);
  } else if (secondPairing) {
    addChosen(secondPairing);
  }
}

// 3) BOOST del ristorante: se non è ancora entrato, prova a inserirlo subito dopo
if (chosen.length < wanted && bestBoost && !alreadyChosen(bestBoost)) {
  addChosen(bestBoost);
}

// 4) EXPLORATION solo dal terzo posto in poi
if (chosen.length < wanted) {
const explorationPool = sorted.filter((w) =>
  !alreadyChosen(w) &&
  !catastrophicMismatch(w) &&
  (w.__q ?? 0) >= Math.max(0.28, leaderPairingQ - 0.18)
);

  while (chosen.length < wanted && explorationPool.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < explorationPool.length; i++) {
      const cand = explorationPool[i];
      if (!canAddWine(cand)) continue;

      const score = mmrScore(cand, chosen, 0.65);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx < 0) break;

    const chosenOne = explorationPool.splice(bestIdx, 1)[0];
    addChosen(chosenOne, true);
  }
}

// 5) Fill finale: prima rispetta la diversità, poi solo se serve la rilassa davvero
if (chosen.length < wanted) {
const relaxedPool = pairingSorted.filter((w) =>
  !alreadyChosen(w) &&
  !catastrophicMismatch(w) &&
  (w.__q ?? 0) >= Math.max(0.22, leaderPairingQ - 0.25)
);

  for (const w of relaxedPool) {
    if (!canAddWine(w)) continue;
    addChosen(w);
    if (chosen.length >= wanted) break;
  }
}

// 6) Rete di sicurezza estrema: mai picks vuoto
if (!chosen.length) {
  for (const w of pairingSorted.slice(0, wanted || 3)) {
    if (alreadyChosen(w)) continue;
    chosen.push(w);
    if (chosen.length >= wanted) break;
  }
}

// IMPORTANTISSIMO: qui NON riordinare più per __scoreCore,
// perché l'ordine scelto sopra è già quello "umano"
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

const topSet = new Set(
  finalChosen
    .slice(0, Math.min(2, finalChosen.length))
    .map((w) => w.__historyKey),
);

const discoverySet = new Set<string>(
  finalChosen
    .filter((w) => explorationKeys.has(w.__historyKey))
    .slice(0, 1)
    .map((w) => w.__historyKey),
);

const eligibleForBand = pairingSorted.filter((w) => !catastrophicMismatch(w));

const leaderQ = eligibleForBand[0]?.__q ?? finalChosen[0]?.__q ?? 0;
const secondQ = eligibleForBand[1]?.__q ?? leaderQ;

const out = finalChosen.map((w, idx) => {
  const grape = (w.uvaggio && String(w.uvaggio).trim())
    ? String(w.uvaggio).trim()
    : "N.D.";

const wineRng = mulberry32(
  hashStringToSeed(`${baseSeed}|${w.nomeN}`),
);

  const baseMotive = buildMotivation(
    w.colore,
    w.__profile,
    dish,
    w.__ctx,
    w.__reasons || [],
    wineRng,
    safeCode,
  );

  const reasonStrength = (w.__reasons || [])
    .slice(0, 2)
    .reduce((s, r) => s + Number(r.strength || 0), 0);

  const pairingBand = getPairingBand({
    q: Number(w.__q ?? 0),
    reasonStrength,
    leaderQ,
    secondQ,
    index: idx,
  });

  const motive = prependConfidenceLabel(
    baseMotive,
    safeCode,
    pairingBand,
  );

  const __style = styleOf(w.colore, w.__profile);

  return {
    ...w,
    __style,
    grape,
    motive,
    pairing_band: pairingBand,
    pairing_confidence_label: getConfidenceLabel(safeCode, pairingBand),
  };
});

console.log(
  "PICKED",
  {
    piatto,
    lang: safeCode,
    seed: baseSeed,
    dish_source: dishResolved.source,
    matched_base_slug: dishResolved.matched_base_slug,
    matched_base_name: dishResolved.matched_base_name,
    matched_alias: dishResolved.matched_alias,
    matched_modifiers: dishResolved.matched_modifiers,
    dish_tags: Array.from(dishTags),
    dish_profile: dish,
picks: out.map((x) => ({
  nome: x.nome,
  colore: x.colore,
  q: +Number(x.__q ?? 0).toFixed(3),
  base: +Number(x.__scoreCore ?? 0).toFixed(3),
  style: x.__style,
  grape: x.grape,
  pairing_band: x.pairing_band,
  pairing_confidence_label: x.pairing_confidence_label,
  motive: x.motive,
  reasons: x.__reasons,
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