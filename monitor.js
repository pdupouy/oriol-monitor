const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');
const oriol = require('./oriol.json');

const NS_URL         = process.env.NS_URL;
const NS_SECRET      = process.env.NS_SECRET;
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const WINDOW_MIN     = parseInt(process.env.BOLUS_WINDOW_MINUTES || '25');
const WARN_MIN       = parseInt(process.env.WARN_AFTER_MINUTES   || '5');
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '08:15,11:00,14:00,17:00,20:30').split(',');

const points = {};
let updateOffset = 0;
let waitingForInput = null; // { g, mealType } — espera texto o número

const FOOTBALL = [
  'âš½ Â¡Buen pase! Bolo confirmado a tiempo.',
  'ðŸ† Â¡Golazo! Llevas una racha perfecta.',
  'ðŸŽ¯ Â¡Al palo! Bolo registrado.',
  'ðŸ¦ Â¡CapitÃ¡n del equipo!',
  'ðŸ”¥ Â¡EstÃ¡s en racha! Sigue asÃ­.',
  'ðŸ§¤ Â¡Porterazo! Te has gestionado solo.',
];

// â”€â”€ SEMÃFORO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function evaluateSemaforo(glucose, trend) {
  if (!glucose) return 'desconocido';
  const bajando      = ['FortyFiveDown', 'SingleDown', 'DoubleDown'].includes(trend);
  const bajandoRapido = ['SingleDown', 'DoubleDown'].includes(trend);

  if (glucose < 70)                     return 'rojo';
  if (glucose < 80)                     return 'rojo';
  if (glucose < 90 && bajandoRapido)    return 'rojo';
  if (glucose < 100 && bajando)         return 'amarillo';
  if (glucose < 100)                    return 'amarillo';
  return 'verde';
}

function semaforoEmoji(s) {
  return { verde: 'ðŸŸ¢', amarillo: 'ðŸŸ¡', rojo: 'ðŸ”´', desconocido: 'âšª' }[s] || 'âšª';
}

// â”€â”€ TIPO DE COMIDA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getMealType(timeStr) {
  const h = parseInt(timeStr);
  if (h < 10) return 'desayuno';
  if (h < 12) return 'esmorzar';
  if (h < 16) return 'comida';
  if (h < 19) return 'merienda';
  return 'cena';
}

// â”€â”€ CONTEXTO ORIOL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isWeekend() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}

function getDayName() {
  return ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'][new Date().getDay()];
}

function getTodayMenu() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  return oriol.menu.find(m => m.fecha === today) || null;
}

function getActiveProfile(hour) {
  const p = isWeekend() ? oriol.perfiles_bomba.finde : oriol.perfiles_bomba.semana;
  return p.find(s => {
    const ini = parseInt(s.hora_inicio);
    const fin = parseInt(s.hora_fin);
    return fin === 24 ? hour >= ini : hour >= ini && hour < fin;
  }) || p[0];
}

function getActivityContext(hour) {
  const acts = oriol.horario.filter(h => h.dia === getDayName());
  const phy  = ['educacion_fisica', 'basquet', 'piscina', 'futbol'];

  const upcoming  = acts.find(a => { const h = parseInt(a.inicio); return phy.includes(a.actividad) && h > hour && h <= hour + 3; });
  const recent    = acts.find(a => { const h = parseInt(a.fin);    return phy.includes(a.actividad) && h >= hour - 2 && h <= hour; });
  const duringAct = acts.find(a => { const s = parseInt(a.inicio), e = parseInt(a.fin); return phy.includes(a.actividad) && hour >= s && hour <= e; });

  return { upcoming, recent, duringAct };
}

