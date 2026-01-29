const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const YOUR_DOMAIN = "https://www.wineinapp.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send({ error: "Method not allowed" });

  const { plan, email, businessName, vat, sdi, pec, ristorante_id } = req.body;

  if (!ristorante_id) {
    console.warn("⚠️ Checkout senza ristorante_id, userò fallback email nel webhook", { email });
  }

  const priceMap = {
    base: "price_1RiFO4RWDcfnUagZw1Z12VEj",
    pro:  "price_1RiFLtRWDcfnUagZp0bIKnOL"
  };
  const selectedPrice = priceMap[plan];

  if (!selectedPrice || !email) return res.status(400).send({ error: "Dati mancanti (plan/email)." });
  if (!businessName) return res.status(400).send({ error: "Ragione sociale obbligatoria." });
  if (!vat) return res.status(400).send({ error: "Partita IVA obbligatoria." });
  if (!sdi && !pec) return res.status(400).send({ error: "Serve Codice SDI oppure PEC." });

  const normVat = String(vat).replace(/\s+/g, "").toUpperCase();
  const vatWithCountry = normVat.startsWith("IT") ? normVat : `IT${normVat}`;
  if (!/^IT\d{11}$/.test(vatWithCountry)) {
    return res.status(400).send({ error: "P.IVA non valida. Formato atteso: IT###########" });
  }

  try {
    let customer = (await stripe.customers.list({ email, limit: 1 })).data[0];

    const customerMetadata = {
      codice_destinatario: sdi || "",
      pec: pec || "",
      ristorante_id: ristorante_id || "",
    };

    if (customer) {
      await stripe.customers.update(customer.id, { name: businessName, email, metadata: customerMetadata });
    } else {
      customer = await stripe.customers.create({ name: businessName, email, metadata: customerMetadata });
    }

    const taxIds = await stripe.customers.listTaxIds(customer.id, { limit: 100 });
    const alreadyHasVat = taxIds.data.find(
      t => t.type === "eu_vat" && String(t.value).toUpperCase() === vatWithCountry
    );
    if (!alreadyHasVat) {
      try {
        await stripe.customers.createTaxId(customer.id, { type: "eu_vat", value: vatWithCountry });
      } catch {
        return res.status(400).send({ error: "P.IVA rifiutata da Stripe. Controlla il numero." });
      }
    }

    const existingSubs = await stripe.subscriptions.list({
  customer: customer.id,
  status: "active",
  limit: 1,
});

if (existingSubs.data.length > 0) {
  return res.status(409).json({
    error: "Hai già un abbonamento attivo. Usa Gestisci Abbonamento dal portale.",
  });
}

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,

      client_reference_id: ristorante_id || undefined,
      metadata: { ristorante_id: ristorante_id || "", plan },

      subscription_data: { metadata: { plan, ristorante_id: ristorante_id || "" } },

      customer_update: { address: "auto", name: "auto" },
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },

      line_items: [{ price: selectedPrice, quantity: 1 }],

      locale: "it",
      success_url: `${YOUR_DOMAIN}/login.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${YOUR_DOMAIN}/abbonamento.html`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("❌ Errore Stripe:", err.message, err);
    return res.status(500).json({ error: err.message, details: err.raw || err });
  }
};




