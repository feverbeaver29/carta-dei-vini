import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Configuration,
  ClientsApi,
  IssuedDocumentsApi,
  IssuedEInvoicesApi,
  IssuedDocumentType,
  CreateClientRequest,
  CreateIssuedDocumentRequest,
  InfoApi,
} from "https://esm.sh/@fattureincloud/fattureincloud-ts-sdk@2?target=deno&deno-std=0.224.0";

// ────────────────────────────────────────────────────────────────────────────────
// ENV & SDK
// ────────────────────────────────────────────────────────────────────────────────
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ────────────────────────────────────────────────────────────────────────────────
/** Somma sicura di amount in centesimi */
const sum = (arr: { amount: number }[] | undefined | null) =>
  (arr || []).reduce((s, x) => s + (x?.amount || 0), 0);

/** Pulisce la P.IVA: rimuove IT/EU, spazi e non numerici */
const cleanVat = (v: unknown) => {
  const s = (v ?? "").toString();
  const cleaned = s.replace(/^IT/i, "").replace(/^EU/i, "").replace(/\D/g, "");
  return cleaned || null;
};

/** SdI: 7 caratteri UPPER, altrimenti null */
const cleanSdi = (v: unknown) => {
  const s = (v ?? "").toString().trim().toUpperCase();
  return s.length === 7 ? s : null;
};

/** Converte "IT"/"Italy"/"Italia" -> { country: "Italia", country_iso: "IT" } */
const toFicCountry = (addr?: { country?: string } | null) => {
  const raw = addr?.country;
  if (!raw) return { country: "Italia", country_iso: "IT" };
  const up = String(raw).trim().toUpperCase();
  if (up === "IT" || up === "ITA" || up === "ITALY" || up === "ITALIA") {
    return { country: "Italia", country_iso: "IT" };
  }
  return { country: String(raw), country_iso: up.length === 2 ? up : undefined };
};