// â”€â”€ CÃLCULO DE BOLO (Playbook Maestro) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function calculateBolus(glucoseMgdl, trend, carbsG, iob, hour, mealType, selectedFood) {
  if (!glucoseMgdl) return null;

  const semaforo = evaluateSemaforo(glucoseMgdl, trend);
  const prof     = getActiveProfile(hour);
  const act      = getActivityContext(hour);
  const target   = oriol.config.objetivo_glucosa_target || 110;
  const warns    = [];
  const notes    = [];

  // HIPOGLUCEMIA â€” bloqueo total
  if (glucoseMgdl < 70) {
    return {
      total: 0, semaforo: 'rojo', blocked: true,
      warnings: ['ðŸ”´ HIPOGLUCEMIA â€” NO insulina. Tratar con 10-15g HC. Revisar en 15 min.'],
      notes: [], splitAdvice: null, prot: 0, grasa: 0
    };
  }

  // Ratio: bocata tiene ratio propio (1:8.5)
  let ratio = prof.ratio_IC;
  if (mealType === 'esmorzar') {
    ratio = oriol.bocata_config?.ratio_clave || 8.5;
    notes.push(`ðŸ“ Ratio bocata: 1:${ratio}`);
  }

  let corr = Math.max(0, (glucoseMgdl - target) / prof.FSI);
  let meal = carbsG > 0 ? carbsG / ratio : 0;

  // CorrecciÃ³n mÃ¡x 1U en comida (Playbook)
  if (mealType === 'comida' && corr > 1) {
    corr = 1;
    notes.push('âš¡ CorrecciÃ³n limitada a 1U (regla comida Playbook)');
  }

  // Ajuste tendencia
  const trendMap = { DoubleUp: 0.5, SingleUp: 0.25, FortyFiveUp: 0.1, Flat: 0, FortyFiveDown: -0.1, SingleDown: -0.25, DoubleDown: -0.5 };
  const tAdj = trendMap[trend] || 0;

  // Ajuste actividad
  let aAdj = 0, aNote = '';
  if (act.duringAct) {
    aAdj  = -0.5;
    aNote = `âš½ Durante ${act.duringAct.actividad} â€” NO bolear ahora`;
    warns.push(aNote);
  } else if (act.upcoming) {
    aAdj  = -0.3;
    aNote = `âš½ ${act.upcoming.actividad} a las ${act.upcoming.inicio} â€” reducido`;
    notes.push(aNote);
  } else if (act.recent) {
    aAdj  = -0.25;
    aNote = `ðŸƒ ${act.recent.actividad} reciente â€” precauciÃ³n`;
    notes.push(aNote);
  }

  // Ajuste semÃ¡foro
  let semAdj = 0;
  if      (semaforo === 'rojo')     { semAdj = -0.5; warns.push('ðŸ”´ DÃA ROJO â€” PROTECCIÃ“N TOTAL'); }
  else if (semaforo === 'amarillo') { semAdj = -0.2; notes.push('ðŸŸ¡ Glucosa en lÃ­mite â€” prudencia'); }

  // Descuento IOB
  const iobD = Math.min(iob || 0, corr + meal);
  if ((iob || 0) > 2) warns.push('âš ï¸ IOB elevada â€” riesgo de apilamiento');

  let total = Math.max(0, Math.round((meal + corr - iobD + tAdj + aAdj + semAdj) * 2) / 2);

  // Estrategia de bolo extendido
  let extensionMin = null;
  let splitUp = null;
  let splitExt = null;

  if (mealType === 'esmorzar' && selectedFood) {
    if (selectedFood.split === 'NUTELLA') {
      warns.push('âš ï¸ NUTELLA CRÃTICO â€” bolo especial, consultar Playbook');
    } else if (selectedFood.split && total > 0) {
  let split = selectedFood.split;
  if      (semaforo === 'rojo')                     split = '40/60';
  else if (semaforo === 'amarillo' || act.upcoming) split = '50/50';

  const [up, ext] = split.split('/').map(Number);
  const upU  = Math.round(total * (up  / 100) * 2) / 2;
  const extU = Math.round(total * (ext / 100) * 2) / 2;

  // Tiempo de extensión: del food si disponible, o 120min por defecto para bocata
const extMin = selectedFood.extension_min || (ext > 0 ? 120 : 0);

splitAdvice = ext > 0
  ? `⏱️ <b>${upU}U ahora</b> (${up}%) + <b>${extU}U extendidos</b> (${ext}%)`
  : null;

extensionMin = extMin;
splitUp = up;
splitExt = ext;
}
}
  
  // Alta grasa en otras comidas (berlina, dÃ³nut)
  if ((selectedFood?.grasa_g || 0) > 10 && !splitAdvice && total > 0) {
    const upU  = Math.round(total * 0.6 * 2) / 2;
    const extU = Math.round(total * 0.4 * 2) / 2;
    splitAdvice = `â±ï¸ Alta grasa â†’ considera: <b>${upU}U ahora</b> + <b>${extU}U en 90min</b>`;
  }

 return {
  total,
  meal: Math.round(meal * 100) / 100,
  corr: Math.round(corr * 100) / 100,
  iobD: Math.round(iobD * 100) / 100,
  ratio,
  semaforo,
  splitAdvice,
  extensionMin,
  splitUp,
  splitExt,
  warnings: warns,
  notes,
  blocked: false,
  prot: selectedFood?.prot_g || 0,
  grasa: selectedFood?.grasa_g || 0
};
  }

  function buildBolusText(b, carbsG) {
  if (!b)        return '⚠️ Sin glucosa reciente — calcula manualmente';
  if (b.blocked) return b.warnings[0];

  let t = `${semaforoEmoji(b.semaforo)} <b>Bolo sugerido: ${b.total} U</b>`;
  if (carbsG > 0) t += ` para ${carbsG}g HC`;
  if (b.prot > 20) t += `\n⚠️ Alta proteína (${b.prot}g) — puede subir en 2-3h`;

  t += `\n<i>${b.meal}U comida + ${b.corr}U corrección − ${b.iobD}U IOB</i>`;

  if (b.splitAdvice) {
    t += `\n\n${b.splitAdvice}`;
    if (b.extensionMin && b.extensionMin > 0) {
      t += `\n   ⏳ Duración extensión: <b>${b.extensionMin} min</b>`;
      t += `\n   → En Tandem: Bolo Extendido · ${b.splitUp}% · ${b.splitExt}% · ${b.extensionMin}min`;
    }
  }

  b.warnings.forEach(w => t += `\n${w}`);
  b.notes.forEach(n    => t += `\n${n}`);

  return t;
}

