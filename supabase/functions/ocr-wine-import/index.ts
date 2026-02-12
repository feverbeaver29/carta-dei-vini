/// <reference deno-lint-ignore-file no-explicit-any />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const allowedOrigins = new Set([
  "https://www.wineinapp.com",
  "https://wineinapp.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(origin: string | null) {
  const o = origin && allowedOrigins.has(origin) ? origin : "https://www.wineinapp.com";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

// --------------------
// Env
// --------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME")!;
const GCS_INPUT_PREFIX = Deno.env.get("GCS_INPUT_PREFIX") ?? "input/";
const GCS_OUTPUT_PREFIX = Deno.env.get("GCS_OUTPUT_PREFIX") ?? "output/";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
const OPENAI_MAX_CHARS = parseInt(Deno.env.get("OPENAI_MAX_CHARS") ?? "12000", 10);

// --------------------
// Helpers: base64url + JWT sign (RS256) for Google OAuth
// --------------------
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlEncodeString(s: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(s));
}

async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  // PEM -> DER
  const clean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)).buffer;

  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function googleAccessToken(scopes: string[]): Promise<string> {
  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned =
    `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(payload))}`;

  const key = await importPrivateKeyPem(sa.private_key);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      new TextEncoder().encode(unsigned),
    ),
  );

  const jwt = `${unsigned}.${base64UrlEncodeBytes(sigBytes)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) throw new Error(`Google token error: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

// --------------------
// GCS JSON API helpers
// --------------------
async function gcsUpload(
  token: string,
  bucket: string,
  objectName: string,
  bytes: Uint8Array,
  contentType: string,
) {
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`GCS upload error: ${await res.text()}`);
}

async function gcsList(token: string, bucket: string, prefix: string) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GCS list error: ${await res.text()}`);
  return await res.json();
}

async function gcsDownload(token: string, bucket: string, objectName: string) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GCS download error: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// --------------------
// Vision API helpers
// --------------------
async function visionImageOCR(token: string, imageBytes: Uint8Array) {
  const contentB64 = btoa(String.fromCharCode(...imageBytes));
  const body = {
    requests: [
      {
        image: { content: contentB64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      },
    ],
  };

  const res = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Vision image OCR error: ${await res.text()}`);
  return await res.json();
}

async function visionAsyncPdfOCR(
  token: string,
  gcsInputUri: string,
  gcsOutputUri: string,
) {
  const body = {
    requests: [
      {
        inputConfig: {
          gcsSource: { uri: gcsInputUri },
          mimeType: "application/pdf",
        },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        outputConfig: {
          gcsDestination: { uri: gcsOutputUri },
          batchSize: 20,
        },
      },
    ],
  };

  const res = await fetch(
    "https://vision.googleapis.com/v1/files:asyncBatchAnnotate",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`Vision async PDF error: ${await res.text()}`);
  return await res.json(); // { name: "operations/..." }
}

async function visionPollOperation(token: string, opName: string) {
  const url = `https://vision.googleapis.com/v1/${opName}`;
  for (let i = 0; i < 60; i++) { // ~60 * 2s = 2 minuti
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Vision poll error: ${await res.text()}`);
    const data = await res.json();
    if (data.done) return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Vision operation timeout (troppo lento).");
}

async function openaiExtractWinesFromText(ocrText: string) {
  if (!OPENAI_API_KEY) return [];

  const text = ocrText.slice(0, OPENAI_MAX_CHARS);

  const schema = {
    name: "wine_import",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              nome: { type: "string" },
              annata: { type: "string" },
              produttore: { type: "string" },
              localita: { type: "string" },
              uvaggio: { type: "string" },
              prezzo_bicchiere: { type: "string" },
              prezzo_bottiglia: { type: "string" },
            },
            required: ["nome"],
          },
        },
      },
      required: ["items"],
    },
  };

  const prompt = `
Sei un assistente che estrae vini da testo OCR di una carta vini.
Regole:
- Non inventare. Se un campo non è presente, lascia stringa vuota.
- Prezzi: se trovi due prezzi, il più basso è calice e il più alto è bottiglia.
- Ignora intestazioni e categorie (es: "VINI ROSSI ITALIANI").
- "produttore/cantina" e "località" possono essere su righe separate: assegnale ai vini fino a quando cambiano.
- Mantieni 'nome' pulito (senza prezzi, senza annate attaccate in modo strano).
Restituisci SOLO JSON conforme allo schema.
TESTO OCR:
${text}
`;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      // Structured Outputs / JSON schema
      response_format: {
        type: "json_schema",
        json_schema: schema,
      },
      temperature: 0,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI error: ${await res.text()}`);
  const data = await res.json();

  // Responses API: trovi il testo JSON in output[0].content[0].text (tipico)
  const outText =
    data?.output?.[0]?.content?.[0]?.text ??
    data?.output_text ??
    "";

  if (!outText) return [];

  const parsed = JSON.parse(outText);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items;
}

