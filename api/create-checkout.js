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
        status: "active"
      });

for (const sub of subscriptions.data) {
  if (sub.status === "active" || sub.status === "trialing") {
    try {
      await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: false
      });
      await stripe.subscriptions.del(sub.id);
    } catch (err) {
      console.warn("⚠️ Impossibile eliminare abbonamento:", sub.id, err.message);
    }
  }
}
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer?.id,
      ...(customer ? {} : { customer_email: email }),
      line_items: [{ price: selectedPrice, quantity: 1 }],
      subscription_data: {
        metadata: { plan }
      },
      success_url: `${YOUR_DOMAIN}/verifica-successo.html?session_id={CHECKOUT_SESSION_ID}`,
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


