import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.24.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.wineinapp.com", // aggiungi altri domini se ti servono
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Usa la SERVICE_ROLE per poter leggere tutte le tabelle
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY")!,
});

// =============== UTIL VARIE ===============

function norm(s?: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // togli accenti
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJSONList(value: any): string[] {
  if (value == null) return [];

  // Caso 1: è già un array (tasting_notes, pairings, typical_notes, ecc.)
  if (Array.isArray(value)) {
    return value.map((x) => String(x));
  }

  // Caso 2: è una stringa (es: text_summary, palate_template, o dati importati da CSV)
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return [];

    // Prova prima come JSON normale
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v.map((x: any) => String(x));
      if (v && typeof v === "object") {
        return Object.values(v).map((x) => String(x));
      }
    } catch {
      // Formato tipo: {"corpo pieno","tannino maturo","acidità media"}
      if (s.startsWith("{") && s.endsWith("}")) {
        const inner = s.slice(1, -1);
        return inner
          .split(",")
          .map((p) => p.replace(/^"+|"+$/g, "").trim())
          .filter(Boolean);
      }

      // Fallback: split semplice su virgola
      return s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
    }
  }

  // Caso 3: altro tipo (number, ecc.) → converto a stringa singola
  return [String(value)];
}


function unique(list: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const s = (x ?? "").trim();
    if (!s) continue;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// PRNG deterministico a partire da una stringa
function makeRng(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDeterministic<T>(arr: T[], k: number, seed: string): T[] {
  const rng = makeRng(seed);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

function clampChars(s: string, max = 160): string {
  if (s.length <= max) return s;

  // cerca punto o virgola entro i limiti
  const cut = s.slice(0, max);
  const punctuation = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf("; "),
    cut.lastIndexOf(", ")
  );

  // se trova una pausa decente → taglia lì
  if (punctuation > max * 0.4) {
    return cut.slice(0, punctuation + 1).trim();
  }

  // altrimenti taglio pulito senza lasciare parole a metà
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace) + "…";
}


// traduci valore 0–1 (+ delta) in “basso/medio/medio-alto”
function livello(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return "medio";
  if (val <= 0.2) return "basso";
  if (val >= 0.8) return "alto";
  if (val >= 0.6) return "medio-alto";
  if (val <= 0.4) return "medio-basso";
  return "medio";
}

// piccole traduzioni da livello tecnico -> frase più "umana"
function descrCorpo(l: string): string {
  switch (l) {
    case "alto":
    case "medio-alto":
      return "struttura importante e avvolgente";
    case "basso":
    case "medio-basso":
      return "corpo snello e scorrevole";
    default:
      return "corpo medio e ben bilanciato";
  }
}

function descrAcidita(l: string): string {
  switch (l) {
    case "alto":
    case "medio-alto":
      return "freschezza vivace";
    case "basso":
    case "medio-basso":
      return "sensazione più morbida che fresca";
    default:
      return "equilibrio tra freschezza e morbidezza";
  }
}

function descrTannino(l: string): string {
  switch (l) {
    case "alto":
    case "medio-alto":
      return "tannino fitto e deciso";
    case "basso":
    case "medio-basso":
      return "tannino morbido e poco incisivo";
    default:
      return "tannino presente ma ben integrato";
  }
}

function inferFamily(
  color: string,
  core: PersistedProfileCore
): PersistedSommelierProfile["family"] {
  const c = norm(color);

  if (c.includes("spum")) return "sparkling";
  if (c.includes("dolce")) return "dessert";
  if (c.includes("bianc")) return core.body >= 0.58 ? "full_white" : "crisp_white";

  // IMPORTANTE: rosso va prima di rosato, perché "rosso" contiene "ros"
  if (c.includes("ross")) {
    return (core.tannin >= 0.55 || core.body >= 0.65)
      ? "structured_red"
      : "light_red";
  }

  if (
    c.includes("rosat") ||
    c.includes("rose") ||
    c.includes("rosé") ||
    c.includes("rosè")
  ) {
    return "rosato";
  }

  return "other";
}

// =============== MAIN ===============
type PersistedProfileCore = {
  acid: number;
  tannin: number;
  body: number;
  sweet: number;
  bubbles: number;
};

type PersistedSommelierProfile = {
  version: number;
  source: string[];
  color: "bianco" | "rosso" | "rosato" | "spumante" | "dolce" | "altro";
  family:
    | "sparkling"
    | "crisp_white"
    | "full_white"
    | "rosato"
    | "light_red"
    | "structured_red"
    | "dessert"
    | "other";
  core: PersistedProfileCore;
  pairing_tags: string[];
  avoid_tags: string[];
  signature_notes: string[];
  confidence: number;
};

type WineKind =
  | "sparkling"
  | "ramato_orange"
  | "rosato"
  | "bianco"
  | "rosso"
  | "dolce"
  | "unknown";

function hasAnyNorm(text: string, needles: string[]): boolean {
  const t = norm(text);
  return needles.some((n) => t.includes(norm(n)));
}

function inferWineKind(wine: any, hint?: any): WineKind {
  const rawHint = String(hint?.wine_type || hint?.type || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (["sparkling", "ramato_orange", "rosato", "bianco", "rosso", "dolce"].includes(rawHint)) {
    return rawHint as WineKind;
  }
  if (hint?.is_sparkling) return "sparkling";
  if (hint?.is_ramato_or_orange) return "ramato_orange";
  if (hint?.is_rose) return "rosato";
  if (hint?.is_white) return "bianco";
  if (hint?.is_red) return "rosso";

  const cat = norm(wine?.categoria);
  const sub = norm(wine?.sottocategoria);
  const name = norm(wine?.nome);
  const all = `${cat} ${sub} ${name}`;

  // Priorità assoluta: se è spumante/metodo classico, deve essere letto come bollicina.
  if (hasAnyNorm(all, [
    "bollicine", "spumante", "metodo classico", "metodo ancestrale", "ancestrale",
    "brut", "extra brut", "pas dose", "pas dosé", "dosaggio zero", "champagne", "lambrusco"
    "franciacorta", "trentodoc", "trento doc", "prosecco", "cremant", "crémant", "pet nat", "pét nat", "dry", "extra dry", "metodo martinotti", "charmat", "champenoise"
  ])) return "sparkling";

  // Ramato/orange: va intercettato prima del generico bianco/rosato.
  if (hasAnyNorm(all, ["ramato", "orange", "macerato", "macerazione sulle bucce", "ambrato"])) {
    return "ramato_orange";
  }

  if (hasAnyNorm(all, ["rosato", "rosati", "rose", "rosé", "rosè", "chiaretto", "cerasuolo"])) return "rosato";
  if (hasAnyNorm(cat, ["bianchi", "bianco"])) return "bianco";
  if (hasAnyNorm(cat, ["rossi", "rosso"])) return "rosso";
  if (hasAnyNorm(all, ["dolce", "dolci", "passito", "vin santo", "vinsanto", "sauternes", "vendemmia tardiva"])) return "dolce";

  return "unknown";
}

function profileColorLabelForKind(kind: WineKind, fallback?: string | null): string {
  switch (kind) {
    case "sparkling": return "Spumante";
    case "dolce": return "Dolce";
    case "rosato": return "Rosato";
    case "ramato_orange":
    case "bianco": return "Bianco";
    case "rosso": return "Rosso";
    default: return fallback || "ND";
  }
}

function visualColorLabelForKind(kind: WineKind, wine: any, fallback?: string | null): string {
  const all = `${wine?.categoria || ""} ${wine?.sottocategoria || ""} ${wine?.nome || ""}`;
  const isRoseSparkling = kind === "sparkling" && hasAnyNorm(all, ["rosato", "rose", "rosé", "rosè"]);
  switch (kind) {
    case "sparkling": return isRoseSparkling ? "Spumante rosato" : "Spumante";
    case "ramato_orange": return "Ramato / orange";
    case "bianco": return "Bianco";
    case "rosato": return "Rosato";
    case "rosso": return "Rosso";
    case "dolce": return "Dolce";
    default: return fallback || "ND";
  }
}

function defaultNotesForKind(kind: WineKind, wine?: any): string[] {
  const all = `${wine?.categoria || ""} ${wine?.sottocategoria || ""} ${wine?.nome || ""}`;
  if (kind === "sparkling" && hasAnyNorm(all, ["rosato", "rose", "rosé", "rosè"])) {
    return ["perlage fine", "piccoli frutti rossi", "crosta di pane"];
  }
  switch (kind) {
    case "sparkling": return ["perlage fine", "agrumi", "crosta di pane"];
    case "ramato_orange": return ["scorza d'agrumi", "erbe officinali", "lieve nota ambrata"];
    case "bianco": return ["agrumi", "fiori bianchi", "nota sapida"];
    case "rosato": return ["piccoli frutti rossi", "floreale delicato", "nota fresca"];
    case "rosso": return ["frutto rosso", "spezie delicate", "nota balsamica"];
    case "dolce": return ["frutta matura", "miele", "nota dolce"];
    default: return ["nota fruttata", "equilibrio", "finale armonico"];
  }
}

function noteForbiddenForKind(note: string, kind: WineKind): boolean {
  const redTerms = [
    "rosso rubino", "granato", "ciliegia", "marasca", "prugna", "frutti neri",
    "sottobosco", "tabacco", "cuoio", "cacao", "espresso", "tannino", "spezie scure",
    "pomodoro arrosto",
  ];
  const whiteTerms = [
    "giallo paglierino", "limone", "mela verde", "fiori bianchi", "mandorla amara",
    "nota citrina", "agrumi verdi",
  ];

  if (kind === "bianco") return hasAnyNorm(note, redTerms);
  if (kind === "ramato_orange") return hasAnyNorm(note, ["rosa cerasuolo", "rosato", "rosso rubino", "granato"]);
  if (kind === "rosato") return hasAnyNorm(note, ["rosso rubino", "granato", "giallo paglierino", "tannino fitto"]);
  if (kind === "rosso") return hasAnyNorm(note, whiteTerms);
  if (kind === "sparkling") return hasAnyNorm(note, ["tannino fitto", "tannini cesellati", "vino fermo", "rosso rubino intenso"]);
  return false;
}

function guardNotesForWineKind(notes: string[], kind: WineKind, wine?: any): string[] {
  const safe = unique(notes).filter((n) => !noteForbiddenForKind(n, kind));
  if (safe.length >= 2) return safe.slice(0, 3);
  return unique([...safe, ...defaultNotesForKind(kind, wine)]).slice(0, 3);
}

function applyProfileGuardrails(
  profile: PersistedSommelierProfile,
  kind: WineKind,
): PersistedSommelierProfile {
  const p: PersistedSommelierProfile = JSON.parse(JSON.stringify(profile));
  p.source = unique([...(p.source || []), "wine_type_guardrails"]);

  if (kind === "sparkling") {
    p.color = "spumante";
    p.family = "sparkling";
    p.core.bubbles = Math.max(p.core.bubbles ?? 0, 0.72);
    p.core.acid = Math.max(p.core.acid ?? 0.5, 0.55);
    p.core.tannin = Math.min(p.core.tannin ?? 0.05, 0.18);
    p.confidence = Math.max(p.confidence ?? 0.68, 0.78);
    return p;
  }

  // I vini fermi non devono ereditare bollicina dai dati uva/denominazione.
  p.core.bubbles = 0;

  if (kind === "bianco") {
    p.color = "bianco";
    p.core.tannin = Math.min(p.core.tannin ?? 0.05, 0.12);
    p.family = (p.core.body ?? 0.5) >= 0.58 ? "full_white" : "crisp_white";
    p.confidence = Math.max(p.confidence ?? 0.68, 0.76);
    return p;
  }

  if (kind === "ramato_orange") {
    p.color = "bianco"; // enum: niente “orange”; lo gestiamo nel testo e nelle note.
    p.core.tannin = Math.min(Math.max(p.core.tannin ?? 0.14, 0.08), 0.28);
    p.core.body = Math.max(p.core.body ?? 0.5, 0.48);
    p.family = (p.core.body ?? 0.5) >= 0.58 ? "full_white" : "crisp_white";
    p.confidence = Math.max(p.confidence ?? 0.68, 0.76);
    return p;
  }

  if (kind === "rosato") {
    p.color = "rosato";
    p.family = "rosato";
    p.core.tannin = Math.min(p.core.tannin ?? 0.12, 0.25);
    p.core.body = Math.min(p.core.body ?? 0.5, 0.68);
    p.confidence = Math.max(p.confidence ?? 0.68, 0.76);
    return p;
  }

  if (kind === "rosso") {
    p.color = "rosso";
    p.core.tannin = Math.max(p.core.tannin ?? 0.35, 0.25);
    p.core.body = Math.max(p.core.body ?? 0.45, 0.38);
    p.family = inferFamily("rosso", p.core);
    p.confidence = Math.max(p.confidence ?? 0.68, 0.76);
    return p;
  }

  if (kind === "dolce") {
    p.color = "dolce";
    p.family = "dessert";
    p.core.sweet = Math.max(p.core.sweet ?? 0.55, 0.55);
    p.confidence = Math.max(p.confidence ?? 0.68, 0.74);
  }

  return p;
}

function buildGuardedFallback(
  kind: WineKind,
  notes: string[],
  struttura: any,
  wine?: any,
): { hook: string; palate: string } {
  const chosen = guardNotesForWineKind(notes, kind, wine);
  const n1 = chosen[0] || "nota fruttata";
  const n2 = chosen[1] || "finale armonico";
  const corpo = descrCorpo(struttura?.corpo);
  const acid = descrAcidita(struttura?.acidita);
  const tann = descrTannino(struttura?.tannino);

  if (kind === "sparkling") {
    return {
      hook: clampChars(`Bollicina fine, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Perlage fine e sorso fresco, con ${corpo} e finale pulito. La chiusura resta tesa e piacevole.`, 220),
    };
  }

  if (kind === "ramato_orange") {
    return {
      hook: clampChars(`Tonalità ramata, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Il sorso è materico ma scorrevole, con ${acid} e una lieve presa tannica da macerazione. Finale sapido e asciutto.`, 220),
    };
  }

  if (kind === "bianco") {
    return {
      hook: clampChars(`Bianco luminoso, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Al palato mostra ${acid} e ${corpo}; il finale è pulito, sapido e continuo.`, 220),
    };
  }

  if (kind === "rosato") {
    return {
      hook: clampChars(`Rosato fragrante, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Il sorso è fresco e scorrevole, con corpo misurato e finale sapido. La trama resta delicata e ben equilibrata.`, 220),
    };
  }

  if (kind === "rosso") {
    return {
      hook: clampChars(`Rosso rubino, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Al palato mostra ${corpo}, ${acid} e ${tann}; il finale è coerente e persistente.`, 220),
    };
  }

  if (kind === "dolce") {
    return {
      hook: clampChars(`Vino dolce, profilo su ${n1} e ${n2}.`, 120),
      palate: clampChars(`Il sorso è morbido e avvolgente, con dolcezza bilanciata e finale armonico.`, 220),
    };
  }

  return {
    hook: clampChars(`Profilo centrato su ${n1} e ${n2}.`, 120),
    palate: clampChars(`Il sorso è equilibrato, con buona continuità e finale armonico.`, 220),
  };
}

function textViolatesWineKind(text: string, kind: WineKind): boolean {
  const t = norm(text);
  if (!t) return true;

  if (kind === "sparkling") {
    const hasBubble = hasAnyNorm(t, ["perlage", "bollicina", "bollicine", "spuma", "effervescenza", "cremosita", "cremosità"]);
    return !hasBubble || hasAnyNorm(t, ["vino fermo", "tannino fitto", "tannini cesellati", "rosso rubino intenso"]);
  }
  if (kind === "bianco") {
    return hasAnyNorm(t, ["rosso", "rubino", "granato", "tannino fitto", "tannini cesellati", "frutti neri", "cuoio"]);
  }
  if (kind === "ramato_orange") {
    return hasAnyNorm(t, ["rosato", "rosa cerasuolo", "rosso rubino", "granato"]);
  }
  if (kind === "rosato") {
    return hasAnyNorm(t, ["giallo paglierino", "rosso rubino", "granato", "tannino fitto", "tannini cesellati"]);
  }
  if (kind === "rosso") {
    return hasAnyNorm(t, ["giallo paglierino", "fiori bianchi", "mela verde", "limone", "mandorla amaricante"]);
  }
  return false;
}

function repairDescriptionIfNeeded(
  hook: string,
  palate: string,
  kind: WineKind,
  notes: string[],
  struttura: any,
  wine?: any,
): { hook: string; palate: string } {
  const full = `${hook} ${palate}`;
  if (!textViolatesWineKind(full, kind)) return { hook, palate };
  return buildGuardedFallback(kind, notes, struttura, wine);
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
  wine_id,
  catalog_wine_id,
  force_regenerate,
  nome,
  annata,
  uvaggio,
  categoria,
  sottocategoria,
  ristorante_id,
  wine_type_hint,
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
    }
  );
}

    // fingerprint per la cache: se cambia qualcosa qui, rigeneriamo
    const fingerprint = [
      norm(nome),
      annata ?? "",
      norm(uvaggio),
      norm(categoria),
      norm(sottocategoria),
      ristorante_id ?? "",
    ].join("|");

    // 0) PROVA A LEGGERE DALLA CACHE descrizioni_vini
