// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.26.0/mod.ts";

const openai = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY")! });

// ---------- Supabase ----------
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ---------- CORS ----------
const ALLOWED_ORIGIN = "https://www.winesfever.com";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json"
};
const ENGINE_VERSION = 2;

// ---------- Utils ----------
const clamp01 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function fingerprintName(nome: string): string {
  if (!nome) return "";
  const stop = new Set([
    "il","lo","la","i","gli","le","l","un","una","uno",
    "del","della","dei","degli","delle","di","de","da","d",
    "e","ed","the","and","of"
  ]);
  const base = nome
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/["“”'’(),.;:]/g, " ")
    .replace(/&/g, " e ")
    .replace(/\b(19|20)\d{2}\b/g, " ");

  const tokens = base
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .filter(w => !stop.has(w));

  tokens.sort();
  return tokens.join("-");
}

function norm(s?: string) {
  return (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function capChipWords(token: string, maxWords = 2): string {
  const parts = token.split(/\s+/).filter(Boolean);
  return parts.slice(0, maxWords).join(" ");
}
function normalizeChipBase(token: string): string {
  // Allinea varianti a voci whitelist
  let t = sanitizeToken(token);
  // erbe mediterranee -> erbe (più compatto per i chip)
  if (t === "erbe mediterranee") t = "erbe";
  return t;
}

/**
 * Evita duplicati semantici tra "agrumi" e specifici (limone/pompelmo).
 * Regola: se è presente un agrume specifico (limone o pompelmo),
 * rimuoviamo "agrumi" per non avere chip quasi identici.
 */
function dedupeCitrus(tokens: string[]): string[] {
  const set = new Set(tokens);
  const hasSpecific = set.has("limone") || set.has("pompelmo");
  if (hasSpecific && set.has("agrumi")) {
    set.delete("agrumi");
  }
  return Array.from(set);
}
function normalizeAndCapNotes(tokens: string[], max = 3): string[] {
  // NOTE: normalizza + cap a 2 parole
  let out = tokens.map(normalizeChipBase);
  out = out.map(t => capChipWords(t)); // cap a 2 parole SOLO per NOTE
  out = dedupeCitrus(out);
  out = uniqPreserve(out);
  return out.slice(0, max);
}

function normalizePairs(tokens: string[], max = 3): string[] {
  // PAIRINGS: normalizza ma NON cappare (per non tagliare "primi al ragù")
  let out = tokens.map(normalizeChipBase);
  // niente capChipWords qui
  out = uniqPreserve(out);
  return out.slice(0, max);
}

// Parsing robusto: accetta array JS, JSON string, Postgres text[] "{...}", o stringa con virgole
function toArray(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") {
    const s = val.trim();
    // JSON array?
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
      try {
        // prima prova JSON (["a","b"])
        if (s.startsWith("[")) {
          const arr = JSON.parse(s);
          return Array.isArray(arr) ? arr.map(String) : [];
        }
        // poi Postgres text[] {"a","b"} -> cerca token tra virgolette
        const m = s.match(/"([^"]+)"/g);
        if (m) return m.map(x => x.slice(1, -1));
        // fallback: split su virgola
        return s.replace(/[{}]/g, "").split(",").map(x => x.trim()).filter(Boolean);
      } catch {
        // fallback: split su virgola
        return s.replace(/[{}]/g, "").split(",").map(x => x.trim()).filter(Boolean);
      }
    }
    // fallback generico "a,b,c"
    return s.split(",").map(x => x.trim()).filter(Boolean);
  }
  // ultimo fallback
  return String(val).split(",").map(x => x.trim()).filter(Boolean);
}

function sanitizeToken(x: string): string {
  return x
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bspezie\b/, " pepe nero") // allinea "spezie" al tuo vocabolario
    .trim();
}

function uniqPreserve<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of arr) {
    const k = typeof a === "string" ? a.toLowerCase() : JSON.stringify(a);
    if (!seen.has(k)) { seen.add(k); out.push(a); }
  }
  return out;
}
type GrapeRow = {
  display_name?: string;
  grape_norm?: string;
  acid?: number; tannin?: number; body?: number; sweet?: number; bubbles?: number;
  tasting_notes?: any;   // può essere text[] o json
  pairings?: any;        // può essere text[] o json
  style_hints?: any;     // può essere text[] o json
  text_summary?: any;    // può essere testo o json
};

