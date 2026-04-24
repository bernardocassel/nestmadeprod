// Vercel API - Support Chat via Claude
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { messages } = req.body;
  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(200).json({ reply: 'Thanks for your message! Email us at support@roomiestay.com for help.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: 'You are a helpful support agent for RoomiStay, a student room rental platform in Gold Coast, Australia. Keep responses short (2-3 sentences), friendly, and helpful. Key info: escrow protects payments until check-in, 5% platform fee, landlords get paid 24h after tenant check-in confirmation. For complex issues, suggest emailing support@roomiestay.com.',
        messages: messages,
      })
    });

    const data = await response.json();
    const reply = data.content && data.content[0] ? data.content[0].text : 'Thanks for your message! Our team will get back to you soon.';
    return res.status(200).json({ reply });
  } catch (e) {
    console.error('Support chat error:', e);
    return res.status(200).json({ reply: 'Thanks for your message! Email us at support@roomiestay.com for help.' });
  }
};
