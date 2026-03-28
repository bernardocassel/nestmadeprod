// NestMate - Create Stripe PaymentIntent with Connect transfer
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLATFORM_FEE_PCT = 0.05; // 5%

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Verify JWT
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    const { bookingId, amount } = req.body;
    if (!bookingId || !amount || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    // Get booking + landlord stripe account
    const { data: booking, error: dbErr } = await supabase
      .from('bookings')
      .select('*, listings(title), landlord:profiles!landlord_id(stripe_account_id, full_name)')
      .eq('id', bookingId)
      .eq('tenant_id', user.id)
      .single();

    if (dbErr || !booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const amountCents = Math.round(amount * 100);
    const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_PCT);
    const landlordStripeId = booking.landlord?.stripe_account_id;

    // Build PaymentIntent options
    const piOptions = {
      amount: amountCents,
      currency: 'aud',
      metadata: {
        bookingId,
        listingId: booking.listing_id,
        tenantId: user.id,
        landlordId: booking.landlord_id,
      },
      description: `NestMate: ${booking.listings?.title || 'Room booking'}`,
      receipt_email: user.email,
    };

    // If landlord has Stripe Connect account, set up transfer
    if (landlordStripeId) {
      piOptions.application_fee_amount = platformFeeCents;
      piOptions.transfer_data = {
        destination: landlordStripeId,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(piOptions);

    // Save payment intent ID
    await supabase.from('bookings').update({
      stripe_payment_intent_id: paymentIntent.id,
    }).eq('id', bookingId);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      platformFee: platformFeeCents / 100,
      landlordConnected: !!landlordStripeId,
    });

  } catch (err) {
    console.error('Payment intent error:', err.message);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
};
