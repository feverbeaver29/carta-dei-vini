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
    // Cerca cliente Stripe tramite email
    const customers = await stripe.customers.list({ email });
    let customer = customers.data[0];

    // Se non esiste, Stripe ne crea uno durante il checkout
    if (customer) {
      // Elimina eventuali abbonamenti attivi
      const subscriptions = await stripe.subscriptions.list({
        customer: customer.id,
        status: "active",
        expand: ["data.default_payment_method"]
      });

      for (const sub of subscriptions.data) {
        await stripe.subscriptions.del(sub.id);
      }
    }

    // Prepara i dati per la sottoscrizione
    const subscriptionData = {
      metadata: { plan }
    };

    // ❗ Solo se è un nuovo cliente (mai abbonato), offri prova gratuita
    if (!customer) {
      subscriptionData.trial_period_days = 7;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price: selectedPrice,
          quantity: 1
        }
      ],
      subscription_data: subscriptionData,
      success_url: `${YOUR_DOMAIN}/verifica-successo.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/abbonamento.html`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("❌ Errore Stripe:", err);
    return res.status(500).json({ error: "Errore nella creazione sessione Stripe" });
  }
};

