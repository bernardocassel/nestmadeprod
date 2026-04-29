const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { userId, email } = req.body;

    if (!userId || !email) {
      return res.status(400).json({ error: 'userId and email are required' });
    }

    const APP_URL = process.env.APP_URL || 'https://nestmadeprod.vercel.app';

    // Check if user already has a Stripe Connect account
    // (You'd look this up in Supabase in production)
    // For now, always create a new account link

    // Create a Stripe Express account
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'AU',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: {
        supabase_user_id: userId,
      },
    });

    // Create the onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${APP_URL}?stripe_connect=refresh`,
      return_url: `${APP_URL}?stripe_connect=success&account_id=${account.id}`,
      type: 'account_onboarding',
    });

    // Save the stripe_account_id to Supabase
    // We do this via Supabase service role key
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase
      .from('profiles')
      .update({ stripe_account_id: account.id })
      .eq('id', userId);

    return res.status(200).json({ url: accountLink.url, accountId: account.id });

  } catch (err) {
    console.error('stripe-connect-onboard error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
