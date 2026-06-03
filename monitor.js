'use strict';

const http   = require('http');
const cron   = require('node-cron');
const fetch  = require('node-fetch');
const crypto = require('crypto');
const oriol  = require('./oriol.json');

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const NS_URL         = process.env.NS_URL;
const NS_SECRET      = process.env.NS_SECRET;
const GROQ_KEY       = process.env.GROQ_API_KEY;
const PORT           = parseInt(process.env.PORT || '3000');
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '08:15,11:00,14:00,17:00,20:30').split(',');
const WINDOW_MIN     = parseInt(process.env.BOLUS_WINDOW_MINUTES || '25');
const WARN_MIN       = parseInt(process.env.WARN_AFTER_MINUTES   || '5');

// System prompt del GPT Leo + reglas del Playbook Maestro
var GPT_SYSTEM = [
  'Habla de forma empatica, cercana e informal, como un amigo mayor que entiende la diabetes.',
  'Usas analogias del futbol y expresiones motivadoras.',
  'Acompanas a Oriol (nino ~10 anos, T1D, bomba Tandem t:slim X2, insulina Humalog Junior) y su familia.',
  'Nunca das ordenes medicas ni sustituyes al profesional.',
  '',
  'PLAYBOOK MAESTRO ORIOL (reglas clinicas):',
  '- Filosofia: PRIMERO ESTABILIDAD, LUEGO PRECISION.',
  '- Semaforo: VERDE (glucosa >100 estable) = calculo normal.',
  '  AMARILLO (80-100 o bajando) = prudencia, reducir upfront.',
  '  ROJO (<80, bajando rapido, hipo reciente) = PROTECCION TOTAL, maximo extendido.',
  '- Bocata (esmorzar 11:00): ratio 1:8.5. SIEMPRE bolo extendido.',
  '  Jamon/butifarra: 60/40 a 120min. Con patio: 50/50.',
  '  Queso: 60/40 a 120min. Dia rojo: 40/60.',
  '  Atun: 50/50 a 120min (siempre mas extendido).',
  '  NUTELLA: protocolo especial, nunca bolo normal.',
  '- Patron Oriol: bocata -> subida -> patio -> bajada. NO asumir que patio compensa siempre.',
  '- Comida escolar (14:00): ratios 1:18-1:20. Correccion maxima 1U.',
  '  Comida rapida (pocas grasas): bolo directo 100/0.',
  '  Comida con grasas: 70/30 a 60-90min.',
  '  Comida lenta/grasa alta: 50/50 a 120min.',
  '- Dia rojo (hipo reciente, rescate, bajando): sin prebolo, mas extendido (50/50 o 40/60).',
  '- Tras hipo: NO bolo completo. Rescatar, estabilizar, bolo parcial.',
  '- Actividad fisica proxima en <2h: reducir upfront del bolo.',
  '- Piscina y baloncesto: techados, no se cancelan por lluvia.',
  '- EF y futbol: no techados, pueden cancelarse por lluvia.',
  '- Dias de lluvia: sin actividad exterior, ajustar.',
  '- Oriol NO necesita mas insulina, necesita mejor TIMING.',
  '',
  'Para cada consulta de split, considera TODOS los factores y explica brevemente el razonamiento.',
  'Responde SIEMPRE en JSON cuando se te pida.'
].join('\n');

const E = {
  soccer:  '\u26BD',
  trophy:  '\uD83C\uDFC6',
  medal:   '\uD83C\uDFC5',
  fire:    '\uD83D\uDD25',
  glove:   '\uD83E\uDD4A',
  green:   '\uD83D\uDFE2',
  yellow:  '\uD83D\uDFE1',
  red:     '\uD83D\uDD34',
  white:   '\u26AA',
  warn:    '\u26A0\uFE0F',
  check:   '\u2705',
  clock:   '\u23F1\uFE0F',
  robot:   '\uD83E\uDD16',
  sos:     '\uD83C\uDD98',
  search:  '\uD83D\uDD0D',
  food:    '\uD83C\uDF7D\uFE0F',
  pencil:  '\uD83D\uDCDD',
  info:    '\u2139\uFE0F',
  run:     '\uD83C\uDFC3',
  no:      '\uD83D\uDEB7',
  edit:    '\u270F\uFE0F',
};

const FOOTBALL = [
  E.soccer + ' Buen pase! Bolo confirmado a tiempo.',
  E.trophy + ' Golazo! Llevas una racha perfecta.',
  E.medal  + ' Al palo! Bolo registrado.',
  E.fire   + ' En racha! Sigue asi.',
  E.glove  + ' Porterazo! Te has gestionado solo.',
];

