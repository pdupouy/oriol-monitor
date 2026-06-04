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
const REMINDER_TIMES = (process.env.REMINDER_TIMES || '11:00,14:00').split(',');
const WINDOW_MIN     = parseInt(process.env.BOLUS_WINDOW_MINUTES || '25');
const WARN_MIN       = parseInt(process.env.WARN_AFTER_MINUTES   || '5');

// ============================================================
// CONOCIMIENTO CLINICO REAL DE ORIOL - BASE DE DECISION DE LEO
// ============================================================
var GPT_SYSTEM = [
  'Eres LEO, copiloto clinico de diabetes de Oriol, nino ~10 anos con T1D en Espana.',
  'Hablas de forma empatica y cercana, con analogias de futbol cuando encaja.',
  'NUNCA das ordenes medicas ni sustituyes al endocrino.',
  '',
  '== DISPOSITIVO ==',
  'Tandem t:slim X2 con Control-IQ. Insulina: Humalog Junior.',
  'Bolo extendido: X% ahora + Y% en Z minutos. Z puede ser CUALQUIER valor entre 30 y 480 min.',
  'Control-IQ ajusta la basal pero NO el bolo manual.',
  '',
  '== PERFILES DE INSULINA ==',
  'SEMANA:',
  '  00:00-06:30: ratio 1:12, FSI 70',
  '  06:30-08:30: ratio 1:9,  FSI 70',
  '  08:30-10:30: ratio 1:10, FSI 70',
  '  10:30-12:30: ratio 1:9  (bocata usar 1:8.5 empirico), FSI 70',
  '  12:30-13:30: ratio 1:18, FSI 70',
  '  13:30-16:30: ratio 1:20, FSI 70',
  '  16:30-22:00: ratio 1:14, FSI 70',
  '  22:00-00:00: ratio 1:12, FSI 70',
  'FINDE: ratios menos agresivos. 09:00-13:00: 1:10. Comida: 1:18. Tarde: 1:16.',
  'Objetivo glucemia: 110 mg/dL.',
  '',
  '== BOCATA (esmorzar ~11:00) - REGLAS EMPIRICAS REALES ==',
  'HC tipico del bocata escolar: 35-55g. Base empirica: ~3.7U para 40g jamon/queso.',
  'Ratio empirica: entre 1:9 y 1:8.5 segun relleno. Puede ser mas agresiva si picos repetidos.',
  'PREBOLO OBLIGATORIO: 15 min standard. 20-25 min si picos altos recientes.',
  '',
  'SPLITS EMPIRICOS DEMOSTRADOS (no reglas fijas, contexto manda):',
  '  Glucosa <85 o flecha abajo:    30/70 en 60-75 min. NUNCA 0/100.',
  '  Glucosa 85-110 estable:        50/50 en 45-60 min.',
  '  Glucosa 110-140:               70/30 en 45 min.',
  '  Glucosa 140-180 subiendo:      80/20 en 30-45 min.',
  '  Glucosa >180 o doble subida:   90/10 en 30 min + correccion contextual.',
  'Split mas usado con exito: 85/15.',
  'Si ha habido picos >240 varios dias: probar 90/10 o ratio mas agresiva.',
  '',
  'RELLENOS - EFECTO EN ABSORCION:',
  '  Jamon dulce/cocido:  rapido, predecible. Bolo necesario suficiente.',
  '  Jamon + queso:       algo mas lento. Estable si bolo correcto.',
  '  Queso cabra/curado:  grasa mayor, pico tardio posible. Mas extendido.',
  '  Atun:                mas tardio. 50/50 o 60/40 minimo.',
  '  Salami/lomo:         intermedio-variable. Vigila pico tardio.',
  '  Nutella:             CRITICO. 100g = ~53g HC. NUNCA bolo normal. Bolo parcial.',
  '',
  'PATRON CLAVE DE ORIOL: bocata -> subida -> patio -> bajada.',
  'Si llega 75-85 estable y come YA: el pan puede levantarlo sin zumo. Split protector.',
  'NUNCA 0/100 para bocata aunque este bajo. Siempre algo de upfront.',
  'Si llega bajo (<85) y comer ya: 30/70, sin rescate si estable.',
  'Si olvido bolo: dar parte directo inmediata + resto extendido. No esperar a >220.',
  '',
  'OBJETIVO BOCATA: evitar pico >160. Llegar a patio ~120-130. No bajar <75 antes actividad.',
  '',
  '== COMIDA DEL COLE (~14:00) ==',
  'Ratio: 1:20 (13:30-16:30). A veces 1:18 si se come antes de las 13:30.',
  'NO hay limite fijo de 1U. Calcular segun HC real y contexto.',
  'Con glucosa baja o bajando: bolo protegido. Comer YA, no esperar.',
  'Con glucosa estable: bolo completo segun HC.',
  'Correccion maxima en comida: 1U adicional (salvo >200 subiendo sin actividad).',
  '',
  'PATRONES PROBADOS EN COMIDA:',
  '  Paella 150g + manzana, sin pan, 82 estable: 1U directo -> resultado muy bueno.',
  '  Lentejas 200g + pollo rebozado + yogur, 60g HC, 100 estable: 3U 50/50 60min.',
  '  Arroz 200g + tortilla + fruta, 75-80g HC, 79 estable, IOB 0: 4U 30/70 o 40/60 en 60-90min.',
  '  Crema verduras + arroz + pescado + fruta, 50-55g HC, 192 bajando: 2.5-2.7U sin correccion, 50/50 45-60min.',
  '  Pizza jamon/queso + verduras + sandia, 80g HC, 107 estable: 4U 50/50 90min.',
  '',
  'SPLITS EN COMIDA:',
  '  Comida rapida (poca grasa): mas upfront, 70/30 o directo.',
  '  Comida mixta normal: 50/50 en 60 min.',
  '  Comida grasa/lenta (pizza, rebozados): 50/50 en 90 min o 40/60 en 2h.',
  '  Glucosa baja o bajando: 30/70 o 40/60 en 60-90 min.',
  '  Arroz/pasta: puede tener cola, no bolo completo si bajando.',
  '',
  '== ESTIMACION HC POR ALIMENTO ==',
  'Bocata escolar: 35-55g (variable segun tamano y pan).',
  'Arroz escolar 200g: ~45-50g HC.',
  'Pasta/fideos 200g: ~50-55g HC.',
  'Lentejas 200g: ~25-30g HC.',
  'Paella 150g: ~30-40g HC.',
  'Guisantes con jamon 150g: ~10-15g HC.',
  'Tortilla patatas (racion): ~20-25g HC.',
  'Croquetas jamon (5u): ~20-25g HC.',
  'Pollo rebozado: ~8-12g HC.',
  'Manzana: 15g HC.',
  'Platano mediano: 23g HC.',
  'Pera: 15g HC.',
  'Mandarina: 10-15g HC.',
  'Naranja: 20g HC.',
  'Uvas: 18g HC.',
  'Sandia 200g: ~15-16g HC.',
  'Melocoton: 12g HC.',
  'Fresa: 8g HC.',
  'Yogur sabores: 12-18g HC.',
  'Tarta de queso 100g: 30-35g HC. 135g: ~40g HC. 110g: ~33g HC.',
  '  Split tarta queso: 40/60 en 2.5h (30/70 si baja, 60/40 si sube rapido).',
  'Barrita cereales 11g: 11g HC (tomar antes basket).',
  'Iogurt: 12-18g segun tipo.',
  '',
  '== ACTIVIDAD FISICA ==',
  'PATIO: NO asumir que compensa automaticamente. Solo si real e intenso.',
  '  Si patio en proximos 60-90 min: reducir total 10-20% o desplazar a extendido.',
  '  Si llueve o no salen: no descontar por patio. Mas upfront.',
  '  Saber si patio va a ocurrir, ya ocurrio, o fue cancelado cambia TODO.',
  '',
  'PISCINA (techada, lluvia no cancela):',
  '  Llegar 140-160 estable es zona segura.',
  '  No corregir agresivo justo antes.',
  '  Si <100 antes: HC.',
  '',
  'BALONCESTO (techado, martes y jueves 17:00):',
  '  Oriol se QUITA la bomba durante el entrenamiento.',
  '  Toma barrita 11g HC antes de empezar.',
  '  Objetivo entrada: 120-150. Si <100 o bajando: 10-15g extra.',
  '  Al reconectar: cuidado con basal perdida y sensibilidad post-ejercicio.',
  '  Micro 0.2-0.3U si sale alto estable/subiendo. NO correccion grande inmediata.',
  '',
  'EDUCACION FISICA (lunes 15-17h, NO techado, puede cancelarse por lluvia):',
  '  Si llueve: no descontar por actividad.',
  '',
  '== MICROCORRECCIONES ==',
  '  >180 subiendo, sin IOB: 0.2-0.3U.',
  '  >220-250 subiendo, poca IOB: 0.4-0.6U.',
  '  Nunca corregir: bajando, con IOB, tras hipo, antes actividad intensa.',
  '  No superar 0.8-1.0U adicional en primera hora sin reevaluar.',
  '',
  '== DIA ROJO (hipo reciente, rescate, bajando, actividad) ==',
  '  Sin prebolo. Menos upfront. Mas extendido.',
  '  PERO: para bocata, nunca 0/100. Siempre algo de upfront.',
  '  Splits dia rojo bocata: 30/70 si muy bajo. 40/60 si bajo-limite.',
  '',
  '== TRAS HIPO ==',
  '  NO bolo completo. Rescatar, estabilizar, bolo parcial.',
  '  Si la hipo coincide con comida de pan: el pan puede ser parte del rescate.',
  '',
  '== REGLA MAESTRA ==',
  '  Oriol NO necesita mas insulina. Necesita mejor TIMING.',
  '  PRIMERO ESTABILIDAD, LUEGO PRECISION.',
  '  Decidir siempre por contexto, no solo por el numero de glucosa.',
  '',
  '== CONTEXTO OBLIGATORIO ANTES DE CALCULAR ==',
  '  1. Fecha y dia semana (detectar EF, basket, piscina)',
  '  2. Hora exacta',
  '  3. Glucemia actual y flecha',
  '  4. IOB real (puede no coincidir con lo mostrado)',
  '  5. HC por componente de la comida',
  '  6. Actividad previa y proxima',
  '  7. Clima (lluvia = sin patio exterior)',
  '  8. Bolos reales recientes (Oriol puede olvidar avisar)',
  '',
  '== FORMATO IDEAL DE RESPUESTA ==',
  '  1. HC por componente + total',
  '  2. Bolo total en U',
  '  3. Split exacto (cualquier porcentaje) y duracion en minutos',
  '  4. Razon breve',
  '  5. Plan si sube / si baja / si cancela actividad',
  '',
  'Responde SIEMPRE en JSON cuando se te pida. Sin texto extra.'
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
  E.soccer + ' Buen pase! Bolo confirmado.',
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
  return new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
}

