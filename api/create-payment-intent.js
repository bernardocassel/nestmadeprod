// NestMate - Create Stripe PaymentIntent (server-side, secure)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || 'https://nestmate.com.au');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Verify JWT token from Supabase
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

    const { bookingId, amount } = req.body;
    if (!bookingId || !amount || amount <= 0 || amount > 50000) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    // Verify booking belongs to this user
    const { data: booking, error: dbErr } = await supabase
      .from('bookings')
      .select('*, listings(title)')
      .eq('id', bookingId)
      .eq('tenant_id', user.id) // Security: only tenant can pay their own booking
      .single();

    if (dbErr || !booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking already processed' });

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // cents
      currency: 'aud',
      metadata: {
        bookingId,
        listingId: booking.listing_id,
        tenantId: user.id,
        landlordId: booking.landlord_id,
      },
      description: `NestMate: ${booking.listings?.title || 'Room booking'}`,
      receipt_email: user.email,
    });

    await supabase.from('bookings').update({
      stripe_payment_intent_id: paymentIntent.id,
    }).eq('id', bookingId);

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('Payment intent error:', err.message);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
};
