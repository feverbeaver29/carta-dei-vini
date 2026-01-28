import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
});

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") || "https://www.wineinapp.com";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });
    }

    // 1) Verifica utente loggato (JWT Supabase)
    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const user = userData.user;
    const userId = user.id;
    const email = user.email || null;

    const { return_path } = await req.json().catch(() => ({}));
    const returnUrl = `${SITE_URL}${return_path || "/abbonamento.html"}`;

    // 2) Client service role per DB
    const supabase = createClient(supabaseUrl, serviceKey);

    // Leggi stripe_customer_id da ristoranti
    const { data: risto, error: ristoErr } = await supabase
      .from("ristoranti")
      .select("stripe_customer_id")
      .eq("id", userId)
      .single();

    if (ristoErr) {
      return new Response(JSON.stringify({ error: "DB error", details: ristoErr.message }), { status: 500 });
    }

    let customerId = risto?.stripe_customer_id as string | null;

    // 3) Se manca customerId, prova a trovarlo su Stripe via email (o crealo)
    if (!customerId) {
      if (!email) {
        return new Response(JSON.stringify({ error: "User email missing" }), { status: 400 });
      }

      const existing = (await stripe.customers.list({ email, limit: 1 })).data[0];
      if (existing) {
        customerId = existing.id;
      } else {
        const created = await stripe.customers.create({
          email,
          metadata: { ristorante_id: userId },
        });
        customerId = created.id;
      }

      // Salva su Supabase
      await supabase
        .from("ristoranti")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId);
    }

    // 4) Crea sessione Portal
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId!,
      return_url: returnUrl,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e) {
    console.error("create-portal-session error:", e);
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
  }
});

