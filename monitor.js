const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');
const oriol = require('./oriol.json');

const NS_URL         = process.env.NS_URL;
const NS_SECRET      = process.env.NS_SECRET;
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const WINDOW_MIN     = parseInt(process.env.BOLUS_WINDOW_MINUTES || '25');
const WARN_MIN       = parseInt(process.env.WARN_AFTER_MINUTES || '5');
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '08:15,13:00,20:30').split(',');

const points = {};
let updateOffset = 0;

const footballMessages = [
  '⚽ ¡Buen pase! Bolo confirmado a tiempo.',
  '🏆 ¡Golazo! Llevas una racha perfecta.',
  '🎯 ¡Al palo! Bolo registrado.',
  '🦁 ¡Capitán del equipo!',
  '🔥 ¡Estás en racha! Sigue así.',
  '🧤 ¡Porterazo! Te has gestionado solo.',
];

// ─── CONTEXTO DE ORIOL ────────────────────────────────────────────────

function isWeekend() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}

function getDayName() {
  const days = ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];
  return days[new Date().getDay()];
}

function getTodayMenu() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  return oriol.menu.find(m => m.fecha === today) || null;
}

function getActiveProfile(hour) {
  const profile = isWeekend() ? oriol.perfiles_bomba.finde : oriol.perfiles_bomba.semana;
  return profile.find(p => {
    const s = parseInt(p.hora_inicio);
    const e = parseInt(p.hora_fin);
    return e === 24 ? hour >= s : hour >= s && hour < e;
  }) || profile[0];
}

function getTodayActivities() {
  return oriol.horario.filter(h => h.dia === getDayName());
}

function getActivityContext(hour) {
  const acts = getTodayActivities();
  const physical = ['educacion_fisica','basquet','piscina','futbol'];
  
  const upcoming = acts.find(a => {
    const h = parseInt(a.inicio);
    return physical.includes(a.actividad) && h > hour && h <= hour + 3;
  });
  
  const recent = acts.find(a => {
    const h = parseInt(a.fin);
    return physical.includes(a.actividad) && h >= hour - 2 && h <= hour;
  });
  
  return { upcoming, recent };
}

function calculateBolus(glucoseMgdl, trend, carbsG, iobUnits, hour) {
  if (!glucoseMgdl) return null;
  
  const profile  = getActiveProfile(hour);
  const activity = getActivityContext(hour);
  const target   = oriol.config.objetivo_glucosa_target || 110;
  const FSI      = profile.FSI;
  const ratio    = profile.ratio_IC;
  const warnings = [];

  if (glucoseMgdl < 70) {
    return { total: 0, warnings: ['🔴 Glucosa baja — NO administrar insulina. Tratar primero la hipoglucemia.'], blocked: true };
  }

  let correction = Math.max(0, (glucoseMgdl - target) / FSI);
  let meal       = carbsG > 0 ? carbsG / ratio : 0;

  const trendMap = { DoubleUp: 0.5, SingleUp: 0.25, FortyFiveUp: 0.1, Flat: 0, FortyFiveDown: -0.1, SingleDown: -0.25, DoubleDown: -0.5 };
  const trendAdj = trendMap[trend] || 0;

  let actAdj  = 0;
  let actNote = '';
  if (activity.upcoming) {
    actAdj  = -0.3;
    actNote = `⚽ ${activity.upcoming.actividad} a las ${activity.upcoming.inicio} — bolo reducido`;
  } else if (activity.recent) {
    actAdj  = -0.25;
    actNote = `🏃 ${activity.recent.actividad} reciente — precaución`;
  }

  const iobDiscount = Math.min(iobUnits || 0, correction);
  let total = meal + correction - iobDiscount + trendAdj + actAdj;
  total = Math.max(0, Math.round(total * 2) / 2);

  if (glucoseMgdl < 90)      warnings.push('⚠️ Glucosa en límite bajo — revisar antes de bolear');
  if ((iobUnits || 0) > 2)   warnings.push('⚠️ IOB elevada — riesgo de apilamiento');
  if (total === 0 && carbsG > 0) warnings.push('ℹ️ El cálculo da 0U — la IOB y el contexto cubren la comida');

  return {
    total,
    meal:       Math.round(meal * 100) / 100,
    correction: Math.round(correction * 100) / 100,
    iobDiscount:Math.round(iobDiscount * 100) / 100,
    trendAdj,
    actAdj,
    actNote,
    ratio,
    FSI,
    target,
    warnings,
    blocked: false
  };
}

