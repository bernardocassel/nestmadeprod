// Vercel Edge Function - Email via Resend
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Resend API key not configured' });

  const { type, bookingId, landlordId, appUrl } = req.body;
  const siteUrl = appUrl || process.env.APP_URL || 'https://roomiestay.com';

  // Email templates
  const templates = {
    booking_received: (data) => ({
      to: data.landlordEmail,
      subject: `New booking request for ${data.listingTitle}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#1C2810">New Booking Request! 🏠</h2>
        <p><strong>${data.tenantName}</strong> wants to book your room.</p>
        <p>📍 <strong>${data.listingTitle}</strong><br>
        📅 Move-in: ${data.moveIn || 'Flexible'}<br>
        💰 Weekly rent: AU$${data.weeklyRent}/wk</p>
        ${data.message ? `<p>Message: <em>"${data.message}"</em></p>` : ''}
        <a href="${siteUrl}" style="display:inline-block;background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700;margin-top:16px">Review Request →</a>
        <p style="color:#888;font-size:12px;margin-top:24px">RoomiStay · Gold Coast, Australia</p>
      </div>`
    }),
    booking_pending_tenant: (data) => ({
      to: data.tenantEmail,
      subject: `Your booking request is being reviewed ⏳`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#1C2810">Request received! ⏳</h2>
        <p>Your booking request for <strong>${data.listingTitle}</strong> has been sent to the landlord.</p>
        <p>📅 Move-in: ${data.moveIn || 'Flexible'}<br>💰 Weekly rent: AU$${data.weeklyRent}/wk</p>
        <p style="color:#888">The landlord has up to 24h to review your request. You'll receive an email once approved.</p>
        <a href="${siteUrl}" style="display:inline-block;background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700;margin-top:16px">View My Bookings →</a>
        <p style="color:#888;font-size:12px;margin-top:24px">RoomiStay · Gold Coast, Australia</p>
      </div>`
    }),
    booking_approved: (data) => ({
      to: data.tenantEmail,
      subject: `Your room request was approved! 🎉`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#1C2810">You're in! 🎉</h2>
        <p>Your booking for <strong>${data.listingTitle}</strong> has been approved.</p>
        <p>📅 Move-in: ${data.moveIn || 'TBC'}<br>💰 Bond held in escrow: AU$${data.bond}</p>
        <a href="${siteUrl}" style="display:inline-block;background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700;margin-top:16px">View Details →</a>
        <p style="color:#888;font-size:12px;margin-top:24px">RoomiStay · Gold Coast, Australia</p>
      </div>`
    }),
    new_message: (data) => ({
      to: data.recipientEmail,
      subject: `New message from ${data.senderName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#1C2810">New message 💬</h2>
        <p><strong>${data.senderName}</strong> sent you a message:</p>
        <blockquote style="border-left:3px solid #C8F135;padding:8px 16px;background:#f5f5f0;margin:16px 0">${data.message}</blockquote>
        <a href="${siteUrl}" style="display:inline-block;background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700">Reply →</a>
        <p style="color:#888;font-size:12px;margin-top:24px">RoomiStay · Gold Coast, Australia</p>
      </div>`
    }),
  };

  try {
    let emailData = { ...req.body };

    // If bookingId provided, fetch booking details from Supabase
    if (bookingId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/bookings?id=eq.${bookingId}&select=*,listings(title,price_weekly),tenant:profiles!tenant_id(full_name,email),landlord:profiles!landlord_id(full_name,email)`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          }
        }
      );
      const bookings = await sbRes.json();
      if (bookings && bookings[0]) {
        const b = bookings[0];
        emailData.listingTitle = b.listings?.title || 'Room';
        emailData.weeklyRent = b.listings?.price_weekly || b.total_rent || 0;
        emailData.tenantName = b.tenant?.full_name || 'Tenant';
        emailData.tenantEmail = b.tenant?.email;
        emailData.landlordEmail = b.landlord?.email;
        emailData.moveIn = b.move_in_date ? new Date(b.move_in_date).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'}) : null;
        emailData.bond = b.bond_amount || 0;
        emailData.message = b.tenant_message || '';
      }
    }

    // Fallback to direct to field if provided
    const template = type && templates[type] ? templates[type](emailData) : { to: req.body.to, subject: req.body.subject, html: req.body.html };

    if (!template.to) return res.status(400).json({ error: 'No recipient email found' });

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'RoomiStay <hello@roomiestay.com>',
        to: [template.to],
        subject: template.subject,
        html: template.html,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || JSON.stringify(data));

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: err.message });
  }
};