function addGoles(uid, name) {
  if (!points[uid]) points[uid] = { name: name, total: 0 };
  points[uid].total += 1;
  return points[uid].total;
}

function randFootball() { return FOOTBALL[Math.floor(Math.random() * FOOTBALL.length)]; }
function isWeekend() { var d = new Date().getDay(); return d === 0 || d === 6; }
function getDayName() { return ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'][new Date().getDay()]; }

function getTodayMenu() {
  var today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  var found = oriol.menu.find(function(m) { return m.fecha === today; });
  console.log('[menu] ' + today + ': ' + (found ? 'OK' : 'no encontrado'));
  return found || null;
}

function getActivity(hour) {
  var acts = oriol.horario.filter(function(h) { return h.dia === getDayName(); });
  var phy  = ['educacion_fisica','basquet','piscina','futbol'];
  return {
    upcoming: acts.find(function(a) { var h=parseInt(a.inicio); return phy.indexOf(a.actividad)>=0&&h>hour&&h<=hour+3; }),
    recent:   acts.find(function(a) { var h=parseInt(a.fin);    return phy.indexOf(a.actividad)>=0&&h>=hour-2&&h<=hour; }),
    during:   acts.find(function(a) { var s=parseInt(a.inicio),e=parseInt(a.fin); return phy.indexOf(a.actividad)>=0&&hour>=s&&hour<=e; })
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
  var bajando = trend==='FortyFiveDown'||trend==='SingleDown'||trend==='DoubleDown';
  var rapido  = trend==='SingleDown'||trend==='DoubleDown';
  if (gluc < 80)             return 'rojo';
  if (gluc < 90 && rapido)   return 'rojo';
  if (gluc < 100 && bajando) return 'amarillo';
  if (gluc < 100)            return 'amarillo';
  return 'verde';
}

// LA IA DECIDE TODO: unidades + split exacto + duracion + razon
async function getBolusSuggestion(gluc, trend, hc, iob, mealType, food, hour) {
  if (!GROQ_KEY || !gluc) return null;

  var sem    = evalSem(gluc, trend);
  var act    = getActivity(hour);
  var day    = getDayName();
  var wknd   = isWeekend() ? 'si' : 'no';
  var actTxt = [];
  if (act.during)   actTxt.push('DURANTE ' + act.during.actividad);
  if (act.upcoming) actTxt.push('proxima: ' + act.upcoming.actividad + ' a las ' + act.upcoming.inicio);
  if (act.recent)   actTxt.push('reciente: ' + act.recent.actividad);

  var lines = [
    'Calcula el bolo completo para Oriol. Contexto exacto:',
    'Glucosa: ' + gluc + ' mg/dL | Tendencia: ' + (trend||'plana') + ' | Semaforo: ' + sem,
    'IOB estimada: ' + (iob||0) + 'U',
    'HC a cubrir: ' + hc + 'g',
    'Tipo comida: ' + mealType,
    food ? 'Alimento: ' + (food.nombre||food.descripcion||JSON.stringify(food)) : '',
    food && food.grasa_g   ? 'Grasa: '     + food.grasa_g   + 'g' : '',
    food && food.prot_g    ? 'Proteina: '  + food.prot_g    + 'g' : '',
    food && food.velocidad ? 'Absorcion: ' + food.velocidad : '',
    'Actividad: ' + (actTxt.length ? actTxt.join(', ') : 'ninguna prevista'),
    'Dia: ' + day + ' | Hora: ' + String(hour).padStart(2,'0') + 'h | Finde: ' + wknd,
    '',
    'Usa el conocimiento clinico de Oriol para calcular.',
    'El split puede ser CUALQUIER porcentaje. La duracion puede ser CUALQUIER valor 30-480 min.',
    'Devuelve SOLO este JSON sin texto extra:',
    '{"total_u":0.0,"upfront_u":0.0,"extended_u":0.0,"extension_min":0,"split":"85/15","razon":"max 15 palabras","hc_usado":0,"prebolo_min":0}'
  ].filter(Boolean).join('\n');

  try {
    var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: Buffer.from(JSON.stringify({
        model:           'llama-3.3-70b-versatile',
        max_tokens:      200,
        temperature:     0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: GPT_SYSTEM },
          { role: 'user',   content: lines }
        ]
      }), 'utf8')
    });
    var data = await res.json();
    var raw  = (data.choices&&data.choices[0]&&data.choices[0].message) ? data.choices[0].message.content : '{}';
    var r    = JSON.parse(raw);
    console.log('[IA bolo] ' + JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('[IA error]', e.message);
    return null;
  }
}

