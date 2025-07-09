import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.14.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inizializza Stripe e Supabase
const stripe = Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2022-11-15" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Dominio autorizzato per CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://www.winesfever.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

serve(async (req) => {
  // Gestione richiesta preflight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  // Solo metodo POST è accettato
  if (req.method !== "POST") {
    return new Response("Metodo non supportato", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  // Parsing del body JSON
let id: string;
try {
  const body = await req.json();
  id = body.id;
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON non valido" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  // Recupera ristorante associato all'email
const { data: risto, error } = await supabase
  .from("ristoranti")
  .select("id, stripe_customer_id")
  .eq("id", id)
  .maybeSingle();

  if (error || !risto?.stripe_customer_id) {
    return new Response(JSON.stringify({ error: "Utente non trovato o senza stripe_customer_id" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  // Recupera l'abbonamento attivo
  const subscriptions = await stripe.subscriptions.list({
    customer: risto.stripe_customer_id,
    status: "active",
    limit: 1,
  });

  if (!subscriptions.data.length) {
    return new Response(JSON.stringify({ error: "Nessun abbonamento attivo" }), {
      status: 400,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  // Cancella l'abbonamento su Stripe
  await stripe.subscriptions.del(subscriptions.data[0].id);

  // Aggiorna stato abbonamento nel database
  await supabase
    .from("ristoranti")
    .update({ subscription_status: "canceled" })
    .eq("id", risto.id);

  return new Response(JSON.stringify({ message: "Abbonamento annullato" }), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
});