const points     = {};
const pending    = {};
let waitingInput = null;

function semEmo(s) {
  if (s === 'verde')    return E.green;
  if (s === 'amarillo') return E.yellow;
  if (s === 'rojo')     return E.red;
  return E.white;
}

function trendEmo(d) {
  if (d === 'DoubleUp')      return '\u2191\u2191';
  if (d === 'SingleUp')      return '\u2191';
  if (d === 'FortyFiveUp')   return '\u2197';
  if (d === 'Flat')          return '\u2192';
  if (d === 'FortyFiveDown') return '\u2198';
  if (d === 'SingleDown')    return '\u2193';
  if (d === 'DoubleDown')    return '\u2193\u2193';
  return '\u2192';
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid'
  });
}

function addGoles(uid, name, n) {
  if (!points[uid]) points[uid] = { name: name, total: 0 };
  points[uid].total += n;
  return points[uid].total;
}

function randFootball() {
  return FOOTBALL[Math.floor(Math.random() * FOOTBALL.length)];
}

function isWeekend() {
  var d = new Date().getDay();
  return d === 0 || d === 6;
}

function getDayName() {
  var days = ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];
  return days[new Date().getDay()];
}

function getTodayMenu() {
  var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  var found = oriol.menu.find(function(m) { return m.fecha === today; });
  console.log('[menu] ' + today + ': ' + (found ? 'OK' : 'no encontrado'));
  return found || null;
}

function getProfile(hour) {
  var p = isWeekend() ? oriol.perfiles_bomba.finde : oriol.perfiles_bomba.semana;
  var found = p.find(function(s) {
    var i = parseInt(s.hora_inicio), f = parseInt(s.hora_fin);
    return f === 24 ? hour >= i : hour >= i && hour < f;
  });
  return found || p[0];
}

function getActivity(hour) {
  var acts = oriol.horario.filter(function(h) { return h.dia === getDayName(); });
  var phy  = ['educacion_fisica','basquet','piscina','futbol'];
  return {
    upcoming: acts.find(function(a) {
      var h = parseInt(a.inicio);
      return phy.indexOf(a.actividad) >= 0 && h > hour && h <= hour + 3;
    }),
    recent: acts.find(function(a) {
      var h = parseInt(a.fin);
      return phy.indexOf(a.actividad) >= 0 && h >= hour - 2 && h <= hour;
    }),
    during: acts.find(function(a) {
      var s = parseInt(a.inicio), e = parseInt(a.fin);
      return phy.indexOf(a.actividad) >= 0 && hour >= s && hour <= e;
    })
  };
}

function getMealType(timeStr) {
  var h = parseInt(timeStr);
  if (h < 10) return 'desayuno';
  if (h < 12) return 'esmorzar';
  if (h < 16) return 'comida';
  if (h < 19) return 'merienda';
  return 'cena';
}

function evalSem(gluc, trend) {
  if (!gluc) return 'desconocido';
  var bajando = trend === 'FortyFiveDown' || trend === 'SingleDown' || trend === 'DoubleDown';
  var rapido  = trend === 'SingleDown' || trend === 'DoubleDown';
  if (gluc < 80)             return 'rojo';
  if (gluc < 90 && rapido)   return 'rojo';
  if (gluc < 100 && bajando) return 'amarillo';
  if (gluc < 100)            return 'amarillo';
  return 'verde';
}