async function estimateFood(desc, mealType) {
  if (!GROQ_KEY) return null;
  var usr = 'Comida de Oriol: "' + desc + '" (' + mealType + '). Estima macronutrientes. JSON: {"descripcion":"breve","HC_g":0,"HC_min":0,"HC_max":0,"prot_g":0,"grasa_g":0,"velocidad":"rapida o lenta","confianza":0.0}';
  try {
    var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: Buffer.from(JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 200, temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: GPT_SYSTEM }, { role: 'user', content: usr }]
      }), 'utf8')
    });
    var data = await res.json();
    return JSON.parse((data.choices&&data.choices[0]&&data.choices[0].message) ? data.choices[0].message.content : '{}');
  } catch (e) { console.error('[food error]', e.message); return null; }
}

function bolusText(sug, hc) {
  if (!sug) return E.warn + ' Sin datos - calcula manualmente';
  if (!sug.total_u || sug.total_u === 0) return E.red + ' Bolo 0U - NO insulina ahora. Tratar hipo primero.';

  var t = semEmo(evalSem(null,null)) + ' <b>Bolo sugerido: ' + sug.total_u + ' U</b>';
  if (hc > 0) t += ' para ' + hc + 'g HC';

  if (sug.extended_u > 0 && sug.extension_min > 0) {
    t += '\n\n' + E.clock + ' <b>' + sug.upfront_u + 'U ahora</b> (' + sug.split.split('/')[0] + '%)';
    t += ' + <b>' + sug.extended_u + 'U en ' + sug.extension_min + ' min</b> (' + sug.split.split('/')[1] + '%)';
    t += '\n   Tandem: Extendido ' + sug.split + '/' + sug.extension_min + 'min';
  } else {
    t += '\n' + E.info + ' Bolo directo';
  }
  if (sug.prebolo_min && sug.prebolo_min > 0) {
    t += '\n' + E.warn + ' Prebolo: poner <b>' + sug.prebolo_min + ' min antes</b> de comer';
  }
  if (sug.razon) t += '\n' + E.info + ' ' + sug.razon;
  return t;
}

