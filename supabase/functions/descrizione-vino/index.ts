// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// ---------- Vocabolari ammessi (chip) ----------
const ALLOWED_NOTES = {
  rosso: ["ciliegia","amarena","prugna","mora","ribes nero","violetta","rosa secca","pepe nero","cannella","chiodo di garofano","liquirizia","tabacco","cuoio","terroso","balsamico","erbe mediterranee"],
  bianco:["agrumi","limone","pompelmo","frutta gialla","pesca","pera","mela","fiori bianchi","erbe","minerale"],
  rosato:["frutta rossa","fragola","lampone","melograno","floreale","erbe"]
} as const;

const ALLOWED_PAIRINGS = {
  rosso: ["primi al ragù","carni rosse","formaggi stagionati","selvaggina","brasati"],
  bianco:["antipasti di pesce","primi di pesce","carni bianche","formaggi freschi","fritti"],
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

// Note tipiche per vitigno (sintetiche, prese dal vocabolario ammesso per evitare invenzioni)
const GRAPE_NOTE_HINTS: Record<string, string[]> = {
  // chiavi in lowercase (grape_norm / synonyms)
  "sangiovese": ["ciliegia","violetta","pepe nero"],
  "nebbiolo": ["rosa secca","ciliegia","liquirizia"],
  "barbera": ["ciliegia","prugna","erbe"],
  "merlot": ["prugna","mora","cannella"],
  "cabernet sauvignon": ["ribes nero","pepe nero","liquirizia"],
  "syrah": ["mora","pepe nero","violetta"],
  "aglianico": ["prugna","terroso","liquirizia"],
  "primitivo": ["prugna","amarena","spezie"], // "spezie" sarà mappata su pepe/cannella
  "nerodavola": ["amarena","erbe mediterranee","spezie"],
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
  // fallback: se cita vitigni “bianchi”
  if (/\bchardonnay|vermentino|fiano|greco|garganega|friulano|verdicchio|sauvignon|pinot\s+bianco\b/.test(all)) return "bianco";
  return "rosso";
}

// ---------- Parsing uvaggio (percentuali opzionali) ----------
type GrapePart = { name: string; pct: number };
function parseUvaggio(uvaggio?: string): GrapePart[] {
  const s = uvaggio || "";
  // esempi: "Sangiovese 90%, Canaiolo 10%" | "Sangiovese, Canaiolo" | "100% Sangiovese"
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
  // normalizza a 100
  const sum = out.reduce((a,b)=>a+b.pct,0) || 100;
  return out.map(g => ({ ...g, pct: Math.round(100 * g.pct / sum) }));
}

// ---------- Lookup: grape_profiles / appellation_priors ----------
async function fetchGrapeRow(name: string) {
  const key = norm(name).replace(/\s+/g," ");
  let q = supabase.from("grape_profiles").select("*").eq("grape_norm", key).maybeSingle();
  let { data, error } = await q;
  if (!data) {
    // prova via synonyms @> key (array-contains)
    const { data: bySyn } = await supabase
      .from("grape_profiles")
      .select("*")
      .contains("synonyms", [key])
      .maybeSingle();
    data = bySyn || null;
  }
  if (!data && error) console.warn("grape lookup error", error);
  return data;
}

async function fetchAppellationDenom(candidates: string[]) {
  // candidates già normalizzati
  for (const c of candidates) {
    // match diretto su denom_norm
    let { data } = await supabase
      .from("appellation_priors")
      .select("*")
      .eq("denom_norm", c)
      .maybeSingle();
    if (data) return data;

    // match via synonyms array
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

// ---------- Testi (hook/palato) ----------
function pickNotes(color: "rosso"|"bianco"|"rosato", grapeHints: string[]): string[] {
  const allow = new Set(ALLOWED_NOTES[color]);
  const cleaned = grapeHints
    .map(n => n.toLowerCase().replace("spezie","pepe nero"))
    .filter(n => allow.has(n));
  const uniq = Array.from(new Set(cleaned));
  // riempi fino a 3 con vocabolario colore
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
  // es. "Limpido e succoso, profuma di ciliegia e violetta con un tocco speziato."
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

// ---------- Pairing logico ----------
function pickPairings(color: "rosso"|"bianco"|"rosato", p: Profile) {
  const base = [...ALLOWED_PAIRINGS[color]];
  // micro-logiche
  if (color !== "rosso" && (p.bubbles > 30 || p.acid > 65)) {
    // privilegia fritti/pesce
    const priority = ["fritture","antipasti di pesce","primi di pesce"];
    return Array.from(new Set(priority.concat(base))).slice(0,3);
  }
  if (color === "rosso" && (p.body > 60 || p.tannin > 55)) {
    const priority = ["carni rosse","formaggi stagionati","brasati"];
    return Array.from(new Set(priority.concat(base))).slice(0,3);
  }
  return base.slice(0,3);
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

    const fp = fingerprintName(nome);

    // 0) cache per fingerprint
    const { data: cached } = await supabase
      .from("descrizioni_vini")
      .select("descrizione, scheda")
      .eq("fingerprint", fp)
      .maybeSingle();
    if (cached?.descrizione) {
      return new Response(JSON.stringify({ descrizione: cached.descrizione, mini_card: cached.scheda || null }), { status: 200, headers: CORS });
    }

    // 1) colore
    const color = guessColor({ nome, categoria, sottocategoria, uvaggio });

    // 2) profilo da uvaggio (media pesata)
    const parts = parseUvaggio(uvaggio);
    const grapeProfiles: {p:Profile, w:number, name:string, matchedAs:string}[] = [];
    for (const g of parts) {
      const row = await fetchGrapeRow(g.name);
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
          matchedAs: row.grape_norm
        });
      }
    }
    const profileFromGrapes = grapeProfiles.length ? mergeWeighted(grapeProfiles.map(x=>({p:x.p, w:x.w||1}))) : { ...emptyProfile, acid: color==="bianco" ? 62 : 55 };

    // 3) prior da denominazione (usa nome/categoria/sottocategoria come candidati)
    const denomCandidates = Array.from(new Set([
      norm(nome), norm(categoria), norm(sottocategoria)
    ].filter(Boolean)));
    const denomRow = await fetchAppellationDenom(denomCandidates);

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

    // 4) chip Note (grape → hints → allowed by color)
    const grapeHintsRaw: string[] = [];
    for (const g of grapeProfiles) {
      const key = (g.matchedAs || g.name || "").toLowerCase();
      if (GRAPE_NOTE_HINTS[key]) grapeHintsRaw.push(...GRAPE_NOTE_HINTS[key]);
      // normalizza "spezie" → pepe/cannella a scelta
    }
    const notes = pickNotes(color, grapeHintsRaw);
    // 5) Hook & Palato
    const hook = buildHook(notes, color, profile.bubbles);
    const palate = buildPalate(profile, color);
    // 6) Pairings
    const pairings = pickPairings(color, profile);

    const descrizione = `${hook} ${palate}`.trim();

    const mini_card = {
      hook,
      palate,
      notes,
      pairings,
      emojis: {
        notes: Object.fromEntries(notes.map(n=>[n, EMOJI.notes.get(n) || ""])),
        pairings: Object.fromEntries(pairings.map(p=>[p, EMOJI.pair.get(p) || ""]))
      },
      profile: { ...profile, color },
      debug: {
        uvaggio_parsed: parts,
        grapes_matched: grapeProfiles.map(g=>({ name:g.name, matchedAs:g.matchedAs, weight:g.w })),
        denom_matched: denomRow ? (denomRow.denom_norm || "synonym") : null
      }
    };

    // 7) salva (cache per fingerprint + retro-compat) 
    await supabase.from("descrizioni_vini").upsert({
      fingerprint: fp,
      nome,
      annata: annata || null,
      uvaggio: uvaggio || null,
      ristorante_id: ristorante_id || null,
      descrizione,
      scheda: mini_card
    }, { onConflict: "fingerprint", ignoreDuplicates: false });

    return new Response(JSON.stringify({ descrizione, mini_card }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("Errore interno:", err);
    return new Response(JSON.stringify({ error: "Errore generazione mini-card", detail: err?.message ?? String(err) }), {
      status: 500, headers: CORS
    });
  }
});


