// RoomiStay - Daily Payment Processor
// Runs every day at 8AM UTC via Vercel Cron
// Rules:
//   - Bond: suggested at booking time, landlord can change timing
//   - First rent: suggested at check-in, landlord can change
//   - Weekly rent: MANDATORY every 7 days, landlord only picks the day of week

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLATFORM_FEE_PCT = 0.05; // 5% to RoomiStay on bond + every weekly rent
const APP_URL = process.env.APP_URL || 'https://roomiestay.com';

module.exports = async (req, res) => {
  // Security: only allow Vercel cron or requests with correct secret
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayStr = new Date().toISOString().split('T')[0];
  console.log(`RoomiStay payment processor running for ${todayStr}`);

  const results = { reminders_sent: 0, charges_scheduled: 0, errors: 0 };

  try {
    // Get all active bookings
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        *,
        listings(title, price_weekly),
        tenant:profiles!tenant_id(full_name, email),
        landlord:profiles!landlord_id(
          full_name, email, stripe_account_id,
          bond_timing, first_rent_timing, rent_cycle, reminder_days
        )
      `)
      .in('status', ['checked_in', 'paid', 'signed', 'approved'])
      .not('move_in_date', 'is', null);

    if (error) throw error;

    for (const booking of bookings || []) {
      try {
        await processBooking(booking, todayStr, results);
      } catch(err) {
        console.error(`Booking ${booking.id} error:`, err.message);
        results.errors++;
      }
    }

    return res.status(200).json({ date: todayStr, ...results });

  } catch(err) {
    console.error('Processor error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function processBooking(booking, todayStr, results) {
  const landlord = booking.landlord || {};
  const tenant = booking.tenant || {};
  const listing = booking.listings || {};

  const today = new Date(todayStr);
  const moveIn = new Date(booking.move_in_date);
  const daysUntilMoveIn = Math.round((moveIn - today) / 86400000);

  const weeklyRent = listing.price_weekly || 0;
  const bondAmount = booking.bond_amount || 0;
  const reminderDays = landlord.reminder_days ?? 3;

  // ── BOND ──
  // Suggested: pay at booking time
  // Landlord can set: checkin / 7_before / 14_before / 30_before / on_approval
  if (!booking.bond_paid_at && bondAmount > 0) {
    const bondDue = getBondDueDays(landlord.bond_timing || 'checkin');

    if (daysUntilMoveIn === bondDue + reminderDays) {
      await sendReminder(tenant.email, 'bond', {
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: bondAmount,
        dueDate: addDays(moveIn, -bondDue),
      });
      results.reminders_sent++;
    }

    if (daysUntilMoveIn <= bondDue) {
      await scheduleCharge(booking, 'bond', bondAmount, landlord.stripe_account_id);
      await supabase.from('bookings').update({ bond_paid_at: todayStr }).eq('id', booking.id);
      results.charges_scheduled++;
    }
  }

  // ── FIRST RENT ──
  // Suggested: pay at check-in
  // Landlord can set: checkin / 7_before / 14_before / on_approval
  if (!booking.first_rent_paid_at && weeklyRent > 0) {
    const firstRentDue = getFirstRentDueDays(landlord.first_rent_timing || 'checkin');

    if (daysUntilMoveIn === firstRentDue + reminderDays) {
      await sendReminder(tenant.email, 'first_rent', {
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: weeklyRent,
        dueDate: addDays(moveIn, -firstRentDue),
        week: 'Week 1',
      });
      results.reminders_sent++;
    }

    if (daysUntilMoveIn <= firstRentDue) {
      await scheduleCharge(booking, 'first_rent', weeklyRent, landlord.stripe_account_id);
      await supabase.from('bookings').update({
        first_rent_paid_at: todayStr,
        last_rent_paid_date: todayStr,
      }).eq('id', booking.id);
      results.charges_scheduled++;
    }
  }

  // ── WEEKLY RENT (MANDATORY - every 7 days) ──
  // Landlord only controls which DAY of week (mon/tue/.../checkin_day)
  if (booking.first_rent_paid_at && booking.last_rent_paid_date && weeklyRent > 0) {
    const lastPaid = new Date(booking.last_rent_paid_date);
    const nextDue = addDays(lastPaid, 7); // Always 7 days - mandatory
    const daysUntilNextRent = Math.round((nextDue - today) / 86400000);
    const weekNum = Math.floor((today - moveIn) / (7 * 86400000)) + 2;

    if (daysUntilNextRent === reminderDays) {
      await sendReminder(tenant.email, 'weekly_rent', {
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: weeklyRent,
        dueDate: nextDue,
        week: `Week ${weekNum}`,
      });
      results.reminders_sent++;
    }

    if (daysUntilNextRent <= 0) {
      await scheduleCharge(booking, 'weekly_rent', weeklyRent, landlord.stripe_account_id);
      await supabase.from('bookings').update({ last_rent_paid_date: todayStr }).eq('id', booking.id);
      results.charges_scheduled++;
    }
  }
}

async function scheduleCharge(booking, type, amount, landlordStripeId) {
  const platformFee = Math.round(amount * PLATFORM_FEE_PCT * 100) / 100;
  const landlordAmount = amount - platformFee;

  await supabase.from('payment_schedules').insert({
    booking_id: booking.id,
    tenant_id: booking.tenant_id,
    landlord_id: booking.landlord_id,
    charge_type: type,
    amount: amount,
    platform_fee: platformFee,
    landlord_amount: landlordAmount,
    status: 'pending',
    due_date: new Date().toISOString().split('T')[0],
  });

  console.log(`Scheduled ${type}: AU$${amount} (landlord AU$${landlordAmount} / platform AU$${platformFee})`);
}

async function sendReminder(email, type, data) {
  if (!email || !process.env.RESEND_API_KEY) return;

  const subjects = {
    bond: `Bond payment due — ${data.listingTitle}`,
    first_rent: `First rent payment due — ${data.listingTitle}`,
    weekly_rent: `Rent payment due (${data.week}) — ${data.listingTitle}`,
  };

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#C8F135;padding:20px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="margin:0;color:#000">${type === 'bond' ? '🔒 Bond' : '💰 Rent'} Payment Reminder</h2>
      </div>
      <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
        <p>Hi <strong>${data.tenantName}</strong>,</p>
        <p>Your ${type === 'bond' ? 'bond' : `rent payment (${data.week})`} of <strong>AU$${data.amount}</strong> for <strong>${data.listingTitle}</strong> is due on <strong>${formatDate(data.dueDate)}</strong>.</p>
        <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #e0e0d8;margin:16px 0">
          <p style="margin:0"><strong>Amount:</strong> AU$${data.amount}</p>
          <p style="margin:4px 0"><strong>Due:</strong> ${formatDate(data.dueDate)}</p>
          <p style="margin:4px 0"><strong>Property:</strong> ${data.listingTitle}</p>
          <p style="margin:4px 0"><strong>Landlord:</strong> ${data.landlordName}</p>
        </div>
        ${type === 'bond' ? '<p style="font-size:.85rem;color:#666">Your bond is held securely in escrow and returned at check-out minus any agreed damages.</p>' : '<p style="font-size:.85rem;color:#666">Weekly payments are processed automatically every 7 days.</p>'}
        <a href="${APP_URL}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">View My Booking →</a>
        <p style="font-size:.75rem;color:#999;margin-top:20px">RoomiStay · Gold Coast, Australia</p>
      </div>
    </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'RoomiStay Payments <payments@roomiestay.com>',
      to: [email],
      subject: subjects[type],
      html,
    }),
  });
}

function getBondDueDays(timing) {
  return { checkin: 0, '7_before': 7, '14_before': 14, '30_before': 30, on_approval: 999 }[timing] || 0;
}

function getFirstRentDueDays(timing) {
  return { checkin: 0, '7_before': 7, '14_before': 14, on_approval: 999 }[timing] || 0;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'
  });
}
