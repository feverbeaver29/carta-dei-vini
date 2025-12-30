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
  "Access-Control-Allow-Origin": "https://www.winesfever.com",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json",
};

const LANGS = {
  it: { name: "italiano", GRAPE: "UVAGGIO", MOTIVE: "MOTIVAZIONE" },
  en: { name: "English", GRAPE: "GRAPE", MOTIVE: "RATIONALE" },
  de: { name: "Deutsch", GRAPE: "REBSORTE", MOTIVE: "BEGRÜNDUNG" },
  es: { name: "Español", GRAPE: "UVA", MOTIVE: "MOTIVACIÓN" },
  fr: { name: "Français", GRAPE: "CÉPAGES", MOTIVE: "JUSTIFICATION" },
  zh: { name: "中文", GRAPE: "葡萄品种", MOTIVE: "理由" },
} as const;

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
  // campi originali + arricchiti
  [k: string]: any;
  prezzoNum: number;
  colore: Colore;
  nomeN: string;
  __producer: string;
  __uvTokens: Set<string>;
  __profile: Profile;
  __ctx: WineTextContext;
  __tags: Set<string>;
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

/** =========================
 *  COLOR PARSING
 *  ========================= */

function coloreFromLabel(labelRaw: string): Colore {
  const s = norm(labelRaw);

  // SPUMANTE / BOLLICINE
  if (
    /\b(spumante|bollicine|metodo classico|classique|champagne|franciacorta|trentodoc|saten|satèn|prosecco|col fondo|colfondo|extra\s*dry|brut|pas do[sz]e|dosaggio zero)\b/
      .test(s)
  ) return "spumante";

  // DOLCE
  if (
    /\b(dolce|passito|vendemmia tardiva|late harvest|sauternes|vin santo|zibibbo passito|moscato passito)\b/
      .test(s)
  ) return "dolce";

  // ROSATO
  if (/\b(rosato|rose|ros[eè]|vino rosato|vini rosati|cerasuolo)\b/.test(s)) {
    return "rosato";
  }

  // BIANCO
  if (/\b(bianco|bianchi|vino bianco|vini bianchi|white|blanc)\b/.test(s)) {
    return "bianco";
  }

  // RAMATO → bianco in stile ramato
  if (/\bramato\b/.test(s)) return "bianco";

  // ROSSO
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
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(x => String(x)).filter(Boolean);

  const s = String(raw).trim();
  if (!s) return [];

  // JSON array
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map(x => String(x)).filter(Boolean) : [s];
    } catch {
      return [s];
    }
  }

  // Postgres text[] style: {"a","b"} oppure {a,b}
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    // split “safe enough” per il tuo caso (virgolette e virgole)
    return inner
      .split(/",(?![^"]*")|,(?![^"]*")/g)
      .map(x => x.replace(/^"+|"+$/g, "").trim())
      .filter(Boolean);
  }

  return [s];
}