// â”€â”€ TECLADOS DINÃMICOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildFoodKeyboard(mealType) {
  const foods = oriol.comidas_rapidas[mealType] || [];
  const rows  = [];
  for (let i = 0; i < foods.length; i += 2) {
    const row = [{ text: foods[i].nombre, callback_data: `food_${i}` }];
    if (foods[i + 1]) row.push({ text: foods[i + 1].nombre, callback_data: `food_${i + 1}` });
    rows.push(row);
  }
  rows.push([
    { text: 'âœ… Ya boleÃ©',       callback_data: 'confirmed_yes' },
    { text: 'ðŸ†˜ Necesito ayuda', callback_data: 'need_help'     }
  ]);
  rows.push([{ text: 'ðŸ† Ver puntos', callback_data: 'show_points' }]);
  return { inline_keyboard: rows };
}

function buildFruitKeyboard() {
  const frutas  = oriol.fruta_hc || {};
  const entries = Object.entries(frutas);
  const rows    = [];
  for (let i = 0; i < entries.length; i += 2) {
    const row = [{ text: `${entries[i][0]} (${entries[i][1]}g)`, callback_data: `fruit_${entries[i][1]}` }];
    if (entries[i + 1]) row.push({ text: `${entries[i + 1][0]} (${entries[i + 1][1]}g)`, callback_data: `fruit_${entries[i + 1][1]}` });
    rows.push(row);
  }
  rows.push([{ text: 'ðŸ¦ Otro postre (~25g)', callback_data: 'fruit_25' }]);
  rows.push([{ text: 'ðŸš« Sin postre',         callback_data: 'fruit_0'  }]);
  rows.push([
    { text: 'âœ… Ya boleÃ©',       callback_data: 'confirmed_yes' },
    { text: 'ðŸ†˜ Necesito ayuda', callback_data: 'need_help'     }
  ]);
  return { inline_keyboard: rows };
}

