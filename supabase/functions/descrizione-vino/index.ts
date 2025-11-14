import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://deno.land/x/openai@v4.24.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://www.winesfever.com", // aggiungi altri domini se ti servono
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

function parseJSONList(s?: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
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
  const cut = s.slice(0, max - 1);
  const i = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
    cut.lastIndexOf(", "),
    cut.lastIndexOf(" ")
  );
  return (i > 40 ? cut.slice(0, i) : cut).trimEnd() + "…";
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

// =============== MAIN ===============

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
    const { nome, annata, uvaggio, categoria, sottocategoria, ristorante_id } =
      await req.json();

    if (!nome) {
      return new Response(
        JSON.stringify({ ok: false, error: "Manca il nome del vino" }),
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
    const { data: cached, error: cacheErr } = await supabase
      .from("descrizioni_vini") // <-- cambia nome se la tabella è diversa
      .select("*")
      .eq("ristorante_id", ristorante_id)
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    if (!cacheErr && cached) {
      // abbiamo già descrizione + scheda salvate
      return new Response(
        JSON.stringify({
          ok: true,
          descrizione: cached.descrizione,
          mini_card: cached.scheda,
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
    const { data: wineRow } = await supabase
      .from("wines")
      .select("*")
      .eq("ristorante_id", ristorante_id)
      .ilike("nome", nome)
      .maybeSingle();

    const wine = {
      nome: wineRow?.nome ?? nome,
      annata: wineRow?.annata ?? annata ?? null,
      uvaggio: wineRow?.uvaggio ?? uvaggio ?? "",
      categoria: wineRow?.categoria ?? categoria ?? "",
      sottocategoria: wineRow?.sottocategoria ?? sottocategoria ?? "",
    };

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

    // 3) PARSE UVAGGIO → lista di vitigni
    const parts = String(wine.uvaggio ?? "")
      .split(/(?:,|;| e | con |\+|\/)+/i)
      .map((s) => s.trim())
      .filter(Boolean);

    const parsedGrapes = parts.map((p) => {
      const pctMatch = p.match(/(\d+)\s*%/);
      const pct = pctMatch ? parseInt(pctMatch[1]) : null;
      const name = p.replace(/\d+\s*%/g, "").trim();
      return { raw: p, name, pct };
    });

    const grapeNames = unique(parsedGrapes.map((g) => g.name));
    const grapesDetailed = grapeNames.map((gName) => {
      const key = norm(gName);
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

      const matchPct =
        parsedGrapes.find((x) => norm(x.name) === key)?.pct ?? null;

      return {
        name: gName,
        percent: matchPct,
        profile: best,
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

    // 5) COSTRUISCI POOL DI NOTE & ABBINAMENTI

    const grapeNotesAll = grapesDetailed.flatMap((g) =>
      g.profile ? parseJSONList(g.profile.tasting_notes) : []
    );
    const grapePairsAll = grapesDetailed.flatMap((g) =>
      g.profile ? parseJSONList(g.profile.pairings) : []
    );

    const appNotes = app ? parseJSONList(app.typical_notes) : [];
    const appPairs = app ? parseJSONList(app.typical_pairings) : [];

    const styleHints = grapesDetailed.flatMap((g) =>
      g.profile ? parseJSONList(g.profile.style_hints) : []
    );
    const grapeTextSummaries = grapesDetailed.flatMap((g) =>
      g.profile ? parseJSONList(g.profile.text_summary) : []
    );
    const appStyleHints = app ? parseJSONList(app.style_hints) : [];
    const appPalateTemplate = app ? parseJSONList(app.palate_template) : [];

    const notesPool = unique([...grapeNotesAll, ...appNotes]);
    const pairingsPool = unique([...grapePairsAll, ...appPairs]);

    const notesChosen = pickDeterministic(notesPool, 3, wineSeed + "|notes");
    const pairingsChosen = pickDeterministic(
      pairingsPool,
      3,
      wineSeed + "|pair"
    );

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

    // colore
    const defaultColor =
      app?.default_color ||
      (norm(wine.categoria).includes("rosso")
        ? "Rosso"
        : norm(wine.categoria).includes("bianco")
        ? "Bianco"
        : norm(wine.categoria).includes("rosa") ||
          norm(wine.categoria).includes("rosato")
        ? "Rosato"
        : "ND");

    // 7) COSTRUISCI CONTEXT PER GPT

    const context = {
      vino: {
        nome: wine.nome,
        annata: wine.annata,
        categoria: wine.categoria,
        sottocategoria: wine.sottocategoria,
        colore: defaultColor,
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
      notes_scelte: notesChosen,
      abbinamenti_scelti: pairingsChosen,
    };

    // fallback descrizione “template” se GPT dovesse fallire
    const fallbackHook = clampChars(
      `${wine.nome}${wine.annata ? ` (${wine.annata})` : ""} – ${defaultColor.toLowerCase()} di profilo ${struttura.corpo}, tannino ${struttura.tannino}, acidità ${struttura.acidita}.`,
      120
    );
    const fallbackPalate = clampChars(
      notesChosen.length
        ? `Al naso emergono ${notesChosen.join(
            ", "
          )}; in bocca mantiene uno stile equilibrato e gastronomico.`
        : `Stile coerente con la denominazione, pensato per essere versatile a tavola.`,
      180
    );

    // 8) CHIAMATA GPT: genera hook + palate (2–3 frasi)

    let hook = fallbackHook;
    let palate = fallbackPalate;

    try {
      const system = `
Sei un sommelier digitale. 
Usa solo i dati nel CONTEXT per descrivere il vino in italiano.
Non inventare vitigni, regioni o denominazioni non presenti.
Devi restituire un JSON con:
{"hook":"...","palate":"..."}.
"hook" = 1 riga breve e accattivante (max ~120 caratteri).
"palate" = 1–2 frasi su bocca/struttura/uso a tavola (max ~200 caratteri).
Non restituire altro testo fuori dal JSON.
`.trim();

      const userMsg = `CONTEXT:\n${JSON.stringify(context, null, 2)}`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
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

    const descrizioneCompleta = `${hook} ${palate}`.trim();

    const mini_card = {
      hook,
      palate,
      notes: notesChosen,
      pairings: pairingsChosen,
      emojis: { notes: {}, pairings: {} },
    };

    // 9) SALVA NELLA CACHE descrizioni_vini
    try {
      await supabase.from("descrizioni_vini").insert({
        nome: wine.nome,
        annata: wine.annata ? String(wine.annata) : null,
        uvaggio: wine.uvaggio,
        descrizione: descrizioneCompleta,
        ristorante_id,
        fingerprint,
        scheda: mini_card,
      });
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