// Calculo de unidades (matematico, sin split)
function calcUnits(gluc, trend, hc, iob, hour, mealType) {
  if (!gluc) return null;

  var sem    = evalSem(gluc, trend);
  var prof   = getProfile(hour);
  var act    = getActivity(hour);
  var target = (oriol.config && oriol.config.objetivo_glucosa_target) ? oriol.config.objetivo_glucosa_target : 110;
  var warns  = [];
  var notes  = [];

  if (gluc < 70) {
    return { total: 0, sem: sem, blocked: true, warnings: [E.red + ' HIPOGLUCEMIA - NO insulina. Tratar con 10-15g HC.'], notes: [], act: act };
  }

  var ratio = prof.ratio_IC;
  if (mealType === 'esmorzar') {
    ratio = (oriol.bocata_config && oriol.bocata_config.ratio_clave) ? oriol.bocata_config.ratio_clave : 8.5;
    notes.push(E.info + ' Ratio bocata: 1:' + ratio);
  }

  var corr = Math.max(0, (gluc - target) / prof.FSI);
  var meal = hc > 0 ? hc / ratio : 0;

  if (mealType === 'comida' && corr > 1) {
    corr = 1;
    notes.push(E.info + ' Correccion limitada a 1U');
  }

  var tMap = { DoubleUp:0.5, SingleUp:0.25, FortyFiveUp:0.1, Flat:0, FortyFiveDown:-0.1, SingleDown:-0.25, DoubleDown:-0.5 };
  var tAdj = tMap[trend] || 0;

  var aAdj = 0;
  if (act.during) {
    aAdj = -0.5;
    warns.push(E.run + ' Durante actividad - valorar no bolear');
  } else if (act.upcoming) {
    aAdj = -0.3;
    notes.push(E.run + ' ' + act.upcoming.actividad + ' a las ' + act.upcoming.inicio + ' - reducido');
  } else if (act.recent) {
    aAdj = -0.25;
    notes.push(E.run + ' ' + act.recent.actividad + ' reciente - precaucion');
  }

  var sAdj = 0;
  if (sem === 'rojo') {
    sAdj = -0.5;
    warns.push(E.red + ' DIA ROJO - PROTECCION TOTAL');
  } else if (sem === 'amarillo') {
    sAdj = -0.2;
    notes.push(E.yellow + ' Glucosa en limite - prudencia');
  }

  var iobD  = Math.min(iob || 0, corr + meal);
  if ((iob || 0) > 2) warns.push(E.warn + ' IOB elevada - riesgo apilamiento');

  var total = Math.max(0, Math.round((meal + corr - iobD + tAdj + aAdj + sAdj) * 2) / 2);

  return {
    total:  total,
    meal:   Math.round(meal * 100) / 100,
    corr:   Math.round(corr * 100) / 100,
    iobD:   Math.round(iobD * 100) / 100,
    ratio:  ratio,
    sem:    sem,
    act:    act,
    warnings: warns,
    notes:    notes,
    blocked:  false
  };
}

// Estrategia de split decidida por IA con contexto completo
async function getBolusStrategy(gluc, trend, hc, iob, mealType, food, sem, hour) {
  if (!GROQ_KEY) return null;

  var act     = getActivity(hour);
  var dayName = getDayName();
  var actDesc = [];
  if (act.during)   actDesc.push('DURANTE: ' + act.during.actividad);
  if (act.upcoming) actDesc.push('Proxima: ' + act.upcoming.actividad + ' a las ' + act.upcoming.inicio);
  if (act.recent)   actDesc.push('Reciente: ' + act.recent.actividad);

  var lines = [
    'Decide el split de bolo para Oriol. Contexto:',
    '- Glucosa: ' + gluc + ' mg/dL ' + (trend || '') + ' | Semaforo: ' + sem,
    '- IOB: ' + (iob || 0) + 'U | HC: ' + hc + 'g',
    '- Comida: ' + mealType + (food ? ' - ' + (food.nombre || food.descripcion || '') : ''),
    food ? '- Grasa: ' + (food.grasa_g || 0) + 'g | Proteina: ' + (food.prot_g || 0) + 'g' : '',
    '- Actividad: ' + (actDesc.length ? actDesc.join(', ') : 'ninguna'),
    '- Dia: ' + dayName + ' | Hora: ' + String(hour).padStart(2,'0') + ':xx',
    '',
    'Responde SOLO con JSON: {"split":"100/0 o 60/40 o 50/50 o 40/60","extension_min":0,"razon":"max 12 palabras"}'
  ].filter(Boolean).join('\n');

  try {
    var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: Buffer.from(JSON.stringify({
        model:           'llama-3.3-70b-versatile',
        max_tokens:      120,
        temperature:     0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GPT_SYSTEM },
          { role: 'user',   content: lines }
        ]
      }), 'utf8')
    });
    var data = await res.json();
    var raw  = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Strategy error]', e.message);
    return null;
  }
}

// Estimacion de comida por descripcion libre
async function estimateFood(desc, mealType) {
  if (!GROQ_KEY) return null;

  var usr = 'Comida de Oriol: "' + desc + '" (' + mealType + '). ' +
    'Estima macronutrientes. JSON: {"descripcion":"breve","HC_g":0,"HC_min":0,"HC_max":0,' +
    '"prot_g":0,"grasa_g":0,"velocidad":"rapida o lenta","confianza":0.0}';

  try {
    var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: Buffer.from(JSON.stringify({
        model:           'llama-3.3-70b-versatile',
        max_tokens:      200,
        temperature:     0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GPT_SYSTEM },
          { role: 'user',   content: usr }
        ]
      }), 'utf8')
    });
    var data = await res.json();
    var raw  = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Food error]', e.message);
    return null;
  }
}

