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
    const customerId = session.customer as string;

    // Email: preferisci quella in sessione, altrimenti dal Customer
    let email = session.customer_email as string | null;
    let customer: any = null;

    if (!email || !customerId) {
      // estrema prudenza, ma il customerId dovrebbe esserci sempre
      const _c = customerId ? await stripe.customers.retrieve(customerId) : null;
      if (_c && typeof _c === "object") {
        customer = _c;
        email = email || _c.email || null;
      }
    } else {
      // recupera comunque il Customer per anagrafica completa
      const _c = await stripe.customers.retrieve(customerId);
      if (_c && typeof _c === "object") customer = _c;
    }

    console.log("✅ Checkout completato per:", email, customerId);

    // Trova il ristorante (prima per email, poi per customerId)
    let { data: risto, error } = await supabase
      .from("ristoranti")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (!risto && customerId) {
      const byStripeId = await supabase
        .from("ristoranti")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      risto = byStripeId.data;
      error = byStripeId.error;
    }

    if (!risto) {
      console.error("❌ Nessun ristorante trovato per email:", email);
      return new Response("Utente non trovato", { status: 404 });
    }

    // ⬇️ Estrai i custom fields (SdI/PEC) dal Checkout
    const customFields = Array.isArray(session.custom_fields) ? session.custom_fields : [];
    const getCF = (key: string) =>
      customFields.find((f: any) => f.key === key)?.text?.value || null;

    const codiceDestinatario = getCF("codice_destinatario");
    const pec = getCF("pec");

    // ⬇️ Tax IDs (P.IVA) dal Customer
    let partitaIVA: string | null = null;
    if (customerId) {
      const taxIds = await stripe.customers.listTaxIds(customerId, { limit: 10 });
      // prendi la prima VAT/P.IVA disponibile
      const vat = taxIds.data.find((t) => t.type === "eu_vat" || t.type === "it_vat");
      partitaIVA = vat?.value || null;
    }

    // ⬇️ Ragione sociale + indirizzo
    const ragioneSociale =
      (customer && typeof customer === "object" && customer.name) || null;
    const indirizzo =
      (customer && typeof customer === "object" && customer.address) || null;

    const selectedPlan = (session.metadata?.plan as string) || "base";

    // Aggiorna ristorante con customerId, stato abbonamento e dati di fatturazione
    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        stripe_customer_id: customerId,
        subscription_status: "active",
        subscription_plan: selectedPlan,

        // campi per FE (assicurati che esistano in schema, vedi sezione NOTE)
        ragione_sociale: ragioneSociale,
        indirizzo_json: indirizzo ? JSON.stringify(indirizzo) : null,
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
    const newPriceId = sub.items.data[0].price.id;

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
    const tax = invoice.tax || 0;                // in centesimi (di solito 0 se forfettario)
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

    // prendi anche descrizione riga (fallback al nome piano)
    const lineDescription =
      firstLine?.description ||
      `Abbonamento ${firstLine?.plan?.nickname || ""}`.trim();

    // aggancia ristorante con TUTTI i campi che ci servono
    let { data: risto } = await supabase
      .from("ristoranti")
      .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    // fallback per email
    if (!risto && invoice.customer_email) {
      const byEmail = await supabase
        .from("ristoranti")
        .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
        .eq("email", invoice.customer_email)
        .maybeSingle();
      risto = byEmail.data || null;
    }

    // Salva/aggiorna record fattura in Supabase
    await supabase.from("fatture").upsert({
      id_stripe: invoiceId,
      numero: number,
      customer_id: customerId,
      ristorante_id: risto?.id || null,
      stato: status,
      currency,
      totale_cent: total,
      imponibile_cent: subtotal,
      imposta_cent: tax,
      hosted_url: hostedUrl,
      pdf_url: pdfUrl,
      periodo_inizio: period_start,
      periodo_fine: period_end,
      created_at_iso: createdAt,
      raw_json: invoice
    }, { onConflict: "id_stripe" });

    console.log("🧾 Invoice salvata:", number || invoiceId);

    // ====== INVIO A MAKE ======
    // Recupera anagrafica Customer da Stripe (per nome/indirizzo)
    const customer = await stripe.customers.retrieve(customerId);

    // Costruisci payload per Make
    const payload = {
      id_stripe: invoiceId,
      number,
      currency,
      subtotal_cent: subtotal,
      total_cent: total,
      hosted_invoice_url: hostedUrl,
      invoice_pdf: pdfUrl,
      period_start,
      period_end,
      description: lineDescription,
      client: {
        name:
          risto?.ragione_sociale ||
          (typeof customer === "object" ? (customer as any).name : null) ||
          risto?.email,
        vat_number: risto?.partita_iva || null,
        sdi: risto?.codice_destinatario || null,
        pec: risto?.pec || null,
        address:
          (typeof customer === "object" ? (customer as any).address : null) ||
          risto?.indirizzo_json ||
          null,
        email: risto?.email || (typeof customer === "object" ? (customer as any).email : null)
      }
    };

    // manda a Make (URL tuo)
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
    const tax = invoice.tax || 0;
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

    // prendi i dati del ristorante
    let { data: risto } = await supabase
      .from("ristoranti")
      .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (!risto && invoice.customer_email) {
      const byEmail = await supabase
        .from("ristoranti")
        .select("id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan")
        .eq("email", invoice.customer_email)
        .maybeSingle();
      risto = byEmail.data || null;
    }

    // aggiorna/crea riga fattura anche qui (stato pagata)
    await supabase.from("fatture").upsert({
      id_stripe: invoiceId,
      numero: number,
      customer_id: customerId,
      ristorante_id: risto?.id || null,
      stato: status,
      currency,
      totale_cent: total,
      imponibile_cent: subtotal,
      imposta_cent: tax,
      hosted_url: hostedUrl,
      pdf_url: pdfUrl,
      periodo_inizio: period_start,
      periodo_fine: period_end,
      created_at_iso: createdAt,
      raw_json: invoice
    }, { onConflict: "id_stripe" });

    // anagrafica Stripe (nome/indirizzo)
    const customer = await stripe.customers.retrieve(customerId);

    // payload per Make
    const payload = {
      id_stripe: invoiceId,
      number,
      currency,
      subtotal_cent: subtotal,
      total_cent: total,
      hosted_invoice_url: hostedUrl,
      invoice_pdf: pdfUrl,
      period_start,
      period_end,
      description: lineDescription,
      client: {
        name:
          risto?.ragione_sociale ||
          (typeof customer === "object" ? (customer as any).name : null) ||
          risto?.email,
        vat_number: risto?.partita_iva || null,
        sdi: risto?.codice_destinatario || null,
        pec: risto?.pec || null,
        address:
          (typeof customer === "object" ? (customer as any).address : null) ||
          risto?.indirizzo_json ||
          null,
        email: risto?.email || (typeof customer === "object" ? (customer as any).email : null)
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


