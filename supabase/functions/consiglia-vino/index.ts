import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

/** =========================
 *  UTIL
 *  ========================= */
const norm = (s:string) => (s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/\s+/g, " ")
  .trim();

const clamp01 = (x:number) => Math.max(0, Math.min(1, x));

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.winesfever.com",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json"
};

const LANGS = {
  it: { name: "italiano", GRAPE: "UVAGGIO", MOTIVE: "MOTIVAZIONE" },
  en: { name: "English",  GRAPE: "GRAPE",   MOTIVE: "RATIONALE" },
  de: { name: "Deutsch",  GRAPE: "REBSORTE",MOTIVE: "BEGRÜNDUNG" },
  es: { name: "Español",  GRAPE: "UVA",     MOTIVE: "MOTIVACIÓN" },
  fr: { name: "Français", GRAPE: "CÉPAGES", MOTIVE: "JUSTIFICATION" },
  zh: { name: "中文",       GRAPE: "葡萄品种",  MOTIVE: "理由" }
} as const;

/** =========================
 *  DOMAIN
 *  ========================= */
type Profile = { acid:number; tannin:number; body:number; sweet:number; bubbles:number };
type Dish = {
  fat:number; spice:number; sweet:number; intensity:number;
  protein: "pesce"|"carne_rossa"|"carne_bianca"|"salumi"|"formaggio"|"veg"|null;
  cooking: "crudo"|"fritto"|"griglia"|"brasato"|"bollito"|null;
  acid_hint:boolean;
};
type Colore = "bianco"|"rosso"|"rosato"|"spumante"|"dolce"|"altro";

// parsing multi-voce "piatti"
const splitDishes = (input: string): string[] =>
  (input||"").split(/\s*,\s*/g).map(s=>s.trim()).filter(Boolean);

// split uvaggio → tokens robusti
function splitGrapes(uvaggio: string): string[] {
  const raw = (uvaggio || "").toLowerCase()
    .replace(/\b(docg?|ig[pt])\b/g, " ")
    .replace(/\bclassico\b/g, " ")
    .replace(/\d+\s*%/g, " ");
  return raw
    .split(/[,;+\-\/&]|\b(?:e|con|blend|uvaggio|cépage|variet[aà])\b|·/g)
    .map(s => s.trim())
    .filter(Boolean);
}

// RNG deterministico
function hashStringToSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed: number) { return function() {
  let t = seed += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};}

// cosine
const toVec = (p: Profile) => [p.acid, p.tannin, p.body, p.sweet, p.bubbles];
function cosSim(a:number[], b:number[]){
  const dot = a.reduce((s,ai,i)=>s+ai*b[i],0);
  const na = Math.sqrt(a.reduce((s,ai)=>s+ai*ai,0));
  const nb = Math.sqrt(b.reduce((s,bi)=>s+bi*bi,0));
  return na && nb ? dot/(na*nb) : 0;
}

/** =========================
 *  HARD COLOR PARSER (NO MORE MISLABELS)
 *  ========================= */
function coloreFromCat(catRaw:string, subRaw:string): Colore {
  const bag = `${catRaw||""} ${subRaw||""}`.toLowerCase();
  if (/\b(spumante|metodo\s*classico|franciacorta|champagne|trentodoc|col\s*fondo|colfondo|bollicine|brut|pas dos[ée]|dosaggio\s*zero|extra\s*dry)\b/.test(bag))
    return "spumante";
  if (/\b(dolce|passito|vendemmia\s*tardiva|late\s*harvest|sauternes|vin\s*santo)\b/.test(bag))
    return "dolce";
  if (/\bros[ée]|\brosato\b/.test(bag))
    return "rosato";
  if (/\bbianco\b/.test(bag))
    return "bianco";
  if (/\brosso\b/.test(bag))
    return "rosso";
  // fallback “altro” (usiamo profilo ma non cambiamo il colore altrove)
  return "altro";
}

/** =========================
 *  DISH PARSER (fallback + IA robusta)
 *  ========================= */
