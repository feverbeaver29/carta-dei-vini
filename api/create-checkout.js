const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const YOUR_DOMAIN = "https://www.winesfever.com";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send({ error: "Method not allowed" });
  }

  const { plan, email, businessName, vat, sdi, pec } = req.body;

  const priceMap = {
    base: "price_1RiFO4RWDcfnUagZw1Z12VEj",
    pro:  "price_1RiFLtRWDcfnUagZp0bIKnOL"
  };
  const selectedPrice = priceMap[plan];

  // ===== Validazioni B2B obbligatorie =====
  if (!selectedPrice || !email) {
    return res.status(400).send({ error: "Dati mancanti (plan/email)." });
  }
  if (!businessName) {
    return res.status(400).send({ error: "Ragione sociale obbligatoria." });
  }
  if (!vat) {
    return res.status(400).send({ error: "Partita IVA obbligatoria." });
  }
  if (!sdi && !pec) {
    return res.status(400).send({ error: "Serve Codice SDI oppure PEC." });
  }

  // Normalizza P.IVA: IT + 11 cifre
  const normVat = String(vat).replace(/\s+/g, "").toUpperCase();
  const vatWithCountry = normVat.startsWith("IT") ? normVat : `IT${normVat}`;
  if (!/^IT\d{11}$/.test(vatWithCountry)) {
    return res.status(400).send({ error: "P.IVA non valida. Formato atteso: IT###########" });
  }

  try {
    // 1) Trova o crea il Customer
    let customer = (await stripe.customers.list({ email, limit: 1 })).data[0];

    if (customer) {
      await stripe.customers.update(customer.id, {
        name: businessName,
        email,
        metadata: {
          codice_destinatario: sdi || "",
          pec: pec || ""
        }
      });
    } else {
      customer = await stripe.customers.create({
        name: businessName,
        email,
        metadata: {
          codice_destinatario: sdi || "",
          pec: pec || ""
        }
      });
    }

    // 2) Garantisci che la P.IVA sia presente sul Customer (blocca i privati)
    const taxIds = await stripe.customers.listTaxIds(customer.id, { limit: 100 });
    const alreadyHasVat = taxIds.data.find(
      t => t.type === "eu_vat" && String(t.value).toUpperCase() === vatWithCountry
    );
    if (!alreadyHasVat) {
      try {
        await stripe.customers.createTaxId(customer.id, {
          type: "eu_vat",
          value: vatWithCountry
        });
      } catch (e) {
        return res.status(400).send({ error: "P.IVA rifiutata da Stripe. Controlla il numero." });
      }
    }

    // 3) Crea la sessione di Checkout (solo con 'customer', niente 'customer_creation')
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      customer: customer.id,
      customer_update: { address: "auto", name: "auto" }, // aggiorna ciò che inserisce in checkout
      billing_address_collection: "required",
      tax_id_collection: { enabled: true }, // mantiene visibile/aggiornabile il campo P.IVA

      line_items: [{ price: selectedPrice, quantity: 1 }],
      subscription_data: { metadata: { plan } },

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



