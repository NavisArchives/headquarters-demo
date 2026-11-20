// A deduction line: a negative price on an invoice line (Andy, 3 Nov 2026:
// « make 2,300, and have like a minus sign » for the prepayment already paid).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { centsFromEuros, printMoney } from '../src/public/assets/finance-lib.js';

async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}

async function draft(database) {
  const client = await db.createClient(database, { name: 'Client SRL', country: 'BE' });
  return db.createInvoice(database, { client_id: client.id, subject: 'Shooting day - Final payment' });
}

describe('deduction lines', () => {
  it('2 300 minus 1 600 already paid, plus extras, totals 745', async () => {
    await withDatabase(async (database) => {
      const invoice = await draft(database);
      const result = await db.setInvoiceLines(database, invoice.id, [
        { description: 'Shooting day, 10 Oct 2026', quantity: 1, unit_cents: 230000 },
        { description: 'Prepayment already paid (6.R.A.L.01)', quantity: 1, unit_cents: -160000 },
        { description: 'Assistant', quantity: 1, unit_cents: 3000 },
        { description: 'Transport', quantity: 1, unit_cents: 1500 },
      ]);
      expect(result.lines.map((l) => l.amount_cents)).toEqual([230000, -160000, 3000, 1500]);
      const stored = await db.getInvoice(database, invoice.id);
      expect(stored.subtotal_cents).toBe(74500);
      expect(stored.total_cents).toBe(74500);
      expect(stored.lines[1].amount_cents).toBe(-160000);
    });
  });

  it('refuses deductions that take the invoice below zero, and keeps the old lines', async () => {
    await withDatabase(async (database) => {
      const invoice = await draft(database);
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Work', quantity: 1, unit_cents: 10000 }]);
      await expect(db.setInvoiceLines(database, invoice.id, [
        { description: 'Work', quantity: 1, unit_cents: 10000 },
        { description: 'Too much off', quantity: 1, unit_cents: -20000 },
      ])).rejects.toThrow(/below zero/);
      const stored = await db.getInvoice(database, invoice.id);
      expect(stored.lines).toHaveLength(1);
      expect(stored.total_cents).toBe(10000);
    });
  });

  it('a negative quantity is still refused (the minus goes on the price)', async () => {
    await withDatabase(async (database) => {
      const invoice = await draft(database);
      await expect(db.setInvoiceLines(database, invoice.id, [{ description: 'x', quantity: -1, unit_cents: 100 }]))
        .rejects.toThrow(/positive number/);
    });
  });

  it('the editor reads -1600 only where a negative is allowed, and the paper prints -€1,600.00', () => {
    expect(centsFromEuros('-1600', 'unit_cents', { negative: true })).toBe(-160000);
    expect(centsFromEuros('−1600,50', 'unit_cents', { negative: true })).toBe(-160050);
    expect(() => centsFromEuros('-1600', 'amount_cents')).toThrow();
    expect(printMoney(-160000)).toBe('-€1,600.00');
  });
});