function buildAllowedVocab(
  baseNotes: readonly string[],
  basePairs: readonly string[],
  denomRow: any | null,
  grapeRows: GrapeRow[]
) {
  const extraNotes: string[] = [];
  const extraPairs: string[] = [];

  // dalla denominazione
  if (denomRow) {
    extraNotes.push(...toArray(denomRow?.typical_notes));
    extraPairs.push(...toArray(denomRow?.typical_pairings));
  }
  // dai vitigni
  for (const g of grapeRows) {
    extraNotes.push(...toArray(g?.tasting_notes));
    extraPairs.push(...toArray(g?.pairings));
  }

  // normalizza
  const normNotes = uniqPreserve(extraNotes.map(sanitizeToken)).filter(Boolean);
  const normPairs = uniqPreserve(extraPairs.map(sanitizeToken)).filter(Boolean);

  // unione con le whitelist base
  const allowedNotes = uniqPreserve([...baseNotes, ...normNotes]);
  const allowedPairings = uniqPreserve([...basePairs, ...normPairs]);

  return { allowedNotes, allowedPairings };
}

// Seme NOTE e PAIRINGS con priorità: denom → vitigni → fallback
function buildSeeds(
  color: "rosso"|"bianco"|"rosato",
  profile: Profile,
  denomRow: any | null,
  grapeRows: GrapeRow[],
  allowedNotes: string[],
  allowedPairings: string[]
) {
  // NOTE
  const seedNotesOrdered = [
    ...toArray(denomRow?.typical_notes),
    ...grapeRows.flatMap(g => toArray(g?.tasting_notes)),
  ].map(sanitizeToken).filter(Boolean);

  let notesSeed = uniqPreserve(seedNotesOrdered).filter(x => allowedNotes.includes(x)).slice(0, 3);
  if (notesSeed.length < 3) {
    // completa con vecchia logica hints → pickNotes
    const grapeHintsRaw: string[] = [];
    for (const g of grapeRows) {
      const key = sanitizeToken(g?.grape_norm || g?.display_name || "");
      if (GRAPE_NOTE_HINTS[key]) grapeHintsRaw.push(...GRAPE_NOTE_HINTS[key]);
    }
    const legacy = uniqPreserve(pickNotes(color, grapeHintsRaw).map(sanitizeToken))
      .filter(x => allowedNotes.includes(x));
    notesSeed = uniqPreserve([...notesSeed, ...legacy]).slice(0, 3);
  }

  // PAIRINGS
  const seedPairsOrdered = [
    ...toArray(denomRow?.typical_pairings),
    ...grapeRows.flatMap(g => toArray(g?.pairings)),
  ].map(sanitizeToken).filter(Boolean);

  let pairSeed = uniqPreserve(seedPairsOrdered).filter(x => allowedPairings.includes(x)).slice(0, 3);
  if (pairSeed.length < 3) {
    const legacyPairs = pickPairings(color, profile).map(sanitizeToken)
      .filter(x => allowedPairings.includes(x));
    pairSeed = uniqPreserve([...pairSeed, ...legacyPairs]).slice(0, 3);
  }

  return { notesSeed, pairSeed };
}

function rankNotesByProfile(
  candidates: string[],
  color: "rosso"|"bianco"|"rosato",
  p: Profile,
  styleHints: string[]
): string[] {
  const S = new Map<string, number>();
  const add = (k: string, v: number) => S.set(k, (S.get(k) || 0) + v);

  const style = styleHints.join(" ");

  for (const c of candidates) {
    add(c, 0); // base

    // Acidità alta -> agrumi/citrus/floreale
    if (p.acid >= 65) {
      if (["agrumi","limone","pompelmo"].includes(c)) add(c, 3);
      if (["fiori bianchi","violetta"].includes(c)) add(c, 1);
      if (["frutta gialla","pesca","pera","mela"].includes(c)) add(c, 1);
    }

    // Tannino alto -> spezia/struttura
    if (color === "rosso" && p.tannin >= 60) {
      if (["pepe nero","liquirizia","tabacco","cuoio","terroso","chiodo di garofano","cannella"].includes(c)) add(c, 3);
      if (["amarena","prugna","mora","ribes nero"].includes(c)) add(c, 1);
    }

    // Corpo pieno -> frutto scuro/spezie
    if (p.body >= 65) {
      if (["prugna","mora","ribes nero"].includes(c)) add(c, 2);
      if (["cannella","chiodo di garofano","pepe nero","liquirizia"].includes(c)) add(c, 1);
    }

    // Corpo leggero + acidità alta -> frutto rosso / agrumi / floreale
    if (p.body <= 40 && p.acid >= 60) {
      if (["ciliegia","fragola","frutta rossa","agrumi","limone","pompelmo","fiori bianchi","violetta"].includes(c)) add(c, 2);
    }

    // Stile/hints che contengono "fine", "floreale", "elegante" -> alza floreali e frutto rosso
    if (/fine|floreal|elegan/i.test(style)) {
      if (["fiori bianchi","violetta","rosa secca","ciliegia","frutta rossa"].includes(c)) add(c, 2);
    }

    // Stile/hints che contengono "speziato", "materico", "strutturato"
    if (/speziat|materic|struttur/i.test(style)) {
      if (["pepe nero","liquirizia","cannella","chiodo di garofano","tabacco","cuoio"].includes(c)) add(c, 2);
    }

    // Territoriale "minerale/sapido"
    if (/sapid|miner/i.test(style)) {
      if (["minerale","agrumi","pompelmo","limone"].includes(c)) add(c, 1);
    }
  }

  return [...candidates].sort((a,b) => (S.get(b)! - S.get(a)!));
}