// Calcular bolo completo: unidades + estrategia de split via IA
async function calcBolus(gluc, trend, hc, iob, hour, mealType, food) {
  var units = calcUnits(gluc, trend, hc, iob, hour, mealType);
  if (!units || units.blocked) return units;
  if (units.total === 0) return units;

  var sem  = units.sem;
  var strat = null;

  if (GROQ_KEY) {
    strat = await getBolusStrategy(gluc, trend, hc, iob, mealType, food, sem, hour);
  }

  var splitAdvice = null;
  if (strat && strat.split && strat.split !== '100/0') {
    var parts  = strat.split.split('/').map(Number);
    var up     = parts[0];
    var ext    = parts[1];
    var upU    = Math.round(units.total * up  / 100 * 2) / 2;
    var extU   = Math.round(units.total * ext / 100 * 2) / 2;
    var extMin = strat.extension_min || 120;
    splitAdvice = E.clock + ' <b>' + upU + 'U ahora</b> (' + up + '%) + <b>' + extU + 'U en ' + extMin + ' min</b> (' + ext + '%)\n' +
      '   Tandem: Extendido ' + up + '/' + ext + '/' + extMin + 'min\n' +
      '   ' + E.info + ' ' + (strat.razon || '');
  } else if (!GROQ_KEY) {
    // Sin IA: fallback para esmorzar
    if (mealType === 'esmorzar') {
      var sp = sem === 'rojo' ? '40/60' : sem === 'amarillo' ? '50/50' : '60/40';
      var p2 = sp.split('/').map(Number);
      var u2 = Math.round(units.total * p2[0] / 100 * 2) / 2;
      var e2 = Math.round(units.total * p2[1] / 100 * 2) / 2;
      splitAdvice = E.clock + ' <b>' + u2 + 'U ahora</b> (' + p2[0] + '%) + <b>' + e2 + 'U en 120 min</b> (' + p2[1] + '%)\n   Tandem: Extendido ' + p2[0] + '/' + p2[1] + '/120min';
    }
  }

  units.splitAdvice = splitAdvice;
  units.prot  = (food && food.prot_g)  || 0;
  units.grasa = (food && food.grasa_g) || 0;
  return units;
}

function bolusText(b, hc) {
  if (!b)        return E.warn + ' Sin glucosa reciente - calcula manualmente';
  if (b.blocked) return b.warnings[0];

  var t = semEmo(b.sem) + ' <b>Bolo sugerido: ' + b.total + ' U</b>';
  if (hc > 0)       t += ' para ' + hc + 'g HC';
  if (b.prot > 20)  t += '\n' + E.warn + ' Alta proteina (' + b.prot + 'g) - puede subir en 2-3h';
  t += '\n<i>' + b.meal + 'U comida + ' + b.corr + 'U correccion - ' + b.iobD + 'U IOB</i>';
  if (b.splitAdvice)              t += '\n\n' + b.splitAdvice;
  b.warnings.forEach(function(w) { t += '\n' + w; });
  b.notes.forEach(function(n)    { t += '\n' + n; });
  return t;
}

function confirmKb(suggestedUnits) {
  var label = suggestedUnits ? E.check + ' Puse ' + suggestedUnits + 'U' : E.check + ' Ya me lo puse';
  return { inline_keyboard: [
    [{ text: label,                       callback_data: 'confirmed_yes' },
     { text: '\u23F3 Ahora mismo',        callback_data: 'confirmed_now' }],
    [{ text: E.edit + ' Puse otra dosis', callback_data: 'change_dose'   },
     { text: E.no   + ' No come ahora',   callback_data: 'not_eating'    }],
    [{ text: E.sos  + ' Necesito ayuda',  callback_data: 'need_help'     }]
  ]};
}

function foodKb(mealType) {
  var foods = (oriol.comidas_rapidas && oriol.comidas_rapidas[mealType]) || [];
  var rows  = [];
  for (var i = 0; i < foods.length; i += 2) {
    var row = [{ text: foods[i].nombre, callback_data: 'food_' + i }];
    if (foods[i + 1]) row.push({ text: foods[i + 1].nombre, callback_data: 'food_' + (i + 1) });
    rows.push(row);
  }
  rows.push([
    { text: E.robot  + ' Describir comida', callback_data: 'food_describe' },
    { text: E.pencil + ' Indicar HC',       callback_data: 'food_number'   }
  ]);
  rows.push([
    { text: E.no    + ' No come ahora',  callback_data: 'not_eating' },
    { text: E.sos   + ' Necesito ayuda', callback_data: 'need_help'  }
  ]);
  rows.push([{ text: E.trophy + ' Ver goles', callback_data: 'show_points' }]);
  return { inline_keyboard: rows };
}

