import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15"
});
const MAKE_WEBHOOK_URL = "https://hook.eu2.make.com/n9foz8yobzhb2yn6ijv9v7mztuybyepj";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// helper per sommare in sicurezza
const sum = (arr: {amount:number}[] | undefined | null) =>
  (arr || []).reduce((s, x) => s + (x?.amount || 0), 0);

serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  if (!sig || !webhookSecret) {
    return new Response("Missing signature or secret", { status: 400 });
  }

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err: any) {
    console.error("❌ Errore verifica firma:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

// =====================================================================================
// ✅ CHECKOUT COMPLETATO: salva Customer + dati FE (P.IVA, SdI/PEC, anagrafica)
// =====================================================================================
if (event.type === "checkout.session.completed") {
  const session = event.data.object as any;
  const customerId = (session.customer as string) || null;

  // Fonte primaria: dettagli "snapshot" nel Checkout
  const det = session.customer_details || {};
  // email robusta
  let email = session.customer_email || det.email || null;

  // Prova a recuperare il Customer (ma non bloccare se Stripe dà 503)
  let customer: any = null;
  if (customerId) {
    try {
      const _c = await stripe.customers.retrieve(customerId);
      if (_c && typeof _c === "object") {
        customer = _c;
        if (!email) email = (customer as any).email || null;
      }
    } catch (e) {
      console.warn("⚠️ retrieve(customer) fallito, procedo con customer_details:", (e as any)?.message);
    }
  }

  console.log("✅ Checkout completato per:", email, customerId);

  // Trova ristorante: usa ilike (case-insensitive) sull'email
  let { data: risto } = await supabase
    .from("ristoranti")
    .select("id")
    .ilike("email", email || "") // <-- case-insensitive
    .maybeSingle();

  if (!risto && customerId) {
    const byStripeId = await supabase
      .from("ristoranti")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    risto = byStripeId.data || null;
  }

  if (!risto) {
    console.error("❌ Nessun ristorante trovato per email:", email);
    return new Response("Utente non trovato", { status: 404 });
  }

  // SdI/PEC: ora prendiamo SOLO dai metadata del Customer (abbiamo tolto i custom_fields)
  const codiceDestinatario = customer?.metadata?.codice_destinatario || null;
  const pec = customer?.metadata?.pec || null;

  // P.IVA: prima dall'instant snapshot del Checkout, poi dal Customer
  let partitaIVA: string | null = null;
  const detTaxIds = Array.isArray(det.tax_ids) ? det.tax_ids : [];
  if (detTaxIds.length) {
    partitaIVA = detTaxIds[0]?.value || null;
  }
  if (!partitaIVA && customerId) {
    try {
      const taxIds = await stripe.customers.listTaxIds(customerId, { limit: 25 });
      const vat = taxIds.data.find((t) => t.type === "eu_vat" || t.type === "it_vat");
      partitaIVA = vat?.value || null;
    } catch (e) {
      console.warn("⚠️ listTaxIds fallito:", (e as any)?.message);
    }
  }

  // Ragione sociale + indirizzo: snapshot dal Checkout, fallback Customer
  const ragioneSociale = det.name || customer?.name || null;
  const indirizzo = det.address || customer?.address || null; // oggetto Stripe

  // Piano reale dal Subscription creato dalla sessione
  let selectedPlan = "base";
  try {
    if (session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string);
      const firstItem = sub.items?.data?.[0];
      const priceId = firstItem?.price?.id;
      selectedPlan = (priceId === "price_1RiFLtRWDcfnUagZp0bIKnOL") ? "pro" : "base";
    }
  } catch (e) {
    console.warn("⚠️ Impossibile leggere subscription dalla session:", (e as any)?.message);
  }

  // Aggiorna ristorante
  const { error: updateErr } = await supabase
    .from("ristoranti")
    .update({
      stripe_customer_id: customerId,
      subscription_status: "active",
      subscription_plan: selectedPlan,
      ragione_sociale: ragioneSociale,
      indirizzo_json: indirizzo || null,     // se la colonna è JSONB va bene così
      partita_iva: partitaIVA,
      codice_destinatario: codiceDestinatario,
      pec: pec
    })
    .eq("id", risto.id);

  if (updateErr) {
    console.error("❌ Errore aggiornamento DB:", updateErr);
    return new Response("Errore DB", { status: 500 });
  }

  console.log("✅ Ristorante aggiornato:", risto.id);
}

  // =====================================================================================
  // 🔁 SUBSCRIPTION UPDATED: tieni allineato piano e stato
  // =====================================================================================
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as any;
    const customerId = sub.customer as string;

    const { data: risto, error } = await supabase
      .from("ristoranti")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (!risto) {
      console.warn("⚠️ Ristorante non trovato per customer ID:", customerId);
      return new Response("ok", { status: 200 });
    }

    const newStatus = sub.status; // active, past_due, canceled, etc.
const firstItem = sub.items?.data?.[0];
const newPriceId = firstItem?.price?.id;

let plan = "base";
if (newPriceId === "price_1RiFLtRWDcfnUagZp0bIKnOL") plan = "pro";


    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        subscription_status: newStatus,
        subscription_plan: plan
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore aggiornamento abbonamento:", updateErr);
    } else {
      console.log(`🔁 Abbonamento aggiornato → ${plan} (${newStatus})`);
    }
  }

  // =====================================================================================
  // 🚫 SUBSCRIPTION DELETED: pulisci stato
  // =====================================================================================
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as any;
    const customerId = sub.customer as string;

    const { data: risto } = await supabase
      .from("ristoranti")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (!risto) {
      console.warn("⚠️ Ristorante non trovato per cancellazione abbonamento");
      return new Response("ok", { status: 200 });
    }

    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        subscription_status: "canceled",
        subscription_plan: null,
        stripe_customer_id: null
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore nel marcare come cancellato:", updateErr);
    } else {
      console.log("🚫 Abbonamento cancellato per:", risto.id);
    }
  }

