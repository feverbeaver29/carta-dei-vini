
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!sig || !webhookSecret) {
    return new Response("Missing signature or secret", { status: 400 });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("❌ Errore verifica firma:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ✅ Evento: pagamento completato o inizio prova gratuita
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const email = session.customer_email;
    const customerId = session.customer;

    console.log("✅ Pagamento riuscito per:", email, customerId);

    // 🔄 Aggiorna il ristorante su Supabase
    const { data: risto, error } = await supabase
      .from("ristoranti")
      .select("id")
      .eq("email", email) // ← assicurati che l'email sia presente in tabella
      .maybeSingle();

    if (!risto) {
      console.error("❌ Nessun ristorante trovato per email:", email);
      return new Response("Utente non trovato", { status: 404 });
    }

    const { error: updateErr } = await supabase
      .from("ristoranti")
      .update({
        stripe_customer_id: customerId,
        subscription_status: "active",
        subscription_plan: "base" // oppure "pro" se lo ricavi dal prezzo
      })
      .eq("id", risto.id);

    if (updateErr) {
      console.error("❌ Errore aggiornamento DB:", updateErr);
      return new Response("Errore DB", { status: 500 });
    }

    console.log("✅ Aggiornato ristorante:", risto.id);
  }

  return new Response("ok", { status: 200 });
});

