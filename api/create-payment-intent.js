// Vercel Edge Function - Stripe PaymentIntent
// Deploy: this file goes to /api/create-payment-intent.js in your repo

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // safe here - server side only
);

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { bookingId, amount, currency = 'aud' } = req.body;
    
    if (!bookingId || !amount) {
      return res.status(400).json({ error: 'bookingId and amount are required' });
    }

    // Verify booking exists in DB
    const { data: booking, error: dbErr } = await supabase
      .from('bookings')
      .select('*, listings(title)')
      .eq('id', bookingId)
      .single();

    if (dbErr || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Create Stripe PaymentIntent (amount in cents)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency,
      metadata: {
        bookingId,
        listingId: booking.listing_id,
        tenantId: booking.tenant_id,
        landlordId: booking.landlord_id,
      },
      description: `NestMate booking: ${booking.listings?.title || 'Room'}`,
      capture_method: 'automatic',
    });

    // Update booking with payment intent ID
    await supabase.from('bookings').update({
      stripe_payment_intent_id: paymentIntent.id,
    }).eq('id', bookingId);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });

  } catch (err) {
    console.error('create-payment-intent error:', err);
    return res.status(500).json({ error: err.message });
  }
};