// --------------------
// Parsing: estrai righe vino (semplice ma robusto)
// --------------------
function normalizeLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function extractWineItemsFromText(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l.length >= 1);

  const items: any[] = [];

  const yearRe = /\b(19|20)\d{2}\b/g;
  const euroLineRe = /^€\s*\d{1,3}(?:[.,]\d{1,2})?$/;
  const numRe = /(?<!\d)(\d{1,3}(?:[.,]\d{1,2})?)(?!\d)/g;

  const producerKeywords = /\b(tenuta|cantina|azienda|societ[aà]|podere|fattoria|vigne|vigneti|vini|agricola)\b/i;

  function toNum(v: string) {
    return parseFloat(v.replace(",", "."));
  }

  function cleanHeader(s: string) {
    const lower = s.toLowerCase();
    if (
      lower.includes("vini") ||
      lower.includes("bottiglia") ||
      lower.includes("al calice") ||
      lower.includes("emilia") ||
      lower.includes("romagna") ||
      lower.includes("italiani") ||
      lower.includes("italiane")
    ) return "";
    return s;
  }

  function looksLikeLocation(s: string) {
    // es: "Torriana (RN)" oppure "... (Brisighella (RA)"
    if (/\([A-Z]{2}\)/.test(s) && s.length <= 40) return true;
    return false;
  }

  function extractLocationFromLine(s: string): string {
    // prende l’ultima parentesi con provincia, se c’è
    const m = s.match(/([^()]*)\(([A-Z]{2})\)\s*$/);
    if (m) return `${m[1].trim()} (${m[2]})`.trim();
    // fallback: tutta la riga se sembra location
    return s.trim();
  }

  function looksLikeProducer(s: string) {
    // no numeri, no euro, abbastanza corto, oppure contiene keyword
    const hasNums = /[0-9]/.test(s);
    const hasEuro = s.includes("€");
    if (hasNums || hasEuro) return false;

    if (producerKeywords.test(s)) return true;

    // tipo: "Filippo Manetti - Vigne di San Lorenzo ..."
    if (s.includes(" - ") && s.length <= 80) return true;

    // riga solo testo medio-corta
    if (s.split(" ").length <= 8 && s.length <= 45) return true;

    return false;
  }

  function isPriceOnlyLine(s: string) {
    const t = s.replace(/\s+/g, " ").trim();
    if (euroLineRe.test(t)) return true;

    // anche "40" da solo (senza €)
    if (/^\d{1,3}(?:[.,]\d{1,2})?$/.test(t)) {
      const n = toNum(t);
      return n >= 1 && n <= 500;
    }
    return false;
  }

  function extractInlinePrices(line: string) {
    const cleaned = line.replace(yearRe, " ").replace(/\s+/g, " ").trim();

    const nums = [...cleaned.matchAll(numRe)]
      .map((m) => m[1])
      .map((s) => ({ raw: s, n: toNum(s) }))
      .filter((x) => Number.isFinite(x.n))
      .filter((x) => x.n >= 1 && x.n <= 500)
      .filter((x) => !(x.n >= 1900 && x.n <= 2099));

    if (!nums.length) return { bottle: null as string | null, glass: null as string | null };

    const sorted = [...nums].sort((a, b) => a.n - b.n);
    return {
      bottle: sorted[sorted.length - 1].raw,
      glass: sorted.length >= 2 ? sorted[0].raw : null,
    };
  }

  function removePriceTokens(name: string, bottle: string | null, glass: string | null) {
    const removeOne = (s: string, p: string | null) => {
      if (!p) return s;
      const esc = p.replace(".", "\\.").replace(",", "\\,");
      return s.replace(new RegExp(`€?\\s*\\b${esc}\\b\\s*€?`, "g"), " ");
    };
    let out = name;
    out = removeOne(out, bottle);
    out = removeOne(out, glass);
    out = out.replace(/[€•·]+/g, " ").replace(/\s+/g, " ").trim();
    return out;
  }

  // pending state
  let pendingName = "";
  let pendingGrapes = "";
  let pendingProducer = "";
  let pendingLocation = "";

  // per gestire 2 righe prezzo consecutive (calice + bottiglia)
  let pendingPriceQueue: string[] = [];

  function finalizeWithPrices(priceA: string, priceB?: string) {
    if (!pendingName) return;

    const finalName = pendingName.replace(yearRe, " ").replace(/\s+/g, " ").trim();
    if (finalName.length < 3) return;

    // se 2 prezzi: calice=min, bottiglia=max
    const p1 = toNum(priceA);
    const p2 = priceB ? toNum(priceB) : NaN;

    let bottle = priceA;
    let glass = "";

    if (priceB && Number.isFinite(p1) && Number.isFinite(p2)) {
      const min = Math.min(p1, p2);
      const max = Math.max(p1, p2);
      glass = String(min).replace(".", ","); // se vuoi comma
      bottle = String(max).replace(".", ",");
    }

    items.push({
      nome: finalName,
      uvaggio: pendingGrapes || "",
      produttore: pendingProducer || "",
      localita: pendingLocation || "",
      prezzo: bottle,
      prezzo_bicchiere: glass,
      confidence: 0.85,
      raw_line: `${pendingProducer} | ${pendingLocation} | ${pendingName} | ${pendingGrapes} | ${priceA}${priceB ? " | " + priceB : ""}`,
    });

    // reset vino + prezzi + uvaggio (ma NON resettiamo producer/location: restano “attivi” finché non cambiano)
    pendingName = "";
    pendingGrapes = "";
    pendingPriceQueue = [];
  }

  for (const raw0 of lines) {
    const raw = normalizeLine(raw0);
    if (!raw) continue;

    const filtered = cleanHeader(raw);
    if (!filtered) continue;

    const lower = raw.toLowerCase();

    // 1) location su righe intermedie (non vino)
    if (looksLikeLocation(raw)) {
      pendingLocation = extractLocationFromLine(raw);
      continue;
    }

    // 2) producer/cantina su righe intermedie (non vino)
    // se la riga contiene anche una location in coda, separiamola
    if (looksLikeProducer(raw)) {
      // prova a separare "... (RA)" come location
      if (/\([A-Z]{2}\)\s*$/.test(raw)) {
        pendingLocation = extractLocationFromLine(raw);
        const before = raw.replace(/\([^)]*\([A-Z]{2}\)\)\s*$/, "").trim(); // gestisce doppia parentesi sporca
        pendingProducer = before || pendingProducer;
      } else {
        pendingProducer = raw;
      }
      continue;
    }

    // 3) uvaggio (una parola/2 parole, no numeri, no euro)
    const hasNums = /[0-9]/.test(raw);
    const hasEuro = raw.includes("€");
    if (!hasNums && !hasEuro && raw.split(" ").length <= 3 && raw.length <= 25) {
      if (!/^cantina\b/i.test(raw) && !/^docg\b/i.test(raw)) {
        pendingGrapes = raw;
        continue;
      }
    }

    // 4) prezzo su riga dedicata: mettilo in coda
    if (isPriceOnlyLine(raw)) {
      const p = raw.replace("€", "").trim();
      if (!pendingName) continue;

      pendingPriceQueue.push(p);

      // se arrivano 2 prezzi consecutivi, chiudiamo con calice+bottiglia
      if (pendingPriceQueue.length >= 2) {
        finalizeWithPrices(pendingPriceQueue[0], pendingPriceQueue[1]);
      }
      // se ne arriva solo uno, non chiudiamo subito: magari il secondo arriva dopo
      continue;
    }

    // 5) riga con prezzi inline (nome + 1/2 prezzi nella stessa riga)
    const { bottle, glass } = extractInlinePrices(raw);
    if (bottle) {
      let name = raw.replace(yearRe, " ").trim();
      name = removePriceTokens(name, bottle, glass);
      if (name.length >= 3 && !/^cantina\b/i.test(name) && !/^docg\b/i.test(name)) {
        items.push({
          nome: name,
          uvaggio: pendingGrapes || "",
          produttore: pendingProducer || "",
          localita: pendingLocation || "",
          prezzo: bottle,
          prezzo_bicchiere: glass || "",
          confidence: 0.85,
          raw_line: raw,
        });
        pendingName = "";
        pendingGrapes = "";
        pendingPriceQueue = [];
        continue;
      }
    }

    // 6) Se arriva una nuova riga “nome vino”, e avevamo 1 solo prezzo in coda, chiudiamo con quello
    if (pendingName && pendingPriceQueue.length === 1) {
      finalizeWithPrices(pendingPriceQueue[0]);
    }

    // 7) set pendingName (possibile vino)
    if (!/^cantina\b/i.test(lower) && !/^docg\b/i.test(lower)) {
      pendingName = raw;
      pendingPriceQueue = []; // reset coda prezzi perché nuovo vino
    }
  }

  // flush finale: se rimane un prezzo singolo
  if (pendingName && pendingPriceQueue.length === 1) {
    finalizeWithPrices(pendingPriceQueue[0]);
  }

  return items;
}