function confirmKb(sug) {
  var label = (sug && sug.total_u) ? E.check + ' Puse ' + sug.total_u + 'U' : E.check + ' Ya me lo puse';
  return { inline_keyboard: [
    [{ text: label,                       callback_data: 'confirmed_yes' },
     { text: '\u23F3 Ahora mismo',        callback_data: 'confirmed_now' }],
    [{ text: E.edit + ' Puse otra dosis', callback_data: 'change_dose'  },
     { text: E.no   + ' No come ahora',   callback_data: 'not_eating'   }],
    [{ text: E.sos  + ' Necesito ayuda',  callback_data: 'need_help'    }]
  ]};
}

function foodKb(mealType) {
  var foods = (oriol.comidas_rapidas && oriol.comidas_rapidas[mealType]) || [];
  var rows  = [];
  for (var i = 0; i < foods.length; i += 2) {
    var row = [{ text: foods[i].nombre, callback_data: 'food_' + i }];
    if (foods[i+1]) row.push({ text: foods[i+1].nombre, callback_data: 'food_' + (i+1) });
    rows.push(row);
  }
  rows.push([
    { text: E.robot  + ' Describir comida', callback_data: 'food_describe' },
    { text: E.pencil + ' Indicar HC',       callback_data: 'food_number'   }
  ]);
  rows.push([
    { text: E.no  + ' No come ahora',  callback_data: 'not_eating' },
    { text: E.sos + ' Necesito ayuda', callback_data: 'need_help'  }
  ]);
  rows.push([{ text: E.trophy + ' Ver goles', callback_data: 'show_points' }]);
  return { inline_keyboard: rows };
}