// =====================================================================================
// 🧾 INVOICE FINALIZED: salva dati e manda a Make per creare la fattura in FIC
// =====================================================================================
if (event.type === "invoice.finalized") {
  const invoice = event.data.object as any;

  try {
    const customerId = invoice.customer as string;
    const number = invoice.number;               // es. "A-0001"
    const invoiceId = invoice.id;                // inv_***
    const currency = invoice.currency;           // "eur"
    const total = invoice.total;                 // in centesimi
    const subtotal = invoice.subtotal;           // in centesimi
    const status = invoice.status;               // draft, open, paid, uncollectible, void
    const hostedUrl = invoice.hosted_invoice_url;
    const pdfUrl = invoice.invoice_pdf;          // URL PDF di Stripe
    const createdAt = invoice.created ? new Date(invoice.created * 1000).toISOString() : null;

    // periodo dell'abbonamento (prima linea)
let period_start: string | null = null;
let period_end: string | null = null;
const firstLine = invoice.lines?.data?.[0];
if (firstLine?.period) {
  period_start = new Date(firstLine.period.start * 1000).toISOString();
  period_end   = new Date(firstLine.period.end   * 1000).toISOString();
}
const lineDescription =
  firstLine?.description ||
  `Abbonamento ${firstLine?.plan?.nickname || ""}`.trim();

// prendi i dati del ristorante (per fallback)
let { data: risto } = await supabase
  .from("ristoranti")
  .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
  .eq("stripe_customer_id", invoice.customer as string)
  .maybeSingle();

if (!risto && invoice.customer_email) {
  const byEmail = await supabase
    .from("ristoranti")
    .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
    .eq("email", invoice.customer_email)
    .maybeSingle();
  risto = byEmail.data || null;
}

// 🔎 DATI "SNAPSHOT" DELL'INVOICE (fonte più affidabile per la fattura)
const invName = invoice.customer_name || risto?.ragione_sociale || null;
const invAddress = invoice.customer_address || risto?.indirizzo_json || null;
const invEmail = invoice.customer_email || risto?.email || null;

// P.IVA dall'invoice se presente, altrimenti dal DB
let invVat: string | null = null;
const invTaxIds = Array.isArray(invoice.customer_tax_ids)
  ? invoice.customer_tax_ids
  : (invoice.customer_tax_ids?.data || []);
if (invTaxIds.length) {
  invVat = invTaxIds[0]?.value || null;
} else {
  invVat = risto?.partita_iva || null;
}

// SdI/PEC: prima DB, poi (se serve) dai metadata del Customer Stripe
let invSdi = risto?.codice_destinatario || null;
let invPec = risto?.pec || null;
try {
  if ((!invSdi || !invPec) && invoice.customer) {
    const cust = await stripe.customers.retrieve(invoice.customer as string);
    if (cust && typeof cust === "object") {
      invSdi = invSdi || (cust as any).metadata?.codice_destinatario || null;
      invPec = invPec || (cust as any).metadata?.pec || null;
    }
  }
} catch { /* non bloccare il flusso fattura */ }

// IVA totale: usa total_tax_amounts se disponibile, altrimenti fallback a invoice.tax
const taxTotal = sum(invoice.total_tax_amounts) || (invoice.tax || 0);

// ====== Salva/aggiorna record fattura in Supabase ======
await supabase.from("fatture").upsert({
  id_stripe: invoice.id,
  numero: invoice.number,
  customer_id: invoice.customer,
  ristorante_id: risto?.id || null,
  stato: invoice.status,
  currency: invoice.currency,
  totale_cent: invoice.total,
  imponibile_cent: invoice.subtotal,
  imposta_cent: taxTotal,
  hosted_url: invoice.hosted_invoice_url,
  pdf_url: invoice.invoice_pdf,
  periodo_inizio: period_start,
  periodo_fine: period_end,
  created_at_iso: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
  raw_json: invoice
}, { onConflict: "id_stripe" });

console.log("🧾 Invoice salvata:", invoice.number || invoice.id);

// ====== INVIO A MAKE ======
const payload = {
  id_stripe: invoice.id,
  number: invoice.number,
  currency: invoice.currency,
  subtotal_cent: invoice.subtotal,
  total_cent: invoice.total,
  hosted_invoice_url: invoice.hosted_invoice_url,
  invoice_pdf: invoice.invoice_pdf,
  period_start,
  period_end,
  description: lineDescription,
  client: {
    name: invName || invEmail,
    vat_number: (risto?.partita_iva || null)?.replace(/^IT/i, "").replace(/\D/g, "") || null,
    sdi: risto?.codice_destinatario || null,
    pec: risto?.pec || null,
    address: invAddress || null,   // oggetto Stripe compatibile con Make
    email: invEmail || null
  }
};

await fetch(MAKE_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});


    console.log("➡️  Inviato a Make per FE:", invoiceId);
  } catch (e) {
    console.error("❌ Errore invoice.finalized:", e);
  }
}
// =====================================================================================
// ✅ INVOICE PAID: invia a Make (utile se hai creato una bozza e poi l'hai pagata)
// =====================================================================================
if (event.type === "invoice.paid") {
  const invoice = event.data.object as any;

  try {
    const customerId = invoice.customer as string;
    const number = invoice.number;
    const invoiceId = invoice.id;
    const currency = invoice.currency;
    const total = invoice.total;
    const subtotal = invoice.subtotal;
    const status = invoice.status;
    const hostedUrl = invoice.hosted_invoice_url;
    const pdfUrl = invoice.invoice_pdf;
    const createdAt = invoice.created ? new Date(invoice.created * 1000).toISOString() : null;

// periodo (prima linea se c'è)
let period_start: string | null = null;
let period_end: string | null = null;
const firstLine = invoice.lines?.data?.[0];
if (firstLine?.period) {
  period_start = new Date(firstLine.period.start * 1000).toISOString();
  period_end   = new Date(firstLine.period.end   * 1000).toISOString();
}
const lineDescription =
  firstLine?.description ||
  `Abbonamento ${firstLine?.plan?.nickname || ""}`.trim();

// prendi i dati del ristorante (per fallback)
let { data: risto } = await supabase
  .from("ristoranti")
  .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
  .eq("stripe_customer_id", invoice.customer as string)
  .maybeSingle();

if (!risto && invoice.customer_email) {
  const byEmail = await supabase
    .from("ristoranti")
    .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
    .eq("email", invoice.customer_email)
    .maybeSingle();
  risto = byEmail.data || null;
}

// 🔎 DATI "SNAPSHOT" DELL'INVOICE (fonte più affidabile per la fattura)
const invName = invoice.customer_name || risto?.ragione_sociale || null;
const invAddress = invoice.customer_address || risto?.indirizzo_json || null;
const invEmail = invoice.customer_email || risto?.email || null;

// P.IVA dall'invoice se presente, altrimenti dal DB
let invVat: string | null = null;
const invTaxIds = Array.isArray(invoice.customer_tax_ids)
  ? invoice.customer_tax_ids
  : (invoice.customer_tax_ids?.data || []);
if (invTaxIds.length) {
  invVat = invTaxIds[0]?.value || null;
} else {
  invVat = risto?.partita_iva || null;
}

// SdI/PEC: prima DB, poi (se serve) dai metadata del Customer Stripe
let invSdi = risto?.codice_destinatario || null;
let invPec = risto?.pec || null;
try {
  if ((!invSdi || !invPec) && invoice.customer) {
    const cust = await stripe.customers.retrieve(invoice.customer as string);
    if (cust && typeof cust === "object") {
      invSdi = invSdi || (cust as any).metadata?.codice_destinatario || null;
      invPec = invPec || (cust as any).metadata?.pec || null;
    }
  }
} catch { /* non bloccare il flusso fattura */ }

// IVA totale: usa total_tax_amounts se disponibile, altrimenti fallback a invoice.tax
const taxTotal = sum(invoice.total_tax_amounts) || (invoice.tax || 0);

// ====== Salva/aggiorna record fattura in Supabase ======
await supabase.from("fatture").upsert({
  id_stripe: invoice.id,
  numero: invoice.number,
  customer_id: invoice.customer,
  ristorante_id: risto?.id || null,
  stato: invoice.status,
  currency: invoice.currency,
  totale_cent: invoice.total,
  imponibile_cent: invoice.subtotal,
  imposta_cent: taxTotal,
  hosted_url: invoice.hosted_invoice_url,
  pdf_url: invoice.invoice_pdf,
  periodo_inizio: period_start,
  periodo_fine: period_end,
  created_at_iso: invoice.created ? new Date(invoice.created * 1000).toISOString() : null,
  raw_json: invoice
}, { onConflict: "id_stripe" });

console.log("🧾 Invoice salvata:", invoice.number || invoice.id);

// ====== INVIO A MAKE ======
const payload = {
  id_stripe: invoice.id,
  number: invoice.number,
  currency: invoice.currency,
  subtotal_cent: invoice.subtotal,
  total_cent: invoice.total,
  hosted_invoice_url: invoice.hosted_invoice_url,
  invoice_pdf: invoice.invoice_pdf,
  period_start,
  period_end,
  description: lineDescription,
  client: {
    name: invName || invEmail,
    vat_number: invVat || null,
    sdi: invSdi || null,
    pec: invPec || null,
    address: invAddress || null,   // oggetto Stripe compatibile con Make
    email: invEmail || null
  }
};

await fetch(MAKE_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});

    console.log("➡️  Inviato a Make (invoice.paid):", invoiceId);
  } catch (e) {
    console.error("❌ Errore invoice.paid:", e);
  }
}

  return new Response("ok", { status: 200 });
});


