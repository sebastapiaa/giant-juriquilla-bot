import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleContext, hoursSummary, localParts, holidayName, hoursFor } from '../src/hours.js';

const ctx = iso => scheduleContext(new Date(iso));

test('summary line matches the shop hours', () => {
  assert.equal(hoursSummary(), 'Lunes a viernes 10:00 am–8:00 pm · Sábado 9:00 am–5:00 pm · Domingo cerrado');
});

test('weekday is computed in Mexico City time, not UTC', () => {
  // 02:30 UTC Saturday is still Friday 8:30 pm in Querétaro.
  assert.equal(localParts(new Date('2026-11-07T02:30:00Z')).weekday, 5);
});

test('friday afternoon: open, closes 8 pm, tomorrow saturday 9-5', () => {
  const c = ctx('2026-11-06T21:17:00Z');
  assert.match(c, /Hoy es viernes\. La tienda está ABIERTA; hoy cerramos a las 8:00 pm/);
  assert.match(c, /Mañana \(sábado, 7 de noviembre\): abrimos 9:00 am – 5:00 pm/);
});

test('saturday after close: next opening is monday', () => {
  const c = ctx('2026-11-07T23:30:00Z');
  assert.match(c, /Hoy es sábado\. La tienda está CERRADA ya por hoy/);
  assert.match(c, /Mañana \(domingo, 8 de noviembre\): cerrado/);
  assert.match(c, /Próxima apertura: el lunes, 9 de noviembre a las 10:00 am/);
});

test('sunday: closed all day, opens tomorrow', () => {
  const c = ctx('2026-11-08T18:00:00Z');
  assert.match(c, /Hoy es domingo\. La tienda está CERRADA todo el día \(los domingos no abrimos\)/);
  assert.match(c, /Próxima apertura: mañana lunes, 9 de noviembre a las 10:00 am/);
});

test('before opening: closed, opens later today', () => {
  const c = ctx('2026-11-09T14:30:00Z');
  assert.match(c, /CERRADA todavía; hoy abrimos a las 10:00 am y cerramos a las 8:00 pm/);
  assert.match(c, /Próxima apertura: hoy lunes, 9 de noviembre a las 10:00 am/);
});

test('statutory holidays are closed in any year', () => {
  assert.equal(holidayName({ year: 2026, month: 11, day: 16 }), 'Día de la Revolución'); // 3rd Monday
  assert.equal(holidayName({ year: 2027, month: 11, day: 15 }), 'Día de la Revolución');
  assert.equal(holidayName({ year: 2026, month: 11, day: 20 }), null); // the historical date, a Friday
  assert.equal(holidayName({ year: 2027, month: 2, day: 1 }), 'Día de la Constitución'); // 1st Monday
  assert.equal(holidayName({ year: 2027, month: 3, day: 15 }), 'Natalicio de Benito Juárez'); // 3rd Monday
  for (const [m, d] of [[1, 1], [5, 1], [9, 16], [12, 25]]) assert.ok(holidayName({ year: 2030, month: m, day: d }));
  assert.equal(hoursFor({ year: 2026, month: 12, day: 25, weekday: 5 }), null);
});

test('monday 16 nov 2026 (Revolución): closed all day, opens tuesday', () => {
  const c = ctx('2026-11-16T17:00:00Z');
  assert.match(c, /Hoy es lunes\. La tienda está CERRADA todo el día: hoy es día festivo \(Día de la Revolución\)/);
  assert.match(c, /Mañana \(martes, 17 de noviembre\): abrimos 10:00 am – 8:00 pm/);
  assert.match(c, /Próxima apertura: mañana martes, 17 de noviembre a las 10:00 am/);
});

test('day before a holiday says tomorrow is closed and skips it for the next opening', () => {
  const c = ctx('2026-11-15T18:00:00Z'); // domingo
  assert.match(c, /Mañana \(lunes, 16 de noviembre\): cerrado, es día festivo \(Día de la Revolución\)/);
  assert.match(c, /Próxima apertura: el martes, 17 de noviembre a las 10:00 am/);
});

test('CLOSED_DATES adds one-off closures', () => {
  const extra = new Set(['2026-11-18']);
  assert.equal(holidayName({ year: 2026, month: 11, day: 18 }, extra), 'cierre programado');
  const c = scheduleContext(new Date('2026-11-18T18:00:00Z'), extra);
  assert.match(c, /CERRADA todo el día: hoy es día festivo \(cierre programado\)/);
  assert.match(c, /Próxima apertura: mañana jueves, 19 de noviembre a las 10:00 am/);
});
