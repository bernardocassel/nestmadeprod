// NestMate - Stripe Connect Onboarding for Landlords
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const APP_URL = process.env.APP_URL || 'https://nestmadeprod.vercel.app';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', APP_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // Verify JWT
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    // Get or create Stripe Connect account
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_account_id, full_name')
      .eq('id', user.id)
      .single();

    let accountId = profile?.stripe_account_id;

    if (!accountId) {
      // Create new Express account
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'AU',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: { supabase_user_id: user.id },
      });
      accountId = account.id;

      // Save to profile
      await supabase.from('profiles').update({
        stripe_account_id: accountId
      }).eq('id', user.id);
    }

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}?stripe_connect=refresh`,
      return_url: `${APP_URL}?stripe_connect=success`,
      type: 'account_onboarding',
    });

    return res.status(200).json({ url: accountLink.url });

  } catch (err) {
    console.error('Stripe Connect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