let cached: any = null;

if (wine_id) {
  const { data } = await supabase
    .from("descrizioni_vini")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .eq("wine_id", wine_id)
    .maybeSingle();

  cached = data || null;
}

if (!cached) {
  const { data } = await supabase
    .from("descrizioni_vini")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  cached = data || null;
}

const canReturnCached =
  cached &&
  !force_regenerate &&
  cached.descrizione_it &&
  cached.scheda_it &&
  cached.sommelier_profile;

if (canReturnCached) {
  return new Response(
    JSON.stringify({
      ok: true,
      descrizione: cached.descrizione_it || cached.descrizione,
      mini_card: cached.scheda_it || cached.scheda,
      cached: true,
    }),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    }
  );
}

    // seed per rendere ogni vino un po' diverso ma stabile
    const wineSeed = `${nome}|${annata ?? ""}|${ristorante_id ?? ""}`;

    // 1) PROVA a recuperare il record esatto da "wines" (opzionale ma utile)
let wineRow: any = null;

if (wine_id) {
  const { data } = await supabase
    .from("wines")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .eq("id", wine_id)
    .maybeSingle();

  wineRow = data || null;
}

if (!wineRow) {
  const { data } = await supabase
    .from("wines")
    .select("*")
    .eq("ristorante_id", ristorante_id)
    .ilike("nome", nome)
    .maybeSingle();

  wineRow = data || null;
}

    const wine = {
      nome: wineRow?.nome ?? nome,
      annata: wineRow?.annata ?? annata ?? null,
      uvaggio: wineRow?.uvaggio ?? uvaggio ?? "",
      categoria: wineRow?.categoria ?? categoria ?? "",
      sottocategoria: wineRow?.sottocategoria ?? sottocategoria ?? "",
    };

    // Guardrail principale: la categoria/admin batte uva e denominazione.
    // Serve a evitare bianchi descritti da rossi, bollicine come vini fermi, ramati come rosati, ecc.
    const wineKind = inferWineKind(wine, wine_type_hint);

    // 2) CARICA tutte le uve e denominazioni in memoria
    const [{ data: allGrapes }, { data: allAppl }] = await Promise.all([
      supabase.from("grape_profiles").select("*"),
      supabase.from("appellation_priors").select("*"),
    ]);

    if (!allGrapes || !allAppl) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Impossibile caricare profili uve/denominazioni",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