function buildReminderText(timeStr, glucose, bolusSuggestion, menu, activities) {
  const glucoseText = glucose
    ? `Glucosa: <b>${glucose.sgv} mg/dL</b> ${trendEmoji(glucose.direction)}`
    : '⚠️ Sin datos de glucosa recientes';

  const menuText = menu
    ? `🍽️ Menú hoy: ${menu.descripcion}\n   HC estimados: ~${menu.HC_g}g`
    : '🍽️ Sin menú registrado para hoy';

  let bolusText = '';
  if (bolusSuggestion) {
    if (bolusSuggestion.blocked) {
      bolusText = `\n🔴 <b>NO BOLEAR</b> — ${bolusSuggestion.warnings[0]}`;
    } else {
      bolusText = `\n💉 Bolo sugerido: <b>${bolusSuggestion.total} U</b>`;
      if (bolusSuggestion.actNote) bolusText += `\n   ${bolusSuggestion.actNote}`;
      if (bolusSuggestion.warnings.length > 0) {
        bolusText += '\n' + bolusSuggestion.warnings.map(w => `   ${w}`).join('\n');
      }
      bolusText += `\n\n<i>Ver razonamiento: comida ${bolusSuggestion.meal}U + corrección ${bolusSuggestion.correction}U - IOB ${bolusSuggestion.iobDiscount}U</i>`;
    }
  }

  const physicalToday = activities.filter(a =>
    ['educacion_fisica','basquet','piscina','futbol'].includes(a.actividad)
  );
  const actText = physicalToday.length > 0
    ? `🏃 Actividad hoy: ${physicalToday.map(a => `${a.actividad} ${a.inicio}`).join(', ')}`
    : '';

  return `⚽ <b>LEO — Bolo ${timeStr}</b>\n${glucoseText}\n\n${menuText}${bolusText}${actText ? '\n' + actText : ''}\n\n¿Te has puesto el bolo, Oriol?`;
}

// ─── TELEGRAM ────────────────────────────────────────────────────────

function nsHeaders() {
  const hash = crypto.createHash('sha1').update(NS_SECRET).digest('hex');
  return { 'api-secret': hash, 'Content-Type': 'application/json' };
}

async function sendTelegram(text, replyMarkup = null) {
  try {
    const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.result?.message_id;
  } catch (e) { console.error('Telegram error:', e.message); return null; }
}

async function editMessage(messageId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

async function answerCallback(id, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text, show_alert: false })
    });
  } catch (e) {}
}

