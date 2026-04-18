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
const MAX_OCR_CHARS = parseInt(Deno.env.get("MAX_OCR_CHARS") ?? "120000", 10);
// --------------------
// Hard limits anti WORKER_LIMIT (CPU/mem/time)
// --------------------
const MAX_PDF_PAGES = parseInt(Deno.env.get("MAX_PDF_PAGES") ?? "20", 10);          // quante pagine OCR leggere max
const MAX_GCS_JSON_FILES = parseInt(Deno.env.get("MAX_GCS_JSON_FILES") ?? "6", 10); // quanti json output max (fail-safe)
const MAX_AI_CHUNKS = parseInt(Deno.env.get("MAX_AI_CHUNKS") ?? "6", 10);           // quanti chunk OpenAI max
const VISION_POLL_MAX = parseInt(Deno.env.get("VISION_POLL_MAX") ?? "45", 10);      // tentativi polling
const VISION_POLL_DELAY_MS = parseInt(Deno.env.get("VISION_POLL_DELAY_MS") ?? "2000", 10); // sleep polling

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

async function visionPollOperation(
  token: string,
  opName: string,
  onTick?: (i: number, max: number) => Promise<void> | void,
) {
  const url = `https://vision.googleapis.com/v1/${opName}`;
  const MAX = VISION_POLL_MAX;

  for (let i = 0; i < MAX; i++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Vision poll error: ${await res.text()}`);
    const data = await res.json();
    if (data.done) return data;

    if (onTick) await onTick(i + 1, MAX);
    await new Promise((r) => setTimeout(r, VISION_POLL_DELAY_MS));
  }
  throw new Error("Vision operation timeout (troppo lento).");
}

function buildNumberedLines(ocrText: string) {
  const lines = ocrText
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const numbered = lines.map((l, i) => `L${String(i + 1).padStart(4, "0")}: ${l}`);
  return { lines, numberedText: numbered.join("\n") };
}

function chunkNumberedText(numberedLines: string[], maxChars: number, overlapLines = 12) {
  const chunks: { start: number; end: number; text: string }[] = [];
  let i = 0;

  while (i < numberedLines.length) {
    let size = 0;
    const start = i;
    const buf: string[] = [];

    while (i < numberedLines.length) {
      const add = numberedLines[i].length + 1;
      if (size + add > maxChars && buf.length) break;
      buf.push(numberedLines[i]);
      size += add;
      i++;
    }

    const end = i;
    chunks.push({ start, end, text: buf.join("\n") });

    const next = Math.max(end - overlapLines, 0);
    i = (next <= start) ? end : next; // ✅ overlap ma sempre progresso
  }

  return chunks;
}

const CURRENCY_SYMBOL_BY_CODE: Record<string, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  JPY: "¥",
  CHF: "CHF",
};

function currencyCodeToSymbol(v?: string | null) {
  const code = normalizeCurrencyCode(v);
  return code ? (CURRENCY_SYMBOL_BY_CODE[code] || "€") : "€";
}

function normalizeCurrencyCode(v?: string | null): string | null {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (s === "€" || s === "EUR" || s === "EURO") return "EUR";
  if (s === "$" || s === "USD") return "USD";
  if (s === "£" || s === "GBP") return "GBP";
  if (s === "¥" || s === "JPY" || s === "YEN") return "JPY";
  if (s === "CHF") return "CHF";
  return null;
}

function normalizeFormatCode(v?: string | null): string | null {
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/,/g, ".");

  if (!s) return null;

  if (["glass", "calice", "bicchiere", "byglass", "alcalice", "glas", "verre"].includes(s)) {
    return "glass";
  }
  if (["075", "0.75", "75cl", "750ml", "bottle", "bot", "bottiglia"].includes(s)) {
    return "075";
  }
  if (["025", "0.25", "25cl", "250ml", "quarter"].includes(s)) {
    return "025";
  }
  if (["0375", "0.375", "37.5cl", "375ml", "halfbottle"].includes(s)) {
    return "0375";
  }
  if (["05", "0.5", "50cl", "500ml", "mezzo", "half"].includes(s)) {
    return "05";
  }
  if (["15", "1.5", "150cl", "1500ml", "magnum"].includes(s)) {
    return "15";
  }
  if (["3l", "3.0", "300cl", "3000ml", "jeroboam"].includes(s)) {
    return "3l";
  }

  return null;
}

function toAdminPriceString(value: any): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number"
    ? value
    : parseFloat(String(value).replace(",", ".").trim());

  if (!Number.isFinite(n)) return "";

  const fixed = Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
  return fixed;
}

function buildNomeCompletoFromRaw(raw: any): string {
  const producer = String(raw?.producer || "").trim();
  const wineName = String(raw?.wine_name || "").trim();
  const denomination = String(raw?.denomination || "").trim();

  let nome = [producer, wineName].filter(Boolean).join(" - ").trim();

  if (!nome && denomination) nome = denomination;

  if (nome && denomination) {
    const ln = nome.toLowerCase();
    const ld = denomination.toLowerCase();
    if (!ln.includes(ld) && !producer && wineName) {
      nome = `${nome} ${denomination}`.trim();
    }
  }

  return nome.trim();
}

function buildUvaggioFromRaw(raw: any): string {
  const grapesRaw = String(raw?.grapes_raw || "").trim();
  if (grapesRaw) return grapesRaw;

  if (!Array.isArray(raw?.grapes)) return "";

  return raw.grapes
    .map((g: any) => {
      if (typeof g === "string") return g.trim();
      const name = String(g?.name || "").trim();
      const pct = g?.pct;
      if (!name) return "";
      return Number.isFinite(pct) ? `${name} ${pct}%` : name;
    })
    .filter(Boolean)
    .join(", ");
}

function projectRawOcrItemToCandidate(raw: any) {
  const prices = Array.isArray(raw?.prices) ? raw.prices : [];
  const admin = {
    nome: buildNomeCompletoFromRaw(raw),
    annata: raw?.vintage ? String(raw.vintage) : "",
    valuta: "€",
    prezzo: "",
    prezzo_bicchiere: "",
    prezzo_025: "",
    prezzo_0375: "",
    prezzo_05: "",
    prezzo_15: "",
    prezzo_3l: "",
    categoria: String(raw?.section || "").trim(),
    sottocategoria: String(raw?.subcategory || "").trim(),
    uvaggio: buildUvaggioFromRaw(raw),
  };

  let pickedCurrency: string | null = normalizeCurrencyCode(raw?.currency);

  for (const p of prices) {
    const code = normalizeFormatCode(p?.format_code ?? p?.format ?? p?.label);
    const value = toAdminPriceString(p?.value);
    const curr = normalizeCurrencyCode(p?.currency);

    if (curr && !pickedCurrency) pickedCurrency = curr;
    if (!code || !value) continue;

    if (code === "glass" && !admin.prezzo_bicchiere) admin.prezzo_bicchiere = value;
    if (code === "075" && !admin.prezzo) admin.prezzo = value;
    if (code === "025" && !admin.prezzo_025) admin.prezzo_025 = value;
    if (code === "0375" && !admin.prezzo_0375) admin.prezzo_0375 = value;
    if (code === "05" && !admin.prezzo_05) admin.prezzo_05 = value;
    if (code === "15" && !admin.prezzo_15) admin.prezzo_15 = value;
    if (code === "3l" && !admin.prezzo_3l) admin.prezzo_3l = value;
  }

  // fallback compatibilità vecchio schema
  if (!admin.prezzo && raw?.price_bottle_eur != null) {
    admin.prezzo = toAdminPriceString(raw.price_bottle_eur);
    if (!pickedCurrency) pickedCurrency = "EUR";
  }
  if (!admin.prezzo_bicchiere && raw?.price_glass_eur != null) {
    admin.prezzo_bicchiere = toAdminPriceString(raw.price_glass_eur);
    if (!pickedCurrency) pickedCurrency = "EUR";
  }

  if (pickedCurrency) admin.valuta = currencyCodeToSymbol(pickedCurrency);

  if (!admin.nome && !admin.prezzo && !admin.prezzo_bicchiere) return null;

  const confidence = typeof raw?.confidence === "number" ? raw.confidence : 0.85;
  const sourceText = String(raw?._source_text || "").trim();

  return {
    nome: admin.nome,
    annata: admin.annata,
    uvaggio: admin.uvaggio,
    prezzo: admin.prezzo,
    prezzo_bicchiere: admin.prezzo_bicchiere,
    prezzo_025: admin.prezzo_025,
    prezzo_0375: admin.prezzo_0375,
    prezzo_05: admin.prezzo_05,
    prezzo_15: admin.prezzo_15,
    prezzo_3l: admin.prezzo_3l,
    valuta: admin.valuta,
    section: admin.categoria,
    subcategory: admin.sottocategoria,
    produttore: String(raw?.producer || "").trim(),
    localita: String(raw?.localita || "").trim(),
    confidence,
    raw_line: sourceText,
    source_text: sourceText,
    source_lines: Array.isArray(raw?.source_lines) ? raw.source_lines : [],
    page_no: raw?.page_no ?? null,
    raw_payload: raw,
    admin_payload: admin,
    confidence_by_field: { overall: confidence },
  };
}

function projectRuleItemToCandidate(raw: any) {
  const admin = {
    nome: String(raw?.nome || "").trim(),
    annata: String(raw?.annata || "").trim(),
    valuta: "€",
    prezzo: String(raw?.prezzo || "").trim(),
    prezzo_bicchiere: String(raw?.prezzo_bicchiere || "").trim(),
    prezzo_025: "",
    prezzo_0375: "",
    prezzo_05: "",
    prezzo_15: "",
    prezzo_3l: "",
    categoria: String(raw?.section || "").trim(),
    sottocategoria: String(raw?.subcategory || "").trim(),
    uvaggio: String(raw?.uvaggio || "").trim(),
  };

  const confidence = typeof raw?.confidence === "number" ? raw.confidence : 0.75;
  const sourceText = String(raw?.raw_line || "").trim();

  return {
    nome: admin.nome,
    annata: admin.annata,
    uvaggio: admin.uvaggio,
    prezzo: admin.prezzo,
    prezzo_bicchiere: admin.prezzo_bicchiere,
    prezzo_025: "",
    prezzo_0375: "",
    prezzo_05: "",
    prezzo_15: "",
    prezzo_3l: "",
    valuta: admin.valuta,
    section: admin.categoria,
    subcategory: admin.sottocategoria,
    produttore: String(raw?.produttore || "").trim(),
    localita: String(raw?.localita || "").trim(),
    confidence,
    raw_line: sourceText,
    source_text: sourceText,
    source_lines: [],
    page_no: null,
    raw_payload: raw,
    admin_payload: admin,
    confidence_by_field: { overall: confidence },
  };
}

async function openaiExtractWinesFromText(
  ocrText: string,
  onChunk?: (done: number, total: number) => Promise<void> | void,
) {
  if (!OPENAI_API_KEY) return [];

  try {
    const { lines, numberedText } = buildNumberedLines(ocrText);
    const numberedLines = numberedText.split("\n");

    const schema = {
      name: "wine_import_v2",
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
                section: { type: ["string", "null"] },
                producer: { type: ["string", "null"] },
                subcategory: { type: ["string", "null"] },
                wine_name: { type: ["string", "null"] },
                denomination: { type: ["string", "null"] },
                vintage: { type: ["integer", "null"] },
                grapes_raw: { type: ["string", "null"] },
                grapes: {
                  type: ["array", "null"],
                  items: { type: "string" },
                },
                prices: {
                  type: ["array", "null"],
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      format_code: { type: ["string", "null"] },
                      value: { type: ["number", "null"] },
                      currency: { type: ["string", "null"] },
                      raw: { type: ["string", "null"] },
                    },
                    required: ["format_code", "value", "currency", "raw"],
                  },
                },
                currency: { type: ["string", "null"] },
                confidence: { type: "number" },
                source_lines: { type: "array", items: { type: "integer" } },
                notes: { type: ["string", "null"] },
                localita: { type: ["string", "null"] },
                page_no: { type: ["integer", "null"] },
              },
              required: [
                "section",
                "producer",
                "subcategory",
                "wine_name",
                "denomination",
                "vintage",
                "grapes_raw",
                "grapes",
                "prices",
                "currency",
                "confidence",
                "source_lines",
                "notes",
                "localita",
                "page_no"
              ],
            },
          },
        },
        required: ["items"],
      },
    };

    let chunks = chunkNumberedText(numberedLines, OPENAI_MAX_CHARS);

    if (chunks.length > MAX_AI_CHUNKS) {
      chunks = chunks.slice(0, MAX_AI_CHUNKS);
    }

    const all: any[] = [];

    for (let idx = 0; idx < chunks.length; idx++) {
      const c = chunks[idx];

      if (onChunk) await onChunk(idx, chunks.length);

      const prompt = `
Ruolo:
Sei un data extractor specializzato in carte dei vini.
Devi leggere testo OCR sporco e restituire dati strutturati SENZA inventare nulla.

Regole fondamentali:
- Non inventare produttore, nome vino, annata, uvaggio, categoria o prezzi.
- Se un campo non è leggibile o non sei sicuro, usa null.
- Ogni item deve avere source_lines.
- Ogni prezzo va messo in "prices" come oggetto.
- "value" deve essere solo numero, senza simboli.
- "currency" deve essere uno tra: EUR, USD, GBP, JPY, CHF oppure null.
- "format_code" deve essere uno tra:
  glass, 075, 025, 0375, 05, 15, 3l, unknown

Regole prezzi / formati:
- Se trovi un solo prezzo bottiglia generico, usa format_code = 075.
- Se trovi "calice", "glass", "by the glass", usa format_code = glass.
- Se trovi 0,25 / 25cl usa 025.
- Se trovi 0,375 / 37,5cl usa 0375.
- Se trovi 0,5 / 50cl usa 05.
- Se trovi 1,5 / Magnum usa 15.
- Se trovi 3L usa 3l.
- Se trovi due prezzi chiaramente riferiti allo stesso vino, NON usare min/max come regola cieca:
  prova a capire se sono glass e bottle oppure due formati diversi.
- Se non riesci a capire il formato, usa unknown.

Regole testo:
- producer = cantina/produttore quando separabile
- wine_name = nome etichetta quando separabile
- denomination = DOC / DOCG / IGT / AOC / AOP / DO / DOP o denominazione chiaramente visibile
- grapes_raw = uvaggio testuale come appare
- grapes = elenco vitigni puliti se chiaramente presenti
- section = macro categoria tipo Rossi / Bianchi / Bollicine / Champagne
- subcategory = zona o sotto-sezione dentro la categoria, se chiaramente presente
- localita = località, comune, provincia o zona se separabile

Output:
Restituisci SOLO JSON valido conforme allo schema.

TESTO OCR (con linee numerate):
${c.text}
`;

      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: prompt,
          text: {
            format: {
              type: "json_schema",
              name: schema.name,
              schema: schema.schema,
              strict: true,
            },
          },
          temperature: 0,
        }),
      });

      if (!res.ok) throw new Error(`OpenAI error: ${await res.text()}`);
      const data = await res.json();

      const outText =
        data?.output?.[0]?.content?.[0]?.text ??
        data?.output_text ??
        "";

      if (!outText) continue;

      const parsed = JSON.parse(outText);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      all.push(...items);

      if (onChunk) await onChunk(idx + 1, chunks.length);
    }

    const norm = (s: any) => String(s ?? "").trim().toLowerCase();

    const seen = new Set<string>();
    const deduped: any[] = [];

    for (const it of all) {
      const priceKey = Array.isArray(it?.prices)
        ? it.prices
            .map((p: any) => `${norm(p?.format_code)}:${String(p?.value ?? "")}`)
            .join("|")
        : "";

      const key = [
        norm(it.producer),
        norm(it.wine_name),
        norm(it.denomination),
        String(it.vintage ?? ""),
        priceKey,
      ].join("|");

      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
    }

    deduped.sort((a, b) => {
      const am = Math.min(...(a.source_lines ?? [999999]));
      const bm = Math.min(...(b.source_lines ?? [999999]));
      return am - bm;
    });

    for (const it of deduped) {
      const src = (it.source_lines ?? [])
        .map((n: number) => lines[n - 1])
        .filter(Boolean)
        .join(" | ");
      it._source_text = src;
    }

    return deduped;
  } catch (e) {
    console.error("OpenAI extract failed:", e);
    return [];
  }
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

    function looksLikeSection(s: string) {
    const t = s.trim();
    // tipico: "LE BOLLICINE ITALIANE", "VINI ROSSI", "BIANCHI", ecc.
    if (t.length < 6 || t.length > 80) return false;
    if (/[0-9€$£]/.test(t)) return false;

    const upperish = t === t.toUpperCase();
    const hasWineWord = /\b(vini|bollicine|bianchi|rossi|rosati|champagne|spumanti|dolci|dessert)\b/i.test(t);
    return upperish || hasWineWord;
  }

  function looksLikeSubcategoryLine(s: string) {
    const t = s.trim();
    // tipico: "Emilia Romagna", "Veneto", "Champagne", "España"
    if (t.length < 3 || t.length > 40) return false;
    if (/[0-9€$£]/.test(t)) return false;
    if (producerKeywords.test(t)) return false; // evita Tenuta/Cantina ecc.

    // poche parole, solo testo
    const wc = t.split(/\s+/).length;
    if (wc < 1 || wc > 4) return false;

    // evita righe che sembrano "nome vino" troppo lunghe o con trattini tipo produttore - vino
    if (t.includes(" - ")) return false;

    return true;
  }

  function toNum(v: string) {
    return parseFloat(v.replace(",", "."));
  }

function cleanHeader(s: string) {
  const lower = s.toLowerCase();
  // filtra solo intestazioni/legende generiche, NON regioni
  if (
    lower.includes("bottiglia") ||
    lower.includes("bottle") ||
    lower.includes("al calice") ||
    lower.includes("glass") ||
    lower.includes("cl") ||
    lower.includes("ml") ||
    lower.includes("prezzo") ||
    lower === "vini"
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
  let pendingSubcategory = "";
let pendingSection = "";

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
  section: pendingSection || "",
  subcategory: pendingSubcategory || "",
  prezzo: bottle,
  prezzo_bicchiere: glass,
  confidence: 0.85,
  raw_line: `${pendingProducer} | ${pendingLocation} | ${pendingSection} | ${pendingSubcategory} | ${pendingName} | ${pendingGrapes} | ${priceA}${priceB ? " | " + priceB : ""}`,
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

        // 0) section (macro categoria)
    if (looksLikeSection(raw)) {
      pendingSection = raw;
      pendingSubcategory = ""; // reset quando cambia sezione
      continue;
    }

    // 0b) subcategory (regione/zona/stato) - valida solo se abbiamo già una section (opzionale ma consigliato)
    if (pendingSection && looksLikeSubcategoryLine(raw)) {
      pendingSubcategory = raw;
      continue;
    }

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
  // se sembra una subcategory, NON trattarlo come uvaggio
  if (looksLikeSubcategoryLine(raw)) {
    pendingSubcategory = raw;
    continue;
  }

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
  section: pendingSection || "",
  subcategory: pendingSubcategory || "",
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

const producerKeywords2 = /\b(tenuta|cantina|azienda|societ[aà]|podere|fattoria|vigne|vigneti|agricola)\b/i;

function looksLikeSection2(s: string) {
  const t = (s || "").trim();
  if (t.length < 6 || t.length > 80) return false;
  if (/[0-9€$£]/.test(t)) return false;

  const upperish = t === t.toUpperCase();
  const hasWineWord = /\b(vini|bollicine|bianchi|rossi|rosati|champagne|spumanti|dolci|dessert)\b/i.test(t);
  return upperish || hasWineWord;
}

function looksLikeSubcategory2(s: string) {
  const t = (s || "").trim();
  if (t.length < 3 || t.length > 40) return false;
  if (/[0-9€$£]/.test(t)) return false;
  if (producerKeywords2.test(t)) return false;

  const wc = t.split(/\s+/).length;
  if (wc < 1 || wc > 4) return false;

  if (t.includes(" - ")) return false; // evita “Produttore - Vino”
  return true;
}

function cleanHeader2(s: string) {
  const lower = (s || "").toLowerCase();
  if (
    lower.includes("bottiglia") ||
    lower.includes("bottle") ||
    lower.includes("al calice") ||
    lower.includes("glass") ||
    lower.includes("cl") ||
    lower.includes("ml") ||
    lower.includes("prezzo") ||
    lower === "vini"
  ) return "";
  return (s || "").trim();
}

/**
 * Ricalcola section/subcategory per ogni item OpenAI usando la riga più vicina sopra (source_lines).
 * Questo elimina l’effetto “Marche appiccicata”.
 */
function reanchorSectionSubcategoryFromSourceLines(aiItems: any[], ocrText: string) {
  const { lines } = buildNumberedLines(ocrText); // 0-index
  const clean = (s: string) => cleanHeader2(s || "").trim();

  // 1) raccogli marker di SECTION e SUBCATEGORY con indice riga
  const sectionMarkers: { idx: number; text: string }[] = [];
  const subMarkers: { idx: number; text: string; sectionIdx: number }[] = [];

  let currentSectionIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const t = clean(lines[i]);
    if (!t) continue;

    if (looksLikeSection2(t)) {
      sectionMarkers.push({ idx: i, text: t });
      currentSectionIdx = sectionMarkers.length - 1;
      continue;
    }

    if (currentSectionIdx >= 0 && looksLikeSubcategory2(t)) {
      subMarkers.push({ idx: i, text: t, sectionIdx: currentSectionIdx });
    }
  }

  // helper: trova la section “corrente” per una riga (ultima section sopra)
  function sectionIndexForLine(lineIdx: number) {
    let s = -1;
    for (let i = 0; i < sectionMarkers.length; i++) {
      if (sectionMarkers[i].idx <= lineIdx) s = i;
      else break;
    }
    return s;
  }

  // helper: limite di validità della section (fino alla prossima section)
  function sectionRange(sectionIdx: number) {
    const start = sectionMarkers[sectionIdx]?.idx ?? 0;
    const end = (sectionIdx + 1 < sectionMarkers.length)
      ? sectionMarkers[sectionIdx + 1].idx
      : lines.length;
    return { start, end };
  }

  // 2) per ogni item: assegna section (ultima sopra) e subcategory “più vicina” (anche sotto)
  const MAX_DIST = 25; // puoi alzare a 35 se vuoi essere più permissivo

  for (const it of aiItems) {
    const src = Array.isArray(it?.source_lines) ? it.source_lines : [];
    if (!src.length) continue;

    // scegli una riga rappresentativa del vino: media delle source_lines
    const avg = Math.round(src.reduce((a: number, b: number) => a + b, 0) / src.length);
    const lineIdx = Math.max(0, avg - 1);

    const secIdx = sectionIndexForLine(lineIdx);
    if (secIdx >= 0) it.section = sectionMarkers[secIdx].text;
    else it.section = null;

    if (secIdx < 0) {
      it.subcategory = null;
      continue;
    }

    const { start, end } = sectionRange(secIdx);

    // candidati subcategory solo dentro questa section
    const candidates = subMarkers.filter(m => m.sectionIdx === secIdx && m.idx >= start && m.idx < end);

    if (!candidates.length) {
      it.subcategory = null;
      continue;
    }

    // scegli la subcategory più vicina (anche sotto!)
    let best = candidates[0];
    let bestDist = Math.abs(best.idx - lineIdx);

    for (const c of candidates) {
      const d = Math.abs(c.idx - lineIdx);

      // tie-break: se stessa distanza, preferisci quella sopra (idx <= lineIdx)
      if (d < bestDist || (d === bestDist && c.idx <= lineIdx && best.idx > lineIdx)) {
        best = c;
        bestDist = d;
      }
    }

    it.subcategory = (bestDist <= MAX_DIST) ? best.text : null;
  }

  return aiItems;
}

async function insertOcrCandidates(supabase: any, jobId: string, items: any[]) {
  const rows = items.slice(0, 500).map((it: any, idx: number) => ({
    job_id: jobId,
    page_no: it.page_no ?? null,
    row_no: idx + 1,
    source_text: it.source_text ?? it.raw_line ?? null,
    source_lines: Array.isArray(it.source_lines) ? it.source_lines : null,
    raw_payload: it.raw_payload ?? {},
    admin_payload: it.admin_payload ?? {},
    confidence_overall: typeof it.confidence === "number" ? it.confidence : null,
    confidence_by_field: it.confidence_by_field ?? {},
    status: "pending",
    is_selected: true,
    updated_at: new Date().toISOString(),
  }));

  if (!rows.length) return [];

  const { data, error } = await supabase
    .from("ocr_import_candidates")
    .insert(rows)
    .select("*");

  if (error) {
    console.warn("Insert candidates warning:", error.message);
    return [];
  }

  return data ?? [];
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
let jobId = "";
let supabase: any = null;
async function setJobProgress(supabase: any, jobId: string, progress: number, status?: string) {
  const patch: any = {
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    updated_at: new Date().toISOString(),
  };
  if (status) patch.status = status;

  const { error } = await supabase.from("ocr_import_jobs").update(patch).eq("id", jobId);
  if (error) console.warn("Job progress update warning:", error.message);
}
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response("Missing Authorization Bearer token", { status: 401, headers: corsHeaders(origin) });
    }

    const { ristorante_id, storage_bucket, storage_path, job_id } = await req.json();

if (!ristorante_id || !storage_bucket || !storage_path) {
  return new Response("Missing params", { status: 400, headers: corsHeaders(origin) });
}

    // Supabase admin client (service role)
supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// jobId: se arriva dal client lo uso, altrimenti fallback come prima
jobId = String(job_id || "").trim();

if (!jobId) {
  const { data: jobIns, error: jobErr } = await supabase
    .from("ocr_import_jobs")
    .insert({
      ristorante_id,
      status: "processing",
      progress: 5,
      file_bucket: storage_bucket,
      file_path: storage_path,
    })
    .select("id")
    .single();

  if (jobErr) throw new Error(`DB job insert error: ${jobErr.message}`);
  jobId = jobIns.id as string;
} else {
  // allineo lo stato iniziale
  await supabase.from("ocr_import_jobs")
    .update({
      status: "processing",
      progress: 15,
      file_bucket: storage_bucket,
      file_path: storage_path,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

    // 3) Scarica file da Supabase Storage
    const { data: fileRes, error: dlErr } = await supabase
      .storage
      .from(storage_bucket)
      .download(storage_path);

    if (dlErr || !fileRes) throw new Error(`Storage download error: ${dlErr?.message ?? "no file"}`);

    const arrayBuf = await fileRes.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    await setJobProgress(supabase, jobId, 25, "processing");
    const mime = fileRes.type || "";

    // 4) Google token (Vision + GCS scope)
    const gToken = await googleAccessToken([
      "https://www.googleapis.com/auth/cloud-vision",
      "https://www.googleapis.com/auth/devstorage.read_write",
    ]);
    await setJobProgress(supabase, jobId, 32, "processing");

    let items: any[] = [];

    // 5) OCR
    if (mime.includes("pdf") || storage_path.toLowerCase().endsWith(".pdf")) {
      // PDF async: upload to GCS input, run Vision async, read output json files from GCS output
      const gcsInputObject = `${GCS_INPUT_PREFIX}${ristorante_id}/${jobId}.pdf`;
      const gcsOutputPrefix = `${GCS_OUTPUT_PREFIX}${ristorante_id}/${jobId}/`;

      await gcsUpload(gToken, GCS_BUCKET_NAME, gcsInputObject, bytes, "application/pdf");
      await setJobProgress(supabase, jobId, 40, "processing");

      const gcsInputUri = `gs://${GCS_BUCKET_NAME}/${gcsInputObject}`;
      const gcsOutputUri = `gs://${GCS_BUCKET_NAME}/${gcsOutputPrefix}`;

      const op = await visionAsyncPdfOCR(gToken, gcsInputUri, gcsOutputUri);
      await setJobProgress(supabase, jobId, 48, "processing");
      const opName = op.name as string;

      await visionPollOperation(gToken, opName, async (i, max) => {
  // da 48% a 70% durante il polling
  const pct = 48 + Math.round((i / max) * (70 - 48));
  await setJobProgress(supabase, jobId, pct, "processing");
});

      // list output objects
const listed = await gcsList(gToken, GCS_BUCKET_NAME, gcsOutputPrefix);

let files: string[] = (listed.items ?? [])
  .map((x: any) => x.name)
  .filter((n: string) => typeof n === "string" && n.endsWith(".json"));

// importantissimo: ordina per nome (Vision spesso mette shard in ordine lessicografico)
files.sort((a, b) => a.localeCompare(b));

// fail-safe: evita di scaricare 200 json se qualcosa va storto
if (files.length > MAX_GCS_JSON_FILES) {
  files = files.slice(0, MAX_GCS_JSON_FILES);
}

let combinedText = "";
let pagesUsed = 0;

for (let i = 0; i < files.length; i++) {
  const objName = files[i];

  // download output JSON: da 70% a 78%
  const pct = 70 + Math.round((i / Math.max(files.length, 1)) * (78 - 70));
  await setJobProgress(supabase, jobId, pct, "processing");

  const outBytes = await gcsDownload(gToken, GCS_BUCKET_NAME, objName);
  const parsed = JSON.parse(new TextDecoder().decode(outBytes));

  const responses = Array.isArray(parsed.responses) ? parsed.responses : [];

  for (const r of responses) {
    // ogni "response" corrisponde tipicamente a una pagina (o parte)
    if (pagesUsed >= MAX_PDF_PAGES) break;

    const t = r.fullTextAnnotation?.text;
    if (!t) { pagesUsed++; continue; }

    if (combinedText.length + t.length + 1 > MAX_OCR_CHARS) {
      combinedText += "\n" + t.slice(0, Math.max(0, MAX_OCR_CHARS - combinedText.length - 1));
      pagesUsed++;
      break;
    }

    combinedText += "\n" + t;
    pagesUsed++;
  }

  if (pagesUsed >= MAX_PDF_PAGES) break;
  if (combinedText.length >= MAX_OCR_CHARS) break;
}

rawOcrText = combinedText;
await setJobProgress(supabase, jobId, 78, "parsing");

// 1) parser “a regole” (fallback)
const ruleItems = extractWineItemsFromText(rawOcrText);

// 2) OpenAI (sempre)
let aiItems: any[] = [];
if (OPENAI_API_KEY) {
  await setJobProgress(supabase, jobId, 88, "ai");
  aiItems = await openaiExtractWinesFromText(rawOcrText, async (done, total) => {
  // progress AI: da 88% a 96% in base ai chunk completati
  const pct = 88 + Math.round((done / Math.max(total, 1)) * (96 - 88));
  await setJobProgress(supabase, jobId, pct, "ai");
});
// ✅ FIX: ricalcola section/subcategory dal testo OCR usando source_lines
if (aiItems.length) {
  aiItems = reanchorSectionSubcategoryFromSourceLines(aiItems, rawOcrText);
}
}
console.log("DEBUG SUB:", aiItems.slice(0, 15).map((x:any)=>({
  wine: x.wine_name,
  sub: x.subcategory,
  lines: x.source_lines
})));

// 3) Se OpenAI ha risultati, usa quelli proiettati verso l'admin.
//    Altrimenti fallback parser -> candidato admin compatibile.
if (aiItems.length) {
  items = aiItems
    .map(projectRawOcrItemToCandidate)
    .filter(Boolean);
} else {
  items = ruleItems
    .map(projectRuleItemToCandidate)
    .filter(Boolean);
}

    } else {
      // image sync
      await setJobProgress(supabase, jobId, 40, "processing"); // prima di chiamare Vision
      const v = await visionImageOCR(gToken, bytes);
        await setJobProgress(supabase, jobId, 60, "processing"); // Vision finita
      const text = v?.responses?.[0]?.fullTextAnnotation?.text ?? "";
      rawOcrText = text;
      
  await setJobProgress(supabase, jobId, 72, "parsing"); // parsing inizia
// 1) parser “a regole” (fallback)
const ruleItems = extractWineItemsFromText(rawOcrText);
await setJobProgress(supabase, jobId, 80, "parsing");

// 2) OpenAI (sempre)
let aiItems: any[] = [];
if (OPENAI_API_KEY) {
  await setJobProgress(supabase, jobId, 88, "ai");
  aiItems = await openaiExtractWinesFromText(rawOcrText, async (done, total) => {
  const pct = 88 + Math.round((done / Math.max(total, 1)) * (96 - 88));
  await setJobProgress(supabase, jobId, pct, "ai");
});
// ✅ FIX: ricalcola section/subcategory dal testo OCR usando source_lines
if (aiItems.length) {
  aiItems = reanchorSectionSubcategoryFromSourceLines(aiItems, rawOcrText);
}
}

// 3) Se OpenAI ha risultati, usa quelli proiettati verso l'admin.
//    Altrimenti fallback parser -> candidato admin compatibile.
if (aiItems.length) {
  items = aiItems
    .map(projectRawOcrItemToCandidate)
    .filter(Boolean);
} else {
  items = ruleItems
    .map(projectRuleItemToCandidate)
    .filter(Boolean);
}
    }

// 6) Salva candidates in DB
await setJobProgress(supabase, jobId, 97, "saving");

let savedCandidates: any[] = [];
if (items.length) {
  savedCandidates = await insertOcrCandidates(supabase, jobId, items);
}

await supabase.from("ocr_import_jobs").update({
  status: "done",
  progress: 100,
  file_mime: mime,
  updated_at: new Date().toISOString(),
}).eq("id", jobId);

return new Response(JSON.stringify({
  job_id: jobId,
  items: savedCandidates.length ? savedCandidates : items,
  raw_ocr_preview: rawOcrText.slice(0, 2000)
}), {
  headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
});

} catch (err: any) {
  console.error(err);

  // se ho già un jobId, segno errore in tabella
  try {
    if (supabase && typeof jobId === "string" && jobId) {
      await supabase.from("ocr_import_jobs").update({
        status: "error",
        progress: 100,
        error: String(err?.message ?? err).slice(0, 5000),
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }
  } catch (e) {
    console.warn("Failed to mark job error:", e);
  }

  return new Response(
    `OCR import error: ${err?.message ?? err}`,
    { status: 500, headers: corsHeaders(origin) },
  );
}
});