function fruitKb() {
  var fr  = oriol.fruta_hc || {};
  var ent = Object.entries(fr);
  var rows = [];
  for (var i = 0; i < ent.length; i += 2) {
    var row = [{ text: ent[i][0]+'('+ent[i][1]+'g)', callback_data: 'fruit_'+ent[i][1] }];
    if (ent[i+1]) row.push({ text: ent[i+1][0]+'('+ent[i+1][1]+'g)', callback_data: 'fruit_'+ent[i+1][1] });
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

function nsH() { return { 'api-secret': crypto.createHash('sha1').update(NS_SECRET).digest('hex'), 'Content-Type': 'application/json' }; }

async function tg(method, params) {
  try {
    var r = await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: Buffer.from(JSON.stringify(params),'utf8')
    });
    return (await r.json()).result;
  } catch(e) { console.error('[TG]',e.message); return null; }
}

async function sendTG(text, kb) {
  var p = { chat_id:CHAT_ID, text:text, parse_mode:'HTML' };
  if (kb) p.reply_markup = kb;
  var r = await tg('sendMessage', p);
  return r && r.message_id ? r.message_id : null;
}

async function ack(id, txt) { await tg('answerCallbackQuery', { callback_query_id:id, text:txt, show_alert:false }); }

async function getGlucose() {
  try { return (await (await fetch(NS_URL+'/api/v1/entries.json?count=1',{headers:nsH()})).json())[0]||null; } catch(e){return null;}
}

async function getBoluses(min) {
  try {
    var since = new Date(Date.now()-min*60000).toISOString();
    return await (await fetch(NS_URL+'/api/v1/treatments.json?find[eventType]=Bolus&find[created_at][$gte]='+since+'&count=5',{headers:nsH()})).json();
  } catch(e){return[];}
}

