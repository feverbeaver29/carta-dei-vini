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

    let hasUsedTrial = false;

if (customer) {
  const allSubs = await stripe.subscriptions.list({
    customer: customer.id,
    status: "all", // include anche cancellate
  });

  hasUsedTrial = allSubs.data.some(sub => sub.trial_end && sub.trial_end * 1000 < Date.now());
}


    if (customer) {
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "active"
      });

      if (subscriptions.data.length > 0) {
        const currentSub = subscriptions.data[0];

        // Aggiorna il piano esistente
        await stripe.subscriptions.update(currentSub.id, {
          cancel_at_period_end: false,
          items: [{
            id: currentSub.items.data[0].id,
            price: selectedPrice
          }],
            proration_behavior: 'none',
            trial_end: 'now',
            metadata: { plan }
        });

        return res.status(200).json({ url: `${YOUR_DOMAIN}/verifica-successo.html?changed=true` });
      }
    }

    // Se nessuna sottoscrizione esistente, crea nuova con trial
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customer?.id,
        customer_email: customer ? undefined : email, // solo se non esiste
      line_items: [{ price: selectedPrice, quantity: 1 }],
      subscription_data: {
        ...(hasUsedTrial ? {} : { trial_period_days: 7 }),
        metadata: { plan }
      },

      success_url: `${YOUR_DOMAIN}/verifica-successo.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/abbonamento.html`
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("❌ Errore Stripe:", err);
    return res.status(500).json({ error: "Errore nella creazione sessione Stripe" });
  }
};


