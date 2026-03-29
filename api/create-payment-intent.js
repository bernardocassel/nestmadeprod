// Vercel Serverless Function - Stripe PaymentIntent
const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'Stripe not configured' });

  const { amount, bookingId, listingId, tenantId, landlordId, currency, description } = req.body;

  if (!amount || amount < 100) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const stripe = Stripe(STRIPE_SECRET);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // amount in cents (AUD)
      currency: currency || 'aud',
      description: description || 'RoomiStay booking',
      metadata: {
        bookingId: bookingId || '',
        listingId: listingId || '',
        tenantId: tenantId || '',
        landlordId: landlordId || '',
        platform: 'roomiestay',
      },
      // Payment held — released manually after check-in confirmation
      capture_method: 'automatic',
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
