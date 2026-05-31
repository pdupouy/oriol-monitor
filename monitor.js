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
  const d = new Date().