async function processUpdate(update) {

  if (update.message) {
    var text = (update.message.text||'').trim();

    if (text === '/bolo' || text.indexOf('/bolo@') === 0) {
      var gluc = await getGlucose();
      var sem  = evalSem(gluc&&gluc.sgv, gluc&&gluc.direction);
      var hour = new Date().getHours();
      var mt   = getMealType(String(hour).padStart(2,'0')+':00');
      var gTxt = gluc ? semEmo(sem)+' Glucosa: <b>'+gluc.sgv+' mg/dL</b> '+trendEmo(gluc.direction) : E.warn+' Sin datos';
      var txt, kb, baseHC = 0;
      if (mt === 'comida') {
        var menu = getTodayMenu();
        baseHC = menu&&menu.HC_g ? menu.HC_g : 0;
        txt = E.soccer+' <b>LEO - Calculo de bolo</b>\n'+gTxt+'\n\n'+E.food+' '+(menu?menu.descripcion:'Sin menu')+'\nHC base: ~'+baseHC+'g\n\nQue fruta o postre?';
        kb  = fruitKb();
      } else {
        txt = E.soccer+' <b>LEO - Calculo de bolo</b>\n'+gTxt+'\n\nQue come Oriol?';
        kb  = foodKb(mt);
      }
      var mid = await sendTG(txt, kb);
      pending['manual_'+Date.now()] = { triggeredAt:new Date(), warned:false, resolved:false, messageId:mid, glucoseData:gluc, mealType:mt, baseHC:baseHC, sem:sem };
      return;
    }

    if (text === '/goles' || text.indexOf('/goles@') === 0) {
      var gMsg = Object.keys(points).length===0
        ? E.trophy+' <b>Marcador LEO</b>\n\nConfirma el primer bolo para empezar!'
        : E.trophy+' <b>Marcador LEO</b>\n\n'+Object.values(points).map(function(p){return E.soccer+' '+p.name+': <b>'+p.total+' goles</b>';}).join('\n');
      await sendTG(gMsg); return;
    }

    if (waitingInput) {
      var ctx = waitingInput;
      var num = parseFloat(text.replace(',','.'));
      waitingInput = null;

      if (ctx.type === 'change_dose') {
        if (!isNaN(num) && num>=0 && num<=30) {
          if (ctx.rem) ctx.rem.resolved = true;
          var g2  = addGoles(ctx.uid, ctx.name);
          var dm  = randFootball()+'\n\n<b>'+ctx.name+'</b> puso <b>'+num+'U</b> '+E.check;
          if (ctx.sug && ctx.sug.extended_u>0) dm += '\n'+E.clock+' '+ctx.sug.upfront_u+'U ahora + '+ctx.sug.extended_u+'U en '+ctx.sug.extension_min+'min';
          dm += '\n'+E.trophy+' +1 gol - Total: '+g2+' goles';
          await sendTG(dm);
        } else { await sendTG(E.warn+' Escribe las unidades puestas (ej: <b>3.5</b>)'); waitingInput=ctx; }
        return;
      }

      var hour2 = new Date().getHours();
      var mt2   = ctx.mealType || getMealType(String(hour2).padStart(2,'0')+':00');
      var g2d   = ctx.glucoseData;

      if (!isNaN(num) && num>=0 && num<=400) {
        await sendTG(E.robot+' Calculando con IA...');
        var sug2 = await getBolusSuggestion(g2d&&g2d.sgv, g2d&&g2d.direction, num, 0, mt2, null, hour2);
        var rem2 = Object.values(pending).sort(function(a,b){return b.triggeredAt-a.triggeredAt;}).find(function(r){return !r.resolved;});
        if (rem2) rem2.lastSug = sug2;
        await sendTG(E.pencil+' <b>'+num+'g HC</b>\n\n'+bolusText(sug2,num)+'\n\nConfirmas el bolo?', confirmKb(sug2));
      } else {
        await sendTG(E.robot+' Analizando comida con IA...');
        var est = await estimateFood(text, mt2);
        if (!est||!est.HC_g) { await sendTG(E.warn+' No pude estimar. Escribe los gramos de HC (ej: <b>45</b>)'); waitingInput=ctx; return; }
        var sug3 = await getBolusSuggestion(g2d&&g2d.sgv, g2d&&g2d.direction, est.HC_g, 0, mt2, est, hour2);
        var rem3 = Object.values(pending).sort(function(a,b){return b.triggeredAt-a.triggeredAt;}).find(function(r){return !r.resolved;});
        if (rem3) rem3.lastSug = sug3;
        var t3 = E.robot+' <b>'+est.descripcion+'</b>\nHC: <b>~'+est.HC_g+'g</b> ('+est.HC_min+'-'+est.HC_max+'g) | Prot: '+est.prot_g+'g | Grasa: '+est.grasa_g+'g\n'+(est.velocidad==='rapida'?'\u26A1':'\uD83D\uDC22')+' '+est.velocidad;
        if (est.confianza<0.7) t3 += '\n'+E.warn+' Estimacion con poca certeza';
        t3 += '\n\n'+bolusText(sug3,est.HC_g)+'\n\nConfirmas el bolo?';
        await sendTG(t3, confirmKb(sug3));
      }
      return;
    }
  }

  if (update.callback_query) {
    var cb   = update.callback_query;
    var data = cb.data;
    var name = (cb.from&&cb.from.first_name)||'Oriol';
    var uid  = cb.from&&cb.from.id;
    var rem  = Object.values(pending).sort(function(a,b){return b.triggeredAt-a.triggeredAt;}).find(function(r){return !r.resolved;});

    if (data === 'confirmed_yes') {
      await ack(cb.id, E.check+' Anotado!');
      var tot = addGoles(uid, name);
      if (rem) rem.resolved = true;
      var cm  = randFootball()+'\n\n<b>'+name+'</b> confirmo el bolo '+E.check;
      if (rem && rem.lastSug && rem.lastSug.extended_u>0) {
        cm += '\n'+E.clock+' '+rem.lastSug.upfront_u+'U ahora + '+rem.lastSug.extended_u+'U en '+rem.lastSug.extension_min+' min';
        cm += '\n   Tandem: Extendido '+rem.lastSug.split+'/'+rem.lastSug.extension_min+'min';
      }
      cm += '\n'+E.trophy+' +1 gol - Total: '+tot+' goles';
      await sendTG(cm);

    } else if (data === 'confirmed_now') {
      await ack(cb.id, '\u23F3 Venga!');
      await sendTG('\u23F3 <b>'+name+'</b> se lo esta poniendo ahora...');

    } else if (data === 'change_dose') {
      await ack(cb.id, E.edit+' Indicar dosis real');
      waitingInput = { type:'change_dose', uid:uid, name:name, rem:rem, sug:rem&&rem.lastSug, glucoseData:rem&&rem.glucoseData, mealType:rem&&rem.mealType };
      var cdMsg = E.edit+' <b>Indica la dosis real puesta</b>\n\n';
      if (rem&&rem.lastSug) { cdMsg += 'Sugerencia: '+rem.lastSug.total_u+'U'; if(rem.lastSug.extended_u>0) cdMsg += ' ('+rem.lastSug.upfront_u+'U ahora + '+rem.lastSug.extended_u+'U en '+rem.lastSug.extension_min+'min)'; cdMsg += '\n\n'; }
      cdMsg += 'Escribe las unidades puestas (ej: <b>3.5</b>)';
      await sendTG(cdMsg);

    } else if (data === 'not_eating') {
      await ack(cb.id, E.no+' Anotado');
      if (rem) rem.resolved = true;
      await sendTG(E.no+' <b>'+name+'</b>: no come ahora. Cancelado.');

    } else if (data === 'need_help') {
      await ack(cb.id, E.sos+' Avisando...');
      if (rem) rem.resolved = true;
      await sendTG(E.sos+' <b>PADRES - ATENCION URGENTE</b>\n\n<b>'+name+'</b> necesita ayuda.\n\uD83D\uDCDE Llamadle inmediatamente.');

    } else if (data === 'show_points') {
      await ack(cb.id, E.trophy);
      var pMsg = Object.keys(points).length===0 ? E.trophy+' <b>Marcador LEO</b>\n\nConfirma el primer bolo!' : E.trophy+' <b>Marcador LEO</b>\n\n'+Object.values(points).map(function(p){return E.soccer+' '+p.name+': <b>'+p.total+' goles</b>';}).join('\n');
      await sendTG(pMsg);

    } else if (data === 'food_describe') {
      await ack(cb.id, E.robot+' Describir');
      waitingInput = { type:'food', glucoseData:rem&&rem.glucoseData, mealType:(rem&&rem.mealType)||getMealType(String(new Date().getHours()).padStart(2,'0')+':00'), baseHC:(rem&&rem.baseHC)||0 };
      await sendTG(E.robot+' <b>Describe la comida de Oriol</b>\n\nEscribe que va a comer.\nEj: bocata de lomo embuchado mediano\n\nO los gramos de HC directamente (ej: <b>45</b>)');

    } else if (data === 'food_number') {
      await ack(cb.id, E.pencil+' Indicar HC');
      waitingInput = { type:'food', glucoseData:rem&&rem.glucoseData, mealType:(rem&&rem.mealType)||getMealType(String(new Date().getHours()).padStart(2,'0')+':00'), baseHC:(rem&&rem.baseHC)||0 };
      await sendTG(E.pencil+' Cuantos gramos de HC?\nEscribe solo el numero (ej: <b>45</b>)');

    } else if (data.indexOf('food_')===0) {
      var idx  = parseInt(data.replace('food_',''));
      var mt4  = (rem&&rem.mealType)||'desayuno';
      var food = ((oriol.comidas_rapidas&&oriol.comidas_rapidas[mt4])||[])[idx];
      if (!food) { await ack(cb.id,'?'); return; }
      await ack(cb.id, food.nombre);

      if (food.split==='NUTELLA') {
        await sendTG(E.warn+' <b>NUTELLA - PROTOCOLO ESPECIAL</b>\n\n100g Nutella = ~53g HC\n\nNO bolo normal. Bolo parcial segun cantidad.\nConsultar Playbook.'); return;
      }
      if (food.HC_g===0 && food.prot_g>15) {
        var t4 = E.food+' <b>'+food.nombre+'</b>\nHC: 0g - sin bolo necesario.'+(food.prot_g>20?'\n'+E.warn+' Alta proteina: puede subir en 2-3h.':'');
        await sendTG(t4, confirmKb(null)); return;
      }

      var hour4 = new Date().getHours();
      var gluc4 = rem&&rem.glucoseData;
      await sendTG(E.robot+' Calculando bolo con IA...');
      var sug4  = await getBolusSuggestion(gluc4&&gluc4.sgv, gluc4&&gluc4.direction, food.HC_g, 0, mt4, food, hour4);
      if (rem) rem.lastSug = sug4;
      await sendTG(E.food+' <b>'+food.nombre+'</b>\nHC: '+food.HC_g+'g | Prot: '+food.prot_g+'g | Grasa: '+food.grasa_g+'g\n\n'+bolusText(sug4,food.HC_g)+'\n\nConfirmas el bolo?', confirmKb(sug4));

    } else if (data.indexOf('fruit_')===0) {
      var fHC  = parseInt(data.replace('fruit_',''));
      var bHC  = (rem&&rem.baseHC)?rem.baseHC:0;
      var tot2 = bHC+fHC;
      await ack(cb.id, fHC>0?'+'+fHC+'g postre':'Sin postre');
      var gluc5 = rem&&rem.glucoseData;
      var menu5 = getTodayMenu();
      await sendTG(E.robot+' Calculando bolo con IA...');
      var sug5  = await getBolusSuggestion(gluc5&&gluc5.sgv, gluc5&&gluc5.direction, tot2, 0, 'comida', menu5, new Date().getHours());
      if (rem) rem.lastSug = sug5;
      await sendTG(E.food+' <b>Comida completa - '+tot2+'g HC</b>\n(Menu: '+bHC+'g + postre: '+fHC+'g)\n\n'+bolusText(sug5,tot2)+'\n\nConfirmas el bolo?', confirmKb(sug5));
    }
  }
}

