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
  console.log('[menu] fecha: ' + today + ' ' + (found ? 'OK' : 'no encontrado'));
  return found || null;
}

function getProfile(hour) {
  var p = isWeekend() ? oriol.perfiles_bomba.finde : oriol.perfiles_bomba.semana;
  var found = p.find(function(s) {
    var i = parseInt(s.hora_inicio);
    var f = parseInt(s.hora_fin);
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

function calcBolus(gluc, trend, hc, iob, hour, mealType, food) {
  if (!gluc) return null;

  var sem    = evalSem(gluc, trend);
  var prof   = getProfile(hour);
  var act    = getActivity(hour);
  var target = (oriol.config && oriol.config.objetivo_glucosa_target) ? oriol.config.objetivo_glucosa_target : 110;
  var warns  = [];
  var notes  = [];

  if (gluc < 70) {
    return {
      total: 0, sem: sem, blocked: true,
      warnings: [E.red + ' HIPOGLUCEMIA - NO insulina. Tratar con 10-15g HC.'],
      notes: [], splitAdvice: null, prot: 0, grasa: 0
    };
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

  var tMap = {
    DoubleUp: 0.5, SingleUp: 0.25, FortyFiveUp: 0.1, Flat: 0,
    FortyFiveDown: -0.1, SingleDown: -0.25, DoubleDown: -0.5
  };
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

  var splitAdvice = null;
  var foodSplit   = (food && food.split && food.split !== 'NUTELLA') ? food.split : null;

  if (foodSplit && total > 0) {
    var sp = foodSplit;
    if (sem === 'rojo')                              sp = '40/60';
    else if (sem === 'amarillo' || act.upcoming)     sp = '50/50';

    var parts  = sp.split('/').map(Number);
    var up     = parts[0];
    var ext    = parts[1];
    var upU    = Math.round(total * up  / 100 * 2) / 2;
    var extU   = Math.round(total * ext / 100 * 2) / 2;
    var extMin = (food && food.extension_min) ? food.extension_min : 120;
    splitAdvice = E.clock + ' <b>' + upU + 'U ahora</b> (' + up + '%) + <b>' + extU + 'U en ' + extMin + ' min</b> (' + ext + '%)\n   Tandem: Extendido ' + up + '/' + ext + '/' + extMin + 'min';
    if (food && food.notas && sem !== 'rojo') notes.push(E.info + ' ' + food.notas);

  } else if (food && (food.grasa_g || 0) > 10 && total > 0) {
    var upU2  = Math.round(total * 0.6 * 2) / 2;
    var extU2 = Math.round(total * 0.4 * 2) / 2;
    splitAdvice = E.clock + ' Alta grasa: <b>' + upU2 + 'U ahora</b> + <b>' + extU2 + 'U en 90 min</b>\n   Tandem: Extendido 60/40/90min';
  }

  return {
    total:  total,
    meal:   Math.round(meal  * 100) / 100,
    corr:   Math.round(corr  * 100) / 100,
    iobD:   Math.round(iobD  * 100) / 100,
    ratio:  ratio,
    sem:    sem,
    splitAdvice: splitAdvice,
    warnings: warns,
    notes:    notes,
    blocked:  false,
    prot:  (food && food.prot_g)  || 0,
    grasa: (food && food.grasa_g) || 0
  };
}

function bolusText(b, hc) {
  if (!b)        return E.warn + ' Sin glucosa reciente - calcula manualmente';
  if (b.blocked) return b.warnings[0];

  var t = semEmo(b.sem) + ' <b>Bolo sugerido: ' + b.total + ' U</b>';
  if (hc > 0)      t += ' para ' + hc + 'g HC';
  if (b.prot > 20) t += '\n' + E.warn + ' Alta proteina (' + b.prot + 'g) - puede subir en 2-3h';
  t += '\n<i>' + b.meal + 'U comida + ' + b.corr + 'U correccion - ' + b.iobD + 'U IOB</i>';
  if (b.splitAdvice)          t += '\n\n' + b.splitAdvice;
  b.warnings.forEach(function(w) { t += '\n' + w; });
  b.notes.forEach(function(n)    { t += '\n' + n; });
  return t;
}

async function estimateFood(desc, mealType) {
  if (!GROQ_KEY) return null;

  var sys = 'Eres nutricionista especializado en diabetes tipo 1 pediatrica. ' +
    'Oriol tiene ~10 anos, usa bomba Tandem con Control-IQ y Humalog Junior. ' +
    'Playbook: ratio bocata 1:8.5, split bocata 60/40 (50/50 si patio, 40/60 dia rojo). ' +
    'Comidas con grasa alta: split 50/50 o 40/60. ' +
    'Responde SOLO con JSON valido, sin texto extra.';

  var usr = 'Comida: "' + desc + '" (' + mealType + '). ' +
    'Devuelve: {"descripcion":"breve","HC_g":0,"HC_min":0,"HC_max":0,' +
    '"prot_g":0,"grasa_g":0,"velocidad":"rapida o lenta",' +
    '"split":"100/0 o 60/40 o 50/50 o 40/60",' +
    '"extension_min":0,"razon":"max 8 palabras","confianza":0.0}';

  try {
    var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: Buffer.from(JSON.stringify({
        model:           'llama-3.3-70b-versatile',
        max_tokens:      300,
        temperature:     0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: usr }
        ]
      }), 'utf8')
    });
    var data = await res.json();
    var raw  = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Groq error]', e.message);
    return null;
  }
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
    { text: E.check + ' Ya bole',        callback_data: 'confirmed_yes' },
    { text: E.sos   + ' Necesito ayuda', callback_data: 'need_help'     }
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
    { text: E.check + ' Ya bole',        callback_data: 'confirmed_yes' },
    { text: E.sos   + ' Necesito ayuda', callback_data: 'need_help'     }
  ]);
  return { inline_keyboard: rows };
}

