import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const norm = (s:string) => (s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/\s+/g, " ")
  .trim();

  function splitDishes(input: string): string[] {
  return (input||"")
    .split(/\s*,\s*/g)        // split su virgole
    .map(s => s.trim())
    .filter(Boolean);
}

  function splitGrapes(uvaggio: string): string[] {
  const raw = (uvaggio || "").toLowerCase();
  return raw
    .split(/[,;+\-\/&]|\b(?:e|con|blend)\b|·/g)
    .map(s => s.replace(/\d+\s*%/g, "").trim())
    .filter(Boolean);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.winesfever.com", // oppure "*" se non usi credenziali
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const LANGS = {
  it: { name: "italiano", GRAPE: "UVAGGIO", MOTIVE: "MOTIVAZIONE" },
  en: { name: "English",  GRAPE: "GRAPE",   MOTIVE: "RATIONALE" },
  de: { name: "Deutsch",  GRAPE: "REBSORTE",MOTIVE: "BEGRÜNDUNG" },
  es: { name: "Español",  GRAPE: "UVA",     MOTIVE: "MOTIVACIÓN" },
  fr: { name: "Français", GRAPE: "CÉPAGES", MOTIVE: "JUSTIFICATION" },
  zh: { name: "中文",       GRAPE: "葡萄品种",  MOTIVE: "理由" }
};

function filtraEVotiVini({
  vini, boost = [], prezzo_massimo = null, colori = [], recenti = { byWine:{}, bySub:{} }
}: {
  vini: any[]; boost?: string[]; prezzo_massimo?: number|null; colori?: string[]; recenti?: { byWine:Record<string,number>, bySub:Record<string,number> };
}) {
  if (!Array.isArray(vini)) return [];

  const ranked = vini
    .filter(v => v.visibile !== false)
    .filter(v => { // hard filter prezzo massimo
      if (!prezzo_massimo) return true;
      const num = parseFloat((v.prezzo || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
      return num <= prezzo_massimo;
    })
    .map(v => {
      let score = 0;
      const nomeN = norm(v.nome);
      const isBoost = boost.includes(nomeN);

      // 1) boost leggero (verrà ripreso anche dopo nella parte match)
      if (isBoost) score += 6;

      // 2) filtro categorie richieste
      if (Array.isArray(colori) && colori.length > 0) {
        const cat = (v.categoria || "").toLowerCase();
        const match = colori.some(c => cat.includes(c.toLowerCase()));
        if (!match) return null; // escludi
        score += 10; // meno dominante di prima
      }

      // 3) anti-ripetizione forte (solo se non boost)
      if (!isBoost) {
        const pSub = norm(String(v.sottocategoria || ""));
        const timesWine = recenti.byWine[nomeN] || 0;
        const timesSub  = recenti.bySub[`${pSub}:${nomeN}`] || 0;
        score -= timesWine * 18;  // ↑
        score -= timesSub  * 12;  // penalità locale per stessa sottocategoria
        if (!timesWine && !timesSub) score += 8; // bonus novità
      }

      // 4) bonus formato “al calice”
      if (v.prezzo_bicchiere) score += 6;

      // 5) traccia produttore + uvaggio normalizzato (robusto)
const producerRaw = String(v.nome || "").split("|")[0];   // parte prima del "|"
v.__producer = norm(producerRaw);
v.__uvaggioN = norm(v.uvaggio || "");
v.__uvTokens = new Set(splitGrapes(v.uvaggio || "").map(norm));

      return { ...v, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // diversificazione di base: max 2 vini per produttore già qui
  const seenProd = new Map<string, number>();
  const diversified: any[] = [];
  for (const w of ranked) {
    const c = seenProd.get(w.__producer) || 0;
    if (c < 2) {
      diversified.push(w);
      seenProd.set(w.__producer, c + 1);
    }
    if (diversified.length >= 120) break;   // più ampio: lascia lavorare meglio la MMR
  }
  return diversified;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
      status: 200
    });
  }

  try {
 const { vini, piatto, ristorante_id, prezzo_massimo, colori, lang } = await req.json();
 const code = String(lang || "it").toLowerCase();
 const normCode = (code === "gb" ? "en" : code);   // alias GB → EN
 const L = LANGS[normCode] || LANGS.it;
    const supabaseUrl = "https://ldunvbftxhbtuyabgxwh.supabase.co";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

    // === Carica mappa uvaggi -> profilo (SOTTO a headers) ===
const gpRes = await fetch(`${supabaseUrl}/rest/v1/grape_profiles?select=display_name,grape_norm,acid,tannin,body,sweet,bubbles,synonyms`, { headers });
const grapeProfiles = await gpRes.json();

type Profile = { acid:number; tannin:number; body:number; sweet:number; bubbles:number };
const priors = new Map<string, Profile>();

for (const r of grapeProfiles) {
  priors.set(norm(r.display_name), { acid:r.acid, tannin:r.tannin, body:r.body, sweet:r.sweet, bubbles:r.bubbles });
  for (const syn of (r.synonyms || [])) {
    priors.set(norm(syn), { acid:r.acid, tannin:r.tannin, body:r.body, sweet:r.sweet, bubbles:r.bubbles });
  }
}

// === (OPZ) Carica prior per denominazioni ===
const apRes = await fetch(`${supabaseUrl}/rest/v1/appellation_priors?select=denom_norm,delta_acid,delta_tannin,delta_body,delta_sweet,delta_bubbles,synonyms`, { headers });
const appellationPriors = apRes.ok ? await apRes.json() : [];
const appMap = new Map<string, {acid:number,tannin:number,body:number,sweet:number,bubbles:number}>();
for (const r of (appellationPriors || [])) {
  const delta = {
    acid:   Number(r.delta_acid   || 0),
    tannin: Number(r.delta_tannin || 0),
    body:   Number(r.delta_body   || 0),
    sweet:  Number(r.delta_sweet  || 0),
    bubbles:Number(r.delta_bubbles|| 0)
  };
  appMap.set(norm(r.denom_norm), delta);
  (r.synonyms || []).forEach((s:string) => appMap.set(norm(s), delta));
}

const clamp01 = (x:number) => Math.max(0, Math.min(1, x));


const toVec = (p: Profile) => [p.acid, p.tannin, p.body, p.sweet, p.bubbles];

function cosSim(a:number[], b:number[]){
  const dot = a.reduce((s,ai,i)=>s+ai*b[i],0);
  const na = Math.sqrt(a.reduce((s,ai)=>s+ai*ai,0));
  const nb = Math.sqrt(b.reduce((s,bi)=>s+bi*bi,0));
  return na && nb ? dot/(na*nb) : 0;
}

// etichetta di stile: utile per forzare varietà negli N finali
function styleOf(p: Profile): "sparkling"|"crisp_white"|"full_white"|"rosato"|"light_red"|"structured_red"{
  if (p.bubbles >= .9) return "sparkling";
  if (p.tannin <= .15 && p.acid >= .6 && p.body <= .55) return "crisp_white";
  if (p.tannin <= .25 && p.body  > .55) return "full_white";
  if (p.tannin <= .35 && p.body <= .55 && p.acid >= .5) return "rosato";
  if (p.tannin <= .5  && p.body <= .6)  return "light_red";
  return "structured_red";
}

// === Fallback per categoria/sottocategoria ===
function fallbackByCategory(cat:string, sub:string): Profile {
  const c = (cat||"").toLowerCase();
  const s = (sub||"").toLowerCase();
  let p: Profile = { acid:.5, tannin:.3, body:.5, sweet:.0, bubbles:0 };
  if (/bianco/.test(c))  p = { acid:.60, tannin:.05, body:.45, sweet:.00, bubbles:0 };
  if (/rosso/.test(c))   p = { acid:.45, tannin:.55, body:.60, sweet:.00, bubbles:0 };
  if (/ros[ée]/.test(c)) p = { acid:.55, tannin:.15, body:.45, sweet:.00, bubbles:0 };
  if (/dolce|passito|vendemmia tardiva/i.test(c)) p.sweet = .7;
  if (/spumante|metodo|franciacorta|champagne/i.test(c)) { p.bubbles=1; p.acid=Math.max(p.acid,.6); }
  if (/pas dos[eé]|nature/.test(s)) p.sweet = 0.00;
  else if (/brut/.test(s))          p.sweet = Math.max(p.sweet, .05);
  else if (/extra ?dry/.test(s))    p.sweet = Math.max(p.sweet, .15);
  else if (/\bdry\b|\bsec\b/.test(s)) p.sweet = Math.max(p.sweet, .25);
  if (/riserva|gran selezione|barrique|rovere|affinamento/i.test(s)) { p.body=Math.min(1,p.body+.12); p.tannin=Math.min(1,p.tannin+.08); }
  return p;
}

// === Profilo finale per singolo vino ===
function profileFromWine(w:any): Profile {
  const grapes = splitGrapes(w.uvaggio);
  const hits: Profile[] = [];
  for (const g of grapes) {
    const key = norm(g);
    const found = priors.get(key);
    if (found) hits.push(found);
  }
if (hits.length) {
  const sum = hits.reduce((a,b)=>({ 
    acid:a.acid+b.acid, tannin:a.tannin+b.tannin, body:a.body+b.body, sweet:a.sweet+b.sweet, bubbles:Math.max(a.bubbles,b.bubbles)
  }), {acid:0,tannin:0,body:0,sweet:0,bubbles:0});

  let base: Profile = {
    acid: +(sum.acid / hits.length).toFixed(2),
    tannin: +(sum.tannin / hits.length).toFixed(2),
    body: +(sum.body / hits.length).toFixed(2),
    sweet: +(sum.sweet / hits.length).toFixed(2),
    bubbles: sum.bubbles > 0 ? 1 : 0
  };

  // (OPZ) prior denominazione
  const denomBag = norm(`${w.denominazione || ""} ${w.sottocategoria || ""} ${w.categoria || ""}`);
  for (const [k, delta] of appMap) {
    if (k && denomBag.includes(k)) {
      base = {
        acid:    clamp01(base.acid   + delta.acid),
        tannin:  clamp01(base.tannin + delta.tannin),
        body:    clamp01(base.body   + delta.body),
        sweet:   clamp01(base.sweet  + delta.sweet),
        bubbles: Math.max(base.bubbles, delta.bubbles > 0 ? 1 : 0)
      };
      break;
    }
  }
  return base;
}
return fallbackByCategory(w.categoria, w.sottocategoria);

}

// === Parser piatto -> feature sintetiche ===
type Dish = {
  fat:number; spice:number; sweet:number; intensity:number;
  protein: "pesce"|"carne_rossa"|"carne_bianca"|"salumi"|"formaggio"|"veg"|null;
  cooking: "crudo"|"fritto"|"griglia"|"brasato"|"bollito"|null;
  acid_hint:boolean;
};

function combineDishes(ds: Dish[]): Dish {
  if (!ds.length) {
    return { fat:.3, spice:0, sweet:0, intensity:.4, protein:null, cooking:null, acid_hint:false };
  }

  const avg = (arr:number[]) => arr.reduce((a,b)=>a+b,0) / arr.length;

  // moda (valore più frequente) ignorando null
  const mode = (arr:(string|null)[]) => {
    const counts = new Map<string, number>();
    for (const v of arr) {
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best: string|null = null;
    let bestN = 0;
    for (const [k,n] of counts.entries()) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return best as any || null;
  };

  // media per i continui
  const fat       = +avg(ds.map(d=>d.fat)).toFixed(2);
  const spice     = +avg(ds.map(d=>d.spice)).toFixed(2);
  const sweet     = +avg(ds.map(d=>d.sweet)).toFixed(2);
  const intensity = +avg(ds.map(d=>d.intensity)).toFixed(2);
  const acid_hint = ds.some(d=>d.acid_hint);

  // moda per le categoriche
  const protein = mode(ds.map(d=>d.protein));
  const cooking = mode(ds.map(d=>d.cooking));

  return { fat, spice, sweet, intensity, acid_hint, protein, cooking };
}

function parseDish(text:string): Dish {
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

// === Punteggio di coerenza profilo-vino -> piatto ===

function matchScore(p:Profile, d:Dish): number {
  let sc = 0;
  // Grassezza → acidità/bollicine
  sc += (d.fat * (p.acid*1.0 + p.bubbles*0.6));
  // Bollicine poco adatte a cotture lunghe/carni importanti
if (d.protein==="carne_rossa" || d.cooking==="brasato" || d.cooking==="griglia") {
  sc -= p.bubbles * 0.4;
}
  // Pesce/crudo → acidità ↑, tannino ↓
  if (d.protein==="pesce" || d.cooking==="crudo") sc += (p.acid*1.35) - (p.tannin*1.0);
  // Fritto → bollicine/acido
  if (d.cooking==="fritto") sc += (p.bubbles*1.3 + p.acid*0.8);
  // Carne rossa/brasato → corpo/tannino
  if (d.protein==="carne_rossa" || d.cooking==="brasato") sc += (p.tannin*1.5 + p.body*1.2);
  if (d.cooking==="brasato") sc -= p.bubbles * 0.6;
  // Piccante → un filo di dolcezza e tannino basso
  sc += (d.spice>0 ? (p.sweet*1.0 - p.tannin*0.8 - p.body*0.4) : 0);
  // Formaggi/fondute → serve corpo, acidità ok ma tannino medio/basso
if (d.protein === "formaggio") {
  sc += p.body * 0.6;
  sc += p.acid * 0.2;
  sc -= Math.max(0, p.tannin - 0.5) * 0.3;
}
// NEW: salumi → rossi leggeri/rosati, acidità per sgrassare, evita bollicine e tannino alto
if (d.protein === "salumi") {
  sc += p.acid * 0.35;                                 // serve freschezza
  sc += Math.max(0, 0.55 - p.tannin) * 0.4;            // premia tannino medio-basso
  sc += Math.max(0, 0.60 - p.body) * 0.2;              // corpo non pesantissimo
  sc -= p.bubbles * 0.40;                               // frizzanti non prioritari coi salumi
}
// NEW: piatti “veg” non fritti → preferisci bianchi/rosati fermi ben acidi
if (d.protein === "veg" && d.cooking !== "fritto") {
  sc += p.acid * 0.45;
  sc -= Math.max(0, p.tannin - 0.25) * 0.6;
  sc -= p.bubbles * 0.15;
}

// NEW: carne bianca alla griglia → corpo medio, poco tannino, bollicine non prioritarie
if (d.protein === "carne_bianca" && d.cooking === "griglia") {
  sc += p.body * 0.4;
  sc -= Math.max(0, p.tannin - 0.4) * 0.5;
  sc -= p.bubbles * 0.2;
}
  // Dessert → richiede dolcezza
  sc += (d.sweet>0 ? (p.sweet*1.5) : 0);
  // Nota acida nel piatto → premia acidità
  if (d.acid_hint) sc += p.acid*0.8;
  // Intensità: matching con il "body"
  sc += (1 - Math.abs(d.intensity - p.body))*0.6;
  return sc;
}

function buildMotivation(L: any, p: Profile, d: Dish): string {
  const parts: string[] = [];

  // regole principali (max 2 frasi brevi)
  if (d.cooking === "fritto" || d.fat >= .6) {
    if (p.bubbles >= .9) parts.push("Bollicine e acidità sgrassano la frittura");
    else if (p.acid >= .6) parts.push("Acidità incisiva per sgrassare il piatto");
  }
  if (d.protein === "pesce" || d.cooking === "crudo") {
    if (p.tannin <= .2) parts.push("Tannino basso adatto al pesce/crudo");
    if (p.acid >= .6) parts.push("Freschezza che valorizza l’ittico");
  }
  if (d.protein === "carne_rossa" || d.cooking === "brasato") {
    if (p.tannin >= .6 || p.body >= .6) parts.push("Struttura e tannino reggono cotture lunghe/carne rossa");
  }
  if (d.spice > 0) {
    if (p.sweet >= .1 && p.tannin <= .5) parts.push("Leggera dolcezza e tannino contenuto smorzano il piccante");
    else if (p.tannin <= .3) parts.push("Profilo morbido adatto al piccante");
  }
  if (d.sweet > 0) {
    if (p.sweet >= .6) parts.push("Dolcezza del vino in equilibrio col dessert");
  }
  // intensità ↔ body
  const bodyGap = Math.abs(d.intensity - p.body);
  if (bodyGap <= .2) parts.push("Intensità in linea con il piatto");
  else if (p.body > d.intensity) parts.push("Corpo sufficiente a bilanciare la ricchezza");
  else parts.push("Profilo snello per non coprire il piatto");

  // extra se c'è una sola frase
  if (parts.length <= 1) {
    const extras = [
      "Equilibrio gusto–vino centrato",
      "Profilo aromatico in armonia col piatto",
      "Finale pulito che invoglia il boccone successivo"
    ];
    parts.push(extras[Math.floor(Math.random()*extras.length)]);
  }

  const sentence = parts.slice(0, 2).join(". ") + ".";
  if (L?.name === "English") {
    return sentence
      .replace("Bollicine", "Bubbles")
      .replace("acidità", "acidity")
      .replace("frittura", "fried food")
      .replace("ittico", "seafood");
  }
  return sentence;
}

// === IA: estrai feature dal/i piatto/i in JSON (robusta) ===
async function getDishFeatures(piattoRaw: string, openaiKey: string | undefined): Promise<Dish> {
  // 1) se la chiave manca → fallback immediato
  if (!openaiKey) {
    console.error("OpenAI key mancante: uso parseDish fallback");
    return combineDishes(splitDishes(piattoRaw).map(parseDish));
  }

  const items = splitDishes(piattoRaw);

  // 2) prompt con ESEMPIO e richiesta di SOLO array JSON
  const userPrompt = `
Analizza questi piatti e restituisci SOLO un ARRAY JSON (non testo attorno, niente spiegazioni), dove ogni elemento è un oggetto con le chiavi:
- "protein": uno tra "pesce","carne_rossa","carne_bianca","salumi","formaggio","veg" oppure null
- "cooking": uno tra "crudo","fritto","griglia","brasato","bollito" oppure null
- "fat": numero tra 0 e 1
- "spice": numero tra 0 e 1
- "sweet": numero tra 0 e 1
- "intensity": numero tra 0 e 1
- "acid_hint": true/false

Se non sei sicuro, usa valori neutrali: fat 0.3, spice 0, sweet 0, intensity 0.4, protein null, cooking null, acid_hint false.

Esempio di OUTPUT valido per due piatti:
[
  { "protein":"carne_rossa","cooking":"brasato","fat":0.6,"spice":0.1,"sweet":0.0,"intensity":0.8,"acid_hint":false },
  { "protein":"veg","cooking":null,"fat":0.3,"spice":0.0,"sweet":0.2,"intensity":0.4,"acid_hint":true }
]

Piatti: ${items.map(s => `"${s}"`).join(", ")}
`.trim();

  // 3) chiamata semplice (niente response_format) + logging difensivo
  let resp: Response | null = null;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // usa un modello disponibile: se vuoi cambiare, cambialo qui
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 400,
        messages: [
          { role: "system", content: "Rispondi sempre e solo con un ARRAY JSON valido. Nessun testo prima o dopo." },
          { role: "user", content: userPrompt }
        ]
      })
    });
  } catch (netErr) {
    console.error("OpenAI fetch error (rete):", netErr);
    return combineDishes(splitDishes(piattoRaw).map(parseDish));
  }

  if (!resp || !resp.ok) {
    const errText = resp ? await resp.text() : "no response";
    console.error("OpenAI non OK:", errText);
    return combineDishes(splitDishes(piattoRaw).map(parseDish));
  }

  // 4) estrai contenuto e parsalo in modo robusto
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content || "";
  // log di debug utile per capire cosa risponde il modello
  console.log("OpenAI raw content:", content.slice(0, 400));

  let arr: any[] = [];
  try {
    // caso ideale: è già un array json
    if (content.trim().startsWith("[")) {
      arr = JSON.parse(content);
    } else {
      // prova a catturare il primo array con una regex
      const m = content.match(/\[[\s\S]*\]/);
      arr = m ? JSON.parse(m[0]) : [];
    }
  } catch (parseErr) {
    console.error("Errore parsing JSON dal contenuto OpenAI:", parseErr);
    arr = [];
  }

  // 5) normalizzazione output → Dish[]
  const toDish = (r:any): Dish => ({
    protein: (["pesce","carne_rossa","carne_bianca","salumi","formaggio","veg"].includes(r?.protein)) ? r.protein : null,
    cooking: (["crudo","fritto","griglia","brasato","bollito"].includes(r?.cooking)) ? r.cooking : null,
    fat: Math.min(1, Math.max(0, Number(r?.fat ?? 0.3))),
    spice: Math.min(1, Math.max(0, Number(r?.spice ?? 0))),
    sweet: Math.min(1, Math.max(0, Number(r?.sweet ?? 0))),
    intensity: Math.min(1, Math.max(0, Number(r?.intensity ?? 0.4))),
    acid_hint: !!r?.acid_hint
  });

  const dishes: Dish[] = Array.isArray(arr) ? arr.map(toDish) : [];
  if (!dishes.length) {
    // fallback “intelligente”: usa il parser semplice su ogni piatto e fai la media
    return combineDishes(items.map(parseDish));
  }
  return combineDishes(dishes);
}

    const infoRes = await fetch(`${supabaseUrl}/rest/v1/ristoranti?id=eq.${ristorante_id}&select=sommelier_range,sommelier_boost_multi`, { headers });
    const [info] = await infoRes.json();

    const range = info?.sommelier_range || "2-3";
    const [min, max] = range.split("-").map(n => parseInt(n));

let boost: string[] = [];
let boostNorm = new Set<string>();
try {
  boost = JSON.parse(info?.sommelier_boost_multi || "[]");
  boostNorm = new Set((boost || []).map(norm));
} catch (_) {
  boost = [];
  boostNorm = new Set();
}

    if (!vini || !Array.isArray(vini) || vini.length === 0) {
      return new Response(JSON.stringify({ error: "Nessun vino nel sistema." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!piatto) {
      return new Response(JSON.stringify({ error: "Manca il nome del piatto." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

let recentLog = [];
try {
  const recentRes = await fetch(`${supabaseUrl}/rest/v1/consigliati_log?ristorante_id=eq.${ristorante_id}&order=creato_il.desc&limit=100`, { headers });
  if (recentRes.ok) {
    recentLog = await recentRes.json();
  }
} catch (_) {
  recentLog = [];
}

// 🔁 Frequenza per vino/sottocategoria con decadimento temporale (half-life 48h)
const freqByWine: Record<string, number> = {};
const freqBySub:  Record<string, number> = {};

const nowMs = Date.now();
const HALF_LIFE_H = 48;
const LAMBDA = Math.log(2) / (HALF_LIFE_H * 3600 * 1000);
const decay = (ts:string) => {
  const t = new Date(ts).getTime();
  const dt = Math.max(0, nowMs - (isNaN(t) ? nowMs : t));
  return Math.exp(-LAMBDA * dt);
};

recentLog.forEach(r => {
  const sotto = norm(String(r.sottocategoria || ""));
  const w = decay(String(r.creato_il || ""));      // peso 0..1 (più recente = più alto)
  (r.vini || []).forEach((nome: string) => {
    const n = norm(nome);
    if (!boostNorm.has(n)) {
      freqByWine[n] = (freqByWine[n] || 0) + w;
      if (sotto) freqBySub[`${sotto}:${n}`] = (freqBySub[`${sotto}:${n}`] || 0) + w;
    }
  });
});

// Valuta varietà recente (quanti vini unici negli ultimi 100 log?)
const recentUnique = new Set<string>();
recentLog.forEach(r => (r.vini || []).forEach((n:string) => recentUnique.add(norm(n))));
const uniqCount = recentUnique.size;

// ε dinamico: se pochi unici, aumenta esplorazione (max 0.5)
const EPS_BASE = 0.20;
const EPS_MAX  = 0.50;
const targetUniq = 18; // vorremmo almeno 18 etichette diverse negli ultimi 100 record
const lack = Math.max(0, targetUniq - uniqCount);   // quanta varietà manca
const EPSILON = Math.min(EPS_MAX, EPS_BASE + lack * 0.02);  // +2pp per unità di “lack”


    // ✅ Filtra e valuta i vini
    const viniFiltrati = filtraEVotiVini({
      vini,
      boost: Array.from(boostNorm),  // <— normalizzati
      prezzo_massimo: prezzo_massimo ? parseInt(prezzo_massimo) : null,
      colori,
      recenti: { byWine: freqByWine, bySub: freqBySub },  // ⬅️
    });

    if (viniFiltrati.length === 0) {
      return new Response(JSON.stringify({ error: "Nessun vino filtrato compatibile." }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    
    const viniConProfilo = viniFiltrati.map(w => {
  const prof = profileFromWine(w);
  return { ...w, __profile: prof };
});

// === Ordina per coerenza col piatto, mantenendo i tuoi filtri esistenti ===
const openaiKey = Deno.env.get("OPENAI_API_KEY");
let dish: Dish;
try {
  dish = await getDishFeatures(piatto, openaiKey);
} catch (e) {
  // fallback totale
  dish = combineDishes(splitDishes(piatto).map(parseDish));
  console.error("Dish features via OpenAI fallite (catch), uso fallback combine(parseDish):", e);
}
console.log("Dish features (combined):", dish);

// === Ordina per coerenza col piatto + integra lo score "filtri/varietà" + rotazione boost ===
const BOOST_THRESHOLD = 0.52;
const LAMBDA_MMR = 0.72;       // tradeoff qualità vs diversità

// normalizza lo score di filtraEVotiVini in [0..1]
const scores = viniConProfilo.map(w => w.score ?? 0);
const minS = Math.min(...scores);
const maxS = Math.max(...scores);
const denom = (maxS - minS) || 1;

// calcola punteggi grezzi
let prelim = viniConProfilo.map(w => {
  const m = matchScore(w.__profile, dish);
  const sNorm = denom ? ((w.score ?? 0) - minS) / denom : 0.5; // se tutti uguali, metti 0.5

  // rotazione boost: se boostato ma “troppo chiamato” → dimezza bonus
  const nomeN = norm(w.nome);
  const calls = (freqByWine?.[nomeN] || 0);
  const boosted = boostNorm.has(nomeN) && m >= BOOST_THRESHOLD;
  // bonus base 0.16 che decade con le chiamate recenti (calls)
const boostBonus = boosted ? 0.16 * Math.exp(-0.7 * calls) : 0;

  // piccola esplorazione (jitter) solo nel ramo exploitation
  const jitter = (Math.random() - 0.5) * 0.04; // ±0.02

  const final = (m * 0.72 + sNorm * 0.18 + boostBonus) + jitter;

  return { ...w, __match: m, __sNorm: sNorm, __final_pre: final, __style: styleOf(w.__profile) };
});

// ε-greedy: 20% → rimescola top 24 e lascia alla MMR il compito di scegliere
if (Math.random() < EPSILON) {
  prelim = prelim
    .sort((a,b) => b.__final_pre - a.__final_pre)
    .slice(0, Math.min(24, prelim.length))
    .sort(() => Math.random() - 0.5)
    .concat(
      prelim.sort((a,b) => b.__final_pre - a.__final_pre).slice(24)
    );
} else {
  prelim.sort((a,b) => b.__final_pre - a.__final_pre);
}

// Maximal Marginal Relevance su profili e uvaggi
const wanted = Math.min(Math.max(max, Math.max(min,1)), prelim.length);

// cap per bollicine (come prima, ma più stretto di default)
const bubblesCap = (dish.cooking === "fritto" || (dish.fat >= 0.6 && !["brasato","griglia"].includes(dish.cooking||"")))
  ? 2 : 1;

const picked: any[] = [];
let bubblesUsed = 0;

function jaccard(a:Set<string>, b:Set<string>){
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

function redundancyPenalty(cand:any, chosen:any[]){
  if (!chosen.length) return 0;

  // similitudine profili
  const p = toVec(cand.__profile);
  const simP = Math.max(...chosen.map(ch => cosSim(p, toVec(ch.__profile))));

  // similitudine uvaggi (Jaccard)
  const uvSim = Math.max(...chosen.map(ch => jaccard(cand.__uvTokens, ch.__uvTokens)));

  // base: prendiamo il max tra le due similitudini
  let pen = Math.max(simP, uvSim * 0.85);

  // stesso uvaggio "quasi" identico => extra
  if (uvSim >= 0.66) pen = Math.min(1, pen + 0.15);

  // stesso produttore => piccola extra
  const sameProd = chosen.some(ch => ch.__producer === cand.__producer);
  if (sameProd) pen = Math.min(1, pen + 0.10);

  return pen; // 0..1
}

// MMR
const pool = prelim.slice(0, Math.min(60, prelim.length)); // se vuoi più varietà, puoi portare 60 -> 80
const capBySub = 2;                     // max 2 etichette per stessa sottocategoria
const usedBySub = new Map<string, number>();

while (picked.length < wanted && pool.length) {
  // ricalcola punteggio MMR ad ogni iterazione
  let bestIdx = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < pool.length; i++) {
    const cand = pool[i];
    const isBubbly = cand.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(cand.categoria || "");
    if (isBubbly && bubblesUsed >= bubblesCap) continue;

    const rel = cand.__final_pre;                 // rilevanza
    const red = redundancyPenalty(cand, picked);  // 0..1 (similitudine)
    const mmr = LAMBDA_MMR * rel - (1 - LAMBDA_MMR) * red;

    if (mmr > bestScore) {
      bestScore = mmr;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) break; // nessun candidato valido

  const candidate = pool[bestIdx];

  // cap per sottocategoria sul candidato scelto
  const subN = norm(String(candidate.sottocategoria || ""));
  if (subN) {
    const used = usedBySub.get(subN) || 0;
    if (used >= capBySub) {
      // scarta questo candidato e riprova
      pool.splice(bestIdx, 1);
      continue;
    }
  }

  // prendi il candidato
  const chosen = pool.splice(bestIdx, 1)[0];
  if (!chosen) break;

  const isBubblyChosen = chosen.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(chosen.categoria || "");
  if (isBubblyChosen) bubblesUsed++;

  picked.push(chosen);

  // aggiorna contatore per sottocategoria
  const subChosen = norm(String(chosen.sottocategoria || ""));
  if (subChosen) {
    usedBySub.set(subChosen, (usedBySub.get(subChosen) || 0) + 1);
  }
}

// opzionale: garantisci 1 slot a un boost coerente se non presente
const alreadyBoosted = topN.some(w => boostNorm.has(norm(w.nome)));
if (!alreadyBoosted) {
  const boostedPool = prelim.filter(w =>
    boostNorm.has(norm(w.nome)) &&
    w.__match >= BOOST_THRESHOLD &&
    !topN.some(p => norm(p.nome) === norm(w.nome))
  );

  // scegli il migliore che non rompe i cap (bollicine/sottocategoria)
  const tryPick = boostedPool.find(cand => {
    const isBubbly = cand.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(cand.categoria || "");
    if (isBubbly && bubblesUsed >= bubblesCap) return false;
    const subN = norm(String(cand.sottocategoria || ""));
    const used = usedBySub.get(subN) || 0;
    if (subN && used >= capBySub) return false;
    return true;
  });

  if (tryPick) {
    // sostituisci l'ultimo (più debole) se abbiamo già raggiunto 'wanted'
    if (topN.length >= wanted) {
      const last = topN.pop();
      // aggiorna contatori se rimpiazziamo un bubbly
      if (last) {
        const lastBub = last.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(last.categoria || "");
        if (lastBub) bubblesUsed = Math.max(0, bubblesUsed - 1);
        const lastSub = norm(String(last.sottocategoria || ""));
        if (lastSub) usedBySub.set(lastSub, Math.max(0, (usedBySub.get(lastSub) || 1) - 1));
      }
    }
    topN.push(tryPick);
    if (tryPick.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(tryPick.categoria || "")) bubblesUsed++;
    const subChosen = norm(String(tryPick.sottocategoria || ""));
    if (subChosen) usedBySub.set(subChosen, (usedBySub.get(subChosen) || 0) + 1);
  }
}

// opzionale: 1 exploration slot se varietà recente bassa
if (topN.length < wanted && uniqCount < targetUniq) {
  const already = new Set(topN.map(p => norm(p.nome)));
  const exploration = prelim
    .filter(w => !already.has(norm(w.nome)))
    .sort((a,b) => (freqByWine[norm(a.nome)] || 0) - (freqByWine[norm(b.nome)] || 0)); // meno esposto prima

  const candidate = exploration.find(cand => {
    const isBubbly = cand.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(cand.categoria || "");
    if (isBubbly && bubblesUsed >= bubblesCap) return false;
    const subN = norm(String(cand.sottocategoria || ""));
    const used = usedBySub.get(subN) || 0;
    if (subN && used >= capBySub) return false;
    return true;
  });

  if (candidate) {
    topN.push(candidate);
    if (candidate.__profile.bubbles >= 0.9 || /spumante|franciacorta|champagne/i.test(candidate.categoria || "")) bubblesUsed++;
    const subChosen = norm(String(candidate.sottocategoria || ""));
    if (subChosen) usedBySub.set(subChosen, (usedBySub.get(subChosen) || 0) + 1);
  }
}

// “varietà di stile” minima: prova ad assicurare almeno 2 stili diversi se possibile
if (picked.length >= 3) {
  const styles = new Set(picked.map(p => p.__style));
  if (styles.size === 1) {
    const firstStyle = picked[0].__style;
    const alt = prelim.find(w => w.__style !== firstStyle && !picked.some(p => p.nome === w.nome));
    if (alt) picked[picked.length-1] = alt;
  }
}

const topN = picked;

// === Output finale + logging
const lines: string[] = [];
for (const w of topN) {
  const grape = (w.uvaggio && w.uvaggio.trim()) ? w.uvaggio.trim() : "N.D.";
  const motive = buildMotivation(L, w.__profile, dish);
  lines.push(`- ${w.nome}
${L.GRAPE}: ${grape}
${L.MOTIVE}: ${motive}`);
}

// prime 5 dopo il pre-ranking (match + varietà + boost rotation)
console.log("Top 5 (prelim):",
  prelim.slice(0,5).map(w => ({
    nome: w.nome,
    match: +w.__match.toFixed(3),
    sNorm: +w.__sNorm.toFixed(3),
    final_pre: +w.__final_pre.toFixed(3),
    prof: w.__profile
  }))
);

// selezione finale (dopo MMR + cap bollicine + varietà di stile)
console.log("DEBUG picked:",
  topN.map(w => ({
    nome: w.nome,
    match: +w.__match.toFixed(3),
    sNorm: +w.__sNorm.toFixed(3),
    final_pre: +w.__final_pre.toFixed(3),
    style: w.__style,
    prof: w.__profile
  }))
);

const viniSuggeriti = topN.map(w => w.nome);
const boostInclusi = viniSuggeriti.some(nome => boostNorm.has(norm(nome)));

await fetch(`${supabaseUrl}/rest/v1/consigliati_log`, {
  method: "POST",
  headers: {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  },
  body: JSON.stringify({
    ristorante_id,
    piatto,
    vini: topN.map(w => w.nome),
    boost_inclusi: topN.some(w => boostNorm.has(norm(w.nome))),
    sottocategoria: topN[0]?.sottocategoria || null
  })
});

// Risposta nel formato identico a prima (campo 'suggestion')
return new Response(JSON.stringify({ suggestion: lines.join("\n\n") }), {
  headers: corsHeaders,
});


  } catch (err) {
    console.error("❌ Errore imprevisto:", err);
    return new Response(JSON.stringify({ error: "Errore interno", detail: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});


