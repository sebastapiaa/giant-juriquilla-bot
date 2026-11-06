import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleContext, hoursSummary, localParts } from '../src/hours.js';

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