const CONFIRM_KB = { inline_keyboard: [
  [{ text: 'âœ… Ya me lo puse', callback_data: 'confirmed_yes' },
   { text: 'â³ Ahora mismo',   callback_data: 'confirmed_now' }],
  [{ text: 'ðŸ†˜ Necesito ayuda', callback_data: 'need_help' }]
]};

// â”€â”€ TELEGRAM HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function nsH() {
  return { 'api-secret': crypto.createHash('sha1').update(NS_SECRET).digest('hex'), 'Content-Type': 'application/json; charset=utf-8' };
}


async function sendTG(text, kb = null) {
  try {
    const b = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
    if (kb) b.reply_markup = kb;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'Content-Type': 'application/json; charset=utf-8'}, body: JSON.stringify(b)
    });
    return (await r.json()).result?.message_id;
  } catch (e) { return null; }
}

async function editTG(mid, text, kb = null) {
  try {
    const b = { chat_id: CHAT_ID, message_id: mid, text, parse_mode: 'HTML' };
    if (kb) b.reply_markup = kb;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: {'Content-Type': 'application/json; charset=utf-8'}, body: JSON.stringify(b)
    });
  } catch (e) {}
}

async function ackCB(id, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text, show_alert: false })
    });
  } catch (e) {}
}

async function getUpdates() {
  try {
    return (await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${updateOffset}&timeout=1`)).json()).result || [];
  } catch (e) { return []; }
}

async function getGlucose() {
  try {
    return (await (await fetch(`${NS_URL}/api/v1/entries.json?count=1`, { headers: nsH() })).json())[0] || null;
  } catch (e) { return null; }
}

async function getBoluses(min) {
  try {
    const since = new Date(Date.now() - min * 60000).toISOString();
    return await (await fetch(
      `${NS_URL}/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]=${since}&count=5`,
      { headers: nsH() }
    )).json();
  } catch (e) { return []; }
}

function te(d) {
  return { DoubleUp: 'â¬†ï¸â¬†ï¸', SingleUp: 'â¬†ï¸', FortyFiveUp: 'â†—ï¸', Flat: 'âž¡ï¸', FortyFiveDown: 'â†˜ï¸', SingleDown: 'â¬‡ï¸', DoubleDown: 'â¬‡ï¸â¬‡ï¸' }[d] || 'âž¡ï¸';
}

function ft(iso) {
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function addPoints(uid, name, n) {
  if (!points[uid]) points[uid] = { name, total: 0 };
  points[uid].total += n;
  return points[uid].total;
}

// ── ESTIMACIÓN IA (Anthropic Claude Haiku) ───────────────────────────

async function estimateFoodWithAI(descripcion, mealType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

 const prompt = `Eres nutricionista especializado en diabetes tipo 1 pediátrica.
Oriol es un adolescente de ~13 años con bomba Tandem t:slim.
El cuidador describe esta comida: "${descripcion}"
Momento: ${mealType}

Estima los macronutrientes y la estrategia de bolo extendido.
Responde ÚNICAMENTE con JSON válido, sin texto ni backticks:
{
  "descripcion": "descripción breve",
  "HC_g": número,
  "HC_min": número,
  "HC_max": número,
  "prot_g": número,
  "grasa_g": número,
  "velocidad": "rapida o lenta",
  "split": "100/0 o 60/40 o 50/50 o 40/60",
  "extension_min": número_entero_en_minutos_o_0_si_no_extendido,
  "razon_split": "razón en menos de 8 palabras",
  "confianza": 0.0
}

Referencia para extension_min:
- Sin extensión (absorción rápida, poca grasa): 0
- Grasa moderada o absorción media: 90
- Alta grasa o absorción muy lenta: 120
- Muy alta grasa (pizza, pasta con crema): 150-180`;

  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages:   [{ role: 'user', content: prompt }]
      })
    });
    const data  = await res.json();
    const texto = data.content?.[0]?.text || '';
    const clean = texto.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('AI error:', e.message);
    return null;
  }
}


// â”€â”€ POLLING DE BOTONES (cada 3 segundos) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const pending = {};

setInterval(async () => {
  const updates = await getUpdates();

  for (const u of updates) {
    updateOffset = Math.max(updateOffset, u.update_id + 1);

    /// Respuesta de texto o número para HC
if (u.message?.text && waitingForInput) {
  const input = u.message.text.trim();
  const ctx   = waitingForInput;
  const hour  = new Date().getHours();
  const n     = parseFloat(input);

  if (!isNaN(n) && n >= 0 && n <= 400) {
    // Número directo → calcular bolo
    waitingForInput = null;
    const b = calculateBolus(ctx.g?.sgv, ctx.g?.direction, n, 0, hour, ctx.mealType, null);
    await sendTG(`📊 <b>${n}g HC</b>\n\n${buildBolusText(b, n)}\n\n¿Confirmas el bolo?`, CONFIRM_KB);
  } else {
    // Descripción de comida → consultar IA
    await sendTG('🤖 Analizando la comida...');
    const estimacion = await estimateFoodWithAI(input, ctx.mealType);
    waitingForInput  = null;

    if (!estimacion) {
      await sendTG('⚠️ No pude estimar esa comida. Escribe solo el número de gramos de HC (ej: <b>45</b>)');
      waitingForInput = ctx; // reintento
    } else {
      const hc = estimacion.HC_g;
      const b  = calculateBolus(ctx.g?.sgv, ctx.g?.direction, hc, 0, hour, ctx.mealType,
        { grasa_g: estimacion.grasa_g, prot_g: estimacion.prot_g, split: estimacion.split });

      let txt = `🤖 <b>${estimacion.descripcion}</b>\n\n`;
      txt += `HC: <b>~${hc}g</b> (rango: ${estimacion.HC_min}-${estimacion.HC_max}g)\n`;
      txt += `Prot: ${estimacion.prot_g}g | Grasa: ${estimacion.grasa_g}g\n`;
      txt += `Absorción: ${estimacion.velocidad === 'rapida' ? '⚡ Rápida' : '🐢 Lenta'}\n`;
      if (estimacion.confianza < 0.7) txt += `⚠️ Estimación con poca certeza — revisa\n`;
      txt += `\n${buildBolusText(b, hc)}\n\n¿Confirmas el bolo?`;

      await sendTG(txt, CONFIRM_KB);
    }
  }
  continue;
}

    // Comando /puntos
    if (u.message?.text === '/puntos') {
      const msg = Object.keys(points).length === 0
        ? 'ðŸ† <b>Marcador LEO</b>\n\nÂ¡Confirma el primer bolo para empezar!'
        : 'ðŸ† <b>Marcador LEO</b>\n\n' + Object.values(points).map(p => `âš½ ${p.name}: <b>${p.total} pts</b>`).join('\n');
      await sendTG(msg);
      continue;
    }

    if (!u.callback_query) continue;

    const cb   = u.callback_query;
    const data = cb.data;
    const name = cb.from.first_name || 'Oriol';
    const uid  = cb.from.id;
    const mid  = cb.message?.message_id;
    const rem  = Object.values(pending).find(r => !r.resolved);

    // â”€â”€ ConfirmaciÃ³n directa
    if (data === 'confirmed_yes') {
      await ackCB(cb.id, 'âœ… Â¡Anotado!');
      const total = addPoints(uid, name, 10);
      if (rem) rem.resolved = true;
      await editTG(mid, `${FOOTBALL[Math.floor(Math.random() * FOOTBALL.length)]}\n\n<b>${name}</b> confirmÃ³ el bolo âœ…\nðŸ† +10 pts Â· Total: ${total} pts`);

    } else if (data === 'confirmed_now') {
      await ackCB(cb.id, 'â³ Â¡Venga, tÃº puedes!');
      await editTG(mid, `â³ <b>${name}</b> se lo estÃ¡ poniendo ahora...`);

    } else if (data === 'not_eating') {
      await ackCB(cb.id, 'ðŸ½ï¸ Anotado');
      if (rem) rem.resolved = true;
      await editTG(mid, `ðŸ½ï¸ <b>${name}</b>: no come todavÃ­a. Recordatorio cancelado.`);

    } else if (data === 'need_help') {
      await ackCB(cb.id, 'ðŸ†˜ Avisando...');
      if (rem) rem.resolved = true;
      await editTG(mid, `ðŸ†˜ <b>PADRES â€” ATENCIÃ“N URGENTE</b>\n\n<b>${name}</b> necesita ayuda ahora.\nðŸ“ž Llamadle inmediatamente.`);

    } else if (data === 'show_points') {
      await ackCB(cb.id, 'ðŸ†');
      const msg = Object.keys(points).length === 0
        ? 'ðŸ† <b>Marcador LEO</b>\n\nÂ¡Confirma el primer bolo!'
        : 'ðŸ† <b>Marcador LEO</b>\n\n' + Object.values(points).map(p => `âš½ ${p.name}: <b>${p.total} pts</b>`).join('\n');
      await sendTG(msg);

    // â”€â”€ SelecciÃ³n de comida (botones dinÃ¡micos del oriol.json)
    } else if (data.startsWith('food_')) {
      const idx  = parseInt(data.replace('food_', ''));
      const mt   = rem?.mealType || 'desayuno';
      const food = (oriol.comidas_rapidas[mt] || [])[idx];
      if (!food) { await ackCB(cb.id, 'â“'); continue; }

      await ackCB(cb.id, food.nombre);

      // HC personalizado
      if (food.HC_g === -1) {
waitingForInput = { g: rem?.glucoseData, mealType: mt };
await sendTG(
  `🤖 <b>Describe la comida de Oriol</b>\n\n` +
  `Escribe qué va a comer con cantidad aproximada.\n` +
  `Ej: <i>"un plato de macarrones con tomate y una manzana"</i>\n\n` +
  `También puedes escribir directamente los gramos de HC (ej: <b>45</b>)`
);
        continue;
      }

      // Protocolo Nutella
      if (food.split === 'NUTELLA') {
        await editTG(mid,
          `âš ï¸ <b>NUTELLA â€” PROTOCOLO ESPECIAL</b>\n\n` +
          `100g Nutella â‰ˆ 53g HC\n\n` +
          `âŒ NO bolo normal\n` +
          `âœ”ï¸ Bolo parcial segÃºn cantidad exacta\n` +
          `âœ”ï¸ Considerar si hubo hipo previa\n` +
          `âœ”ï¸ Bolo parcial si patio posterior\n\n` +
          `Consultar Playbook Maestro antes de bolear.`
        );
        continue;
      }

      // Cena sin HC
      if (food.HC_g === 0 && food.prot_g > 15) {
        await editTG(mid,
          `ðŸ“Š <b>${food.nombre}</b>\n` +
          `HC: 0g | Prot: ${food.prot_g}g | Grasa: ${food.grasa_g}g\n\n` +
          `â„¹ï¸ Sin hidratos â€” sin bolo de comida necesario.\n` +
          `${food.prot_g > 20 ? 'âš ï¸ Alta proteÃ­na: puede subir glucosa en 2-3h.\n' : ''}` +
          `\nÂ¿Confirmas que no hay bolo?`,
          CONFIRM_KB
        );
        continue;
      }

      const hour = new Date().getHours();
      const b    = calculateBolus(rem?.glucoseData?.sgv, rem?.glucoseData?.direction, food.HC_g, 0, hour, mt, food);

      let txt = `ðŸ“Š <b>${food.nombre}</b>\n`;
      txt += `HC: ${food.HC_g}g | Prot: ${food.prot_g}g | Grasa: ${food.grasa_g}g\n\n`;
      txt += buildBolusText(b, food.HC_g);
      txt += `\n\nÂ¿Confirmas el bolo?`;

      await editTG(mid, txt, CONFIRM_KB);

    // â”€â”€ SelecciÃ³n de fruta (comida)
    } else if (data.startsWith('fruit_')) {
      const fruitHC = parseInt(data.replace('fruit_', ''));
      await ackCB(cb.id, fruitHC > 0 ? `ðŸŽ +${fruitHC}g` : 'ðŸš« Sin postre');

      const hour    = new Date().getHours();
      const totalHC = (rem?.baseHC || 0) + fruitHC;
      const b       = calculateBolus(rem?.glucoseData?.sgv, rem?.glucoseData?.direction, totalHC, 0, hour, 'comida', null);

      let txt = `ðŸ“Š <b>Comida completa â€” ${totalHC}g HC</b>\n`;
      txt += `(MenÃº: ${rem?.baseHC || 0}g + postre: ${fruitHC}g)\n\n`;
      txt += buildBolusText(b, totalHC);
      txt += `\n\nÂ¿Confirmas el bolo?`;

      await editTG(mid, txt, CONFIRM_KB);
    }
  }
}, 3000);

// â”€â”€ CRON: RECORDATORIOS PROGRAMADOS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

cron.schedule('* * * * *', async () => {
  const now   = new Date();
  const h     = now.getHours();
  const tStr  = `${String(h).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (REMINDER_TIMES.includes(tStr) && !pending[tStr]) {
    const glucose  = await getGlucose();
    const semaforo = evaluateSemaforo(glucose?.sgv, glucose?.direction);
    const mealType = getMealType(tStr);
    const gTxt     = glucose
      ? `${semaforoEmoji(semaforo)} Glucosa: <b>${glucose.sgv} mg/dL</b> ${te(glucose.direction)}`
      : 'âš ï¸ Sin datos de glucosa recientes';

    let text, kb, baseHC = 0;

    if (mealType === 'comida') {
      const menu = getTodayMenu();
      baseHC = menu?.HC_g || 0;
      text = `âš½ <b>LEO â€” Comida ${tStr}</b>\n${gTxt}\n\n` +
             `ðŸ½ï¸ ${menu ? menu.descripcion : 'Sin menÃº registrado hoy'}\n` +
             `HC base: ~${baseHC}g\n\n` +
             `Â¿QuÃ© fruta o postre come hoy Oriol?`;
      kb = buildFruitKeyboard();
    } else {
      const nombres = { desayuno: 'Desayuno', esmorzar: 'Esmorzar', merienda: 'Merienda', cena: 'Cena' };
      text = `âš½ <b>LEO â€” ${nombres[mealType] || mealType} ${tStr}</b>\n${gTxt}\n\nÂ¿QuÃ© come Oriol?`;
      kb   = buildFoodKeyboard(mealType);
    }

    const msgId = await sendTG(text, kb);
    pending[tStr] = {
      triggeredAt: now, warned: false, resolved: false,
      messageId: msgId, glucoseData: glucose, mealType, baseHC, semaforo
    };
    console.log(`[${tStr}] ${mealType} | ${semaforoEmoji(semaforo)} ${semaforo} | G:${glucose?.sgv || '?'}`);
  }

  // Vigilar bolo en bomba
  for (const [t, r] of Object.entries(pending)) {
    if (r.resolved) continue;
    const mins = (now - r.triggeredAt) / 60000;
    const bols = await getBoluses(WINDOW_MIN);

    if (bols.length > 0) {
      const b = bols[0];
      await sendTG(`ðŸ” <b>Bolo detectado en la bomba</b>\n${b.insulin || b.amount || '?'}U a las ${ft(b.created_at)}`);
      r.resolved = true;
    } else if (mins >= WARN_MIN && !r.warned) {
      const g = await getGlucose();
      await sendTG(
        `âš ï¸ <b>Sin bolo despuÃ©s de ${WARN_MIN} min</b>\n` +
        (g ? `${semaforoEmoji(evaluateSemaforo(g.sgv, g.direction))} ${g.sgv} mg/dL ${te(g.direction)}\n` : '') +
        `\nPadres: Â¿podÃ©is confirmar con Oriol?`
      );
      r.warned = true;
    } else if (mins >= WINDOW_MIN) {
      r.resolved = true;
    }
  }

  // Limpieza de recordatorios antiguos
  for (const [k, r] of Object.entries(pending)) {
    if (r.resolved && (now - r.triggeredAt) > 7200000) delete pending[k];
  }
});

console.log('âœ… LEO activo â€” Playbook Maestro Oriol integrado');
console.log(`Perfil: ${isWeekend() ? 'FINDE' : 'SEMANA'} | Recordatorios: ${REMINDER_TIMES.join(', ')}`);