// 3) PARSE UVAGGIO → lista di vitigni (robusto + pesi coerenti)

// parole “descrittive” che a volte finiscono dentro l'uvaggio e rovinano il match
const TRAILING_DESCRIPTORS = [
  "ramato",
  "orange",
  "bio",
  "brut",
  "extra brut",
  "pas dose",
  "dosaggio zero",
  "metodo classico",
  "metodo ancestrale",
];

function cleanGrapeName(raw: string): string {
  let s = raw.trim();

  // rimuovi percentuali (anche tra parentesi) tipo " (43%) " o "43%"
  s = s.replace(/\(\s*\d+(?:[.,]\d+)?\s*%\s*\)/g, " ");
  s = s.replace(/\d+(?:[.,]\d+)?\s*%/g, " ");

  // normalizza spazi
  s = s.replace(/\s+/g, " ").trim();

  // togli descrittori finali (solo se in coda)
  const n = norm(s);
  for (const d of TRAILING_DESCRIPTORS) {
    const dn = norm(d);
    if (n.endsWith(" " + dn) || n === dn) {
      // rimuovi la parola finale dal testo originale in modo “soft”
      const re = new RegExp(`\\s+${d}$`, "i");
      s = s.replace(re, "").trim();
    }
  }

  return s;
}

function parsePercent(raw: string): number | null {
  const m = raw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(num)) return null;
  return num;
}