async function loadPriors(headers: Record<string, string>): Promise<Priors> {
  const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";

  // ---- grape_profiles ----
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

  // ---- appellation_priors ----
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

  // split “umano” (virgole, ;, /, &, +, e)
  const chunks = s0
    .split(/[,;\/&+]|(?:\s+e\s+)|(?:\s+ed\s+)/gi)
    .map(x => x.trim())
    .filter(Boolean);

  const temp: { key: string; pct?: number; display?: string }[] = [];

  for (const c of chunks) {
    const m = c.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const pct = m ? parseFloat(m[1].replace(",", ".")) : undefined;

    const name = norm(c.replace(/(\d+(?:[.,]\d+)?)\s*%/g, " "))
      .replace(/\b(varieta|varieta|uve|uvaggio|blend)\b/g, "")
      .trim();

    if (!name) continue;

    // prova match diretto su grape_profiles (incl. synonyms già in map)
    const gp = priors.grapesByKey.get(name);
    if (gp) {
      temp.push({ key: name, pct, display: gp.display_name });
      continue;
    }

    // fallback: a volte arriva "cabernet sauvignon" -> ok; ma se restano parole extra
    // prova a trovare una chiave contenuta (light, non costoso)
    let foundKey = "";
    for (const k of priors.grapesByKey.keys()) {
      if (k.length >= 4 && name.includes(k)) { foundKey = k; break; }
    }
    if (foundKey) {
      const gp2 = priors.grapesByKey.get(foundKey);
      temp.push({ key: foundKey, pct, display: gp2?.display_name });
    }
  }

  if (!temp.length) return [];

  const withPct = temp.filter(x => typeof x.pct === "number" && !isNaN(x.pct!));
  const withoutPct = temp.filter(x => x.pct == null);

  if (withPct.length === 0) {
    const w = 1 / temp.length;
    return temp.map(x => ({ key: x.key, weight: w, display: x.display }));
  }

  const sumPct = withPct.reduce((a, x) => a + (x.pct || 0), 0);
  const rem = Math.max(0, 100 - sumPct);
  const fill = withoutPct.length ? (rem / withoutPct.length) : 0;

  const parts = temp.map(x => ({
    key: x.key,
    display: x.display,
    weight: ((x.pct ?? fill) / 100),
  }));

  // normalizza pesi (nel caso sum>100 o stringhe strane)
  const S = parts.reduce((a, p) => a + p.weight, 0) || 1;
  return parts
    .map(p => ({ ...p, weight: p.weight / S }))
    .filter(p => p.weight > 0.0001)
    .sort((a,b) => b.weight - a.weight);
}

