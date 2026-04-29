// NestMate/RoomiStay - Scheduled Payment Processor
// Called daily by a cron job (Vercel Cron or external scheduler)
// Handles: bond collection, weekly rent, payment reminders

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PLATFORM_FEE_PCT = 0.05; // 5% to RoomiStay
const APP_URL = process.env.APP_URL || 'https://nestmadeprod.vercel.app';

module.exports = async (req, res) => {
  // Verify cron secret to prevent unauthorized calls
  const cronSecret = req.headers['x-cron-secret'];
  if (cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  console.log(`Processing payments for ${todayStr}`);

  const results = { reminders: 0, charges: 0, errors: 0 };

  try {
    // ── 1. Get all active bookings with payment schedules ──
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select(`
        *,
        listings(title, price_weekly, landlord_id),
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
        await processBookingPayments(booking, todayStr, results);
      } catch (err) {
        console.error(`Error processing booking ${booking.id}:`, err.message);
        results.errors++;
      }
    }

    return res.status(200).json({
      date: todayStr,
      processed: bookings?.length || 0,
      ...results,
    });

  } catch (err) {
    console.error('Payment processor error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function processBookingPayments(booking, todayStr, results) {
  const landlord = booking.landlord || {};
  const tenant = booking.tenant || {};
  const listing = booking.listings || {};

  const moveInDate = new Date(booking.move_in_date);
  const today = new Date(todayStr);
  const daysUntilMoveIn = Math.round((moveInDate - today) / (1000 * 60 * 60 * 24));

  const bondTiming = landlord.bond_timing || 'checkin';
  const firstRentTiming = landlord.first_rent_timing || 'checkin';
  const rentCycle = landlord.rent_cycle || 'weekly';
  const reminderDays = landlord.reminder_days ?? 3;

  const weeklyRent = listing.price_weekly || booking.total_rent || 0;
  const bondAmount = booking.bond_amount || 0;

  // ── BOND COLLECTION ──
  if (!booking.bond_paid_at) {
    const bondDueDays = getBondDueDays(bondTiming);
    
    // Send reminder
    if (daysUntilMoveIn === bondDueDays + reminderDays) {
      await sendPaymentReminder(tenant.email, {
        type: 'bond_reminder',
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: bondAmount,
        dueDate: addDays(moveInDate, -bondDueDays),
        appUrl: APP_URL,
      });
      results.reminders++;
    }

    // Charge bond
    if (daysUntilMoveIn === bondDueDays || (bondTiming === 'checkin' && daysUntilMoveIn === 0)) {
      if (booking.stripe_payment_intent_id && landlord.stripe_account_id) {
        await chargeTenant(booking, bondAmount, 'bond', landlord.stripe_account_id);
        await supabase.from('bookings').update({ bond_paid_at: todayStr }).eq('id', booking.id);
        results.charges++;
      }
    }
  }

  // ── FIRST RENT PAYMENT ──
  if (!booking.first_rent_paid_at) {
    const firstRentDueDays = getFirstRentDueDays(firstRentTiming);

    // Send reminder
    if (daysUntilMoveIn === firstRentDueDays + reminderDays) {
      await sendPaymentReminder(tenant.email, {
        type: 'rent_reminder',
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: weeklyRent,
        dueDate: addDays(moveInDate, -firstRentDueDays),
        period: 'Week 1',
        appUrl: APP_URL,
      });
      results.reminders++;
    }

    // Charge first rent
    if (daysUntilMoveIn <= firstRentDueDays) {
      if (landlord.stripe_account_id) {
        await chargeTenant(booking, weeklyRent, 'first_rent', landlord.stripe_account_id);
        await supabase.from('bookings')
          .update({ first_rent_paid_at: todayStr, last_rent_paid_date: todayStr })
          .eq('id', booking.id);
        results.charges++;
      }
    }
  }

  // ── RECURRING RENT ──
  if (booking.first_rent_paid_at && booking.last_rent_paid_date) {
    const lastPaid = new Date(booking.last_rent_paid_date);
    const cycleDays = rentCycle === 'fortnightly' ? 14 : rentCycle === 'monthly' ? 30 : 7;
    const nextDueDate = addDays(lastPaid, cycleDays);
    const daysUntilNextRent = Math.round((nextDueDate - today) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.floor((today - moveInDate) / (cycleDays * 1000 * 60 * 60 * 24)) + 2;

    // Send reminder
    if (daysUntilNextRent === reminderDays) {
      await sendPaymentReminder(tenant.email, {
        type: 'rent_reminder',
        tenantName: tenant.full_name,
        landlordName: landlord.full_name,
        listingTitle: listing.title,
        amount: weeklyRent,
        dueDate: nextDueDate,
        period: 'Week ' + weekNumber,
        appUrl: APP_URL,
      });
      results.reminders++;
    }

    // Charge recurring rent
    if (daysUntilNextRent <= 0 && landlord.stripe_account_id) {
      await chargeTenant(booking, weeklyRent, 'weekly_rent', landlord.stripe_account_id);
      await supabase.from('bookings')
        .update({ last_rent_paid_date: todayStr })
        .eq('id', booking.id);
      results.charges++;
    }
  }
}

async function chargeTenant(booking, amount, chargeType, landlordStripeId) {
  const amountCents = Math.round(amount * 100);
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_PCT);

  // Create a charge (requires saved payment method - implement in next phase)
  // For now, log the charge intent
  await supabase.from('payment_schedules').insert({
    booking_id: booking.id,
    tenant_id: booking.tenant_id,
    landlord_id: booking.landlord_id,
    charge_type: chargeType,
    amount: amount,
    platform_fee: amount * PLATFORM_FEE_PCT,
    landlord_amount: amount * 0.95,
    status: 'pending',
    due_date: new Date().toISOString().split('T')[0],
  });

  console.log(`Charge scheduled: ${chargeType} $${amount} for booking ${booking.id}`);
}

async function sendPaymentReminder(email, data) {
  if (!email || !process.env.RESEND_API_KEY) return;

  const templates = {
    bond_reminder: {
      subject: `Bond payment due soon — ${data.listingTitle}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#C8F135;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="margin:0;color:#000">🔔 Bond Payment Reminder</h2>
        </div>
        <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
          <p>Hi <strong>${data.tenantName}</strong>,</p>
          <p>Your bond payment of <strong>AU$${data.amount}</strong> for <strong>${data.listingTitle}</strong> is due on <strong>${formatDate(data.dueDate)}</strong>.</p>
          <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #e0e0d8;margin:16px 0">
            <p style="margin:0"><strong>Amount:</strong> AU$${data.amount}</p>
            <p style="margin:4px 0"><strong>Due date:</strong> ${formatDate(data.dueDate)}</p>
            <p style="margin:4px 0"><strong>Property:</strong> ${data.listingTitle}</p>
          </div>
          <p style="font-size:.85rem;color:#666">Your bond is held securely in escrow and returned when you check out (minus any damages agreed with your landlord).</p>
          <a href="${data.appUrl}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">View Booking →</a>
        </div>
      </div>`,
    },
    rent_reminder: {
      subject: `Rent payment due soon — ${data.listingTitle} (${data.period})`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#C8F135;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="margin:0;color:#000">💰 Rent Payment Reminder</h2>
        </div>
        <div style="padding:24px;background:#f9f9f6;border-radius:0 0 12px 12px">
          <p>Hi <strong>${data.tenantName}</strong>,</p>
          <p>Your rent payment (${data.period}) of <strong>AU$${data.amount}</strong> for <strong>${data.listingTitle}</strong> is due on <strong>${formatDate(data.dueDate)}</strong>.</p>
          <div style="background:#fff;padding:16px;border-radius:10px;border:1px solid #e0e0d8;margin:16px 0">
            <p style="margin:0"><strong>Amount:</strong> AU$${data.amount}/week</p>
            <p style="margin:4px 0"><strong>Due date:</strong> ${formatDate(data.dueDate)}</p>
            <p style="margin:4px 0"><strong>Period:</strong> ${data.period}</p>
            <p style="margin:4px 0"><strong>Property:</strong> ${data.listingTitle}</p>
          </div>
          <p style="font-size:.85rem;color:#666">Payment will be processed automatically. Contact your landlord ${data.landlordName} if you have any questions.</p>
          <a href="${data.appUrl}" style="display:inline-block;background:#C8F135;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">View Booking →</a>
        </div>
      </div>`,
    },
  };

  const tmpl = templates[data.type];
  if (!tmpl) return;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'RoomiStay <payments@roomiestay.com>',
      to: [email],
      subject: tmpl.subject,
      html: tmpl.html,
    }),
  });
}

function getBondDueDays(timing) {
  const map = { 'checkin': 0, '7_before': 7, '14_before': 14, '30_before': 30, 'on_approval': 999 };
  return map[timing] || 0;
}

function getFirstRentDueDays(timing) {
  const map = { 'checkin': 0, '7_before': 7, '14_before': 14, 'on_approval': 999 };
  return map[timing] || 0;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