// --------------------
// Main
// --------------------
serve(async (req) => {
  const origin = req.headers.get("origin");
if (req.method === "OPTIONS") {
  return new Response("ok", { headers: corsHeaders(origin) });
}
let rawOcrText = "";
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response("Missing Authorization Bearer token", { status: 401, headers: corsHeaders(origin) });
    }

    const { ristorante_id, storage_bucket, storage_path } = await req.json();

    if (!ristorante_id || !storage_bucket || !storage_path) {
      return new Response("Missing params", { status: 400, headers: corsHeaders(origin) });
    }

    // Supabase admin client (service role)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1) Verifica utente e piano PRO via DB (owner_id = auth.uid)
    //    Recuperiamo user id dal token usando getUser
    const anonClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user?.id) {
      return new Response("Invalid user session", { status: 401, headers: corsHeaders(origin) });
    }
    const userId = userData.user.id;

    const { data: risto, error: ristoErr } = await supabase
      .from("ristoranti")
      .select("id, owner_id, subscription_plan, subscription_status")
      .eq("id", ristorante_id)
      .single();

    if (ristoErr || !risto) return new Response("Ristorante not found", { status: 404, headers: corsHeaders(origin) });
    if (risto.owner_id !== userId) return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });

    const plan = String(risto.subscription_plan ?? "").toLowerCase();
    const status = String(risto.subscription_status ?? "").toLowerCase();
    if (plan !== "pro" || (status && status !== "active")) {
      return new Response("PRO required", { status: 402, headers: corsHeaders(origin) });
    }

    // 2) Crea job
    const { data: jobIns, error: jobErr } = await supabase
      .from("ocr_import_jobs")
      .insert({
        ristorante_id,
        status: "processing",
        file_bucket: storage_bucket,
        file_path: storage_path,
      })
      .select("id")
      .single();

    if (jobErr) throw new Error(`DB job insert error: ${jobErr.message}`);
    const jobId = jobIns.id as string;

    // 3) Scarica file da Supabase Storage
    const { data: fileRes, error: dlErr } = await supabase
      .storage
      .from(storage_bucket)
      .download(storage_path);

    if (dlErr || !fileRes) throw new Error(`Storage download error: ${dlErr?.message ?? "no file"}`);

    const arrayBuf = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const mime = fileRes.type || "";

    // 4) Google token (Vision + GCS scope)
    const gToken = await googleAccessToken([
      "https://www.googleapis.com/auth/cloud-vision",
      "https://www.googleapis.com/auth/devstorage.read_write",
    ]);

    let items: any[] = [];

    // 5) OCR
    if (mime.includes("pdf") || storage_path.toLowerCase().endsWith(".pdf")) {
      // PDF async: upload to GCS input, run Vision async, read output json files from GCS output
      const gcsInputObject = `${GCS_INPUT_PREFIX}${ristorante_id}/${jobId}.pdf`;
      const gcsOutputPrefix = `${GCS_OUTPUT_PREFIX}${ristorante_id}/${jobId}/`;

      await gcsUpload(gToken, GCS_BUCKET_NAME, gcsInputObject, bytes, "application/pdf");

      const gcsInputUri = `gs://${GCS_BUCKET_NAME}/${gcsInputObject}`;
      const gcsOutputUri = `gs://${GCS_BUCKET_NAME}/${gcsOutputPrefix}`;

      const op = await visionAsyncPdfOCR(gToken, gcsInputUri, gcsOutputUri);
      const opName = op.name as string;

      await visionPollOperation(gToken, opName);

      // list output objects
      const listed = await gcsList(gToken, GCS_BUCKET_NAME, gcsOutputPrefix);
      const files: string[] = (listed.items ?? []).map((x: any) => x.name).filter((n: string) =>
        n.endsWith(".json")
      );

      let combinedText = "";
      for (const objName of files) {
        const outBytes = await gcsDownload(gToken, GCS_BUCKET_NAME, objName);
        const jsonText = new TextDecoder().decode(outBytes);
        const parsed = JSON.parse(jsonText);

        // Vision output: { responses: [...] }
        const responses = parsed.responses ?? [];
        for (const r of responses) {
          const t = r.fullTextAnnotation?.text;
          if (t) combinedText += `\n${t}`;
        }
      }
      rawOcrText = combinedText;
      items = extractWineItemsFromText(combinedText);
            // AI refine/fallback (solo se serve)
      if (items.length < 3 && OPENAI_API_KEY) {
        const aiItems = await openaiExtractWinesFromText(rawOcrText);
        if (aiItems.length) {
          // mappiamo ai campi che usa il tuo frontend
          items = aiItems.map((x: any) => ({
            nome: x.nome || "",
            uvaggio: x.uvaggio || "",
            produttore: x.produttore || "",
            localita: x.localita || "",
            prezzo: x.prezzo_bottiglia || "",
            prezzo_bicchiere: x.prezzo_bicchiere || "",
            confidence: 0.9,
            raw_line: "openai",
          }));
        }
      }

    } else {
      // image sync
      const v = await visionImageOCR(gToken, bytes);
      const text = v?.responses?.[0]?.fullTextAnnotation?.text ?? "";
      rawOcrText = text;
      items = extractWineItemsFromText(text);
            if (items.length < 3 && OPENAI_API_KEY) {
        const aiItems = await openaiExtractWinesFromText(rawOcrText);
        if (aiItems.length) {
          items = aiItems.map((x: any) => ({
            nome: x.nome || "",
            uvaggio: x.uvaggio || "",
            produttore: x.produttore || "",
            localita: x.localita || "",
            prezzo: x.prezzo_bottiglia || "",
            prezzo_bicchiere: x.prezzo_bicchiere || "",
            confidence: 0.9,
            raw_line: "openai",
          }));
        }
      }
    }

    // 6) Salva items in DB (facoltativo ma utile)
    if (items.length) {
      const rows = items.slice(0, 500).map((it) => ({
        job_id: jobId,
        raw_line: it.raw_line ?? null,
        name_guess: it.nome ?? null,
        price_guess: it.prezzo ?? null,
        grapes_guess: it.uvaggio ?? null,
        confidence: it.confidence ?? null,
      }));
      const { error: itemsErr } = await supabase.from("ocr_import_items").insert(rows);
      if (itemsErr) console.warn("Insert items warning:", itemsErr.message);
    }

    await supabase.from("ocr_import_jobs").update({
      status: "done",
      progress: 100,
      file_mime: mime,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

return new Response(JSON.stringify({
  job_id: jobId,
  items,
  raw_ocr_preview: rawOcrText.slice(0, 2000) // solo primi 2000 caratteri
}), {
  headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
});

  } catch (err: any) {
    console.error(err);
    return new Response(`OCR import error: ${err?.message ?? err}`, { status: 500, headers: corsHeaders(origin) });
  }
});
