// Vercel Edge Function - Email via Resend
// Get free API key at: https://resend.com

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { to, subject, html, type } = req.body;

  // Email templates
  const templates = {
    booking_received: (data) => ({
      subject: `New booking request for ${data.listingTitle}`,
      html: `<h2>New Booking Request! 🏠</h2>
        <p><strong>${data.tenantName}</strong> wants to book your room.</p>
        <p>📍 ${data.listingTitle}<br>
        📅 Move-in: ${data.moveIn}<br>
        💰 Total: AU$${data.total}</p>
        <p>Message: "${data.message}"</p>
        <a href="${data.appUrl}/s-landlord" style="background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700">Review Request →</a>`
    }),
    booking_approved: (data) => ({
      subject: `Your room request was approved! 🎉`,
      html: `<h2>You're in! 🎉</h2>
        <p>Your booking for <strong>${data.listingTitle}</strong> has been approved.</p>
        <p>📅 Move-in: ${data.moveIn}<br>💰 Bond held in escrow: AU$${data.bond}</p>
        <a href="${data.appUrl}" style="background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700">View Details →</a>`
    }),
    new_message: (data) => ({
      subject: `New message from ${data.senderName}`,
      html: `<h2>New message 💬</h2>
        <p><strong>${data.senderName}</strong> sent you a message:</p>
        <blockquote style="border-left:3px solid #C8F135;padding:8px 16px;background:#f5f5f0">${data.message}</blockquote>
        <a href="${data.appUrl}" style="background:#C8F135;padding:12px 24px;border-radius:8px;text-decoration:none;color:#000;font-weight:700">Reply →</a>`
    }),
  };

  try {
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) return res.status(500).json({ error: 'Resend API key not configured' });

    const template = type && templates[type] ? templates[type](req.body) : { subject, html };

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'NestMate <hello@nestmate.com.au>',
        to: [to],
        subject: template.subject,
        html: template.html,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Email failed');
    
    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: err.message });
  }
};