// split più ampio (aggiungo & e "and")
const parts = String(wine.uvaggio ?? "")
  .split(/(?:,|;| e | ed | con |\+|\/|&| and )+/i)
  .map((s) => s.trim())
  .filter(Boolean);

// prima passata: estrai nome+% puliti
const parsedRaw = parts.map((p) => ({
  raw: p,
  name: cleanGrapeName(p),
  pct: parsePercent(p),
}));

// unifica duplicati per nome normalizzato (somma le % se ripetute)
const byKey = new Map<string, { name: string; pct: number | null }>();
for (const g of parsedRaw) {
  const key = norm(g.name);
  if (!key) continue;

  const prev = byKey.get(key);
  if (!prev) {
    byKey.set(key, { name: g.name, pct: g.pct });
  } else {
    // se entrambe hanno pct → somma, altrimenti mantieni quella esistente
    if (prev.pct != null && g.pct != null) prev.pct += g.pct;
    else if (prev.pct == null && g.pct != null) prev.pct = g.pct;
  }
}

const parsedGrapes = Array.from(byKey.values());

// calcolo pesi “coerenti”:
// - se tutte senza %: pesi uguali
// - se alcune con %: normalizzo le % e ripartisco il resto sulle senza %
function computeWeights(list: { name: string; pct: number | null }[]) {
  const withPct = list.filter((x) => x.pct != null) as { name: string; pct: number }[];
  const withoutPct = list.filter((x) => x.pct == null);

  if (list.length === 0) return [];

  // caso: una sola uva senza % -> 100%
  if (list.length === 1 && list[0].pct == null) {
    return [{ name: list[0].name, percent: 100 }];
  }

  if (withPct.length === 0) {
    const eq = 100 / list.length;
    return list.map((x) => ({ name: x.name, percent: eq }));
  }

  let sum = withPct.reduce((a, b) => a + b.pct, 0);

  // se somma > 100, normalizza a 100
  if (sum > 100) {
    return list.map((x) => {
      if (x.pct == null) return { name: x.name, percent: 0 };
      return { name: x.name, percent: (x.pct / sum) * 100 };
    });
  }

  const remaining = Math.max(0, 100 - sum);
  const share = withoutPct.length > 0 ? remaining / withoutPct.length : 0;

  return list.map((x) => ({
    name: x.name,
    percent: x.pct != null ? x.pct : share,
  }));
}