function profileAndContextFromWine(
  w: any,
  priors: Priors,
  coloreCategoria: Colore,
): { profile: Profile; colore: Colore; ctx: WineTextContext } {
  const uvParts = parseUvaggioWeighted(String(w.uvaggio || ""), priors);
const uvTokens = uvParts.map(p => p.key);

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
      // pesi: docg > doc > igt > altri
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

  // --- numerico (base simile a versione precedente) ---

  // sgrassare
  sc += (dish.fat * (profile.acid * 1.0 + profile.bubbles * 0.6));

  // pesce/crudo
  if (dish.protein === "pesce" || dish.cooking === "crudo") {
    sc += (profile.acid * 1.35) - (profile.tannin * 1.0);
    if (dish.acid_hint && dish.cooking !== "fritto") {
      sc += profile.acid * 0.25;
      sc -= profile.bubbles * 0.35;
    }
  }

  // fritto
  if (dish.cooking === "fritto") {
    sc += profile.bubbles * 1.3 + profile.acid * 0.8;
  }

  // brasato / carne rossa
  if (dish.protein === "carne_rossa" || dish.cooking === "brasato") {
    sc += profile.tannin * 1.8 + profile.body * 1.35 - profile.bubbles * 0.8;
    if (profile.tannin >= 0.6 && profile.body >= 0.6) sc += 0.15;
  }

  // piccante
  if (dish.spice > 0) {
    sc += profile.sweet * 1.0 - profile.tannin * 0.8 - profile.body * 0.4;
  }

  // formaggi
  if (dish.protein === "formaggio") {
    sc += profile.body * 0.6 + profile.acid * 0.2 -
      Math.max(0, profile.tannin - 0.5) * 0.3;
  }

  // salumi
  if (dish.protein === "salumi") {
    sc += profile.acid * 0.35 +
      Math.max(0, 0.55 - profile.tannin) * 0.4 +
      Math.max(0, 0.6 - profile.body) * 0.2 -
      profile.bubbles * 0.4;
  }

  // veg non fritto
  if (dish.protein === "veg" && dish.cooking !== "fritto") {
    sc += profile.acid * 0.45 -
      Math.max(0, profile.tannin - 0.25) * 0.6 -
      profile.bubbles * 0.15;
  }

  // veg intenso
  if (dish.protein === "veg" && dish.intensity >= 0.55) {
    sc += Math.max(
      0.1,
      0.35 - Math.max(0, profile.tannin - 0.55) * 0.4,
    ) + profile.body * 0.2;
  }

  // carni bianche alla griglia / arrosto
  if (dish.protein === "carne_bianca" && dish.cooking === "griglia") {
    sc += profile.body * 0.4 -
      Math.max(0, profile.tannin - 0.4) * 0.5 -
      profile.bubbles * 0.2;
  }

  // dessert
  if (dish.sweet > 0) sc += profile.sweet * 1.5;

  // accenno acido
  if (dish.acid_hint) sc += profile.acid * 0.8;

  // allineamento intensità
  sc += (1 - Math.abs(dish.intensity - profile.body)) * 0.6;

  // hard cuts
  if (
    (dish.protein === "pesce" || dish.cooking === "crudo") &&
    profile.tannin >= 0.65
  ) {
    sc -= 0.4 * (profile.tannin - 0.65);
  }

  // --- testo: pairings canonici & stile ---

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
 *  MOTIVAZIONE TESTUALE
 *  ========================= */
function lowerFirst(s: string) {
  s = (s || "").trim();
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
function pickUnique(arr: string[], n: number, rand: () => number) {
  const clean = (arr || [])
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  // preferisci note non troppo corte e non troppo lunghe
  const filtered = clean.filter((s) => {
    const wc = wordCount(s);
    return wc >= 1 && wc <= 6; // “ciliegia”, “agrumi”, “erbe mediterranee”, ecc.
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

function joinNice(list: string[]) {
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} e ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}`;
}

function pickOne(arr: string[], rand: () => number) {
  if (!arr || arr.length === 0) return "";
  return arr[Math.floor(rand() * arr.length)];
}

function buildPairingCore(profile: Profile, dish: Dish, rand: () => number) {
  const lines: string[] = [];

  const isRich = dish.fat >= 0.6 || dish.intensity >= 0.7 || dish.cooking === "brasato";
  const isDelicate = dish.intensity <= 0.45 && dish.fat <= 0.4;
  const isSpicy = dish.spice >= 0.45;

  const hasBubbles = profile.bubbles >= 0.9;
  const feelsFresh = profile.acid >= 0.6 || hasBubbles;
  const hasShoulder = profile.body >= 0.6;
  const isSoft = profile.sweet >= 0.12; // “punta di morbidezza”

// 1) frase “piatto-centric” (POOL)
if (dish.protein === "carne_rossa" || dish.cooking === "brasato") {
  const base = [
    "Sta al passo con la succulenza e la lunga cottura, senza perdere ritmo",
    "Tiene testa al piatto e lo accompagna fino in fondo, boccone dopo boccone",
    "Con questo piatto serve un rosso con spalla: qui non si siede mai",
    "Fa da struttura al piatto: sostiene la carne e pulisce il finale",
    "È centrato: regge la parte intensa senza diventare pesante",
    "Sulla lunga cottura funziona perché resta teso e non si appiattisce",
    "Si incastra bene con la parte pepata e la profondità del sugo",
    "Ha passo lungo: accompagna la masticazione e chiude asciutto",
    "È un rosso “da tavola”: sostiene il piatto senza sovrastarlo",
    "Fa ordine nel boccone: intensità giusta e finale pulito",
  ];
  lines.push(pickOne(base, rand));

} else if (dish.protein === "carne_bianca") {
  const base = [
    "Accompagna la carne bianca con equilibrio, senza coprire i sapori",
    "È un abbinamento morbido: sostiene il piatto ma resta elegante",
    "Sta bene perché non appesantisce e lascia il boccone pulito",
    "Sulla carne bianca funziona perché resta preciso e scorrevole",
    "Tiene il centro bocca pieno ma con un finale asciutto",
    "Fa da spalla al piatto senza diventare invadente",
    "Rispetta la delicatezza, ma dà comunque soddisfazione al sorso",
    "È centrato: sapore, ma sempre con misura",
  ];
  lines.push(pickOne(base, rand));

} else if (dish.protein === "pesce" || dish.cooking === "crudo") {
  const base = [
    "È preciso sul pesce: resta armonico e non indurisce il boccone",
    "Sul crudo è perfetto perché è pulito e ti lascia la bocca fresca",
    "Sta bene perché accompagna senza coprire la delicatezza del piatto",
    "Funziona: bevi e hai subito voglia di un altro boccone",
    "È un sorso “marino”: pulito, dritto e molto gastronomico",
    "Tiene tutto in equilibrio e valorizza la parte più fine del piatto",
    "Non fa a pugni con l’ittico: resta scorrevole e preciso",
    "È l’abbinamento che non sbaglia: pulizia e armonia",
  ];

  const pool = (dish.cooking === "crudo")
    ? base
    : base.filter(s => !/crudo/i.test(s));

  lines.push(pickOne(pool, rand));

} else if (dish.protein === "salumi") {
  const base = [
    "Con i salumi funziona perché ti pulisce la bocca e invoglia l’assaggio successivo",
    "È perfetto per i salumi: alleggerisce il grasso e resta scorrevole",
    "Ti tiene il palato vivo tra un taglio e l’altro",
    "Sta bene perché non diventa pesante e non impasta",
    "Fa da “reset” tra un boccone e l’altro",
    "Tiene insieme sapidità e grassezza con naturalezza",
    "È un abbinamento da aperitivo serio: pulito e gastronomico",
    "Con i salumi fa il suo lavoro: alleggerisce e rilancia",
  ];
  lines.push(pickOne(base, rand));

} else if (dish.protein === "formaggio") {
  const base = [
    "Con il formaggio regge sapidità e maturazione senza impastare",
    "Sta bene perché accompagna la cremosità e chiude pulito",
    "Funziona: sostiene il gusto del formaggio e resta equilibrato",
    "È centrato perché non diventa stucchevole con la parte grassa",
    "Tiene il boccone ordinato e lascia una bella freschezza finale",
    "Con il formaggio fa da spalla e non si perde",
    "È un abbinamento che scorre: niente pesantezza, solo armonia",
    "Si incastra bene con la sapidità e rende il sorso più invitante",
  ];
  lines.push(pickOne(base, rand));

} else {
  // veg / altro
  const base = [
    "Resta agile e gastronomico: sostiene il sapore, ma lascia il piatto protagonista",
    "È un abbinamento pulito: accompagna e non invade",
    "Sta bene perché dà slancio senza coprire i dettagli",
    "È preciso: sorso scorrevole e molto “da tavola”",
    "Fa compagnia al piatto senza prendersi la scena",
    "È quello che scegli quando vuoi equilibrio e bevibilità",
    "Tiene il ritmo del piatto e chiude asciutto",
    "Rispetta i sapori e rende il boccone più leggero",
  ];
  lines.push(pickOne(base, rand));
}

  // 2) dettaglio “meccanico” ma detto da sala
  if (dish.cooking === "fritto" || dish.fat >= 0.6) {
    if (hasBubbles) {
  const base = [
    "La bollicina fa da spazzolino: ripulisce e alleggerisce ogni boccone",
    "La bolla pulisce il palato e rende il boccone più leggero",
    "Con il fritto è perfetto: bollicina e freschezza fanno reset",
    "La bollicina sgrassa e ti prepara subito al boccone successivo",
    "È il classico abbinamento da fritto: croccantezza fuori, bocca pulita dentro",
  ];
  lines.push(pickOne(base, rand));
}
    else if (feelsFresh) {
  const base = [
    "Ha lo slancio giusto per sgrassare e tenere il palato vivo",
    "Ripulisce bene e rende il boccone più leggero",
    "Dà freschezza e ti invita al sorso successivo",
    "Fa da reset tra un boccone e l’altro",
    "Tiene la bocca pulita e non stanca",
  ];
  lines.push(pickOne(base, rand));
}
  }

if (isSpicy && rand() < 0.9) {
  if (isSoft) {
    const base = [
      "Ha una punta di morbidezza che fa da cuscino al piccante",
      "La morbidezza smussa il piccante e rende il sorso più rotondo",
      "Addolcisce gli spigoli del peperoncino e resta piacevole",
      "Ha quel minimo di dolcezza che spegne il fuoco e rilancia il gusto",
      "Fa da “cuscino” al piccante: bocca più calma e sorso più fluido",
    ];
    lines.push(pickOne(base, rand));
  } else {
    const base = [
      "Non spinge sul calore: accompagna il piccante senza farlo salire",
      "Resta fresco e lineare: non amplifica la speziatura",
      "Tiene il piccante in equilibrio, senza asciugare troppo la bocca",
      "È un sorso controllato: non accende il peperoncino",
      "Sta sul filo giusto: accompagna la spezia senza farla dominare",
    ];
    lines.push(pickOne(base, rand));
  }
}

if (dish.acid_hint && rand() < 0.75) { // 75%: così non appare sempre identica
  const base = [
    "Si aggancia bene alla parte più fresca/acidula del piatto e lo rende più armonico",
    "Dialoga con l’acidità del piatto e tiene il sorso dritto",
    "Sta benissimo sul pomodoro: accompagna la parte fresca senza coprirla",
    "Sulla componente acida resta pulito e non si scompone",
    "Resta preciso sull’acidità e lascia la bocca più “pulita”",
  ];
  lines.push(pickOne(base, rand));
}


  // intensità (detta bene)
  if (isRich && hasShoulder) {
  const base = [
    "Ha abbastanza spalla per non farsi mettere in ombra",
    "Resta presente anche con un piatto importante",
    "Ha struttura sufficiente per reggere il boccone",
    "Non si perde: accompagna fino al finale",
    "Tiene bene il ritmo anche sulla parte più intensa",
  ];
  lines.push(pickOne(base, rand));
}

if (isDelicate && !hasShoulder && rand() < 0.85) {
  const base = [
    "È snello: non invade e ti lascia gustare i dettagli del piatto",
    "Resta leggero e preciso: accompagna senza coprire",
    "È tutto giocato sulla misura: sorso agile e boccone protagonista",
    "Ha un profilo fine: valorizza il piatto senza alzare la voce",
    "Scorrevole e pulito, così il piatto resta al centro",
    "È essenziale e gastronomico: non appesantisce, ma dà continuità",
  ];
  lines.push(pickOne(base, rand));
}

  // pick 2 frasi, massimo naturale
  const pool = Array.from(new Set(lines.filter(Boolean)));
  const chosen: string[] = [];
  while (chosen.length < 2 && pool.length) {
    const idx = Math.floor(rand() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]);
  }

  const text = chosen.join(". ").replace(/\s+/g, " ").trim();
const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
const final = parts.slice(0, 2).join(" ").trim();
return final.endsWith(".") ? final : final + ".";
}

function buildMotivation(
  profile: Profile,
  dish: Dish,
  ctx: WineTextContext,
  rand: () => number,
): string {
  const core = lowerFirst(buildPairingCore(profile, dish, rand));

  // prendi 1–2 note tra tasting/typical (senza diventare prolissi)
const rawNotes = pickUnique(
  [...(ctx.tastingNotes || []), ...(ctx.typicalNotes || [])],
  4, // prendo più roba e poi filtro
  rand,
).map((s) => trimToWords(s, 4));

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

  // intro “da sala” (variazione)
const intros = [
  "Io lo sceglierei perché",
  "È un abbinamento che funziona perché",
  "Qui ci sta benissimo:",
  "Se vuoi andare sul sicuro:",
  "Secondo me è centrato perché",
  "Da sommelier te lo dico: ",
  "Se vuoi un sorso “giusto”,",
  "È una scelta elegante perché",
];
  const intro = intros[Math.floor(rand() * intros.length)];

  let text = "";
  if (hasNotes) {
const notePart = `ti porta ${joinNice(notes)};`;
text = `${intro} ${notePart} ${core}`;
  } else {
    text = `${intro} ${core}`;
  }

  // compatto, una riga, niente spiegoni
  text = text.replace(/\s+/g, " ").trim();

let final = text;

if (wordCount(final) > 34) {
  // prova a tenere solo la prima frase (o le prime 2 se ci stanno)
  const sents = final.split(/(?<=[.!?])\s+/).filter(Boolean);
  let acc = "";
  for (const s of sents) {
    const candidate = acc ? `${acc} ${s}` : s;
    if (wordCount(candidate) <= 34) acc = candidate;
    else break;
  }
  final = acc || trimToWords(sents[0] || final, 34);
}

// pulizia finale: evita che finisca con "e" / "ed" / ";"
final = final.replace(/\b(e|ed)\s*$/i, "").trim();
final = final.replace(/;\s*$/g, "").trim();

// micro-firma da sala (raramente), dà identità senza essere ripetitiva
if (rand() < 0.28) {
  const closers = [
    "Da tavola vera.",
    "Molto gastronomico.",
    "Bevibilità altissima.",
    "Equilibrio e pulizia.",
    "Sorso preciso, finale pulito.",
    "Scorrevole e centrato.",
  ];
  const c = pickOne(closers, rand);
  // evita doppia chiusura se già lunghissimo
  if (wordCount(final) <= 28) final = `${final} ${c}`;
}
return final.endsWith(".") ? final : final + ".";
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

    const code = String(lang || "it").toLowerCase();
    const L = LANGS[code === "gb" ? "en" : code] || LANGS.it;

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

    // ---- config ristorante ----
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

    // ---- priors ----
    const priors = await loadPriors(headers);

    // ---- exposure logs ----
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

    // cooldown set (ultimi N suggerimenti)
    const COOL_N = 80;
    const coolList: string[] = [];
    for (const r of recentLog) {
      for (const nome of (r.vini || [])) {
        const n = norm(nome);
        if (!coolList.includes(n)) coolList.push(n);
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
      const w = decay(String(r.creato_il || ""));
      (r.vini || []).forEach((nome: string) => {
        const n = norm(nome);
        expByWine[n] = (expByWine[n] || 0) + w;
      });
    });

    // seed stabile (per giorno)
    const day = new Date().toISOString().slice(0, 10);
    const rng = mulberry32(
      hashStringToSeed(`${ristorante_id}|${norm(piatto)}|${day}`),
    );

    // ---- parse piatto (GPT + fallback) ----
    const dish = await getDishFeatures(piatto, Deno.env.get("OPENAI_API_KEY"));
    const piattoNorm = norm(piatto);

    // ---- normalizza vini, prezzo, colore, filtri ----
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
        const __uvTokens = new Set(splitGrapes(String(v.uvaggio || "")).map(
          norm,
        ));

        return {
          ...v,
          prezzoNum,
          colore: coloreCat,
          nomeN,
          __producer,
          __uvTokens,
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

    // ---- arricchisci con profilo & contesto text ----
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

    // ---- punteggi (match + esplorazione) ----
    const mVals = enriched.map((w) =>
      matchScore(w.__profile, dish, w.__ctx, piattoNorm)
    );
    const mMin = Math.min(...mVals);
    const mMax = Math.max(...mVals);
    const mRange = (mMax - mMin) || 1;
    const mNorm = (m: number) => (m - mMin) / mRange;

    const totalViews = Object.values(expByWine).reduce((a, b) => a + b, 0) ||
      1;
    const C = 0.30;

    const baseList: EnrichedWine[] = enriched.map((w, idx) => {
      const q = mNorm(mVals[idx]);
      const views = expByWine[w.nomeN] || 0;
      const explore = C *
        Math.sqrt(Math.log(totalViews + Math.E) / (views + 1));
      const blended = 0.82 * q + 0.18 * explore;

      const exposurePenalty = -0.1 *
        Math.pow((views / (totalViews || 1)), 0.7);
      const cooldownPenalty = coolSet.has(w.nomeN) ? -0.25 : 0;
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

    // ---- ordina per scoreCore ----
    const sorted = [...baseList].sort((a, b) =>
      (b.__scoreCore ?? 0) - (a.__scoreCore ?? 0)
    );

    // ---- caps per diversità ----
    const capByProd = 1;
    const capBySub = 1;
    const capByGrape = wanted <= 3 ? 1 : 2;

    const usedByProd = new Map<string, number>();
    const usedBySub = new Map<string, number>();
    const usedByGrape = new Map<string, number>();

    const chosen: EnrichedWine[] = [];

    const catastrophicMismatch = (w: EnrichedWine): boolean => {
      const p = w.__profile;
      // pesce/crudo con rossi molto tannici e dolcezza nulla
      if (
        (dish.protein === "pesce" || dish.cooking === "crudo") &&
        w.colore === "rosso" &&
        p.tannin >= 0.8 &&
        p.sweet <= 0.05
      ) return true;
      // dessert con vino secco
      if (dish.sweet > 0.4 && p.sweet < 0.25) return true;
      // piatto molto piccante con tannino altissimo
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

    // ---- 1) garantisci almeno un BOOST (se sensato) ----
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

    // ---- 2) 1–2 vini mai visti ----
    const neverSeen = sorted.filter((w) =>
      (expByWine[w.nomeN] || 0) === 0 && !catastrophicMismatch(w)
    );
    for (const w of neverSeen) {
      if (chosen.length >= Math.min(2, wanted)) break;
      if (chosen.some((c) => c.nomeN === w.nomeN)) continue;
      if (!canAddWine(w)) continue;
      chosen.push(w);
      registerWine(w);
    }

    // ---- 3) riempi con MMR ----
    const already = new Set(chosen.map((w) => w.nomeN));
    const pool = sorted.filter((w) => !already.has(w.nomeN));

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

    // ---- stile icona ----
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

    // top & discovery
    const topByScore = [...finalChosen].sort((a, b) =>
      (b.__scoreCore ?? 0) - (a.__scoreCore ?? 0)
    ).slice(0, Math.min(2, finalChosen.length));
    const topSet = new Set(topByScore.map((w) => w.nomeN));

    let discoveryWine: EnrichedWine | null = null;
    let worstAvgSim = Infinity;
    for (const cand of finalChosen) {
      if (topSet.has(cand.nomeN)) continue;
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
      discoveryWine ? [discoveryWine.nomeN] : [],
    );

    const out = finalChosen.map((w) => {
      const grape = (w.uvaggio && String(w.uvaggio).trim())
        ? String(w.uvaggio).trim()
        : "N.D.";
const wineRng = mulberry32(
  hashStringToSeed(`${ristorante_id}|${norm(piatto)}|${day}|${w.nomeN}`),
);

const motive = buildMotivation(w.__profile, dish, w.__ctx, wineRng);

      const __style = styleOf(w.colore, w.__profile);

      return {
        ...w,
        __style,
        grape,
        motive,
      };
    });

    // logging sintetico server-side
console.log(
  "PICKED",
  {
    piatto,
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

    // persist log
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
          boost_inclusi: out.some((w) => w.__isBoost),
          sottocategoria: out[0]?.sottocategoria || null,
        }),
      });
    } catch {
      // non bloccare la risposta se il log fallisce
    }

    // output testuale per UI
    const rows = out.map((w) => {
      const isBoost = !!w.__isBoost;
      const parts = [
        isBoost ? ICONS.boosted : "",
        topSet.has(w.nomeN) ? ICONS.top : "",
        discoverySet.has(w.nomeN) ? ICONS.discovery : "",
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