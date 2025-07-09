import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inizializza Stripe e Supabase
const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2022-11-15" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Header per CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://www.winesfever.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // Solo POST è supportato
  if (req.method !== "POST") {
    return new Response("Metodo non supportato", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  // Parsing del body
  let id: string;
  try {
    const body = await req.json();
    id = body.id;
    console.log("Ricevuto ID:", id);
  } catch {
    console.log("Errore parsing JSON");
    return new Response(JSON.stringify({ error: "Body JSON non valido" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  // Recupera il ristorante
  const { data: risto, error } = await supabase
    .from("ristoranti")
    .select("id, stripe_customer_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !risto?.stripe_customer_id) {
    console.log("Errore Supabase o stripe_customer_id mancante", error, risto);
    return new Response(JSON.stringify({ error: "Utente non trovato o senza stripe_customer_id" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  console.log("Utente trovato:", risto);

  // Cerca sottoscrizioni attive o in prova
  const subscriptions = await stripe.subscriptions.list({
    customer: risto.stripe_customer_id,
    status: "all",
    limit: 5,
  });

  const subscription = subscriptions.data.find(sub =>
    ["active", "trialing", "incomplete", "past_due"].includes(sub.status)
  );

  if (!subscription) {
    console.log("Nessun abbonamento valido da annullare per:", risto.stripe_customer_id);
    return new Response(JSON.stringify({ error: "Nessun abbonamento valido da annullare" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  console.log("Annullamento abbonamento:", subscription.id);
  await stripe.subscriptions.del(subscription.id);

  // Aggiorna DB
  await supabase
    .from("ristoranti")
    .update({ subscription_status: "canceled" })
    .eq("id", risto.id);

  console.log("Annullamento completato");

  return new Response(JSON.stringify({ message: "Abbonamento annullato" }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
});

