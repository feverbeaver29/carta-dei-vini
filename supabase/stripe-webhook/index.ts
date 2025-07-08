
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
});
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  try {
    const sig = req.headers.get("stripe-signature");
    const body = await req.text();
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!sig || !webhookSecret) {
      return new Response("Missing signature or secret", { status: 400 });
    }

    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer;
      const plan = session.items?.data?.[0]?.price?.id || session.subscription;

      // Cerca ristorante con quel customer_id
      const { data: risto, error } = await supabase
        .from("ristoranti")
        .select("*")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (risto) {
        await supabase
          .from("ristoranti")
          .update({
            subscription_status: "active",
            subscription_plan: plan.includes("pro") ? "pro" : "base"
          })
          .eq("id", risto.id);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Errore webhook:", err);
    return new Response("Webhook Error", { status: 400 });
  }
});
