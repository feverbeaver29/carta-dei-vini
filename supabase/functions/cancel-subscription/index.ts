import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2022-11-15" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const { email } = await req.json();

  const { data: risto, error } = await supabase
    .from("ristoranti")
    .select("id, stripe_customer_id")
    .eq("email", email)
    .maybeSingle();

  if (error || !risto?.stripe_customer_id) {
    return new Response("Utente non trovato o senza stripe_customer_id", { status: 400 });
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: risto.stripe_customer_id,
    status: "active",
    limit: 1
  });

  if (!subscriptions.data.length) {
    return new Response("Nessun abbonamento attivo", { status: 400 });
  }

  await stripe.subscriptions.del(subscriptions.data[0].id);

  await supabase
    .from("ristoranti")
    .update({
      subscription_status: "canceled"
    })
    .eq("id", risto.id);

  return new Response("Annullato", { status: 200 });
});