cron.schedule('* * * * *', async function() {
  var now  = new Date();
  var h    = now.getHours();
  var tStr = String(h).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');

  if (REMINDER_TIMES.indexOf(tStr)>=0 && !pending[tStr]) {
    var gluc = await getGlucose();
    var sem  = evalSem(gluc&&gluc.sgv, gluc&&gluc.direction);
    var mt   = getMealType(tStr);
    var gTxt = gluc ? semEmo(sem)+' Glucosa: <b>'+gluc.sgv+' mg/dL</b> '+trendEmo(gluc.direction) : E.warn+' Sin datos';
    var txt, kb, baseHC=0;
    if (mt==='comida') {
      var menu = getTodayMenu();
      baseHC = menu&&menu.HC_g?menu.HC_g:0;
      txt = E.soccer+' <b>LEO - Comida '+tStr+'</b>\n'+gTxt+'\n\n'+E.food+' '+(menu?menu.descripcion:'Sin menu')+'\nHC base: ~'+baseHC+'g\n\nQue fruta o postre?';
      kb  = fruitKb();
    } else {
      var names={desayuno:'Desayuno',esmorzar:'Esmorzar',merienda:'Merienda',cena:'Cena'};
      txt = E.soccer+' <b>LEO - '+(names[mt]||mt)+' '+tStr+'</b>\n'+gTxt+'\n\nQue come Oriol?';
      kb  = foodKb(mt);
    }
    var mid = await sendTG(txt, kb);
    pending[tStr] = { triggeredAt:now, warned:false, resolved:false, messageId:mid, glucoseData:gluc, mealType:mt, baseHC:baseHC, sem:sem };
    console.log('['+tStr+'] '+mt+' | G:'+(gluc?gluc.sgv:'?'));
  }

  var keys = Object.keys(pending);
  for (var i=0; i<keys.length; i++) {
    var r = pending[keys[i]];
    if (r.resolved) continue;
    var mins = (now-r.triggeredAt)/60000;
    var bols = await getBoluses(WINDOW_MIN);
    if (bols.length>0) {
      var b = bols[0];
      await sendTG(E.search+' <b>Bolo detectado en la bomba</b>\n'+(b.insulin||b.amount||'?')+'U a las '+fmtTime(b.created_at));
      r.resolved=true;
    } else if (mins>=WARN_MIN && !r.warned) {
      var g = await getGlucose();
      await sendTG(E.warn+' <b>Sin bolo despues de '+WARN_MIN+' min</b>\n'+(g?semEmo(evalSem(g.sgv,g.direction))+' '+g.sgv+' mg/dL '+trendEmo(g.direction)+'\n':'')+'\nPadres: podeis confirmar con Oriol?');
      r.warned=true;
    } else if (mins>=WINDOW_MIN) { r.resolved=true; }
  }

  var allKeys = Object.keys(pending);
  for (var j=0; j<allKeys.length; j++) {
    if (pending[allKeys[j]].resolved&&(now-pending[allKeys[j]].triggeredAt)>7200000) delete pending[allKeys[j]];
  }
});

var server = http.createServer(function(req,res) {
  if (req.method==='POST' && req.url==='/webhook') {
    var body='';
    req.on('data',function(c){body+=c.toString();});
    req.on('end',function(){
      try { var u=JSON.parse(body); processUpdate(u).catch(function(e){console.error('[err]',e.message);}); }
      catch(e){console.error('[parse]',e.message);}
      res.writeHead(200); res.end('OK');
    });
  } else {
    res.writeHead(200,{'Content-Type':'text/plain;charset=utf-8'});
    res.end('LEO - Copiloto Diabetes Oriol - OK');
  }
});

server.listen(PORT, function() {
  console.log('\u2705 LEO activo en puerto '+PORT);
  console.log('Recordatorios: '+REMINDER_TIMES.join(', '));
  console.log('Groq IA: '+(GROQ_KEY?'SI - conocimiento clinico Oriol activo':'NO'));
});