function fruitKb() {
  var fr   = oriol.fruta_hc || {};
  var ent  = Object.entries(fr);
  var rows = [];
  for (var i = 0; i < ent.length; i += 2) {
    var row = [{ text: ent[i][0] + ' (' + ent[i][1] + 'g)', callback_data: 'fruit_' + ent[i][1] }];
    if (ent[i + 1]) row.push({ text: ent[i + 1][0] + ' (' + ent[i + 1][1] + 'g)', callback_data: 'fruit_' + ent[i + 1][1] });
    rows.push(row);
  }
  rows.push([
    { text: 'Otro postre (~25g)', callback_data: 'fruit_25' },
    { text: 'Sin postre',         callback_data: 'fruit_0'  }
  ]);
  rows.push([
    { text: E.no  + ' No come ahora',  callback_data: 'not_eating' },
    { text: E.sos + ' Necesito ayuda', callback_data: 'need_help'  }
  ]);
  return { inline_keyboard: rows };
}

function nsH() {
  return { 'api-secret': crypto.createHash('sha1').update(NS_SECRET).digest('hex'), 'Content-Type': 'application/json' };
}

async function tg(method, params) {
  try {
    var r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(params), 'utf8')
    });
    return (await r.json()).result;
  } catch (e) { console.error('[TG]', e.message); return null; }
}

async function sendTG(text, kb) {
  var p = { chat_id: CHAT_ID, text: text, parse_mode: 'HTML' };
  if (kb) p.reply_markup = kb;
  var r = await tg('sendMessage', p);
  return r && r.message_id ? r.message_id : null;
}

async function editTG(mid, text, kb) {
  var p = { chat_id: CHAT_ID, message_id: mid, text: text, parse_mode: 'HTML' };
  if (kb) p.reply_markup = kb;
  await tg('editMessageText', p);
}

async function ack(id, text) {
  await tg('answerCallbackQuery', { callback_query_id: id, text: text, show_alert: false });
}

async function getGlucose() {
  try {
    var r = await fetch(NS_URL + '/api/v1/entries.json?count=1', { headers: nsH() });
    return (await r.json())[0] || null;
  } catch (e) { return null; }
}

async function getBoluses(min) {
  try {
    var since = new Date(Date.now() - min * 60000).toISOString();
    var r = await fetch(NS_URL + '/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]=' + since + '&count=5', { headers: nsH() });
    return await r.json();
  } catch (e) { return []; }
}