const weightedGrapes = computeWeights(parsedGrapes);

// 3B) MATCH con grape_profiles → grapesDetailed (usa i pesi calcolati)

const grapesDetailed = weightedGrapes.map((wg) => {
  const key = norm(wg.name);
  let best: any = null;

  for (const g of allGrapes) {
    const base = norm(g.grape_norm || g.display_name);
    const syns = parseJSONList(g.synonyms).map(norm);

    if (
      base === key ||
      syns.includes(key) ||
      key.includes(base) ||
      base.includes(key)
    ) {
      best = g;
      break;
    }
  }

  return {
    name: wg.name,
    percent: wg.percent, // <- numero sempre coerente (0..100)
    profile: best,       // <- null se non matcha
  };
});


    // 4) TROVA DENOMINAZIONE (appellation_priors) partendo da sottocategoria / nome
    const hint = norm(wine.sottocategoria || wine.nome);
    let app: any = null;

    for (const a of allAppl) {
      const d = norm(a.denom_norm);
      const syns = parseJSONList(a.synonyms).map(norm);
      if (
        hint.includes(d) ||
        d.includes(hint) ||
        syns.some((s) => hint.includes(s) || s.includes(hint))
      ) {
        app = a;
        break;
      }
    }

    function weightedItems(items: string[], percent: number) {
  // scala: ogni ~10% = 1 copia, min 1 se percent>0
  const copies = percent <= 0 ? 0 : Math.max(1, Math.round(percent / 10));
  const out: string[] = [];
  for (let i = 0; i < copies; i++) out.push(...items);
  return out;
}