async function getUpdates() {
  try {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${updateOffset}&timeout=1`);
    const data = await res.json();
    return data.result || [];
  } catch (e) { return []; }
}

async function getRecentBoluses(minutesBack) {
  try {
    const since = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
    const url   = `${NS_URL}/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]=${since}&count=5`;
    const res   = await fetch(url, { headers: nsHeaders() });
    return await res.json();
  } catch (e) { return []; }
}

async function getLatestGlucose() {
  try {
    const res  = await fetch(`${NS_URL}/api/v1/entries.json?count=1`, { headers: nsHeaders() });
    const data = await res.json();
    return data[0] || null;
  } catch (e) { return null; }
}

function trendEmoji(d) {
  return { DoubleUp:'⬆️⬆️', SingleUp:'⬆️', FortyFiveUp:'↗️', Flat:'➡️',
           FortyFiveDown:'↘️', SingleDown:'⬇️', DoubleDown:'⬇️⬇️' }[d] || '➡️';
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

// ─── POLLING BOTONES ─────────────────────────────────────────────────

const pendingReminders = {};

setInterval(async () => {
  const updates = await getUpdates();
  for (const update of updates) {
    updateOffset = Math.max(updateOffset, update.update_id + 1);

    if (update.callback_query) {
      const cb      = update.callback_query;
      const userId  = cb.from.id;
      const name    = cb.from.first_name || 'Oriol';
      const data    = cb.data;
      const msgId   = cb.message?.message_id;
      const reminder = Object.values(pendingReminders).find(r => !r.resolved);

      if (data === 'confirmed_yes') {
        await answerCallback(cb.id, '✅ ¡Anotado!');
        const total = addPoints(userId, name, 10);
        if (reminder) reminder.resolved = true;
        await editMessage(msgId,
          `${randomFootball()}\n\n<b>${name}</b> confirmó el bolo ✅\n🏆 +10 puntos · Total: ${total} pts`
        );

      } else if (data === 'confirmed_now') {
        await answerCallback(cb.id, '⏳ ¡Venga, tú puedes!');
        await editMessage(msgId, `⏳ <b>${name}</b> se lo está poniendo ahora...`);

      } else if (data === 'not_eating') {
        await answerCallback(cb.id, '🍽️ Anotado');
        if (reminder) reminder.resolved = true;
        await editMessage(msgId, `🍽️ <b>${name}</b>: no come todavía. Recordatorio cancelado.`);

      } else if (data === 'need_help') {
        await answerCallback(cb.id, '🆘 Avisando...');
        if (reminder) reminder.resolved = true;
        await editMessage(msgId,
          `🆘 <b>PADRES — ATENCIÓN</b>\n\n<b>${name}</b> necesita ayuda ahora.\n📞 Llamadle inmediatamente.`
        );

      } else if (data === 'show_points') {
        await answerCallback(cb.id, '🏆 Marcador');
        let msg = '🏆 <b>Marcador LEO</b>\n\n';
        if (Object.keys(points).length === 0) {
          msg += '¡Aún no hay puntos! Confirma el primer bolo.';
        } else {
          for (const p of Object.values(points)) msg += `⚽ ${p.name}: <b>${p.total} pts</b>\n`;
        }
        await sendTelegram(msg);
      }
    }

    if (update.message?.text === '/puntos') {
      let msg = '🏆 <b>Marcador LEO</b>\n\n';
      if (Object.keys(points).length === 0) {
        msg += '¡Confirma el primer bolo para empezar!';
      } else {
        for (const p of Object.values(points)) msg += `⚽ ${p.name}: <b>${p.total} pts</b>\n`;
      }
      await sendTelegram(msg);
    }
  }
}, 3000);

// ─── RECORDATORIOS ───────────────────────────────────────────────────

cron.schedule('* * * * *', async () => {
  const now     = new Date();
  const hour    = now.getHours();
  const timeStr = `${String(hour).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  if (REMINDER_TIMES.includes(timeStr) && !pendingReminders[timeStr]) {
    const glucose    = await getLatestGlucose();
    const menu       = getTodayMenu();
    const activities = getTodayActivities();
    const carbsG     = menu?.HC_g || 0;
    const bolus      = glucose ? calculateBolus(glucose.sgv, glucose.direction, carbsG, 0, hour) : null;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Ya me lo puse',  callback_data: 'confirmed_yes' },
          { text: '⏳ Ahora mismo',    callback_data: 'confirmed_now' }
        ],
        [
          { text: '🍽️ No como aún',   callback_data: 'not_eating' },
          { text: '🆘 Necesito ayuda', callback_data: 'need_help' }
        ],
        [{ text: '🏆 Ver puntos', callback_data: 'show_points' }]
      ]
    };

    const text  = buildReminderText(timeStr, glucose, bolus, menu, activities);
    const msgId = await sendTelegram(text, keyboard);

    pendingReminders[timeStr] = { triggeredAt: now, warned: false, resolved: false, messageId: msgId };
    console.log(`Recordatorio: ${timeStr} | HC: ${carbsG}g | Bolo sugerido: ${bolus?.total || '?'}U`);
  }

  for (const [rTime, reminder] of Object.entries(pendingReminders)) {
    if (reminder.resolved) continue;
    const minsSince = (now - reminder.triggeredAt) / 60000;
    const boluses   = await getRecentBoluses(WINDOW_MIN);

    if (boluses.length > 0) {
      const b = boluses[0];
      await sendTelegram(
        `🔍 <b>Bolo detectado en la bomba</b>\n${b.insulin || b.amount || '?'}U a las ${formatTime(b.created_at)}`
      );
      reminder.resolved = true;
    } else if (minsSince >= WARN_MIN && !reminder.warned) {
      const g = await getLatestGlucose();
      await sendTelegram(
        `⚠️ <b>Sin bolo después de ${WARN_MIN} min</b>\n` +
        `${g ? `Glucosa: ${g.sgv} mg/dL ${trendEmoji(g.direction)}` : ''}\n\n` +
        `Padres: ¿habéis podido confirmar con Oriol?`
      );
      reminder.warned = true;
    } else if (minsSince >= WINDOW_MIN) {
      reminder.resolved = true;
    }
  }

  for (const [rTime, reminder] of Object.entries(pendingReminders)) {
    if (reminder.resolved && (now - reminder.triggeredAt) > 7200000) delete pendingReminders[rTime];
  }
});

console.log('✅ LEO activo con menú, perfiles y cálculo de bolo');
console.log('Perfil activo:', isWeekend() ? 'FINDE' : 'SEMANA');
console.log('Recordatorios:', REMINDER_TIMES.join(', '));
