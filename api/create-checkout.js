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
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      // Se non c'è un customer esistente, passiamo l'email e facciamo creare il Customer
      customer: customer?.id,
      ...(customer ? {} : { customer_email: email }),
      customer_creation: "always",                 // crea sempre un Customer se non esiste
      customer_update: { address: "auto", name: "auto" }, // salva automaticamente su Customer

      // Raccogliamo i dati necessari per la fattura elettronica
      tax_id_collection: { enabled: true },       // P.IVA / VAT
      billing_address_collection: "required",     // indirizzo di fatturazione
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

      // Se sei in forfettario e non applichi IVA, NON attivare automatic_tax/Stripe Tax
      automatic_tax: { enabled: false },

      line_items: [{ price: selectedPrice, quantity: 1 }],
      subscription_data: {
        metadata: { plan }
      },

      // UX
      locale: "it",
      success_url: `${YOUR_DOMAIN}/login.html?checkout=success`,
      cancel_url: `${YOUR_DOMAIN}/abbonamento.html`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("❌ Errore Stripe:", err.message, err);
    return res.status(500).json({
      error: err.message,
      details: err.raw || err
    });
  }
};


