const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');

const NS_URL       = process.env.NS_URL;
const NS_SECRET    = process.env.NS_SECRET;
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
const WINDOW_MIN   = parseInt(process.env.BOLUS_WINDOW_MINUTES || '25');
const WARN_MIN     = parseInt(process.env.WARN_AFTER_MINUTES || '5');
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '08:15,13:00,20:30').split(',');

const points = {};
let updateOffset = 0;

const footballMessages = [
  '⚽ ¡Buen pase! Bolo confirmado a tiempo.',
  '🏆 ¡Golazo! Llevas una racha perfecta.',
  '🎯 ¡Al palo! Bolo registrado.',
  '🦁 ¡Capitán del equipo! Otra confirmación perfecta.',
  '🔥 ¡Estás en racha! Sigue así.',
  '🧤 ¡Porterazo! Te has gestionado solo.',
];

function nsHeaders() {
  const hash = crypto.createHash('sha1').update(NS_SECRET).digest('hex');
  return { 'api-secret': hash, 'Content-Type': 'application/json' };
}

async function sendTelegram(text, replyMarkup = null) {
  try {
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.result?.message_id;
  } catch (e) { console.error('Telegram error:', e.message); return null; }
}

async function editMessage(messageId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Edit error:', e.message); }
}

async function answerCallback(id, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text, show_alert: false })
    });
  } catch (e) {}
}

async function getUpdates() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${updateOffset}&timeout=1`);
    const data = await res.json();
    return data.result || [];
  } catch (e) { return []; }
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

function trendEmoji(d) {
  return {'DoubleUp':'⬆️⬆️','SingleUp':'⬆️','FortyFiveUp':'↗️','Flat':'➡️','FortyFiveDown':'↘️','SingleDown':'⬇️','DoubleDown':'⬇️⬇️'}[d] || '➡️';
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
}

function addPoints(userId, name, amount) {
  if (!points[userId]) points[userId] = { name, total: 0 };
  points[userId].total += amount;
  return points[userId].total;
}

function randomFootball() {
  return footballMessages[Math.floor(Math.random() * footballMessages.length)];
}

const pendingReminders = {};

// Polling botones cada 3 segundos
setInterval(async () => {
  const updates = await getUpdates();
  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);

    if (update.callback_query) {
      const cb = update.callback_query;
      const userId = cb.from.id;
      const name = cb.from.first_name || 'Oriol';
      const data = cb.data;
      const msgId = cb.message?.message_id;
      const reminder = Object.values(pendingReminders).find(r => !r.resolved);

      if (data === 'confirmed_yes') {
        await answerCallback(cb.id, '✅ ¡Anotado!');
        const total = addPoints(userId, name, 10);
        if (reminder) reminder.resolved = true;
        await editMessage(msgId,
          `${randomFootball()}\n\n` +
          `<b>${name}</b> confirmó el bolo ✅\n` +
          `🏆 +10 puntos · Total: ${total} pts`
        );

      } else if (data === 'confirmed_now') {
        await answerCallback(cb.id, '⏳ ¡Venga, tú puedes!');
        await editMessage(msgId,
          `⏳ <b>${name}</b> se lo está poniendo ahora...\n` +
          `Vigilando que llegue a la bomba.`
        );

      } else if (data === 'not_eating') {
        await answerCallback(cb.id, '🍽️ Anotado');
        if (reminder) reminder.resolved = true;
        await editMessage(msgId,
          `🍽️ <b>${name}</b>: no come todavía.\n` +
          `Recordatorio cancelado.`
        );

      } else if (data === 'need_help') {
        await answerCallback(cb.id, '🆘 Avisando...');
        if (reminder) reminder.resolved = true;
        await editMessage(msgId,
          `🆘 <b>PADRES — ATENCIÓN</b>\n\n` +
          `<b>${name}</b> necesita ayuda ahora.\n` +
          `📞 Llamadle inmediatamente.`
        );

      } else if (data === 'show_points') {
        await answerCallback(cb.id, '🏆 Marcador');
        let msg = '🏆 <b>Marcador LEO</b>\n\n';
        if (Object.keys(points).length === 0) {
          msg += '¡Aún no hay puntos! Confirma el primer bolo.';
        } else {
          for (const p of Object.values(points)) {
            msg += `⚽ ${p.name}: <b>${p.total} pts</b>\n`;
          }
        }
        await sendTelegram(msg);
      }
    }

    if (update.message?.text === '/puntos') {
      let msg = '🏆 <b>Marcador LEO</b>\n\n';
      if (Object.keys(points).length === 0) {
        msg += '¡Aún no hay puntos! Confirma el primer bolo.';
      } else {
        for (const p of Object.values(points)) {
          msg += `⚽ ${p.name}: <b>${p.total} pts</b>\n`;
        }
      }
      await sendTelegram(msg);
    }
  }
}, 3000);

// Recordatorios programados
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  if (REMINDER_TIMES.includes(timeStr) && !pendingReminders[timeStr]) {
    const glucose = await getLatestGlucose();
    const glucoseText = glucose
      ? `\nGlucosa: <b>${glucose.sgv} mg/dL</b> ${trendEmoji(glucose.direction)}`
      : '\n⚠️ Sin datos de glucosa recientes';

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Ya me lo puse', callback_data: 'confirmed_yes' },
          { text: '⏳ Ahora mismo', callback_data: 'confirmed_now' }
        ],
        [
          { text: '🍽️ No como aún', callback_data: 'not_eating' },
          { text: '🆘 Necesito ayuda', callback_data: 'need_help' }
        ],
        [
          { text: '🏆 Ver puntos', callback_data: 'show_points' }
        ]
      ]
    };

    const msgId = await sendTelegram(
      `⚽ <b>LEO — Bolo ${timeStr}</b>${glucoseText}\n\n` +
      `¿Te has puesto el bolo, Oriol?`,
      keyboard
    );

    pendingReminders[timeStr] = { triggeredAt: now, warned: false, resolved: false, messageId: msgId };
    console.log(`Recordatorio: ${timeStr}`);
  }

  for (const [rTime, reminder] of Object.entries(pendingReminders)) {
    if (reminder.resolved) continue;
    const minsSince = (now - reminder.triggeredAt) / 60000;
    const boluses = await getRecentBoluses(WINDOW_MIN);

    if (boluses.length > 0) {
      const b = boluses[0];
      await sendTelegram(
        `🔍 <b>Bolo detectado en la bomba</b>\n` +
        `${b.insulin || b.amount || '?'}U a las ${formatTime(b.created_at)}`
      );
      reminder.resolved = true;
    } else if (minsSince >= WARN_MIN && !reminder.warned) {
      const glucose = await getLatestGlucose();