// 5) COSTRUISCI POOL DI NOTE & ABBINAMENTI

const grapeNotesAll = grapesDetailed.flatMap((g) => {
  if (!g.profile) return [];
  const notes = parseJSONList(g.profile.tasting_notes);
  return weightedItems(notes, g.percent ?? 0);
});

const grapePairsAll = grapesDetailed.flatMap((g) => {
  if (!g.profile) return [];
  const pairs = parseJSONList(g.profile.pairings);
  return weightedItems(pairs, g.percent ?? 0);
});

const appNotes = app ? parseJSONList(app.typical_notes) : [];
const appPairs = app ? parseJSONList(app.typical_pairings) : [];

const styleHints = grapesDetailed.flatMap((g) => {
  if (!g.profile) return [];
  const hints = parseJSONList(g.profile.style_hints);
  return weightedItems(hints, g.percent ?? 0);
});

const grapeTextSummaries = grapesDetailed.flatMap((g) => {
  if (!g.profile) return [];
  const ts = parseJSONList(g.profile.text_summary);
  return weightedItems(ts, g.percent ?? 0);
});

const appStyleHints = app ? parseJSONList(app.style_hints) : [];
const appPalateTemplate = app ? parseJSONList(app.palate_template) : [];

// pool solo dai DATI delle tabelle (uva + denominazione)
const notesPool = unique([...grapeNotesAll, ...appNotes]);
const pairingsPool = unique([...grapePairsAll, ...appPairs]);

// scegli massimo 3, ma se il pool è vuoto usa un fallback neutro
const notesChosen =
  notesPool.length > 0
    ? pickDeterministic(
        notesPool,
        Math.min(3, notesPool.length),
        wineSeed + "|notes",
      )
    : ["nota fruttata", "leggera speziatura"];

const pairingsChosen =
  pairingsPool.length > 0
    ? pickDeterministic(
        pairingsPool,
        Math.min(3, pairingsPool.length),
        wineSeed + "|pair",
      )
    : ["piatti della cucina locale"];

const notesChosenGuarded = guardNotesForWineKind(notesChosen, wineKind, wine);
const pairingsChosenGuarded = pairingsChosen;

    // 6) PROFILO STRUTTURALE (acid/tannin/body/sweet/bubbles) combinando uva + delta denominazione

    function avgProp(
      prop: "acid" | "tannin" | "body" | "sweet" | "bubbles"
    ): number | null {
      let sum = 0;
      let w = 0;
      for (const g of grapesDetailed) {
        const p = g.profile?.[prop];
        if (p == null) continue;

        let weight: number;
        if (g.percent != null) {
          weight = g.percent;
        } else if (grapesDetailed.length > 0) {
          weight = 100 / grapesDetailed.length;
        } else {
          weight = 1;
        }

        sum += p * weight;
        w += weight;
      }
      if (!w) return null;
      return sum / w;
    }

    let acidBase = avgProp("acid");
    let tanninBase = avgProp("tannin");
    let bodyBase = avgProp("body");
    let sweetBase = avgProp("sweet");
    let bubblesBase = avgProp("bubbles");

    // applica delta della denominazione se presente
    if (app) {
      const dA = app.delta_acid ?? 0;
      const dT = app.delta_tannin ?? 0;
      const dB = app.delta_body ?? 0;
      const dS = app.delta_sweet ?? 0;
      const dBu = app.delta_bubbles ?? 0;
      if (acidBase != null)
        acidBase = Math.min(1, Math.max(0, acidBase + dA));
      if (tanninBase != null)
        tanninBase = Math.min(1, Math.max(0, tanninBase + dT));
      if (bodyBase != null)
        bodyBase = Math.min(1, Math.max(0, bodyBase + dB));
      if (sweetBase != null)
        sweetBase = Math.min(1, Math.max(0, sweetBase + dS));
      if (bubblesBase != null)
        bubblesBase = Math.min(1, Math.max(0, bubblesBase + dBu));
    }

    const struttura = {
      acidita: livello(acidBase),
      tannino: livello(tanninBase),
      corpo: livello(bodyBase),
      dolcezza: livello(sweetBase),
      bollicina: livello(bubblesBase),
    };

    // colore: prima rispetta la categoria/admin, poi eventualmente la denominazione.
    const categoryColor = norm(wine.categoria).includes("rosso")
      ? "Rosso"
      : norm(wine.categoria).includes("bianco")
      ? "Bianco"
      : norm(wine.categoria).includes("rosa") || norm(wine.categoria).includes("rosato")
      ? "Rosato"
      : "ND";

    const defaultColor = profileColorLabelForKind(wineKind, categoryColor !== "ND" ? categoryColor : app?.default_color);
    const visualColorHint = visualColorLabelForKind(wineKind, wine, defaultColor);