// ---------- Vocabolari ammessi ----------
const ALLOWED_NOTES = {
  rosso: ["ciliegia","amarena","prugna","mora","ribes nero","violetta","rosa secca","pepe nero","cannella","chiodo di garofano","liquirizia","tabacco","cuoio","terroso","balsamico","erbe mediterranee"],
  bianco:["agrumi","limone","pompelmo","frutta gialla","pesca","pera","mela","fiori bianchi","erbe","minerale"],
  rosato:["frutta rossa","fragola","lampone","melograno","floreale","erbe"]
} as const;

const ALLOWED_PAIRINGS = {
  rosso: ["primi al ragù","carni rosse","formaggi stagionati","selvaggina","brasati"],
  bianco:["antipasti di pesce","primi di pesce","carni bianche","formaggi freschi","fritture"],
  rosato:["salumi","fritture","cucina mediterranea","carni bianche","formaggi freschi"]
} as const;

const EMOJI = {
  notes: new Map<string,string>([
    ["ciliegia","🍒"],["amarena","🍒"],["prugna","🟣"],["mora","🫐"],["ribes nero","🫐"],
    ["violetta","🌸"],["rosa secca","🌹"],["pepe nero","⚫️"],["cannella","🟤"],["chiodo di garofano","🟤"],
    ["liquirizia","🖤"],["tabacco","🍂"],["cuoio","👞"],["terroso","⛰️"],["balsamico","🌿"],["erbe mediterranee","🌿"],
    ["agrumi","🍋"],["limone","🍋"],["pompelmo","🍊"],["frutta gialla","🍑"],["pesca","🍑"],
    ["pera","🍐"],["mela","🍏"],["fiori bianchi","🌼"],["erbe","🌿"],["minerale","⛰️"],
    ["frutta rossa","🍓"],["fragola","🍓"],["lampone","🍓"],["melograno","🔴"],["floreale","🌸"]
  ]),
  pair: new Map<string,string>([
    ["antipasti di pesce","🐟"],["primi di pesce","🍝"],["carni bianche","🍗"],["carni rosse","🥩"],
    ["formaggi freschi","🧀"],["formaggi stagionati","🧀"],["primi al ragù","🍝"],["fritture","🍤"],
    ["salumi","🍖"],["cucina mediterranea","🍅"],["selvaggina","🦌"],["brasati","🍲"]
  ])
};

// Note sintetiche per vitigno
const GRAPE_NOTE_HINTS: Record<string, string[]> = {
  "sangiovese": ["ciliegia","violetta","pepe nero"],
  "nebbiolo": ["rosa secca","ciliegia","liquirizia"],
  "barbera": ["ciliegia","prugna","erbe"],
  "merlot": ["prugna","mora","cannella"],
  "cabernet sauvignon": ["ribes nero","pepe nero","liquirizia"],
  "syrah": ["mora","pepe nero","violetta"],
  "aglianico": ["prugna","terroso","liquirizia"],
  "primitivo": ["prugna","amarena","pepe nero"],
  "nerodavola": ["amarena","erbe mediterranee","pepe nero"],
  "vermentino": ["agrumi","erbe","minerale"],
  "chardonnay": ["frutta gialla","mela","fiori bianchi"],
  "sauvignon": ["agrumi","erbe","fiori bianchi"],
  "garganega": ["pera","fiori bianchi","minerale"],
  "fiano": ["frutta gialla","erbe","minerale"],
  "greco": ["agrumi","minerale","fiori bianchi"],
  "verdicchio": ["agrumi","mela","minerale"],
  "pinot nero": ["ciliegia","fragola","violetta"],
  "pinot bianco": ["pera","mela","fiori bianchi"]
};