async function processUpdate(update) {

  if (update.message) {
    var text = (update.message.text || '').trim();

    if (text === '/bolo' || text.indexOf('/bolo@') === 0) {
      var gluc = await getGlucose();
      var sem  = evalSem(gluc && gluc.sgv, gluc && gluc.direction);
      var hour = new Date().getHours();
      var mt   = getMealType(String(hour).padStart(2,'0') + ':00');
      var gTxt = gluc ? semEmo(sem) + ' Glucosa: <b>' + gluc.sgv + ' mg/dL</b> ' + trendEmo(gluc.direction) : E.warn + ' Sin datos';
      var txt, kb, baseHC = 0;

      if (mt === 'comida') {
        var menu = getTodayMenu();
        baseHC = menu && menu.HC_g ? menu.HC_g : 0;
        txt = E.soccer + ' <b>LEO - Calculo de bolo</b>\n' + gTxt + '\n\n' + E.food + ' ' + (menu ? menu.descripcion : 'Sin menu') + '\nHC base: ~' + baseHC + 'g\n\nQue fruta o postre?';
        kb  = fruitKb();
      } else {
        txt = E.soccer + ' <b>LEO - Calculo de bolo</b>\n' + gTxt + '\n\nQue come Oriol?';
        kb  = foodKb(mt);
      }

      var mid = await sendTG(txt, kb);
      pending['manual_' + Date.now()] = { triggeredAt: new Date(), warned: false, resolved: false, messageId: mid, glucoseData: gluc, mealType: mt, baseHC: baseHC, sem: sem };
      return;
    }

    if (text === '/goles' || text.indexOf('/goles@') === 0) {
      var gMsg = Object.keys(points).length === 0
        ? E.trophy + ' <b>Marcador LEO</b>\n\nConfirma el primer bolo!'
        : E.trophy + ' <b>Marcador LEO</b>\n\n' + Object.values(points).map(function(p) { return E.soccer + ' ' + p.name + ': <b>' + p.total + ' goles</b>'; }).join('\n');
      await sendTG(gMsg);
      return;
    }

    if (waitingInput) {
      var ctx = waitingInput;
      var num = parseFloat(text.replace(',', '.'));
      waitingInput = null;

      if (ctx.type === 'change_dose') {
        if (!isNaN(num) && num >= 0 && num <= 30) {
          if (ctx.rem) ctx.rem.resolved = true;
          var g2 = addGoles(ctx.uid, ctx.name, 1);
          await sendTG(randFootball() + '\n\n<b>' + ctx.name + '</b> puso <b>' + num + 'U</b> ' + E.check + '\n(Sugerencia: ' + ctx.suggested + 'U)\n' + E.trophy + ' +1 gol - Total: ' + g2 + ' goles');
        } else {
          await sendTG(E.warn + ' Escribe las unidades puestas (ej: <b>3.5</b>)');
          waitingInput = ctx;
        }
        return;
      }

      var hour2 = new Date().getHours();
      var mt2   = ctx.mealType || getMealType(String(hour2).padStart(2,'0') + ':00');

      if (!isNaN(num) && num >= 0 && num <= 400) {
        await sendTG(E.robot + ' Calculando...');
        var b2 = await calcBolus(ctx.glucoseData && ctx.glucoseData.sgv, ctx.glucoseData && ctx.glucoseData.direction, num, 0, hour2, mt2, null);
        await sendTG(E.pencil + ' <b>' + num + 'g HC</b>\n\n' + bolusText(b2, num) + '\n\nConfirmas el bolo?', confirmKb(b2 && b2.total));
      } else {
        await sendTG(E.robot + ' Analizando comida con IA...');
        var est = await estimateFood(text, mt2);
        if (!est) {
          await sendTG(E.warn + ' No pude estimar. Escribe los gramos de HC (ej: <b>45</b>)');
          waitingInput = ctx;
          return;
        }
        var food3 = { HC_g: est.HC_g, prot_g: est.prot_g, grasa_g: est.grasa_g, nombre: est.descripcion };
        var b3    = await calcBolus(ctx.glucoseData && ctx.glucoseData.sgv, ctx.glucoseData && ctx.glucoseData.direction, est.HC_g, 0, hour2, mt2, food3);
        var t3    = E.robot + ' <b>' + est.descripcion + '</b>\nHC: <b>~' + est.HC_g + 'g</b> (rango ' + est.HC_min + '-' + est.HC_max + 'g) | Prot: ' + est.prot_g + 'g | Grasa: ' + est.grasa_g + 'g\n' + (est.velocidad === 'rapida' ? '\u26A1 Rapida' : '\uD83D\uDC22 Lenta');
        if (est.confianza < 0.7) t3 += '\n' + E.warn + ' Estimacion con poca certeza';
        t3 += '\n\n' + bolusText(b3, est.HC_g) + '\n\nConfirmas el bolo?';
        await sendTG(t3, confirmKb(b3 && b3.total));
      }
      return;
    }
  }

  if (update.callback_query) {
    var cb   = update.callback_query;
    var data = cb.data;
    var name = (cb.from && cb.from.first_name) || 'Oriol';
    var uid  = cb.from && cb.from.id;
    var mid2 = cb.message && cb.message.message_id;
    var rem  = Object.values(pending).sort(function(a,b){ return b.triggeredAt - a.triggeredAt; }).find(function(r){ return !r.resolved; });

    if (data === 'confirmed_yes') {
      await ack(cb.id, E.check + ' Anotado!');
      var tot = addGoles(uid, name, 1);
      if (rem) rem.resolved = true;
      await editTG(mid2, randFootball() + '\n\n<b>' + name + '</b> confirmo el bolo ' + E.check + '\n' + E.trophy + ' +1 gol - Total: ' + tot + ' goles');

    } else if (data === 'confirmed_now') {
      await ack(cb.id, '\u23F3 Venga!');
      await editTG(mid2, '\u23F3 <b>' + name + '</b> se lo esta poniendo ahora...');

    } else if (data === 'change_dose') {
      await ack(cb.id, E.edit + ' Indicar dosis real');
      var msgTxt   = (cb.message && cb.message.text) || '';
      var matchSug = msgTxt.match(/Bolo sugerido: ([\d.]+) U/);
      var suggested = matchSug ? parseFloat(matchSug[1]) : null;
      waitingInput = { type: 'change_dose', uid: uid, name: name, rem: rem, suggested: suggested, glucoseData: rem && rem.glucoseData, mealType: rem && rem.mealType };
      await sendTG(E.edit + ' <b>Indica la dosis real puesta</b>\n\n' + (suggested ? 'Sugerencia: ' + suggested + 'U\n\n' : '') + 'Escribe las unidades que pusiste (ej: <b>3.5</b>)');

    } else if (data === 'not_eating') {
      await ack(cb.id, E.no + ' Anotado');
      if (rem) rem.resolved = true;
      await editTG(mid2, E.no + ' <b>' + name + '</b>: no come ahora. Cancelado.');

    } else if (data === 'need_help') {
      await ack(cb.id, E.sos + ' Avisando...');
      if (rem) rem.resolved = true;
      await editTG(mid2, E.sos + ' <b>PADRES - ATENCION URGENTE</b>\n\n<b>' + name + '</b> necesita ayuda.\n\uD83D\uDCDE Llamadle inmediatamente.');

    } else if (data === 'show_points') {
      await ack(cb.id, E.trophy);
      var pMsg = Object.keys(points).length === 0 ? E.trophy + ' <b>Marcador LEO</b>\n\nConfirma el primer bolo!' : E.trophy + ' <b>Marcador LEO</b>\n\n' + Object.values(points).map(function(p){ return E.soccer + ' ' + p.name + ': <b>' + p.total + ' goles</b>'; }).join('\n');
      await sendTG(pMsg);

    } else if (data === 'food_describe') {
      await ack(cb.id, E.robot + ' Describir');
      waitingInput = { type: 'food', glucoseData: rem && rem.glucoseData, mealType: (rem && rem.mealType) || getMealType(String(new Date().getHours()).padStart(2,'0') + ':00'), baseHC: (rem && rem.baseHC) || 0 };
      await sendTG(E.robot + ' <b>Describe la comida de Oriol</b>\n\nEscribe que va a comer.\nEj: bocata de lomo embuchado mediano\n\nO los gramos de HC directamente (ej: <b>45</b>)');

    } else if (data === 'food_number') {
      await ack(cb.id, E.pencil + ' Indicar HC');
      waitingInput = { type: 'food', glucoseData: rem && rem.glucoseData, mealType: (rem && rem.mealType) || getMealType(String(new Date().getHours()).padStart(2,'0') + ':00'), baseHC: (rem && rem.baseHC) || 0 };
      await sendTG(E.pencil + ' Cuantos gramos de HC?\nEscribe solo el numero (ej: <b>45</b>)');

    } else if (data.indexOf('food_') === 0) {
      var idx  = parseInt(data.replace('food_', ''));
      var mt4  = (rem && rem.mealType) || 'desayuno';
      var food = ((oriol.comidas_rapidas && oriol.comidas_rapidas[mt4]) || [])[idx];
      if (!food) { await ack(cb.id, '?'); return; }
      await ack(cb.id, food.nombre);

      if (food.split === 'NUTELLA') {
        await editTG(mid2, E.warn + ' <b>NUTELLA - PROTOCOLO ESPECIAL</b>\n\n100g Nutella = ~53g HC\n\nNO bolo normal. Bolo parcial segun cantidad.\nConsultar Playbook.'); return;
      }
      if (food.HC_g === 0 && food.prot_g > 15) {
        var t4 = E.food + ' <b>' + food.nombre + '</b>\nHC: 0g - sin bolo necesario.';
        if (food.prot_g > 20) t4 += '\n' + E.warn + ' Alta proteina: puede subir en 2-3h.';
        await editTG(mid2, t4, confirmKb(0)); return;
      }

      await editTG(mid2, E.robot + ' Calculando bolo con contexto...');
      var hour4 = new Date().getHours();
      var b4    = await calcBolus(rem && rem.glucoseData && rem.glucoseData.sgv, rem && rem.glucoseData && rem.glucoseData.direction, food.HC_g, 0, hour4, mt4, food);
      await editTG(mid2, E.food + ' <b>' + food.nombre + '</b>\nHC: ' + food.HC_g + 'g | Prot: ' + food.prot_g + 'g | Grasa: ' + food.grasa_g + 'g\n\n' + bolusText(b4, food.HC_g) + '\n\nConfirmas el bolo?', confirmKb(b4 && b4.total));

    } else if (data.indexOf('fruit_') === 0) {
      var fHC   = parseInt(data.replace('fruit_', ''));
      var bHC   = (rem && rem.baseHC) ? rem.baseHC : 0;
      var tot2  = bHC + fHC;
      await ack(cb.id, fHC > 0 ? '+' + fHC + 'g' : 'Sin postre');
      await editTG(mid2, E.robot + ' Calculando bolo con contexto...');
      var hour5 = new Date().getHours();
      var menu5 = getTodayMenu();
      var b5    = await calcBolus(rem && rem.glucoseData && rem.glucoseData.sgv, rem && rem.glucoseData && rem.glucoseData.direction, tot2, 0, hour5, 'comida', menu5);
      await editTG(mid2, E.food + ' <b>Comida completa - ' + tot2 + 'g HC</b>\n(Menu: ' + bHC + 'g + postre: ' + fHC + 'g)\n\n' + bolusText(b5, tot2) + '\n\nConfirmas el bolo?', confirmKb(b5 && b5.total));
    }
  }
}