// 7) COSTRUISCI CONTEXT PER GPT

const context = {
  vino: {
    nome: wine.nome,
    annata: wine.annata,
    categoria: wine.categoria,
    sottocategoria: wine.sottocategoria,
    colore: visualColorHint,
  },
  uvaggi: grapesDetailed.map((g) => ({
    nome: g.name,
    percentuale: g.percent,
    style_hints: g.profile ? parseJSONList(g.profile.style_hints) : [],
    text_summary: g.profile ? parseJSONList(g.profile.text_summary) : [],
  })),
  denominazione: app
    ? {
        nome: app.denom_norm,
        style_hints: appStyleHints,
        terroir_tags: parseJSONList(app.terroir_tags),
        palate_template: appPalateTemplate,
      }
    : null,
  struttura,
  wine_type_guardrail: {
    tipo: wineKind,
    authoritative: true,
    note: "La categoria/nome inseriti in admin vincolano colore, bollicina e struttura. Uva e denominazione non possono sovrascriverli.",
  },

  // DATI COMPLETI dalle tabelle, per aromi/abbinamenti/stile
  grape_tasting_notes: grapeNotesAll,
  grape_pairings: grapePairsAll,
  appellation_typical_notes: appNotes,
  appellation_pairings: appPairs,
  grape_style_hints: styleHints,
  appellation_style_hints: appStyleHints,
  denominazione_palate_template: appPalateTemplate,

  // sintesi per la mini-card (3 note + 3 abbinamenti)
  notes_scelte: notesChosenGuarded,
  abbinamenti_scelti: pairingsChosenGuarded,
  guardrail_notes: defaultNotesForKind(wineKind, wine),
};

// fallback descrizione “template” se GPT dovesse fallire o violare colore/tipologia
const guardedFallback = buildGuardedFallback(wineKind, notesChosenGuarded, struttura, wine);
const fallbackHook = guardedFallback.hook;
const fallbackPalate = guardedFallback.palate;

const fallbackCore: PersistedProfileCore = {
  acid: acidBase ?? 0.5,
  tannin: tanninBase ?? 0.5,
  body: bodyBase ?? 0.5,
  sweet: sweetBase ?? 0.05,
  bubbles: bubblesBase ?? 0,
};

const fallbackColor: PersistedSommelierProfile["color"] =
  norm(defaultColor).includes("spum") ? "spumante" :
  norm(defaultColor).includes("dolc") ? "dolce" :
  norm(defaultColor).includes("ross") ? "rosso" :
  norm(defaultColor).includes("bianc") ? "bianco" :
  norm(defaultColor).includes("ros") ? "rosato" :
  "altro";

const avoidTags = unique([
  (fallbackCore.sweet < 0.12 ? "dessert" : null),
  (fallbackCore.tannin > 0.65 ? "pesce delicato" : null),
  (fallbackCore.bubbles > 0.8 && fallbackCore.sweet < 0.2 ? "brasati lunghi" : null),
]);

let persistedProfile: PersistedSommelierProfile = {
  version: 1,
  source: ["grape_profiles", "appellation_priors", "context"],
  color: fallbackColor,
  family: inferFamily(fallbackColor, fallbackCore),
  core: fallbackCore,
  pairing_tags: pairingsChosenGuarded,
  avoid_tags: avoidTags,
  signature_notes: notesChosenGuarded,
  confidence: 0.68,
};