// ---------- Heuristics colore ----------
function guessColor(meta: { nome?: string; categoria?: string; sottocategoria?: string; uvaggio?: string }): "rosso"|"bianco"|"rosato" {
  const T = (s:string)=> (s||"").toLowerCase();
  const all = [meta.nome, meta.categoria, meta.sottocategoria, meta.uvaggio].map(T).join(" ");
  if (/\brosat[oi]\b|ros[eé]\b|cerasuol[oa]\b/.test(all)) return "rosato";
  if (/\bbianc[oi]\b|blanc[s]?\b|metodo\s+classico|spumante|brut|pas\s+dos[èe]|extra\s+brut|dosaggio\s+zero|blanc\s*de\s*blancs/.test(all)) return "bianco";
  if (/\bross[oi]\b/.test(all)) return "rosso";
  if (/\bchardonnay|vermentino|fiano|greco|garganega|friulano|verdicchio|sauvignon|pinot\s+bianco\b/.test(all)) return "bianco";
  return "rosso";
}

// ---------- Parsing uvaggio ----------
type GrapePart = { name: string; pct: number };
function parseUvaggio(uvaggio?: string): GrapePart[] {
  const s = uvaggio || "";
  const parts = s.split(/[,;+/]| e |\&/i).map(x=>x.trim()).filter(Boolean);
  const out: GrapePart[] = [];
  let totalPct = 0;

  for (const p of parts) {
    const m1 = p.match(/(\d{1,3})\s*%/);
    const m2 = p.replace(/\d{1,3}\s*%/g, "").trim();
    if (m1) {
      const pct = Math.min(100, Math.max(0, parseInt(m1[1])));
      const name = m2 || p.replace(/\d{1,3}\s*%/g, "").trim();
      out.push({ name, pct });
      totalPct += pct;
    } else {
      out.push({ name: p, pct: 0 });
    }
  }
  if (out.length && totalPct === 0) {
    const eq = Math.round(100 / out.length);
    return out.map(g => ({ ...g, pct: eq }));
  }
  const sum = out.reduce((a,b)=>a+b.pct,0) || 100;
  return out.map(g => ({ ...g, pct: Math.round(100 * g.pct / sum) }));
}

// ---------- Lookup ----------
async function fetchGrapeRow(name: string) {
  const key = norm(name).replace(/\s+/g," ");
  let { data } = await supabase
    .from("grape_profiles")
    .select("*")
    .eq("grape_norm", key)
    .maybeSingle();

  if (!data) {
    const bySyn = await supabase
      .from("grape_profiles")
      .select("*")
      .contains("synonyms", [key])
      .maybeSingle();
    data = bySyn.data || null;
  }
  return data;
}

async function fetchAppellationDenom(candidates: string[]) {
  for (const c of candidates) {
    let { data } = await supabase
      .from("appellation_priors")
      .select("*")
      .eq("denom_norm", c)
      .maybeSingle();
    if (data) return data;

    const bySyn = await supabase
      .from("appellation_priors")
      .select("*")
      .contains("synonyms", [c])
      .maybeSingle();
    if (bySyn.data) return bySyn.data;
  }
  return null;
}

// ---------- Fusione profili ----------
type Profile = { acid:number; tannin:number; body:number; sweet:number; bubbles:number };
const emptyProfile: Profile = { acid:50, tannin:50, body:50, sweet:5, bubbles:0 };

function mergeWeighted(profiles: {p:Profile, w:number}[]): Profile {
  let A=0, T=0, B=0, S=0, U=0, W=0;
  for (const {p,w} of profiles) {
    A += p.acid * w; T += p.tannin * w; B += p.body * w; S += p.sweet * w; U += p.bubbles * w; W += w;
  }
  if (!W) return { ...emptyProfile };
  return {
    acid: clamp01(A/W),
    tannin: clamp01(T/W),
    body: clamp01(B/W),
    sweet: clamp01(S/W),
    bubbles: clamp01(U/W),
  };
}

// ---------- Testi (Sommelier Mini-Card) ----------
function pickNotes(color: "rosso"|"bianco"|"rosato", grapeHints: string[]): string[] {
  const allow = new Set(ALLOWED_NOTES[color]);
  const cleaned = grapeHints
    .map(n => n.toLowerCase().replace("spezie","pepe nero"))
    .filter(n => allow.has(n));
  const uniq = Array.from(new Set(cleaned));
  const fill = ALLOWED_NOTES[color].filter(n => !uniq.includes(n));
  return uniq.concat(fill).slice(0,3);
}

function structureText(p: Profile, color: "rosso"|"bianco"|"rosato") {
  const bodyTxt = p.body < 40 ? "corpo leggero" : p.body > 70 ? "corpo pieno" : "corpo medio";
  const acidTxt = p.acid < 40 ? "acidità morbida" : p.acid > 65 ? "acidità vivace" : "acidità equilibrata";
  const tanTxt  = color === "rosso"
    ? (p.tannin < 35 ? "tannino fine" : p.tannin > 65 ? "tannino presente" : "tannino fine")
    : "";
  return { bodyTxt, acidTxt, tanTxt };
}

