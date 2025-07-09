const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const YOUR_DOMAIN = "https://www.winesfever.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send({ error: "Method not allowed" });
  }

  const { plan, email } = req.body; // ✅ qui riceviamo l'email giusta

  const priceMap = {
    base: "price_1RiFO4RWDcfnUagZw1Z12VEj",
    pro: "price_1RiFLtRWDcfnUagZp0bIKnOL"
  };

  const selectedPrice = priceMap[plan];

  if (!selectedPrice || !email) {
    return res.status(400).send({ error: "Dati mancanti" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: selectedPrice,
          quantity: 1
        }
      ],
      customer_email: email, // ✅ ora usiamo la variabile corretta
      subscription_data: {
        trial_period_days: 7,
        metadata: {
      plan // 👈 aggiunto qui!
    }
      },
      success_url: `${YOUR_DOMAIN}/verifica-successo.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/checkout.html`
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Errore nella creazione sessione Stripe" });
  }
};