function parseDishFallback(text:string): Dish {
  const s = (text||"").toLowerCase();
  const dish: Dish = { fat:0.3, spice:0, sweet:0, intensity:0.4, protein:null, cooking:null, acid_hint:false };

  if (/crudo|tartare|carpaccio/.test(s)) dish.cooking="crudo", dish.intensity=.3;
  if (/fritt|impanat/.test(s)) dish.cooking="fritto", dish.fat=.7, dish.intensity=Math.max(dish.intensity,.5);
  if (/griglia|brace|arrosto/.test(s)) dish.cooking="griglia", dish.intensity=.6;
  if (/brasat|stracotto|stufato/.test(s)) dish.cooking="brasato", dish.intensity=.8, dish.fat=Math.max(dish.fat,.6);
  if (/bollit/.test(s)) dish.cooking="bollito", dish.intensity=Math.max(dish.intensity,.45);
  if (/limone|agrodolce|aceto|capperi|citric|yuzu/.test(s)) dish.acid_hint=true;
  if (/piccant|’nduja|nduja|peperoncino|curry|speziat/.test(s)) dish.spice=.6;
  if (/dolce|dessert|tiramisu|cheesecake|torta|pasticc|gelato|sorbetto/.test(s)) dish.sweet=.8, dish.intensity=.6;

  if (/pesce|tonno|salmone|gamber|calamari|cozze|vongole|polpo|scampi|branzino|orata|spigola/.test(s)) dish.protein="pesce";
  else if (/manzo|bovino|fiorentina|tagliata|agnello|cervo|capriolo|cacciagione/.test(s)) dish.protein="carne_rossa", dish.intensity=.8;
  else if (/maiale|porchetta|salsiccia|pollo|tacchino|coniglio|anatra|oca/.test(s)) dish.protein="carne_bianca", dish.intensity=Math.max(dish.intensity,.5);
  else if (/salume|prosciutto|speck|salami|mortadella|culatello|bresaola/.test(s)) dish.protein="salumi", dish.intensity=.6, dish.fat=.6;
  else if (/formagg|parmigiano|pecorino|gorgonzola|caprino|blu|erborinat/.test(s)) dish.protein="formaggio", dish.intensity=.7, dish.fat=.6;
  else dish.protein = dish.protein ?? "veg";

  if (/burro|panna|carbonara|cacio e pepe|alla gricia|quattro formaggi/.test(s)) dish.fat=Math.max(dish.fat,.6);
  if (/pomodoro|rag[ùu]/.test(s)) dish.intensity=Math.max(dish.intensity,.55);

  return dish;
}