function capLen(s: string, max: number) {
  return s.length <= max ? s : (s.slice(0, max-1).replace(/\s+\S*$/,"") + "…");
}

function buildHook(aromas: string[], color: "rosso"|"bianco"|"rosato", bubbles: number) {
  const two = aromas.slice(0,2).join(" e ");
  const fr = two ? `Profuma di ${two}` : (color==="bianco" ? "Profuma di frutta e fiori bianchi" : color==="rosato" ? "Profuma di frutta rossa e fiori" : "Profumi di frutto e spezia");
  const eff = bubbles > 20 ? " e una bolla fine" : "";
  const spiceHint = /pepe|cannella|chiodo|liquirizia/.test(two) ? "" : (color!=="bianco" ? " con un tocco speziato" : "");
  return capLen(`${fr}${spiceHint}${eff}.`, 110);
}

function buildPalate(p: Profile, color: "rosso"|"bianco"|"rosato") {
  const { bodyTxt, acidTxt, tanTxt } = structureText(p, color);
  const chunks = [bodyTxt, acidTxt, tanTxt].filter(Boolean).join(", ");
  const coda = p.acid >= 60 ? "beva scorrevole e sapida" : "beva morbida e pulita";
  return capLen(`${chunks}: ${coda}.`, 120);
}

function applyPalateTemplate(
  template: string,
  p: Profile,
  color: "rosso"|"bianco"|"rosato"
) {
  const { bodyTxt, acidTxt, tanTxt } = structureText(p, color);
  const coda = p.acid >= 60 ? "beva scorrevole e sapida" : "beva morbida e pulita";
  const tanSpacer = tanTxt ? ", " : ""; // virgola solo se il tannino esiste (rossi)

  const out = template
    .replace(/\{body_txt\}/g, bodyTxt)
    .replace(/\{acid_txt\}/g, acidTxt)
    .replace(/\{tan_txt\}/g, tanTxt)
    .replace(/\{tan_spacer\}/g, tanSpacer)
    .replace(/\{coda\}/g, coda);

  return capLen(out.endsWith(".") ? out : (out + "."), 120);
}

// Hook “umano” che usa aromi reali + hints/terroir + micro-beneficio dai pairing
function buildHookV2(
  aromas: string[],                  // es. notesSeed (minuscoli)
  styleHints: string[],              // es. denomRow.style_hints + grapes.style_hints
  terroirTags: string[],             // es. denomRow.terroir_tags
  pairSeed: string[],                // es. pairSeed (minuscoli)
  color: "rosso"|"bianco"|"rosato",
  bubbles: number
) {
  const two = aromas.slice(0,2).join(" e ");
  const fr = two
    ? `Profuma di ${two}`
    : (color==="bianco"
        ? "Profuma di frutta e fiori bianchi"
        : color==="rosato"
          ? "Profuma di frutta rossa e fiori"
          : "Profumi di frutto e spezia");

  // scegli UNO style hint non ridondante
  const stylePick = styleHints.find(h =>
    !/profuma|aroma|bouquet|frutta|fiori|spezi/i.test(h)
  );
  const styleBit = stylePick ? `, ${stylePick}` : "";

  // scegli UNO terroir tag sobrio
  const terrPick = terroirTags.find(t =>
    /collinare|montano|vulcanico|mediterraneo|marino|continentale/i.test(t)
  );
  const terrBit = terrPick ? `, impronta ${terrPick}` : "";

  const eff = bubbles > 20 ? " e una bolla fine" : "";

  // piccolissimo “beneficio” da pairing (solo se abbiamo almeno 1)
  const benefit = pairSeed.length ? `: perfetto con ${pairSeed[0]}` : "";

  const sentence = `${fr}${styleBit}${terrBit}${eff}${benefit}.`;
  return capLen(sentence.replace(/\s+/g, " "), 110);
}

function pickPairings(color: "rosso"|"bianco"|"rosato", p: Profile) {
  const base = [...ALLOWED_PAIRINGS[color]];
  if (color !== "rosso" && (p.bubbles > 30 || p.acid > 65)) {
    const priority = ["fritture","antipasti di pesce","primi di pesce"];
    return Array.from(new Set(priority.concat(base))).slice(0,3);
  }
  if (color === "rosso" && (p.body > 60 || p.tannin > 55)) {
    const priority = ["carni rosse","formaggi stagionati","brasati"];
    return Array.from(new Set(priority.concat(base))).slice(0,3);
  }
  return base.slice(0,3);
}

