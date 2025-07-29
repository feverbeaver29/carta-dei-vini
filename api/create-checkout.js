const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const YOUR_DOMAIN = "https://www.winesfever.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send({ error: "Method not allowed" });
  }

  const { plan, email } = req.body;
  const priceMap = {
    base: "price_1RiFO4RWDcfnUagZw1Z12VEj",
    pro: "price_1RiFLtRWDcfnUagZp0bIKnOL"
  };

  const selectedPrice = priceMap[plan];
  if (!selectedPrice || !email) {
    return res.status(400).send({ error: "Dati mancanti" });
  }

  try {
    const customers = await stripe.customers.list({ email });
    const customer = customers.data[0];

    if (customer) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all"
      });

      const existingSub = subscriptions.data.find(sub =>
        ["active", "trialing", "past_due", "incomplete", "unpaid"].includes(sub.status)
      );

      if (existingSub) {
        // 🔁 Aggiorna il piano esistente
        await stripe.subscriptions.update(existingSub.id, {
          cancel_at_period_end: false,
          items: [{
            id: existingSub.items.data[0].id,
            price: selectedPrice
          }],
          proration_behavior: "create_prorations",
          metadata: { plan }
        });

        return res.status(200).json({ url: `${YOUR_DOMAIN}/verifica-successo.html?changed=true` });
      }
    }

    // 🎯 Nessun abbonamento esistente: crea nuova sessione checkout
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer?.id,
      ...(customer ? {} : { customer_email: email }),
      line_items: [{ price: selectedPrice, quantity: 1 }],
      subscription_data: {
        metadata: { plan }
      },
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


