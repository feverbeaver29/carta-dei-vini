import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15"
});

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
  } catch (err) {
    console.error("❌ Errore verifica firma:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ✅ Evento: checkout completato (primo abbonamento)
  if (event.type === "checkout.session.completed") {
const session = event.data.object;
const customerId = session.customer;

// 🔍 Fallback: recupera email dal customer Stripe se mancante
let email = session.customer_email;
if (!email) {
  const customer = await stripe.customers.retrieve(customerId);
  if (typeof customer === 'object' && customer.email) {
    email = customer.email;
  }
}

    console.log("✅ Checkout completato per:", email, customerId);

// Cerca prima per email, poi per stripe_customer_id se necessario
let { data: risto, error } = await supabase
  .from("ristoranti")
  .select("id")
  .eq("email", email)
  .maybeSingle();

if (!risto) {
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

    const selectedPlan = session.metadata?.plan || "base";

    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        stripe_customer_id: customerId,
        subscription_status: "active",
        subscription_plan: selectedPlan,
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore aggiornamento DB:", updateErr);
      return new Response("Errore DB", { status: 500 });
    }

    console.log("✅ Ristorante aggiornato:", risto.id);
  }

  // ✅ Evento: abbonamento aggiornato (upgrade/downgrade, fine trial, cambio status)
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    const customerId = sub.customer;

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

  // ✅ Evento: abbonamento cancellato manualmente o da Stripe
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const customerId = sub.customer;

    const { data: risto, error } = await supabase
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

  return new Response("ok", { status: 200 });
});