function combineDishes(ds: Dish[]): Dish {
  if (!ds.length) return { fat:.3, spice:0, sweet:0, intensity:.4, protein:null, cooking:null, acid_hint:false };
  const avg = (a:number[]) => a.reduce((x,y)=>x+y,0)/a.length;
  const mode = (arr:(string|null)[]) => {
    const m = new Map<string,number>();
    for (const v of arr) if (v) m.set(v, (m.get(v)||0)+1);
    return Array.from(m.entries()).sort((a,b)=>b[1]-a[1])[0]?.[0] as any ?? null;
  };
  return {
    fat:+avg(ds.map(d=>d.fat)).toFixed(2),
    spice:+avg(ds.map(d=>d.spice)).toFixed(2),
    sweet:+avg(ds.map(d=>d.sweet)).toFixed(2),
    intensity:+avg(ds.map(d=>d.intensity)).toFixed(2),
    acid_hint: ds.some(d=>d.acid_hint),
    protein: mode(ds.map(d=>d.protein)),
    cooking: mode(ds.map(d=>d.cooking))
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
Piatti: ${items.map(s=>`"${s}"`).join(", ")}
`.trim();

  let resp: Response | null = null;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          { role: "system", content: "Rispondi sempre e solo con un ARRAY JSON valido. Nessun testo prima o dopo." },
          { role: "user", content: userPrompt }
        ]
      })
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
    else { const m = content.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : []; }
  } catch { arr = []; }

  const toDish = (r:any): Dish => ({
    protein: (["pesce","carne_rossa","carne_bianca","salumi","formaggio","veg"].includes(r?.protein)) ? r.protein : null,
    cooking: (["crudo","fritto","griglia","brasato","bollito"].includes(r?.cooking)) ? r.cooking : null,
    fat: clamp01(Number(r?.fat ?? 0.3)),
    spice: clamp01(Number(r?.spice ?? 0)),
    sweet: clamp01(Number(r?.sweet ?? 0)),
    intensity: clamp01(Number(r?.intensity ?? 0.4)),
    acid_hint: !!r?.acid_hint
  });

  const dishes: Dish[] = Array.isArray(arr) ? arr.map(toDish) : [];
  return dishes.length ? combineDishes(dishes) : combineDishes(items.map(parseDishFallback));
}

/** =========================
 *  MATCHING
 *  ========================= */
function matchScore(p:Profile, d:Dish): number {
  let sc = 0;
  sc += (d.fat * (p.acid*1.0 + p.bubbles*0.6)); // sgrassare
  if (d.protein==="pesce" || d.cooking==="crudo") sc += (p.acid*1.35) - (p.tannin*1.0);
  if (d.cooking==="fritto") sc += (p.bubbles*1.3 + p.acid*0.8);
  if (d.protein==="carne_rossa" || d.cooking==="brasato") sc += (p.tannin*1.5 + p.body*1.2) - (p.bubbles*0.6);
  if (d.spice>0) sc += (p.sweet*1.0 - p.tannin*0.8 - p.body*0.4);
  if (d.protein==="formaggio") { sc += p.body*0.6 + p.acid*0.2 - Math.max(0, p.tannin-0.5)*0.3; }
  if (d.protein==="salumi") { sc += p.acid*0.35 + Math.max(0,0.55-p.tannin)*0.4 + Math.max(0,0.60-p.body)*0.2 - p.bubbles*0.40; }
  if (d.protein==="veg" && d.cooking!=="fritto") { sc += p.acid*0.45 - Math.max(0,p.tannin-0.25)*0.6 - p.bubbles*0.15; }
  if (d.protein==="carne_bianca" && d.cooking==="griglia") { sc += p.body*0.4 - Math.max(0,p.tannin-0.4)*0.5 - p.bubbles*0.2; }
  if (d.sweet>0) sc += (p.sweet*1.5);
  if (d.acid_hint) sc += p.acid*0.8;
  sc += (1 - Math.abs(d.intensity - p.body))*0.6;
  // hard cuts
  if ((d.protein==="pesce" || d.cooking==="crudo") && p.tannin >= 0.65) sc -= 0.4*(p.tannin - 0.65);
  return sc;
}

function buildMotivation(L:any, p:Profile, d:Dish): string {
  const out:string[] = [];
  if (d.cooking==="fritto" || d.fat>=.6) {
    if (p.bubbles>=.9) out.push("Bollicine e acidità sgrassano la frittura");
    else if (p.acid>=.6) out.push("Acidità incisiva per sgrassare il piatto");
  }
  if (d.protein==="pesce" || d.cooking==="crudo") {
    if (p.tannin<=.2) out.push("Tannino basso adatto al pesce/crudo");
    if (p.acid>=.6) out.push("Freschezza che valorizza l’ittico");
  }
  if (d.protein==="carne_rossa" || d.cooking==="brasato") {
    if (p.tannin>=.6 || p.body>=.6) out.push("Struttura e tannino reggono cotture lunghe/carne rossa");
  }
  if (d.spice>0) {
    if (p.sweet>=.1 && p.tannin<=.5) out.push("Leggera dolcezza e tannino contenuto smorzano il piccante");
    else if (p.tannin<=.3) out.push("Profilo morbido adatto al piccante");
  }
  if (d.sweet>0 && p.sweet>=.6) out.push("Dolcezza del vino in equilibrio col dessert");
  const gap=Math.abs(d.intensity-p.body);
  if (gap<=.2) out.push("Intensità in linea con il piatto");
  else if (p.body>d.intensity) out.push("Corpo sufficiente a bilanciare la ricchezza");
  else out.push("Profilo snello per non coprire il piatto");
  return (out.slice(0,2).join(". ") + ".");
}

/** =========================
 *  PRIORS: grapes & denominazioni
 *  ========================= */
type PriorMap = Map<string, Profile>;
async function loadPriors(headers:Record<string,string>): Promise<{grape:PriorMap, app: Map<string,Profile>}> {
  const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
  const gpRes = await fetch(`${supabaseUrl}/rest/v1/grape_profiles?select=display_name,grape_norm,acid,tannin,body,sweet,bubbles,synonyms`, { headers });
  if (!gpRes.ok) throw new Error(`grape_profiles ${gpRes.status}`);
  const grapeRows = await gpRes.json();

  const grape = new Map<string,Profile>();
  for (const r of grapeRows) {
    const p = { acid:r.acid, tannin:r.tannin, body:r.body, sweet:r.sweet, bubbles:r.bubbles };
    grape.set(norm(r.display_name), p);
    for (const syn of (r.synonyms || [])) grape.set(norm(syn), p);
  }

  const apRes = await fetch(`${supabaseUrl}/rest/v1/appellation_priors?select=denom_norm,delta_acid,delta_tannin,delta_body,delta_sweet,delta_bubbles,synonyms`, { headers });
  const appRows = apRes.ok ? await apRes.json() : [];
  const app = new Map<string,Profile>();
  for (const r of (appRows||[])) {
    const delta:Profile = {
      acid:Number(r.delta_acid||0),
      tannin:Number(r.delta_tannin||0),
      body:Number(r.delta_body||0),
      sweet:Number(r.delta_sweet||0),
      bubbles:Number(r.delta_bubbles||0)
    };
    app.set(norm(r.denom_norm), delta);
    (r.synonyms||[]).forEach((s:string)=>app.set(norm(s), delta));
  }
  return { grape, app };
}

/** profileFromWine con guard-rail sul COLORE **/
function profileFromWine(w:any, priors: {grape:PriorMap, app:Map<string,Profile>}, colore:Colore): Profile {
  const tokens = splitGrapes(w.uvaggio).map(norm);
  const hits: Profile[] = [];
  for (const g of tokens) {
    const p = priors.grape.get(g);
    if (p) hits.push(p);
  }

  let base: Profile;
  if (hits.length) {
    const sum = hits.reduce((a,b)=>({
      acid:a.acid+b.acid, tannin:a.tannin+b.tannin, body:a.body+b.body, sweet:a.sweet+b.sweet, bubbles:Math.max(a.bubbles,b.bubbles)
    }), {acid:0,tannin:0,body:0,sweet:0,bubbles:0});
    base = {
      acid:+(sum.acid/hits.length).toFixed(2),
      tannin:+(sum.tannin/hits.length).toFixed(2),
      body:+(sum.body/hits.length).toFixed(2),
      sweet:+(sum.sweet/hits.length).toFixed(2),
      bubbles: sum.bubbles>0 ? 1 : 0
    };
  } else {
    // fallback “centroide” di categoria
    base = { acid:.55, tannin:.35, body:.52, sweet:0, bubbles:0 };
  }

  // denominazione → delte pesate (docg>doc>igt)
  const bag = norm(`${w.denominazione||""} ${w.sottocategoria||""} ${w.categoria||""}`);
  const matches: Array<{w:number, d:Profile}> = [];
  for (const [k, delta] of priors.app) {
    if (k && bag.includes(k)) {
      const spec = /\bdocg\b/.test(k) ? 1.0 : /\bdoc\b/.test(k) ? 0.7 : /\big[pt]\b/.test(k) ? 0.4 : 0.2;
      matches.push({ w: spec, d: delta });
    }
  }
  if (matches.length) {
    const W = matches.reduce((s,m)=>s+m.w,0) || 1;
    const agg = matches.reduce((acc,m)=>({
      acid: acc.acid + m.d.acid*(m.w/W),
      tannin: acc.tannin + m.d.tannin*(m.w/W),
      body: acc.body + m.d.body*(m.w/W),
      sweet: acc.sweet + m.d.sweet*(m.w/W),
      bubbles: Math.max(acc.bubbles, m.d.bubbles>0 ? 1 : 0)
    }), {acid:0,tannin:0,body:0,sweet:0,bubbles:0});
    base = {
      acid: clamp01(base.acid + agg.acid),
      tannin: clamp01(base.tannin + agg.tannin),
      body: clamp01(base.body + agg.body),
      sweet: clamp01(base.sweet + agg.sweet),
      bubbles: Math.max(base.bubbles, agg.bubbles)
    };
  }

  // ======= HARD COLOR GUARD-RAILS =======
  switch (colore) {
    case "spumante":
      base = { ...base, bubbles:1, acid:Math.max(base.acid, .6), tannin: Math.min(base.tannin, .25) };
      break;
    case "bianco":
      base = { ...base, tannin: Math.min(base.tannin, .25), body: clamp01(base.body) };
      break;
    case "rosato":
      base = { ...base, tannin: Math.min(base.tannin, .45) };
      break;
    case "rosso":
      // nulla di speciale: lasciamo uvaggio/denom guidare ma niente bubbles “accidentali”
      base = { ...base, bubbles: 0 };
      break;
    case "dolce":
      base = { ...base, sweet: Math.max(base.sweet, .6) };
      break;
  }
  return base;
}

/** =========================
 *  ROTAZIONE: exposure + UCB + fair caps + MMR
 *  ========================= */
function jaccard(a:Set<string>|undefined, b:Set<string>|undefined){
  if (!a || !b || a.size===0 || b.size===0) return 0;
  let inter=0; for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter/uni : 0;
}

function mmrScore(cand:any, chosen:any[], lambda=0.6){
  if (!chosen.length) return cand.__baseScore;
  const simP = Math.max(...chosen.map(ch => cosSim(toVec(cand.__profile), toVec(ch.__profile))));
  const uvSim= Math.max(...chosen.map(ch => jaccard(cand.__uvTokens, ch.__uvTokens)));
  const pen = Math.max(simP, uvSim*1.0);
  return lambda * cand.__baseScore - (1 - lambda) * pen;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
  return new Response(null, { status: 204, headers: corsHeaders });
}

  try {
    const { vini, piatto, ristorante_id, prezzo_massimo, colori, lang } = await req.json();
    const coloriNorm: Colore[] = Array.isArray(colori) && colori.length
      ? colori.map((c: string) => coloreFromCat(String(c || ""), String(c || "")))
      : [];
    const coloriSet = new Set(coloriNorm);
    const code = String(lang || "it").toLowerCase();
    const L = LANGS[code === "gb" ? "en" : code] || LANGS.it;

    if (!Array.isArray(vini) || vini.length===0)
      return new Response(JSON.stringify({ error:"Nessun vino nel sistema." }), { status:400, headers:corsHeaders });
    if (!piatto)
      return new Response(JSON.stringify({ error:"Manca il nome del piatto." }), { status:400, headers:corsHeaders });

    const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

    // config ristorante
    const infoRes = await fetch(`${supabaseUrl}/rest/v1/ristoranti?id=eq.${ristorante_id}&select=sommelier_range,sommelier_boost_multi`, { headers });
    const [info] = await infoRes.json();
    const range = info?.sommelier_range || "2-3";
    const [min, max] = range.split("-").map(n => parseInt(n));
    const wanted = (n => Math.min(Math.max(max, Math.max(min,1)), n))(vini.length);

    let boostList: string[] = [];
    try { boostList = JSON.parse(info?.sommelier_boost_multi || "[]"); } catch {}
    const boostSet = new Set(boostList.map(norm));

    // priors
    const priors = await loadPriors(headers);

    // recent logs → exposure con half-life
    let recentLog:any[] = [];
    try {
      const recentRes = await fetch(`${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&order=creato_il.desc&limit=300`, { headers });
      if (recentRes.ok) recentLog = await recentRes.json();
    } catch {}
    const nowMs = Date.now(), HALF_LIFE_H=48, LAMBDA_DECAY = Math.log(2) / (HALF_LIFE_H*3600*1000);
    const decay = (ts:string) => { const t = new Date(ts).getTime(); const dt = Math.max(0, nowMs - (isNaN(t)?nowMs:t)); return Math.exp(-LAMBDA_DECAY*dt); };

    const expByWine: Record<string,number> = {};
    const expBySub:  Record<string,number> = {};
    recentLog.forEach(r=>{
      const sotto = norm(String(r.sottocategoria||""));
      const w = decay(String(r.creato_il||""));
      (r.vini||[]).forEach((nome:string)=>{
        const n = norm(nome);
        expByWine[n] = (expByWine[n]||0) + w;
        if (sotto) expBySub[`${sotto}:${n}`] = (expBySub[`${sotto}:${n}`]||0) + w;
      });
    });

    // seed jitter STABILE AL GIORNO (non al minuto)
    const day = new Date().toISOString().slice(0,10); // YYYY-MM-DD
    const rng = mulberry32(hashStringToSeed(`${ristorante_id}|${norm(piatto)}|${day}`));

    // parse piatto
    const dish = await getDishFeatures(piatto, Deno.env.get("OPENAI_API_KEY"));

    // normalizza vini, colore hard, filtri prezzo & colori richiesti
    const wines0 = vini
      .filter(v => v?.visibile !== false)
      .map(v => {
        const prezzoNum = parseFloat(String(v.prezzo||"").replace(/[^\d.,]/g,"").replace(",", ".")) || 0;
        const colore = coloreFromCat(String(v.categoria||""), String(v.sottocategoria||""));
        const nomeN = norm(v.nome);
        const producerRaw = String(v.nome||"").split("|")[0];
        const __producer = norm(producerRaw);
        const __uvTokens = new Set(splitGrapes(v.uvaggio || "").map(norm));
        return { ...v, prezzoNum, colore, nomeN, __producer, __uvTokens };
      })
      .filter(v => !prezzo_massimo || v.prezzoNum <= Number(prezzo_massimo))
        .filter(v => coloriSet.size ? coloriSet.has(v.colore) : true);

    if (!wines0.length)
      return new Response(JSON.stringify({ error:"Nessun vino filtrato compatibile." }), { status:400, headers:corsHeaders });

    // costruisci profilo con guard-rails colore
    const wines = wines0.map(w => {
      const __profile = profileFromWine(w, priors, w.colore);
      return { ...w, __profile };
    });

    // match grezzo & normalizzazione 0..1
    const mVals = wines.map(w => matchScore(w.__profile, dish));
    const mMin = Math.min(...mVals), mMax = Math.max(...mVals), mRange = (mMax - mMin) || 1;
    const mNorm = (m:number) => (m - mMin) / mRange;

    // UCB exploration: priorità a poco/mai esposti
    // UCB = quality_norm + c*sqrt( ln(total+e) / (views+1) )
    const totalViews = Object.values(expByWine).reduce((a,b)=>a+b,0) || 1;
    const C = 0.30; // spinta esplorativa (puoi 0.25–0.40)
    const baseList = wines.map(w => {
      const q = mNorm(matchScore(w.__profile, dish));
      const views = expByWine[w.nomeN] || 0;
      const ucb = q + C * Math.sqrt(Math.log(totalViews + Math.E) / (views + 1));
      // bonus “meno esposti nel tier”
      const exposurePenalty = -0.10 * Math.pow((views / (totalViews||1)), 0.7);
      // leggero jitter stabile
      const jitter = (rng() - 0.5) * 0.02;
      return { ...w, __q:q, __baseScore: clamp01(ucb + exposurePenalty + jitter) };
    });

    // pool ordinato (qualità + esplorazione)
    const sorted = baseList.sort((a,b)=>b.__baseScore - a.__baseScore);

    // priorità assoluta: includi 1–2 vini “mai visti” se esistono
    const neverSeen = sorted.filter(w => (expByWine[w.nomeN] || 0) === 0).slice(0, Math.min(2, wanted));

    // caps per diversità
    const capByProd = wanted >= 4 ? 2 : 1;
    const capBySub  = wanted >= 4 ? 2 : 1;
    const capByGrape = wanted <= 3 ? 1 : 2;

    const usedByProd = new Map<string,number>();
    const usedBySub  = new Map<string,number>();
    const usedByGrape = new Map<string,number>();
    const chosen:any[] = [];

    // helper per vitigno “principale” (prima token uvaggio, poi fallback su denom)
    function mainGrapeOf(w:any){
      const arr = Array.from(w.__uvTokens || []);
      if (arr.length) return arr[0];
      const bag = `${w.denominazione||""} ${w.sottocategoria||""} ${w.categoria||""}`.toLowerCase();
      const m = bag.match(/\b(barbera|nebbiolo|sangiovese|merlot|cabernet|syrah|pinot\s+nero|pinot\s+grigio|chardonnay|vermentino|greco|fiano|verdicchio|zibibbo|grillo|glera|sagrantino|aglianico|primitivo|nero d.?avola|corvina|trebbiano)\b/);
      return m ? norm(m[0]) : "";
    }

    // prima aggiungi “never seen” rispettando caps
    for (const w of neverSeen) {
      const prod = w.__producer;
      const sub  = norm(String(w.sottocategoria||""));
      const grape = mainGrapeOf(w);
      if ((usedByProd.get(prod)||0) >= capByProd) continue;
      if (sub && (usedBySub.get(sub)||0) >= capBySub) continue;
      if (grape && (usedByGrape.get(grape)||0) >= capByGrape) continue;
      chosen.push(w);
      usedByProd.set(prod, (usedByProd.get(prod)||0)+1);
      if (sub) usedBySub.set(sub, (usedBySub.get(sub)||0)+1);
      if (grape) usedByGrape.set(grape, (usedByGrape.get(grape)||0)+1);
      if (chosen.length >= Math.min(2, wanted)) break;
    }

    // BOOST GUARANTITO (1 slot hard; 2 se wanted>=5)
    const boostSlots = Math.min(wanted>=5?2:1, wanted);
    const alreadyBoostCount = chosen.filter(w => boostSet.has(norm(w.nome))).length;
    if (alreadyBoostCount < boostSlots) {
      const boostCands = sorted.filter(w => boostSet.has(norm(w.nome)));
      // guard-rails: no bollicine su brasato/carne rossa intensa; evita tannino altissimo su pesce/crudo
      function allowedBoost(w:any){
        const p = w.__profile as Profile;
        const isBubbly = p.bubbles>=0.9 || /\b(spumante|franciacorta|champagne)\b/i.test(String(w.categoria||""));
        if ((dish.cooking==="brasato" || (dish.protein==="carne_rossa" && dish.intensity>=0.75)) && isBubbly) return false;
        if ((dish.protein==="pesce" || dish.cooking==="crudo") && p.tannin>=0.70) return false;
        // richiedi un match minimo “decente” (0.42) ma se non c'è niente, prenderemo il best allowed lo stesso
        return mNorm(matchScore(p, dish)) >= 0.42;
      }
      // ordina per: allowed prima, poi min exposure, poi baseScore
      const sortedBoost = boostCands
        .sort((a,b)=> ( (expByWine[a.nomeN]||0)-(expByWine[b.nomeN]||0) ) || (b.__baseScore - a.__baseScore));

      const take = [];
      for (const cand of sortedBoost) {
        // se nessun allowed, alla fine prenderemo il “best allowed OR best safe” sotto guard-rails soft
        if (allowedBoost(cand)) take.push(cand);
        if (take.length >= (boostSlots - alreadyBoostCount)) break;
      }
      if (take.length < (boostSlots - alreadyBoostCount) && sortedBoost.length) {
        // prendi comunque il migliore “consentito soft”
        take.push(sortedBoost[0]);
      }
      for (const cand of take) {
        if (chosen.length >= wanted) break;
        if (chosen.some(c => c.nomeN === cand.nomeN)) continue;
        const prod = cand.__producer;
        const sub  = norm(String(cand.sottocategoria||""));
        const grape = mainGrapeOf(cand);
        if ((usedByProd.get(prod)||0) >= capByProd) continue;
        if (sub && (usedBySub.get(sub)||0) >= capBySub) continue;
        if (grape && (usedByGrape.get(grape)||0) >= capByGrape) continue;
        chosen.push(cand);
        usedByProd.set(prod, (usedByProd.get(prod)||0)+1);
        if (sub) usedBySub.set(sub, (usedBySub.get(sub)||0)+1);
        if (grape) usedByGrape.set(grape, (usedByGrape.get(grape)||0)+1);
        if (chosen.filter(w => boostSet.has(norm(w.nome))).length >= boostSlots) break;
      }
    }

    // riempi con MMR + caps dal pool rimanente
    const already = new Set(chosen.map(w=>w.nomeN));
    const pool = sorted.filter(w => !already.has(w.nomeN));

    while (chosen.length < wanted && pool.length) {
      let bestIdx = -1, bestScore = -Infinity;
      for (let i=0; i<pool.length; i++) {
        const cand = pool[i];
        const prod = cand.__producer;
        const sub  = norm(String(cand.sottocategoria||""));
        const grape = mainGrapeOf(cand);
        if ((usedByProd.get(prod)||0) >= capByProd) continue;
        if (sub && (usedBySub.get(sub)||0) >= capBySub) continue;
        if (grape && (usedByGrape.get(grape)||0) >= capByGrape) continue;

        const score = mmrScore(cand, chosen, 0.6);
        if (score > bestScore) { bestScore=score; bestIdx=i; }
      }
      if (bestIdx < 0) break;
      const chosenOne = pool.splice(bestIdx,1)[0];
      chosen.push(chosenOne);
      const prod = chosenOne.__producer;
      const sub  = norm(String(chosenOne.sottocategoria||""));
      const grape = mainGrapeOf(chosenOne);
      usedByProd.set(prod, (usedByProd.get(prod)||0)+1);
      if (sub) usedBySub.set(sub, (usedBySub.get(sub)||0)+1);
      if (grape) usedByGrape.set(grape, (usedByGrape.get(grape)||0)+1);
    }

    // stile (solo per varietà visiva, NON per colore)
    function styleOf(p:Profile, meta?:{categoria?:string; denominazione?:string; sottocategoria?:string}):
      "sparkling"|"crisp_white"|"full_white"|"rosato"|"light_red"|"structured_red" {
      if (p.bubbles>=.9) return "sparkling";
      // ricavo dalla durezza del profilo, ma non cambio colore
      if (p.tannin<=.15 && p.acid>=.6 && p.body<=.55) return "crisp_white";
      if (p.tannin<=.25 && p.body > .55) return "full_white";
      if (p.tannin<=.5  && p.body<=.6)  return "light_red";
      return "structured_red";
    }

    const out = chosen.map(w => {
      const grape = (w.uvaggio && w.uvaggio.trim()) ? w.uvaggio.trim() : "N.D.";
      const motive = buildMotivation(L, w.__profile, dish);
      return { ...w, __style: styleOf(w.__profile, { categoria:w.categoria, denominazione:w.denominazione, sottocategoria:w.sottocategoria }), grape, motive };
    });

    // logging sintetico
    console.log("PICKED",
      out.map(x => ({ nome:x.nome, q:+x.__q?.toFixed(3), base:+x.__baseScore?.toFixed(3), style:x.__style, prof:x.__profile })),
      { seed:`${ristorante_id}|${norm(piatto)}|${day}` }
    );

    // persist log
    await fetch(`${supabaseUrl}/rest/v1/consigliati_log`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        ristorante_id,
        piatto,
        vini: out.map(w => w.nome),
        boost_inclusi: out.some(w => boostSet.has(norm(w.nome))),
        sottocategoria: out[0]?.sottocategoria || null
      })
    });

    // response compatibile
    const Lbl = L;
    const lines = out.map(w => `- ${w.nome}
${Lbl.GRAPE}: ${w.grape}
${Lbl.MOTIVE}: ${w.motive}`);
    return new Response(JSON.stringify({ suggestion: lines.join("\n\n") }), { headers: corsHeaders });

  } catch (err:any) {
    console.error("❌ Errore imprevisto:", err);
    return new Response(JSON.stringify({ error:"Errore interno", detail: err?.message }), { status:500, headers:corsHeaders });
  }
});