var CONFIRM_KB = { inline_keyboard: [
  [{ text: E.check + ' Ya me lo puse',  callback_data: 'confirmed_yes' },
   { text: '\u23F3 Ahora mismo',        callback_data: 'confirmed_now' }],
  [{ text: E.sos   + ' Necesito ayuda', callback_data: 'need_help'     }]
]};

function nsH() {
  return {
    'api-secret': crypto.createHash('sha1').update(NS_SECRET).digest('hex'),
    'Content-Type': 'application/json'
  };
}

async function tg(method, params) {
  try {
    var r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    Buffer.from(JSON.stringify(params), 'utf8')
    });
    return (await r.json()).result;
  } catch (e) {
    console.error('[TG error]', e.message);
    return null;
  }
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
    var d = await r.json();
    return d[0] || null;
  } catch (e) { return null; }
}

async function getBoluses(min) {
  try {
    var since = new Date(Date.now() - min * 60000).toISOString();
    var url   = NS_URL + '/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]=' + since + '&count=5';
    var r     = await fetch(url, { headers: nsH() });
    return await r.json();
  } catch (e) { return []; }
}

async function processUpdate(update) {

  if (update.message) {
    var text = (update.message.text || '').trim();

    if (text === '/bolo' || text.indexOf('/bolo@') === 0) {
      var gluc    = await getGlucose();
      var sem     = evalSem(gluc && gluc.sgv, gluc && gluc.direction);
      var hour    = new Date().getHours();
      var mt      = getMealType(String(hour).padStart(2,'0') + ':00');
      var gTxt    = gluc
        ? semEmo(sem) + ' Glucosa: <b>' + gluc.sgv + ' mg/dL</b> ' + trendEmo(gluc.direction)
        : E.warn + ' Sin datos de glucosa';
      var txt, kb, baseHC = 0;

      if (mt === 'comida') {
        var menu = getTodayMenu();
        baseHC = menu && menu.HC_g ? menu.HC_g : 0;
        txt = E.soccer + ' <b>LEO - Calculo de bolo</b>\n' + gTxt + '\n\n' +
          E.food + ' ' + (menu ? menu.descripcion : 'Sin menu registrado hoy') +
          '\nHC base: ~' + baseHC + 'g\n\nQue fruta o postre come hoy?';
        kb = fruitKb();
      } else {
        txt = E.soccer + ' <b>LEO - Calculo de bolo</b>\n' + gTxt + '\n\nQue come Oriol?';
        kb  = foodKb(mt);
      }

      var mid = await sendTG(txt, kb);
      var key = 'manual_' + Date.now();
      pending[key] = { triggeredAt: new Date(), warned: false, resolved: false, messageId: mid, glucoseData: gluc, mealType: mt, baseHC: baseHC, sem: sem };
      return;
    }

    if (text === '/goles' || text.indexOf('/goles@') === 0) {
      var msg = Object.keys(points).length === 0
        ? E.trophy + ' <b>Marcador LEO</b>\n\nConfirma el primer bolo para empezar!'
        : E.trophy + ' <b>Marcador LEO</b>\n\n' + Object.values(points).map(function(p) {
            return E.soccer + ' ' + p.name + ': <b>' + p.total + ' goles</b>';
          }).join('\n');
      await sendTG(msg);
      return;
    }

    if (waitingInput) {
      var ctx = waitingInput;
      var num = parseFloat(text.replace(',', '.'));
      waitingInput = null;

      if (!isNaN(num) && num >= 0 && num <= 400) {
        var hour2 = new Date().getHours();
        var b2    = calcBolus(ctx.glucoseData && ctx.glucoseData.sgv, ctx.glucoseData && ctx.glucoseData.direction, num, 0, hour2, ctx.mealType, null);
        await sendTG(E.pencil + ' <b>' + num + 'g HC</b>\n\n' + bolusText(b2, num) + '\n\nConfirmas el bolo?', CONFIRM_KB);
      } else {
        await sendTG(E.robot + ' Analizando la comida...');
        var est = await estimateFood(text, ctx.mealType);

        if (!est) {
          await sendTG(E.warn + ' No pude estimar esa comida. Escribe los gramos de HC directamente (ej: <b>45</b>)');
          waitingInput = ctx;
          return;
        }

        var hour3 = new Date().getHours();
        var food3 = {
          HC_g: est.HC_g, prot_g: est.prot_g, grasa_g: est.grasa_g,
          split: est.split, extension_min: est.extension_min, notas: est.razon
        };
        var b3  = calcBolus(ctx.glucoseData && ctx.glucoseData.sgv, ctx.glucoseData && ctx.glucoseData.direction, est.HC_g, 0, hour3, ctx.mealType, food3);
        var txt3 = E.robot + ' <b>' + est.descripcion + '</b>\n' +
          'HC: <b>~' + est.HC_g + 'g</b> (rango ' + est.HC_min + '-' + est.HC_max + 'g)' +
          ' | Prot: ' + est.prot_g + 'g | Grasa: ' + est.grasa_g + 'g\n' +
          'Absorcion: ' + (est.velocidad === 'rapida' ? '\u26A1 Rapida' : '\uD83D\uDC22 Lenta');
        if (est.confianza < 0.7) txt3 += '\n' + E.warn + ' Estimacion con poca certeza - revisa';
        txt3 += '\n\n' + bolusText(b3, est.HC_g) + '\n\nConfirmas el bolo?';
        await sendTG(txt3, CONFIRM_KB);
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

    var rem = Object.values(pending)
      .sort(function(a, b) { return b.triggeredAt - a.triggeredAt; })
      .find(function(r) { return !r.resolved; });

    if (data === 'confirmed_yes') {
      await ack(cb.id, E.check + ' Anotado!');
      var total = addGoles(uid, name, 1);
      if (rem) rem.resolved = true;
      await editTG(mid2, randFootball() + '\n\n<b>' + name + '</b> confirmo el bolo ' + E.check + '\n' + E.trophy + ' +1 gol - Total: ' + total + ' goles');

    } else if (data === 'confirmed_now') {
      await ack(cb.id, '\u23F3 Venga!');
      await editTG(mid2, '\u23F3 <b>' + name + '</b> se lo esta poniendo ahora...');

    } else if (data === 'not_eating') {
      await ack(cb.id, 'Anotado');
      if (rem) rem.resolved = true;
      await editTG(mid2, '<b>' + name + '</b>: no come todavia. Recordatorio cancelado.');

    } else if (data === 'need_help') {
      await ack(cb.id, E.sos + ' Avisando...');
      if (rem) rem.resolved = true;
      await editTG(mid2, E.sos + ' <b>PADRES - ATENCION URGENTE</b>\n\n<b>' + name + '</b> necesita ayuda ahora.\n\uD83D\uDCDE Llamadle inmediatamente.');

    } else if (data === 'show_points') {
      await ack(cb.id, E.trophy + ' Marcador');
      var msg2 = Object.keys(points).length === 0
        ? E.trophy + ' <b>Marcador LEO</b>\n\nConfirma el primer bolo!'
        : E.trophy + ' <b>Marcador LEO</b>\n\n' + Object.values(points).map(function(p) {
            return E.soccer + ' ' + p.name + ': <b>' + p.total + ' goles</b>';
          }).join('\n');
      await sendTG(msg2);

    } else if (data === 'food_describe') {
      await ack(cb.id, E.robot + ' Describir');
      waitingInput = {
        glucoseData: rem && rem.glucoseData,
        mealType:    (rem && rem.mealType) || getMealType(String(new Date().getHours()).padStart(2,'0') + ':00'),
        baseHC:      (rem && rem.baseHC)   || 0
      };
      await sendTG(
        E.robot + ' <b>Describe la comida de Oriol</b>\n\n' +
        'Escribe que va a comer con cantidad aproximada.\n' +
        'Ej: bocata de lomo embuchado mediano\n\n' +
        'O escribe directamente los gramos de HC (ej: <b>45</b>)'
      );

    } else if (data === 'food_number') {
      await ack(cb.id, E.pencil + ' Indicar HC');
      waitingInput = {
        glucoseData: rem && rem.glucoseData,
        mealType:    (rem && rem.mealType) || getMealType(String(new Date().getHours()).padStart(2,'0') + ':00'),
        baseHC:      (rem && rem.baseHC)   || 0
      };
      await sendTG(E.pencil + ' Cuantos gramos de HC va a comer Oriol?\nEscribe solo el numero (ej: <b>45</b>)');

    } else if (data.indexOf('food_') === 0) {
      var idx  = parseInt(data.replace('food_', ''));
      var mt2  = (rem && rem.mealType) || 'desayuno';
      var list = (oriol.comidas_rapidas && oriol.comidas_rapidas[mt2]) || [];
      var food = list[idx];
      if (!food) { await ack(cb.id, '?'); return; }

      await ack(cb.id, food.nombre);

      if (food.split === 'NUTELLA') {
        await editTG(mid2,
          E.warn + ' <b>NUTELLA - PROTOCOLO ESPECIAL</b>\n\n' +
          '100g Nutella = ~53g HC\n\n' +
          'NO bolo normal - bolo parcial segun cantidad exacta\n' +
          'Considerar si hubo hipo previa\n' +
          'Consultar Playbook antes de bolear.'
        );
        return;
      }

      if (food.HC_g === 0 && food.prot_g > 15) {
        var txt4 = E.food + ' <b>' + food.nombre + '</b>\nHC: 0g - sin bolo de comida necesario.';
        if (food.prot_g > 20) txt4 += '\n' + E.warn + ' Alta proteina: puede subir glucosa en 2-3h.';
        await editTG(mid2, txt4, CONFIRM_KB);
        return;
      }

      var hour4 = new Date().getHours();
      var b4    = calcBolus(
        rem && rem.glucoseData && rem.glucoseData.sgv,
        rem && rem.glucoseData && rem.glucoseData.direction,
        food.HC_g, 0, hour4, mt2, food
      );
      await editTG(mid2,
        E.food + ' <b>' + food.nombre + '</b>\n' +
        'HC: ' + food.HC_g + 'g | Prot: ' + food.prot_g + 'g | Grasa: ' + food.grasa_g + 'g\n\n' +
        bolusText(b4, food.HC_g) + '\n\nConfirmas el bolo?',
        CONFIRM_KB
      );

    } else if (data.indexOf('fruit_') === 0) {
      var fHC   = parseInt(data.replace('fruit_', ''));
      var bHC   = (rem && rem.baseHC) ? rem.baseHC : 0;
      var total2 = bHC + fHC;
      await ack(cb.id, fHC > 0 ? '+' + fHC + 'g postre' : 'Sin postre');

      var hour5 = new Date().getHours();
      var b5    = calcBolus(
        rem && rem.glucoseData && rem.glucoseData.sgv,
        rem && rem.glucoseData && rem.glucoseData.direction,
        total2, 0, hour5, 'comida', null
      );
      await editTG(mid2,
        E.food + ' <b>Comida completa - ' + total2 + 'g HC</b>\n' +
        '(Menu: ' + bHC + 'g + postre: ' + fHC + 'g)\n\n' +
        bolusText(b5, total2) + '\n\nConfirmas el bolo?',
        CONFIRM_KB
      );
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
    var gTxt = gluc
      ? semEmo(sem) + ' Glucosa: <b>' + gluc.sgv + ' mg/dL</b> ' + trendEmo(gluc.direction)
      : E.warn + ' Sin datos de glucosa';

    var txt, kb, baseHC = 0;

    if (mt === 'comida') {
      var menu = getTodayMenu();
      baseHC = menu && menu.HC_g ? menu.HC_g : 0;
      txt = E.soccer + ' <b>LEO - Comida ' + tStr + '</b>\n' + gTxt + '\n\n' +
        E.food + ' ' + (menu ? menu.descripcion : 'Sin menu registrado hoy') +
        '\nHC base: ~' + baseHC + 'g\n\nQue fruta o postre come hoy Oriol?';
      kb = fruitKb();
    } else {
      var names = { desayuno:'Desayuno', esmorzar:'Esmorzar', merienda:'Merienda', cena:'Cena' };
      txt = E.soccer + ' <b>LEO - ' + (names[mt] || mt) + ' ' + tStr + '</b>\n' + gTxt + '\n\nQue come Oriol?';
      kb  = foodKb(mt);
    }

    var mid = await sendTG(txt, kb);
    pending[tStr] = {
      triggeredAt: now, warned: false, resolved: false,
      messageId: mid, glucoseData: gluc, mealType: mt, baseHC: baseHC, sem: sem
    };
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
      await sendTG(E.search + ' <b>Bolo detectado en la bomba</b>\n' + (b.insulin || b.amount || '?') + 'U a las ' + fmtTime(b.created_at));
      r.resolved = true;
    } else if (mins >= WARN_MIN && !r.warned) {
      var g = await getGlucose();
      await sendTG(
        E.warn + ' <b>Sin bolo despues de ' + WARN_MIN + ' min</b>\n' +
        (g ? semEmo(evalSem(g.sgv, g.direction)) + ' ' + g.sgv + ' mg/dL ' + trendEmo(g.direction) + '\n' : '') +
        '\nPadres: podeis confirmar con Oriol?'
      );
      r.warned = true;
    } else if (mins >= WINDOW_MIN) {
      r.resolved = true;
    }
  }

  var allKeys = Object.keys(pending);
  for (var j = 0; j < allKeys.length; j++) {
    if (pending[allKeys[j]].resolved && (now - pending[allKeys[j]].triggeredAt) > 7200000) {
      delete pending[allKeys[j]];
    }
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
      } catch (e) {
        console.error('[parse error]', e.message);
      }
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
  console.log('Groq AI: ' + (GROQ_KEY ? 'SI' : 'NO - usa Indicar HC'));
  console.log('Webhook: POST /webhook');
});
