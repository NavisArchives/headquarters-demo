// A care plan bills from go-live, never back to the signature (audit B10, M5).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import * as orders from '../src/worker/orders-db.js';

async function withOrder(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    const client = await db.createClient(database, { name: 'A Client', initials: 'AC', vat_number: 'BE0123456789' });
    const order = await orders.createOrder(database, { client_id: client.id, slug: 'a-project', title: 'Website — Design and build', started_on: '2026-09-10' });
    await fn(database, order);
  } finally { await dispose(); }
}
const periods = async (database, orderId) => (await database.prepare("SELECT period FROM order_entries WHERE order_id = ? AND kind = 'monthly' ORDER BY period").bind(orderId).all()).results.map((r) => r.period);

describe('a monthly charge', () => {
  it('bills from its own start date, not the order\'s', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care plan', unit_cents: 9000, starts_on: '2026-12-01' });
      expect(line.starts_on).toBe('2026-12-01');
      await orders.accrueMonths(database, order.id, '2027-01-15');
      expect(await periods(database, order.id)).toEqual(['2026-12', '2027-01']);
    });
  }, 30000);

  it('added later without a date, starts the day it is added: never back-dated', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care plan', unit_cents: 9000 }, { today: '2026-11-14' });
      await orders.accrueMonths(database, order.id, '2026-11-20');
      expect(await periods(database, order.id)).toEqual(['2026-11']); // not September, not October
    });
  }, 30000);

  it('a line from before 0029 (no start date) keeps the order\'s start', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care plan', unit_cents: 9000 }, { today: '2026-09-10' });
      await database.prepare('UPDATE order_lines SET starts_on = NULL WHERE id = ?').bind(line.id).run();
      await orders.accrueMonths(database, order.id, '2026-11-20');
      expect(await periods(database, order.id)).toEqual(['2026-09', '2026-10', '2026-11']);
    });
  }, 30000);

  it('names its invoice after the care plan, not the build', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care plan', unit_cents: 9000, starts_on: '2026-11-01' });
      const made = await orders.invoiceOrder(database, order.id, { today: '2026-11-20' });
      const invoice = made.invoice ?? made;
      expect(invoice.subject).toBe('Care plan · 2026-11');
    });
  }, 30000);

  it('refuses a start date that is not a date', async () => {
    await withOrder(async (database, order) => {
      await expect(orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care', unit_cents: 9000, starts_on: 'soon' })).rejects.toMatchObject({ field: 'starts_on' });
    });
  }, 30000);
});