// Genera Mini-Card con GPT usando SOLO i tuoi dati come base.
// Output obbligatori: hook, palate, notes[3], pairings[3]
async function gptComposeMiniCard(input: {
  nome: string; annata?: string; uvaggio?: string; categoria?: string; sottocategoria?: string;
  color: "rosso"|"bianco"|"rosato";
  profile: { acid:number; tannin:number; body:number; sweet:number; bubbles:number };
  allowedNotes: string[]; allowedPairings: string[];
  seedNotes: string[];           // note di partenza
  seedPairings?: string[];       // abbinamenti di partenza
  styleHints?: string[];         // suggerimenti stile (denom + vitigni)
  terroirTags?: string[];        // tag territorio (solo se presenti)
  palateTemplate?: string;       // se presente, va rispettato
  styleSeed: number;
}) {

  const styleVariants = [
    "limpido e succoso", "teso e sapido", "agile e fragrante", "materico e profondo",
    "croccante e agrumato", "avvolgente e speziato", "fine e floreale", "sapido e scorrevole"
  ];
  const styleHint = styleVariants[input.styleSeed % styleVariants.length];

const system = `Sei un sommelier. Scrivi una mini-card in italiano, concisa e professionale.
Regole:
- Formato: 1 riga Hook (<=110 char) + 1 riga Palato (<=120 char) + 3 chip Note (<=2 parole) + 3 chip Abbinamenti (categorie).
- Usa SOLO questi vocabolari: NOTE = ${input.allowedNotes.join(", ")}. ABBINAMENTI = ${input.allowedPairings.join(", ")}.
- Dai priorità a seed e dati forniti (denominazione/vitigni): note_seed, pair_seed, style_hints, terroir_tags.
- L'Hook può includere un micro-beneficio concreto se utile (es. "perfetto con <pair_seed[0]>"), senza slogan.
- Se "palateTemplate" è presente, compila i token {body_txt},{acid_txt},{tan_txt},{tan_spacer},{coda} in modo coerente col profilo e non aggiungere altro nel palato.
- Niente invenzioni su legno/affinamenti/annate/territori non forniti.
- Tieni conto del profilo: acidità ${input.profile.acid}/100, tannino ${input.profile.tannin}/100, corpo ${input.profile.body}/100, bollicina ${input.profile.bubbles}/100.
- Preferisci termini corretti e asciutti. Evita aggettivi ripetuti.`;


const user = {
  vino: {
    nome: input.nome,
    annata: input.annata || null,
    uvaggio: input.uvaggio || null,
    categoria: input.categoria || null,
    sottocategoria: input.sottocategoria || null,
    colore: input.color,
    profilo: input.profile,
    note_seed: input.seedNotes || [],
    pair_seed: input.seedPairings || [],
    style_hints: input.styleHints || [],
    terroir_tags: input.terroirTags || [],
    palate_template: input.palateTemplate || null
  }
};

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,         // un filo di variazione
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({
          RICHIESTA: "Restituisci SOLO JSON con: {hook, palate, notes:[3], pairings:[3]}",
          DATI: user
        })
      }
    ],
    max_tokens: 240
  });

  let out: any = {};
  try { out = JSON.parse(res.choices?.[0]?.message?.content || "{}"); } catch {}
  if (!out || !out.hook || !out.palate) return null;

  // Sanitizzazione finale: rispetto vocabolari e lunghezze
  const cap = (s: string, n: number) => s.length <= n ? s : (s.slice(0, n-1).replace(/\s+\S*$/, "") + "…");
  const allowN = new Set(input.allowedNotes.map(s=>s.toLowerCase()));
  const allowP = new Set(input.allowedPairings.map(s=>s.toLowerCase()));
  const notes = (Array.isArray(out.notes)? out.notes: [])
    .map((x:any)=> String(x||"").toLowerCase()).filter((x:string)=>allowN.has(x)).slice(0,3);
  const pair  = (Array.isArray(out.pairings)? out.pairings: [])
    .map((x:any)=> String(x||"").toLowerCase()).filter((x:string)=>allowP.has(x)).slice(0,3);

  return {
    hook: cap(String(out.hook||""), 110),
    palate: cap(String(out.palate||""), 120),
    notes,
    pairings: pair
  };
}

// ---------- Main ----------
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    const body = await req.json();
    const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } = body || {};
    if (!nome) {
      return new Response(JSON.stringify({ error: "Parametro 'nome' mancante" }), { status: 400, headers: CORS });
    }

    const fp = `${fingerprintName(nome)}::v${ENGINE_VERSION}`;


    // 0) cache per fingerprint
    const { data: cached } = await supabase
      .from("descrizioni_vini")
      .select("descrizione, scheda")
      .eq("fingerprint", fp)
      .maybeSingle();
    if (cached?.descrizione && cached?.scheda) {
      // compat: restituisco sia mini_card che scheda (uguali)
      return new Response(JSON.stringify({ descrizione: cached.descrizione, mini_card: cached.scheda, scheda: cached.scheda }), { status: 200, headers: CORS });
    }

