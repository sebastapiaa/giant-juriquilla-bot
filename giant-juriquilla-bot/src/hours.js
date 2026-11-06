// Opening-hours arithmetic, done in code so the model never has to work out
// "what day is it, are we open, when do we open next" by itself. The model has
// no clock and reasons badly about dates; it only paraphrases what this says.

const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// 0 = domingo … 6 = sábado. null = cerrado. 24h clock, local time.
// Keep in sync with nothing: knowledge.js builds its "Horario" line from this.
export const HOURS = {
  0: null,
  1: { open: '10:00', close: '20:00' },
  2: { open: '10:00', close: '20:00' },
  3: { open: '10:00', close: '20:00' },
  4: { open: '10:00', close: '20:00' },
  5: { open: '10:00', close: '20:00' },
  6: { open: '09:00', close: '17:00' },
};

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// "20:00" -> "8:00 pm"
export function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// One-line schedule for the knowledge base, generated so it can never drift
// from HOURS. Groups consecutive weekdays with identical hours.
export function hoursSummary() {
  const parts = [];
  let i = 1; // start on lunes, wrap to domingo last
  const order = [1, 2, 3, 4, 5, 6, 0];
  while (i < order.length + 1) {
    const d = order[i - 1];
    let j = i;
    const key = JSON.stringify(HOURS[d]);
    while (j < order.length && JSON.stringify(HOURS[order[j]]) === key) j++;
    const first = DAYS[d], last = DAYS[order[j - 1]];
    const label = first === last ? cap(first) : `${cap(first)} a ${last}`;
    parts.push(HOURS[d] ? `${label} ${fmt12(HOURS[d].open)}–${fmt12(HOURS[d].close)}` : `${label} cerrado`);
    i = j + 1;
  }
  return parts.join(' · ');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Local wall-clock components of `date` in the shop's timezone.
export function localParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  return {
    weekday: DAY_INDEX[parts.weekday.slice(0, 3).toLowerCase()],
    day: Number(parts.day), month: Number(parts.month), year: Number(parts.year),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function longDate(date) {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  }).format(date);
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('es-MX', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

// The block injected into the system prompt. Everything the model needs to
// answer "¿están abiertos?", "¿a qué hora cierran?", "¿mañana abren?" is
// stated outright, so it has nothing to compute.
export function scheduleContext(now = new Date()) {
  const today = localParts(now);
  const tomorrowDate = new Date(now.getTime() + 24 * 3_600_000);
  const h = HOURS[today.weekday];
  const hT = HOURS[localParts(tomorrowDate).weekday];
  const nowTime = new Intl.DateTimeFormat('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).format(now);

  let status;
  if (!h) status = `CERRADA todo el día (los ${DAYS[today.weekday]}s no abrimos).`;
  else if (today.minutes < minutes(h.open)) status = `CERRADA todavía; hoy abrimos a las ${fmt12(h.open)} y cerramos a las ${fmt12(h.close)}.`;
  else if (today.minutes < minutes(h.close)) status = `ABIERTA; hoy cerramos a las ${fmt12(h.close)}.`;
  else status = `CERRADA ya por hoy (hoy cerramos a las ${fmt12(h.close)}).`;

  // Next time the doors open, searching forward from now.
  let next = null;
  for (let i = 0; i < 8 && !next; i++) {
    const d = new Date(now.getTime() + i * 24 * 3_600_000);
    const p = localParts(d);
    const hh = HOURS[p.weekday];
    if (!hh) continue;
    if (i === 0 && today.minutes >= minutes(hh.open)) continue;
    next = `${i === 0 ? 'hoy' : i === 1 ? 'mañana' : 'el'} ${dayLabel(d)} a las ${fmt12(hh.open)}`;
  }

  return [
    `Fecha y hora actual en Juriquilla, Querétaro: ${longDate(now)}, ${nowTime}`,
    `Hoy es ${DAYS[today.weekday]}. La tienda está ${status}`,
    `Mañana (${dayLabel(tomorrowDate)}): ${hT ? `abrimos ${fmt12(hT.open)} – ${fmt12(hT.close)}` : 'cerrado'}.`,
    `Próxima apertura: ${next}.`,
    `Horario general: ${hoursSummary()}.`,
    `Usa SIEMPRE estos datos tal cual para cualquier pregunta sobre fecha, día, hora, si estamos abiertos o a qué hora abrimos/cerramos. NO calcules el día de la semana ni el horario tú mismo. Los mensajes anteriores de esta conversación pueden ser de otro día: ignora cualquier fecha, día u horario mencionado antes y usa solo lo de arriba.`,
  ].join('\n');
}