// ────────────────────────────────────────────────────────────────────────────────
// FIC: crea/riusa cliente e genera + invia e-fattura
// ────────────────────────────────────────────────────────────────────────────────
async function ficCreateAndSend(invoicePayload: {
  client: {
    name: string | null;
    vat_number: string | null;
    sdi?: string | null;
    pec?: string | null;
    address?: any | null;  // Stripe.Address
    email?: string | null;
  };
  description: string;
  currency: string;
  subtotal_cent: number;
}) {
  const accessToken = Deno.env.get("FIC_ACCESS_TOKEN")!;
  const companyId = Number(Deno.env.get("FIC_COMPANY_ID")!);
  const cfg = new Configuration({ accessToken });

  const clientsApi = new ClientsApi(cfg);
  const docsApi = new IssuedDocumentsApi(cfg);
  const einvApi = new IssuedEInvoicesApi(cfg);
  const infoApi = new InfoApi(cfg);

  const ficCountry = toFicCountry(invoicePayload.client.address);

  // 0) Aliquota IVA 0% (preferibilmente N2.2)
  let vat0IdNum: number;
  try {
    const vatsResp = await infoApi.listVatTypes(companyId);
    const list = vatsResp.data?.data ?? [];
    const preferred = list.find(
      (v) =>
        v?.value === 0 &&
        !v?.is_disabled &&
        (((v as any)?.e_invoice?.nature === "N2.2") ||
          /forfett/i.test(v?.description ?? "") ||
          /n2\.2/i.test(v?.description ?? ""))
    );
    const anyZero = preferred ?? list.find((v) => v?.value === 0 && !v?.is_disabled);
    if (!anyZero?.id) throw new Error("Nessuna aliquota 0% disponibile in FIC: crea un'aliquota 0% con natura N2.2.");
    vat0IdNum = Number(anyZero.id);
  } catch (e) {
    console.error("FIC listVatTypes error:", (e as any)?.response?.data || e);
    throw e;
  }

  // 1) Crea cliente, altrimenti dedup (P.IVA -> nome)
  let clientId: number | undefined;
  try {
    const cReq: CreateClientRequest = {
      data: {
        type: "company",
        name: invoicePayload.client.name ?? invoicePayload.client.email ?? "Cliente",
        vat_number: invoicePayload.client.vat_number ?? undefined,
        ei_code: invoicePayload.client.sdi ?? undefined,
        pec: invoicePayload.client.pec ?? undefined,
        email: invoicePayload.client.email ?? undefined,
        address_street: invoicePayload.client.address?.line1 ?? undefined,
        address_postal_code: invoicePayload.client.address?.postal_code ?? undefined,
        address_city: invoicePayload.client.address?.city ?? undefined,
        address_province: invoicePayload.client.address?.state ?? undefined,
        country: ficCountry.country,
        country_iso: ficCountry.country_iso,
      },
    };
    const created = await clientsApi.createClient(companyId, cReq);
    clientId = created.data?.id ?? created.data?.data?.id; // compatibilità doppio nesting
  } catch (e: any) {
    console.error("FIC createClient error:", e?.response?.data || e);
    // → dedup: page/per_page *espliciti* per non sballare i posizionali
    try {
      // priorità: P.IVA pulita
      if (invoicePayload.client.vat_number) {
        const qVat = `vat_number = '${invoicePayload.client.vat_number}'`;
        const foundByVat = await clientsApi.listClients(
          companyId,
          undefined, // fieldset
          undefined, // sort
          1,         // page
          20,        // per_page  (integer!)
          qVat
        );
        clientId = foundByVat.data?.data?.[0]?.id ?? clientId;
      }
      // fallback: denominazione esatta
      if (!clientId && invoicePayload.client.name) {
        const safeName = invoicePayload.client.name.replace(/'/g, "\\'");
        const qName = `name = '${safeName}'`;
        const foundByName = await clientsApi.listClients(
          companyId,
          undefined,
          undefined,
          1,
          20,
          qName
        );
        clientId = foundByName.data?.data?.[0]?.id ?? clientId;
      }
    } catch (e2) {
      console.error("FIC listClients (dedup) error:", (e2 as any)?.response?.data || e2);
    }
    // se non troviamo l'ID, proseguiamo con entity “on-the-fly”
  }

  // 2) Riga documento (forfettario → imponibile senza IVA)
  const net = Number((invoicePayload.subtotal_cent / 100).toFixed(2));
  const item: any = {
    name: invoicePayload.description || "Abbonamento mensile",
    qty: 1,
    net_price: net,
    vat: { id: vat0IdNum },
  };

  // 3) Crea documento
  const gross = net;
  const todayIso = new Date().toISOString().slice(0, 10);

  const docReq: CreateIssuedDocumentRequest = {
    data: {
      type: IssuedDocumentType.Invoice,
      entity: {
        id: clientId, // se presente, linka al cliente esistente
        name: invoicePayload.client.name ?? invoicePayload.client.email ?? "Cliente",
        vat_number: invoicePayload.client.vat_number ?? undefined,
        ei_code: invoicePayload.client.sdi ?? undefined,
        pec: invoicePayload.client.pec ?? undefined,
        email: invoicePayload.client.email ?? undefined,
        address_street: invoicePayload.client.address?.line1 ?? undefined,
        address_postal_code: invoicePayload.client.address?.postal_code ?? undefined,
        address_city: invoicePayload.client.address?.city ?? undefined,
        address_province: invoicePayload.client.address?.state ?? undefined,
        country: ficCountry.country,
        country_iso: ficCountry.country_iso,
      },
      currency: { id: (invoicePayload.currency || "EUR").toUpperCase() },
      items_list: [item],
      visible_subject: "Abbonamento Wine in App",
      payments_list: [
        {
          amount: Number(gross.toFixed(2)),
          due_date: todayIso,
          status: "not_paid",
          payment_terms: { type: "standard", days: 0 },
        },
      ],
    },
  };

  try {
    const createdDoc = await docsApi.createIssuedDocument(companyId, docReq);

    // ⬅️ FIX: l’ID può essere in `data.data.id` (Axios-like) o in `data.id`
    const documentId =
      (createdDoc as any)?.data?.data?.id ??
      (createdDoc as any)?.data?.id ??
      (createdDoc as any)?.id ??
      undefined;

    if (!documentId) {
      console.error("FIC createIssuedDocument: risposta inattesa", createdDoc);
      throw new Error("Creazione documento FIC: risposta senza id");
    }

    // 4) invia e-fattura
    await einvApi.sendEInvoice(companyId, documentId, {});
  } catch (e: any) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error("FIC create/send error:", { status, data, err: e?.message || e });
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// WEBHOOK
// ────────────────────────────────────────────────────────────────────────────────
serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  if (!sig || !webhookSecret) {
    return new Response("Missing signature or secret", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err: any) {
    console.error("❌ Errore verifica firma:", err?.message);
    return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ✅ CHECKOUT COMPLETATO
  // ──────────────────────────────────────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const customerId = (session.customer as string) || null;

const det = session.customer_details || {};
let email = session.customer_email || det.email || null;

const rawRistoranteId =
  session.client_reference_id || session.metadata?.ristorante_id || null;

const ristoranteId =
  typeof rawRistoranteId === "string" && rawRistoranteId.trim()
    ? rawRistoranteId.trim()
    : null;

    // prova a recuperare il Customer (senza bloccare il flusso)
    let customer: any = null;
    if (customerId) {
      try {
        const _c = await stripe.customers.retrieve(customerId);
        if (_c && typeof _c === "object") {
          customer = _c;
          if (!email) email = (customer as any).email || null;
        }
      } catch (e) {
        console.warn(
          "⚠️ retrieve(customer) fallito, procedo con customer_details:",
          (e as any)?.message
        );
      }
    }

    console.log("✅ Checkout completato per:", email, customerId);

// ✅ trova ristorante: PRIMA per ristoranteId, poi fallback
let risto: { id: string } | null = null;

// 1) by ristoranteId (strong link)
if (ristoranteId) {
  const byId = await supabase
    .from("ristoranti")
    .select("id")
    .eq("id", ristoranteId)
    .maybeSingle();
  risto = byId.data || null;
}

// 2) fallback by email (email è UNIQUE → maybeSingle)
if (!risto && email) {
  const byEmail = await supabase
    .from("ristoranti")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  risto = byEmail.data || null;
}

// 3) fallback by stripe_customer_id
if (!risto && customerId) {
  const byStripeId = await supabase
    .from("ristoranti")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  risto = byStripeId.data || null;
}

if (!risto) {
  console.error("❌ Nessun ristorante trovato", { ristoranteId, email, customerId });
  return new Response("Utente non trovato", { status: 404 });
}

    // metadati FE dal Customer
    const codiceDestinatario = customer?.metadata?.codice_destinatario || null;
    const pec = customer?.metadata?.pec || null;

    // P.IVA: prima dal checkout snapshot, poi dal customer
    let partitaIVA: string | null = null;
    const detTaxIds = Array.isArray(det.tax_ids) ? det.tax_ids : [];
    if (detTaxIds.length) {
      partitaIVA = detTaxIds[0]?.value || null;
    }
    if (!partitaIVA && customerId) {
      try {
        const taxIds = await stripe.customers.listTaxIds(customerId, {
          limit: 25,
        });
        const vat = taxIds.data.find(
          (t) => t.type === "eu_vat" || t.type === "it_vat"
        );
        partitaIVA = vat?.value || null;
      } catch (e) {
        console.warn("⚠️ listTaxIds fallito:", (e as any)?.message);
      }
    }

    const ragioneSociale = det.name || customer?.name || null;
    const indirizzo = det.address || customer?.address || null;

    // Piano dalla subscription creata dalla sessione
    let selectedPlan = "base";
    try {
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(
          session.subscription as string
        );
        const firstItem = sub.items?.data?.[0];
        const priceId = firstItem?.price?.id;
        selectedPlan =
          priceId === "price_1RiFLtRWDcfnUagZp0bIKnOL" ? "pro" : "base";
      }
    } catch (e) {
      console.warn(
        "⚠️ Impossibile leggere subscription dalla session:",
        (e as any)?.message
      );
    }

    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        stripe_customer_id: customerId,
        subscription_status: "active",
        subscription_plan: selectedPlan,
        ragione_sociale: ragioneSociale,
        indirizzo_json: indirizzo || null,
        partita_iva: cleanVat(partitaIVA),
        codice_destinatario: codiceDestinatario,
        pec: pec,
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore aggiornamento DB:", updateErr);
      return new Response("Errore DB", { status: 500 });
    }

    console.log("✅ Ristorante aggiornato:", risto.id);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 🔁 SUBSCRIPTION UPDATED
  // ──────────────────────────────────────────────────────────────────────────
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as any;
    const customerId = sub.customer as string;

    const { data: risto } = await supabase
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
        subscription_plan: plan,
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore aggiornamento abbonamento:", updateErr);
    } else {
      console.log(`🔁 Abbonamento aggiornato → ${plan} (${newStatus})`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 🚫 SUBSCRIPTION DELETED
  // ──────────────────────────────────────────────────────────────────────────
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
        stripe_customer_id: null,
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore nel marcare come cancellato:", updateErr);
    } else {
      console.log("🚫 Abbonamento cancellato per:", risto.id);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 🧾 INVOICE FINALIZED
  // ──────────────────────────────────────────────────────────────────────────
  if (event.type === "invoice.finalized") {
    const invoice = event.data.object as any;

    try {
      const currency = (invoice.currency || "eur").toString().toUpperCase();
      const subtotal = Number(invoice.subtotal ?? 0);

      // Periodo dalla prima linea (se presente)
      let period_start: string | null = null;
      let period_end: string | null = null;
      const firstLine = invoice.lines?.data?.[0];
      if (firstLine?.period) {
        period_start = new Date(firstLine.period.start * 1000).toISOString();
        period_end = new Date(firstLine.period.end * 1000).toISOString();
      }
      const lineDescription =
        firstLine?.description ||
        `Abbonamento ${firstLine?.plan?.nickname || ""}`.trim();

const lineDescription =
  firstLine?.description ||
  `Abbonamento ${firstLine?.plan?.nickname || ""}`.trim();

// ✅ 0) Prova a recuperare ristorante_id dalla subscription metadata (flusso per ID)
let ristoranteIdInv: string | null = null;

try {
  if (invoice.subscription) {
    const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
    const rid = (sub as any)?.metadata?.ristorante_id;
    if (typeof rid === "string" && rid.trim()) ristoranteIdInv = rid.trim();
  }
} catch (e) {
  console.warn("⚠️ Impossibile recuperare subscription metadata:", (e as any)?.message);
}

// ✅ 1) Cerca ristorante: prima per ID, poi fallback
let risto: any = null;

if (ristoranteIdInv) {
  const byId = await supabase
    .from("ristoranti")
    .select(
      "id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan"
    )
    .eq("id", ristoranteIdInv)
    .maybeSingle();
  risto = byId.data || null;
}

if (!risto) {
  const byStripeId = await supabase
    .from("ristoranti")
    .select(
      "id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan"
    )
    .eq("stripe_customer_id", invoice.customer as string)
    .maybeSingle();
  risto = byStripeId.data || null;
}

if (!risto && invoice.customer_email) {
  const byEmail = await supabase
    .from("ristoranti")
    .select(
      "id, email, ragione_sociale, partita_iva, codice_destinatario, pec, indirizzo_json, subscription_plan"
    )
    .eq("email", invoice.customer_email)
    .maybeSingle();
  risto = byEmail.data || null;
}

if (!risto) {
  console.error("❌ Nessun ristorante trovato (invoice.finalized)", {
    ristoranteIdInv,
    customer: invoice.customer,
    email: invoice.customer_email,
  });
  // Non blocco il webhook: salvo fattura senza ristorante_id
}

      // Dati snapshot dall'invoice
      const invName = invoice.customer_name || risto?.ragione_sociale || null;
      const invAddress = invoice.customer_address || risto?.indirizzo_json || null;
      const invEmail = invoice.customer_email || risto?.email || null;

      // P.IVA: dall'invoice se c'è, altrimenti dal DB
      let invVat: string | null = null;
      const invTaxIds = Array.isArray(invoice.customer_tax_ids)
        ? invoice.customer_tax_ids
        : invoice.customer_tax_ids?.data || [];
      if (invTaxIds.length) {
        invVat = invTaxIds[0]?.value || null;
      } else {
        invVat = risto?.partita_iva || null;
      }
      const invVatClean = cleanVat(invVat) || cleanVat(risto?.partita_iva);

      // SdI / PEC: prima DB, poi metadata customer Stripe se serve
      let invSdi = cleanSdi(risto?.codice_destinatario);
      let invPec = risto?.pec || null;
      try {
        if ((!invSdi || !invPec) && invoice.customer) {
          const cust = await stripe.customers.retrieve(
            invoice.customer as string
          );
          if (cust && typeof cust === "object") {
            invSdi = cleanSdi(invSdi || (cust as any).metadata?.codice_destinatario);
            invPec = invPec || (cust as any).metadata?.pec || null;
          }
        }
      } catch {
        /* non bloccare il flusso fattura */
      }

      // IVA totale (se presente)
      const taxTotal = sum(invoice.total_tax_amounts) || (invoice.tax || 0);

      // Salva/aggiorna record fattura in Supabase
      await supabase.from("fatture").upsert(
        {
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
          created_at_iso: invoice.created
            ? new Date(invoice.created * 1000).toISOString()
            : null,
          raw_json: invoice,
        },
        { onConflict: "id_stripe" }
      );

      console.log("🧾 Invoice salvata:", invoice.number || invoice.id);

      // Crea e invia fattura su FIC
      await ficCreateAndSend({
        description: lineDescription,
        currency,
        subtotal_cent: subtotal,
        client: {
          name: invName || invEmail,
          vat_number: invVatClean || null,
          sdi: invSdi || null,
          pec: invPec || null,
          address: invAddress || null,
          email: invEmail || null,
        },
      });

      console.log(
        "✅ Fattura creata/inviata su Fatture in Cloud:",
        invoice.number || invoice.id
      );
    } catch (e) {
      console.error("❌ Errore invoice.finalized:", e);
    }
  }

  return new Response("ok", { status: 200 });
});


