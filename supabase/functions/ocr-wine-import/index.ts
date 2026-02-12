/// <reference deno-lint-ignore-file no-explicit-any />
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// --------------------
// Env
// --------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")!;
const GCS_BUCKET_NAME = Deno.env.get("GCS_BUCKET_NAME")!;
const GCS_INPUT_PREFIX = Deno.env.get("GCS_INPUT_PREFIX") ?? "input/";
const GCS_OUTPUT_PREFIX = Deno.env.get("GCS_OUTPUT_PREFIX") ?? "output/";

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
    .filter((l) => l.length >= 3);

  const items: any[] = [];

  const priceRe = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(€)?\b/;

  for (const raw of lines) {
    const l = raw;

    // filtri “header” comuni (puoi aggiungere parole)
    const lower = l.toLowerCase();
    if (
      lower === "rossi" || lower === "bianchi" || lower.includes("bollicine") ||
      lower.includes("spumanti") || lower.includes("vini") ||
      lower.includes("calice") && l.length < 20
    ) continue;

    const m = l.match(priceRe);
    if (!m) continue;

    const price = m[1];

    // nome = linea senza prezzo e simboli
    let name = l.replace(priceRe, "").replace(/[€•·\-–—]+/g, " ").trim();
    if (name.length < 3) continue;

    // uvaggio: (qualcosa) se contiene virgole, %, o parole tipiche
    let grapes = "";
    const par = l.match(/\(([^)]+)\)/);
    if (par) {
      const cand = par[1].trim();
      if (/[%,]/.test(cand) || cand.split(" ").length <= 6) grapes = cand;
    } else {
      // oppure dopo " - " o " / " se sembra uvaggio
      const dashSplit = l.split(" - ");
      if (dashSplit.length >= 2) {
        const tail = dashSplit[dashSplit.length - 1].trim();
        if (/[%,]/.test(tail) && tail.length <= 40) grapes = tail;
      }
    }

    const confidence =
      (m ? 0.7 : 0.4) + (grapes ? 0.1 : 0) + (name.length > 6 ? 0.1 : 0);

    items.push({
      nome: name,
      prezzo: price,
      uvaggio: grapes,
      confidence: Math.min(0.95, confidence),
      raw_line: raw,
    });
  }

  return items;
}

// --------------------
// Main
// --------------------
serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response("Missing Authorization Bearer token", { status: 401 });
    }

    const { ristorante_id, storage_bucket, storage_path } = await req.json();

    if (!ristorante_id || !storage_bucket || !storage_path) {
      return new Response("Missing params", { status: 400 });
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
      return new Response("Invalid user session", { status: 401 });
    }
    const userId = userData.user.id;

    const { data: risto, error: ristoErr } = await supabase
      .from("ristoranti")
      .select("id, owner_id, subscription_plan, subscription_status")
      .eq("id", ristorante_id)
      .single();

    if (ristoErr || !risto) return new Response("Ristorante not found", { status: 404 });
    if (risto.owner_id !== userId) return new Response("Forbidden", { status: 403 });

    const plan = String(risto.subscription_plan ?? "").toLowerCase();
    const status = String(risto.subscription_status ?? "").toLowerCase();
    if (plan !== "pro" || (status && status !== "active")) {
      return new Response("PRO required", { status: 402 });
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

      items = extractWineItemsFromText(combinedText);
    } else {
      // image sync
      const v = await visionImageOCR(gToken, bytes);
      const text = v?.responses?.[0]?.fullTextAnnotation?.text ?? "";
      items = extractWineItemsFromText(text);
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

    return new Response(JSON.stringify({ job_id: jobId, items }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error(err);
    return new Response(`OCR import error: ${err?.message ?? err}`, { status: 500 });
  }
});
