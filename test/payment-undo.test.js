// Money actions that can be undone (audit B8, F8): a payment taken back, and a
// voided invoice that gives its order entries back.
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import * as orders from '../src/worker/orders-db.js';

async function withInvoice(fn, { lines = [{ description: 'Work', quantity: 1, unit_cents: 100000 }] } = {}) {
  const { database, dispose } = await freshDatabase();
  try {
    const client = await db.createClient(database, { name: 'A Client', initials: 'AC' });
    const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
    await db.setInvoiceLines(database, draft.id, lines);
    const issued = await db.issueInvoice(database, draft.id, '2026-10-01');
    await fn(database, issued, client);
  } finally { await dispose(); }
}

describe('taking a payment back', () => {
  it('removes it, opens the invoice again, and keeps a note', async () => {
    await withInvoice(async (database, inv) => {
      const p = await db.recordPayment(database, inv.id, { amount_cents: 100000, paid_on: '2026-10-05', label: 'KBC' });
      expect((await db.getInvoice(database, inv.id)).paid_on).toBe('2026-10-05');
      const out = await db.removePayment(database, inv.id, p.id);
      expect(out.removed).toMatchObject({ id: p.id, amount_cents: 100000 });
      const after = await db.getInvoice(database, inv.id);
      expect(after.paid_on).toBeNull();
      expect(after.due_cents).toBe(100000);
      expect(after.payments).toEqual([]);
      expect(after.notes).toMatch(/Payment removed \d{4}-\d{2}-\d{2}: €1,000\.00 of 2026-10-05 \(KBC\)/);
      // The right amount can be recorded now.
      await db.recordPayment(database, inv.id, { amount_cents: 60000, paid_on: '2026-10-06' });
      expect((await db.getInvoice(database, inv.id)).due_cents).toBe(40000);
    });
  }, 30000);

  it('keeps the paid date when the payments left still cover it', async () => {
    await withInvoice(async (database, inv) => {
      await db.recordPayment(database, inv.id, { amount_cents: 60000, paid_on: '2026-10-05' });
      const second = await db.recordPayment(database, inv.id, { amount_cents: 40000, paid_on: '2026-10-09' });
      expect((await db.getInvoice(database, inv.id)).paid_on).toBe('2026-10-09');
      await db.removePayment(database, inv.id, second.id);
      expect((await db.getInvoice(database, inv.id)).paid_on).toBeNull(); // 600 of 1000: no longer settled
    });
  }, 30000);

  it('answers nothing for a payment of another invoice', async () => {
    await withInvoice(async (database, inv) => {
      const p = await db.recordPayment(database, inv.id, { amount_cents: 1000, paid_on: '2026-10-05' });
      expect(await db.removePayment(database, inv.id + 999, p.id)).toBeNull();
      expect(await db.removePayment(database, inv.id, p.id + 999)).toBeNull();
      expect((await db.getInvoice(database, inv.id)).payments).toHaveLength(1);
    });
  }, 30000);
});

describe('voiding an invoice made from an order', () => {
  it('gives its months back, so a correct invoice can bill them', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      // An order's invoice comes out reverse charge, which needs the client's VAT number.
      const client = await db.createClient(database, { name: 'A Client', initials: 'AC', vat_number: 'BE0123456789' });
      const order = await orders.createOrder(database, { client_id: client.id, slug: 'a-project', title: 'Care', started_on: '2026-09-01' });
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care plan', unit_cents: 9000, starts_on: '2026-09-01' });
      const made = await orders.invoiceOrder(database, order.id, { today: '2026-10-15' });
      const invoiceId = made.invoice?.id ?? made.id;
      const billed = await database.prepare('SELECT COUNT(*) AS n FROM order_entries WHERE invoice_id = ?').bind(invoiceId).first();
      expect(billed.n).toBeGreaterThan(0);
      await db.issueInvoice(database, invoiceId, '2026-10-15');
      await db.voidInvoice(database, invoiceId, 'wrong months');
      const still = await database.prepare('SELECT COUNT(*) AS n FROM order_entries WHERE invoice_id = ?').bind(invoiceId).first();
      expect(still.n).toBe(0);
      // Billed again, once: the same months, on a new invoice.
      const again = await orders.invoiceOrder(database, order.id, { today: '2026-10-15' });
      expect((again.invoice?.id ?? again.id)).not.toBe(invoiceId);
      await expect(orders.invoiceOrder(database, order.id, { today: '2026-10-15' })).rejects.toMatchObject({ field: 'entries' });
    } finally { await dispose(); }
  }, 30000);
});
