// NestMate - Email via Resend
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FROM_EMAIL = 'NestMate <hello@nestmate.com.au>';
const APP_URL = process.env.APP_URL || 'https://nestmate.com.au';

const templates = {
  booking_received: (d) => ({
    subject: `New booking request — ${d.listingTitle}`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#C8F135;padding:20px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="margin:0;color:#000;font-size:1.4rem">New Booking Request! 🏠</h1>
      </div>
      <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
        <p><strong>${d.tenantName}</strong> wants to book your room.</p>
        <div style="background:#fff;padding:16px;border-radius:10px;margin:16px 0;border:1px solid #e0e0d8">
          <p style="margin:4px 0">📍 <strong>${d.listingTitle}</strong></p>
          <p style="margin:4px 0">📅 Move-in: <strong>${d.moveIn}</strong></p>
          <p style="margin:4px 0">💰 Total: <strong>AU$${d.total}</strong> (held in escrow)</p>
          ${d.message ? `<p style="margin:12px 0 4px 0;font-style:italic;color:#666">"${d.message}"</p>` : ''}
        </div>
        <a href="${APP_URL}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
          Review Request →
        </a>
        <p style="color:#999;font-size:.8rem;margin-top:20px">NestMate · Gold Coast, Australia</p>
      </div>
    </div>`
  }),

  booking_approved: (d) => ({
    subject: `Your room request was approved! 🎉`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#C8F135;padding:20px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="margin:0;color:#000;font-size:1.4rem">You're moving in! 🎉</h1>
      </div>
      <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
        <p>Your booking for <strong>${d.listingTitle}</strong> has been approved.</p>
        <div style="background:#fff;padding:16px;border-radius:10px;margin:16px 0;border:1px solid #e0e0d8">
          <p style="margin:4px 0">📅 Move-in: <strong>${d.moveIn}</strong></p>
          <p style="margin:4px 0">🔒 Bond held in escrow: <strong>AU$${d.bond}</strong></p>
        </div>
        <a href="${APP_URL}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
          View Details →
        </a>
      </div>
    </div>`
  }),

  new_message: (d) => ({
    subject: `New message from ${d.senderName} on NestMate`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#C8F135;padding:20px;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="margin:0;color:#000;font-size:1.4rem">New Message 💬</h1>
      </div>
      <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
        <p><strong>${d.senderName}</strong> sent you a message about <strong>${d.listingTitle || 'a room'}</strong>:</p>
        <div style="background:#fff;padding:16px;border-radius:10px;border-left:4px solid #C8F135;margin:16px 0">
          <p style="margin:0;font-style:italic">"${d.message}"</p>
        </div>
        <a href="${APP_URL}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
          Reply →
        </a>
      </div>
    </div>`
  }),
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return res.status(500).json({ error: 'Email not configured' });

    const { type, to, bookingId, landlordId } = req.body;

    let recipient = to;
    let templateData = req.body;

    // If we have bookingId, fetch details from DB
    if (bookingId) {
      const { data: booking } = await supabase
        .from('bookings')
        .select('*, listings(title), tenant:profiles!tenant_id(full_name, email), landlord:profiles!landlord_id(full_name, email)')
        .eq('id', bookingId)
        .single();

      if (booking) {
        templateData = {
          ...templateData,
          listingTitle: booking.listings?.title || 'Room',
          tenantName: booking.tenant?.full_name || 'Tenant',
          moveIn: booking.move_in_date || '',
          total: booking.total_amount || 0,
          bond: booking.bond_amount || 0,
          message: booking.tenant_message || '',
        };
        // Use landlord email if not specified
        if (!recipient && landlordId) {
          recipient = booking.landlord?.email;
        }
      }
    }

    if (!recipient) return res.status(400).json({ error: 'No recipient' });

    const template = templates[type];
    if (!template) return res.status(400).json({ error: 'Unknown template type' });

    const { subject, html } = template(templateData);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [recipient], subject, html }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.message || 'Resend API error');
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Email error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