persistedProfile = applyProfileGuardrails(persistedProfile, wineKind);

    // 8) CHIAMATA GPT: genera hook + palate (2–3 frasi)

    let hook = fallbackHook;
    let palate = fallbackPalate;

    try {
const system = `
Sei un sommelier digitale e scrivi brevi descrizioni di degustazione in italiano.

Il CONTEXT contiene:
- informazioni su vitigni, denominazioni e struttura (acidità, tannino, corpo, ecc.);
- "grape_tasting_notes" e "appellation_typical_notes" con aromi e profumi;
- "notes_scelte" = 2–3 aromi chiave da mettere in evidenza;
- "abbinamenti_scelti" verrà mostrato separatamente nella carta.

Stile:
- NON ripetere il nome del vino o dell’azienda.
- NON citare abbinamenti nel testo.
- NON elencare aromi in forma di lista; integrarli in frasi naturali.
- Evita formule ripetitive: varia l'inizio delle frasi ("In bocca", "Il sorso", "L'ingresso", "La beva", "La trama gustativa", "In apertura", "Al palato").
- Varia anche le chiusure ("chiude con una scia", "sfuma su toni freschi", "lascia un ricordo sapido", "termina in eleganza").
- Usa soltanto aromi e sensazioni presenti nel CONTEXT. Non inventare nulla.
- Linguaggio professionale ma naturale, da sommelier, senza toni pubblicitari.

Regole anti-errore OBBLIGATORIE:
- CONTEXT.wine_type_guardrail.tipo è AUTORITATIVO: uva e denominazione NON possono cambiare colore/tipologia.
- Se tipo = "bianco": vietato usare rosso, rubino, granato, tannino fitto, frutti neri, cuoio.
- Se tipo = "rosso": vietato usare giallo paglierino, mela verde, limone dominante, fiori bianchi, mandorla amaricante come struttura da bianco.
- Se tipo = "rosato": descrivilo come rosato, non come rosso strutturato; tannino solo basso o appena accennato.
- Se tipo = "ramato_orange": usa ramato, rame chiaro, ambrato leggero o orange; NON chiamarlo rosato.
- Se tipo = "sparkling": deve emergere chiaramente la bollicina. Usa parole come perlage, bollicina, spuma, effervescenza o cremosità. Non descriverlo come vino fermo.

Output:
Devi restituire SOLO un JSON con:
{"hook":"...","palate":"..."}

"hook":
- 1 frase molto breve (max ~90 caratteri).
- Riassume lo stile generale del vino e 1–2 aromi chiave, usando parole prese da "notes_scelte" o dalle liste di note.

"palate":
- 1 o 2 frasi (max ~220 caratteri).
- Descrive colore e sensazioni di bocca: ingresso, centro bocca, finale.
- Traduci la struttura in parole semplici: ad es. acidità alta -> "fresco e vibrante", corpo pieno -> "sorso ricco e avvolgente", tannino alto -> "tannino fitto ma ben integrato".
- Puoi usare 1–2 aromi dal CONTEXT per collegare naso e bocca, ma senza forma elenco.

Usa un italiano naturale, come in una carta dei vini di un ristorante curato.
Assicurati che ogni frase abbia una chiusura completa, senza lasciare sospensioni o frasi interrotte.
`.trim();


      const userMsg = `CONTEXT:\n${JSON.stringify(context, null, 2)}`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.45,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
      });

      const raw = resp.choices?.[0]?.message?.content ?? "";
      const jsonStart = raw.indexOf("{");
      const jsonEnd = raw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const obj = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
        if (obj?.hook) hook = clampChars(String(obj.hook), 140);
        if (obj?.palate) palate = clampChars(String(obj.palate), 220);
      }
    } catch (_e) {
      // se GPT fallisce, usiamo i fallback
    }

    const repaired = repairDescriptionIfNeeded(hook, palate, wineKind, notesChosenGuarded, struttura, wine);
    hook = repaired.hook;
    palate = repaired.palate;

    const descrizioneCompleta = `${hook} ${palate}`.trim();

    const mini_card = {
      hook,
      palate,
      notes: notesChosenGuarded,
      pairings: pairingsChosenGuarded,
      emojis: { notes: {}, pairings: {} },
    };

    // 9) SALVA NELLA CACHE descrizioni_vini
// 9) SALVA / AGGIORNA in descrizioni_vini
try {
  const payload = {
    nome: wine.nome,
    annata: wine.annata ? String(wine.annata) : null,
    uvaggio: wine.uvaggio,
    descrizione: descrizioneCompleta,
    scheda: mini_card,

    // master italiano
    descrizione_it: descrizioneCompleta,
    scheda_it: mini_card,

    ristorante_id,
    fingerprint,

    wine_id: wine_id || wineRow?.id || null,
    catalog_wine_id: catalog_wine_id || wineRow?.catalog_wine_id || null,

    sommelier_profile: persistedProfile,
    sommelier_profile_confidence: persistedProfile.confidence ?? 0.68,
    sommelier_profile_updated_at: new Date().toISOString(),
  };

  if (cached?.id) {
    const { error: updErr } = await supabase
      .from("descrizioni_vini")
      .update(payload)
      .eq("id", cached.id);

    if (updErr) {
      console.error("Errore update descrizioni_vini:", updErr);
    }
  } else {
    const { error: insErr } = await supabase
      .from("descrizioni_vini")
      .insert(payload);

    if (insErr) {
      console.error("Errore insert descrizioni_vini:", insErr);
    }
  }
} catch (e) {
  console.error("Errore salvataggio descrizioni_vini:", e);
}

    return new Response(
      JSON.stringify({
        ok: true,
        descrizione: descrizioneCompleta,
        mini_card,
        cached: false,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("descrizione-vino error", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});