// 1) denominazione (per priorità colore e delta)
const denomCandidates = Array.from(new Set([ norm(nome), norm(categoria), norm(sottocategoria) ].filter(Boolean)));
const denomRow = await fetchAppellationDenom(denomCandidates);

// 2) colore (override con default_color della denominazione se presente)
const color = (denomRow?.default_color as ("rosso"|"bianco"|"rosato") | undefined) 
  ?? guessColor({ nome, categoria, sottocategoria, uvaggio });

// 3) profilo da uvaggio (media pesata), ora con color definitivo
const parts = parseUvaggio(uvaggio);
const grapeProfiles: {p:Profile, w:number, name:string, matchedAs:string, raw:GrapeRow}[] = [];
for (const g of parts) {
  const row = await fetchGrapeRow(g.name) as GrapeRow | null;
  if (row) {
    grapeProfiles.push({
      p: {
        acid: row.acid ?? 50,
        tannin: row.tannin ?? (color==="rosso"?55:10),
        body: row.body ?? 50,
        sweet: row.sweet ?? 5,
        bubbles: row.bubbles ?? 0
      },
      w: g.pct || 0,
      name: row.display_name || g.name,
      matchedAs: row.grape_norm || sanitizeToken(g.name),
      raw: row
    });
  }
}

const profileFromGrapes = grapeProfiles.length 
  ? mergeWeighted(grapeProfiles.map(x=>({p:x.p, w:x.w||1}))) 
  : { ...emptyProfile, acid: color==="bianco" ? 62 : 55 };

// 4) applica i delta della denominazione (se presenti)
let profile: Profile = { ...profileFromGrapes };
if (denomRow) {
  profile = {
    acid: clamp01(profile.acid + (denomRow.delta_acid ?? 0)),
    tannin: clamp01(profile.tannin + (denomRow.delta_tannin ?? 0)),
    body: clamp01(profile.body + (denomRow.delta_body ?? 0)),
    sweet: clamp01(profile.sweet + (denomRow.delta_sweet ?? 0)),
    bubbles: clamp01(profile.bubbles + (denomRow.delta_bubbles ?? 0)),
  };
}
// 5) vocabolari dinamici (denominazione + vitigni) → allowed lists
const baseAllowedNotes = ALLOWED_NOTES[color] as unknown as string[];
const baseAllowedPairs = ALLOWED_PAIRINGS[color] as unknown as string[];
const grapeRowsRaw = grapeProfiles.map(g => g.raw);

const { allowedNotes, allowedPairings } = buildAllowedVocab(
  baseAllowedNotes,
  baseAllowedPairs,
  denomRow,
  grapeRowsRaw
);

function buildCanonicalMap(baseAllowed: readonly string[], dynamicAllowed: string[]) {
  // preferisci le forme base (con accenti), poi le dinamiche
  const m = new Map<string, string>();
  for (const t of baseAllowed) m.set(sanitizeToken(t), t);
  for (const t of dynamicAllowed) if (!m.has(sanitizeToken(t))) m.set(sanitizeToken(t), t);
  return m;
}
function canonDisplay(tokens: string[], canonMap: Map<string,string>): string[] {
  return tokens.map(t => {
    const k = sanitizeToken(t);
    return canonMap.get(k) || t;
  });
}

const canonNotesMap = buildCanonicalMap(baseAllowedNotes, allowedNotes);
const canonPairMap  = buildCanonicalMap(baseAllowedPairs, allowedPairings);

// 6) seed NOTE e PAIRINGS con priorità ai tuoi dati
const { notesSeed, pairSeed } = buildSeeds(
  color,
  profile,
  denomRow,
  grapeRowsRaw,
  allowedNotes,
  allowedPairings
);
const notesSeedCapped = notesSeed.map(t => capChipWords(t));
const pairSeedCapped  = pairSeed.map(t => capChipWords(t));
// Normalizzazione finale chip (erbe mediterranee -> erbe, gestione agrumi vs specifici)
const notesSeedNorm = normalizeAndCapNotes(notesSeedCapped, 3);
const pairSeedNorm  = normalizePairs(pairSeedCapped, 3);

// 7) Hints & template dal DB
const denomStyleHints = toArray(denomRow?.style_hints).map(sanitizeToken);
const denomTerroir = toArray(denomRow?.terroir_tags).map(sanitizeToken);
const palateTemplate = typeof denomRow?.palate_template === "string" ? denomRow.palate_template : "";

