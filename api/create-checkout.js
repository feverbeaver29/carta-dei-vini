const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const YOUR_DOMAIN = "https://www.winesfever.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send({ error: "Method not allowed" });
  }

  const { plan, email } = req.body;
  const priceMap = {
    base: "price_1RiFO4RWDcfnUagZw1Z12VEj",
    pro:  "price_1RiFLtRWDcfnUagZp0bIKnOL"
  };

  const selectedPrice = priceMap[plan];
  if (!selectedPrice || !email) {
    return res.status(400).send({ error: "Dati mancanti" });
  }

  try {
    // Prova a riusare un Customer esistente con la stessa email
    const customers = await stripe.customers.list({ email, limit: 1 });
    const customer = customers.data[0];

    if (customer) {
      // Se esiste già un abbonamento attivo/in corso, esegui cambio piano
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all"
      });

      const existingSub = subscriptions.data.find(sub =>
        ["active", "trialing", "past_due", "incomplete", "unpaid"].includes(sub.status)
      );

      if (existingSub) {
        await stripe.subscriptions.update(existingSub.id, {
          cancel_at_period_end: false,
          items: [{
            id: existingSub.items.data[0].id,
            price: selectedPrice
          }],
          proration_behavior: "create_prorations",
          metadata: { plan }
        });

        return res.status(200).json({
          url: `${YOUR_DOMAIN}/verifica-successo.html?changed=true`
        });
      }
    }

// Nessun abbonamento esistente: crea una nuova sessione di Checkout
const baseParams = {
  mode: "subscription",
  // Dati FE / anagrafica
  tax_id_collection: { enabled: true },
  billing_address_collection: "required",
  custom_fields: [
    {
      key: "codice_destinatario",
      label: { type: "custom", custom: "Codice Destinatario (SdI)" },
      type: "text"
    },
    {
      key: "pec",
      label: { type: "custom", custom: "PEC (in alternativa al Codice SdI)" },
      type: "text",
      optional: true
    }
  ],
  automatic_tax: { enabled: false },

  // Linea abbonamento
  line_items: [{ price: selectedPrice, quantity: 1 }],
  subscription_data: { metadata: { plan } },

  // UX
  locale: "it",
  success_url: `${YOUR_DOMAIN}/login.html?checkout=success`,
  cancel_url: `${YOUR_DOMAIN}/abbonamento.html`
};

// Se ho trovato un customer esistente, lo riuso.
// Altrimenti faccio creare un customer nuovo indicando l’email.
let sessionParams;
if (customer) {
  sessionParams = {
    ...baseParams,
    customer: customer.id,
    customer_update: { address: "auto", name: "auto" }
  };
} else {
  sessionParams = {
    ...baseParams,
    customer_email: email,
    customer_creation: "always",
    customer_update: { address: "auto", name: "auto" }
  };
}

const session = await stripe.checkout.sessions.create(sessionParams);
return res.status(200).json({ url: session.url });


  } catch (err) {
    console.error("❌ Errore Stripe:", err.message, err);
    return res.status(500).json({
      error: err.message,
      details: err.raw || err
    });
  }
};