cron.schedule('* * * * *', async function() {
  var now  = new Date();
  var h    = now.getHours();
  var tStr = String(h).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

  if (REMINDER_TIMES.indexOf(tStr) >= 0 && !pending[tStr]) {
    var gluc = await getGlucose();
    var sem  = evalSem(gluc && gluc.sgv, gluc && gluc.direction);
    var mt   = getMealType(tStr);
    var gTxt = gluc ? semEmo(sem) + ' Glucosa: <b>' + gluc.sgv + ' mg/dL</b> ' + trendEmo(gluc.direction) : E.warn + ' Sin datos';
    var txt, kb, baseHC = 0;

    if (mt === 'comida') {
      var menu = getTodayMenu();
      baseHC = menu && menu.HC_g ? menu.HC_g : 0;
      txt = E.soccer + ' <b>LEO - Comida ' + tStr + '</b>\n' + gTxt + '\n\n' + E.food + ' ' + (menu ? menu.descripcion : 'Sin menu') + '\nHC base: ~' + baseHC + 'g\n\nQue fruta o postre?';
      kb  = fruitKb();
    } else {
      var names = { desayuno:'Desayuno', esmorzar:'Esmorzar', merienda:'Merienda', cena:'Cena' };
      txt = E.soccer + ' <b>LEO - ' + (names[mt]||mt) + ' ' + tStr + '</b>\n' + gTxt + '\n\nQue come Oriol?';
      kb  = foodKb(mt);
    }

    var mid = await sendTG(txt, kb);
    pending[tStr] = { triggeredAt: now, warned: false, resolved: false, messageId: mid, glucoseData: gluc, mealType: mt, baseHC: baseHC, sem: sem };
    console.log('[' + tStr + '] ' + mt + ' | G:' + (gluc ? gluc.sgv : '?'));
  }

  var keys = Object.keys(pending);
  for (var i = 0; i < keys.length; i++) {
    var r = pending[keys[i]];
    if (r.resolved) continue;
    var mins = (now - r.triggeredAt) / 60000;
    var bols = await getBoluses(WINDOW_MIN);
    if (bols.length > 0) {
      var b = bols[0];
      await sendTG(E.search + ' <b>Bolo detectado en la bomba</b>\n' + (b.insulin||b.amount||'?') + 'U a las ' + fmtTime(b.created_at));
      r.resolved = true;
    } else if (mins >= WARN_MIN && !r.warned) {
      var g = await getGlucose();
      await sendTG(E.warn + ' <b>Sin bolo despues de ' + WARN_MIN + ' min</b>\n' + (g ? semEmo(evalSem(g.sgv,g.direction)) + ' ' + g.sgv + ' mg/dL ' + trendEmo(g.direction) + '\n' : '') + '\nPadres: podeis confirmar con Oriol?');
      r.warned = true;
    } else if (mins >= WINDOW_MIN) {
      r.resolved = true;
    }
  }

  var allKeys = Object.keys(pending);
  for (var j = 0; j < allKeys.length; j++) {
    if (pending[allKeys[j]].resolved && (now - pending[allKeys[j]].triggeredAt) > 7200000) delete pending[allKeys[j]];
  }
});

var server = http.createServer(function(req, res) {
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(chunk) { body += chunk.toString(); });
    req.on('end', function() {
      try {
        var update = JSON.parse(body);
        processUpdate(update).catch(function(e) { console.error('[update error]', e.message); });
      } catch (e) { console.error('[parse error]', e.message); }
      res.writeHead(200);
      res.end('OK');
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LEO - Copiloto Diabetes Oriol - OK');
  }
});

server.listen(PORT, function() {
  console.log('\u2705 LEO activo en puerto ' + PORT);
  console.log('Perfil: ' + (isWeekend() ? 'FINDE' : 'SEMANA'));
  console.log('Recordatorios: ' + REMINDER_TIMES.join(', '));
  console.log('Groq IA: ' + (GROQ_KEY ? 'SI - split contextual activo' : 'NO - fallback basico'));
});