const grapeStyleHints = uniqPreserve(
  grapeRowsRaw.flatMap(g => toArray(g?.style_hints).map(sanitizeToken))
);

const styleHintsAll = uniqPreserve([...denomStyleHints, ...grapeStyleHints]);
const terroirTagsAll = uniqPreserve(denomTerroir);
// Ordina le NOTE in base al profilo e agli hints (ora che styleHintsAll è pronto)
const notesSeedRanked = rankNotesByProfile(notesSeedNorm, color, profile, styleHintsAll).slice(0, 3);

// ❷ micro-variazione stabile per etichetta (fingerprint -> numero)
function hashToInt(s: string){ let h=0; for (let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i))|0; } return Math.abs(h); }
const styleSeed = hashToInt(fingerprintName(nome) + (annata || "")); // varia per etichetta/annata

// ❸ chiedi a GPT la mini-card, guidata dai tuoi dati
let gptCard = null;
try {
gptCard = await gptComposeMiniCard({
  nome, annata, uvaggio, categoria, sottocategoria,
  color,
  profile,
  allowedNotes,          // whitelist dinamica
  allowedPairings,       // whitelist dinamica
seedNotes: notesSeedNorm,
seedPairings: pairSeedNorm,
  styleHints: styleHintsAll,
  terroirTags: terroirTagsAll,
  palateTemplate,
  styleSeed
});


} catch (e) {
  // silenzioso: andremo in fallback deterministico
}

// ❹ se GPT ok, usa quelle; altrimenti fallback alle tue frasi deterministic
let notes = canonDisplay(notesSeedRanked, canonNotesMap).map(s => s.charAt(0).toUpperCase() + s.slice(1));
let pairings = canonDisplay(pairSeedNorm, canonPairMap).map(s => s.charAt(0).toUpperCase() + s.slice(1));
let hook  = buildHookV2(notesSeedRanked, styleHintsAll, terroirTagsAll, pairSeedNorm, color, profile.bubbles);
let palate= palateTemplate ? applyPalateTemplate(palateTemplate, profile, color) : buildPalate(profile, color);

if (gptCard) {
  if (gptCard.notes?.length === 3) {
    const n = gptCard.notes.map((x:string)=> capChipWords(x));
    const nNorm = normalizeAndCapNotes(n, 3);
    const nRank = rankNotesByProfile(nNorm, color, profile, styleHintsAll).slice(0,3);
    notes = canonDisplay(nRank, canonNotesMap).map((x:string)=> x.charAt(0).toUpperCase()+x.slice(1));
  }
  if (gptCard.pairings?.length === 3) {
    const p = gptCard.pairings.map((x:string)=> String(x||""));
    const pNorm = normalizePairs(p, 3); // NIENTE cap per i pairings
    pairings = canonDisplay(pNorm, canonPairMap).map((x:string)=> x.charAt(0).toUpperCase()+x.slice(1));
  }
  hook   = gptCard.hook || hook;
  palate = gptCard.palate || palate;
}

    const descrizione = `${hook} ${palate}`.trim();

    const mini_card = {
      hook,                         // 1 riga
      palate,                       // 1 riga
      notes,                        // 3 chip (≤2 parole)
      pairings,                     // 3 chip (categorie)
      emojis: {
        notes: Object.fromEntries(notes.map(n=>[n, EMOJI.notes.get(n) || ""])),
        pairings: Object.fromEntries(pairings.map(p=>[p, EMOJI.pair.get(p) || ""]))
      },
      profile: { ...profile, color },
debug: {
  uvaggio_parsed: parts,
  grapes_matched: grapeProfiles.map(g=>({
    name: g.name,
    matchedAs: g.matchedAs,
    weight: g.w,
    tasting_notes: toArray(g.raw?.tasting_notes),
    pairings: toArray(g.raw?.pairings),
  })),
  style_hints_all: styleHintsAll,
  terroir_tags_all: terroirTagsAll,
  palate_template_used: palateTemplate || null,
  denom_matched: denomRow ? (denomRow.denom_norm || "synonym") : null
}
    };

    // 6) salva cache
    await supabase.from("descrizioni_vini").upsert({
      fingerprint: fp,
      nome,
      annata: annata || null,
      uvaggio: uvaggio || null,
      ristorante_id: ristorante_id || null,
      descrizione,
      scheda: mini_card                 // compat: salvo come "scheda"
    }, { onConflict: "fingerprint", ignoreDuplicates: false });

    // 7) risposta (compat)
    return new Response(JSON.stringify({ descrizione, mini_card, scheda: mini_card }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione mini-card", detail: err?.message ?? String(err) }), {
      status: 500, headers: CORS
    });
  }
});


