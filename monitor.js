const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');

const NS_URL       = process.env.NS_URL;
const NS_SECRET    = process.env.NS_SECRET;
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
const WINDOW_MIN   = parseInt(process.env.BOLUS_WINDOW_MINUTES  || '25');
const WARN_MIN     = parseInt(process.env.WARN_AFTER_MINUTES    || '10');
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '08:15,13:00,20:30').split(',');

function nsHeaders() {
  const hash = crypto.createHash('sha1').update(NS_SECRET).digest('hex');
  return { 'api-secret': hash, 'Content-Type': 'application/json' };
}

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram error:', e.message); }
}

async function getRecentBoluses(minutesBack) {
  try {
    const since = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
    const url = `${NS_URL}/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]=${since}&count=5`;
    const res = await fetch(url, { headers: nsHeaders() });
    return await res.json();
  } catch (e) { return []; }
}

async function getLatestGlucose() {
  try {
    const res = await fetch(`${NS_URL}/api/v1/entries.json?count=1`, { headers: nsHeaders() });
    const data = await res.json();
    return data[0] || null;
  } catch (e) { return null; }
}

function trendEmoji(direction) {
  const map = {
    'DoubleUp':'⬆️⬆️','SingleUp':'⬆️','FortyFiveUp':'↗️',
    'Flat':'➡️',
    'FortyFiveDown':'↘️','SingleDown':'⬇️','DoubleDown':'⬇️⬇️'
  };
  return map[direction] || '➡️';
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
}

const pendingReminders = {};

cron.schedule('* * * * *', async () => {
  const now   = new Date();
  const hh    = String(now.getHours()).padStart(2,'0');
  const mm    = String(now.getMinutes()).padStart(2,'0');
  const timeStr = `${hh}:${mm}`;

  if (REMINDER_TIMES.includes(timeStr) && !pendingReminders[timeStr]) {
    const glucose = await getLatestGlucose();
    const glucoseText = glucose
      ? `\nGlucosa: <b>${glucose.sgv} mg/dL</b> ${trendEmoji(glucose.direction)}`
      : '\n⚠️ Sin datos de glucosa recientes';

    await sendTelegram(
      `⏰ <b>Recordatorio de bolo — ${timeStr}</b>${glucoseText}\n\nVigilando si la bomba registra el bolo...`
    );

    pendingReminders[timeStr] = { triggeredAt: now, warned: false, resolved: false };
    console.log(`Recordatorio disparado: ${timeStr}`);
  }

  for (const [rTime, reminder] of Object.entries(pendingReminders)) {
    if (reminder.resolved) continue;

    const minsSince = (now - reminder.triggeredAt) / 60000;
    const boluses   = await getRecentBoluses(WINDOW_MIN);

    if (boluses.length > 0) {
      const b       = boluses[0];
      const insulin = b.insulin || b.amount || '?';
      const bolusAt = formatTime(b.created_at);

      await sendTelegram(
        `✅ <b>Bolo detectado en la bomba</b>\n` +
        `Insulina: <b>${insulin} U</b> · Hora: ${bolusAt}\n` +
        `(verificado ~${Math.round(minsSince)} min después del aviso)`
      );
      reminder.resolved = true;

    } else if (minsSince >= WARN_MIN && !reminder.warned) {
      const glucose = await getLatestGlucose();
      const glucoseText = glucose
        ? `Glucosa actual: ${glucose.sgv} mg/dL ${trendEmoji(glucose.direction)}`
        : 'Sin datos de glucosa.';

      await sendTelegram(
        `⚠️ <b>Sin bolo detectado — ${WARN_MIN} min después del aviso</b>\n` +
        `${glucoseText}\n\n` +
        `La bomba no ha registrado ningún bolo todavía.\n` +
        `¿Habéis podido hablar con Oriol?`
      );
      reminder.warned = true;

    } else if (minsSince >= WINDOW_MIN) {
      reminder.resolved = true;
    }
  }

  for (const [rTime, reminder] of Object.entries(pendingReminders)) {
    if (reminder.resolved && (now - reminder.triggeredAt) > 7200000) {
      delete pendingReminders[rTime];
    }
  }
});

console.log('✅ Monitor de Oriol iniciado');
console.log('Recordatorios:', REMINDER_TIMES.join(', '));
