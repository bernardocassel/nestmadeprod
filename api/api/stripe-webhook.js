// NestMate - Stripe Webhook Handler (secure)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe signature' });

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { bookingId, tenantId, landlordId } = pi.metadata;
        if (!bookingId) break;

        // Update booking to pending (waiting landlord approval)
        await supabase.from('bookings').update({
          status: 'pending',
          paid_at: new Date().toISOString(),
          stripe_payment_intent_id: pi.id,
        }).eq('id', bookingId);

        // Record payment in escrow
        await supabase.from('payments').insert({
          booking_id: bookingId,
          tenant_id: tenantId,
          landlord_id: landlordId,
          amount: pi.amount / 100,
          currency: pi.currency,
          stripe_payment_intent_id: pi.id,
          status: 'held_in_escrow',
        });

        // Notify landlord
        await fetch(`${process.env.APP_URL}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'booking_received',
            bookingId,
            landlordId,
          }),
        });

        console.log(`✅ Payment confirmed & escrowed: booking ${bookingId}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const { bookingId } = event.data.object.metadata;
        if (bookingId) {
          await supabase.from('bookings').update({ status: 'payment_failed' }).eq('id', bookingId);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Still return 200 to prevent Stripe retries for logic errors
  }

  return res.status(200).json({ received: true });
};
