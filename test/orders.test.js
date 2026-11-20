/**
 * Orders, against a real SQLite database: what a client is charged for on one
 * project, how a month and a day become money owed, and the one rule that
 * matters — nothing is ever billed twice.
 *
 * Every database here is created empty and thrown away. No production data.
 */
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import * as orders from '../src/worker/orders-db.js';
import { monthsDue, orderTotals } from '../src/worker/orders-db.js';

async function withOrder(fn, { startedOn = '2026-07-01' } = {}) {
  const { database, dispose } = await freshDatabase();
  try {
    const client = await db.createClient(database, { name: 'A Client', initials: 'AC' });
    const order = await orders.createOrder(database, {
      client_id: client.id, slug: 'a-project', title: 'Site and care', started_on: startedOn,
    });
    await fn(database, order, client);
  } finally { await dispose(); }
}

describe('months an order has run', () => {
  it('counts the month it started and the month it is in', () => {
    expect(monthsDue('2026-07-14', '2026-09-22')).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('stops at the month it ended in', () => {
    expect(monthsDue('2026-07-14', '2026-09-22', '2026-08-31')).toEqual(['2026-07', '2026-08']);
  });

  it('is one month on its first day', () => {
    expect(monthsDue('2026-09-01', '2026-09-01')).toEqual(['2026-09']);
  });
});

describe('what an order charges', () => {
  it('writes a one-off charge the moment the line is agreed', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'once', description: 'Website build', unit_cents: 300000 });
      const full = await orders.getOrder(database, order.id, { today: '2026-07-01' });
      expect(full.entries).toHaveLength(1);
      expect(full.totals.uninvoiced_cents).toBe(300000);
    });
  });

  it('accrues one monthly charge per month, and never a second for the same month', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care', unit_cents: 12000, starts_on: order.started_on });
      await orders.getOrder(database, order.id, { today: '2026-09-22' });
      const again = await orders.getOrder(database, order.id, { today: '2026-09-22' });
      expect(again.entries.filter((e) => e.kind === 'monthly')).toHaveLength(3);
      expect(again.totals.uninvoiced_cents).toBe(36000);
    });
  });

  it('charges a day only when the day is logged', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'daily', description: 'Shoot day', unit_cents: 45000 });
      const empty = await orders.getOrder(database, order.id, { today: '2026-07-02' });
      expect(empty.totals.uninvoiced_cents).toBe(0);

      await orders.logOrderWork(database, order.id, { line_id: line.id, happened_on: '2026-07-02', quantity: 1.5 });
      const full = await orders.getOrder(database, order.id, { today: '2026-07-02' });
      expect(full.totals.days_logged).toBe(1.5);
      expect(full.totals.uninvoiced_cents).toBe(67500);
    });
  });

  it('refuses work against a line that is neither a day nor an hour rate', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care', unit_cents: 12000, starts_on: order.started_on });
      await expect(orders.logOrderWork(database, order.id, { line_id: line.id })).rejects.toThrow(/daily or an hourly line/);
    });
  });

  it('charges an hourly line by the hour, at the hours logged', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'hourly', description: 'Ice bath session', unit_cents: 8000 });
      const empty = await orders.getOrder(database, order.id, { today: '2026-07-02' });
      expect(empty.totals.hour_rate_cents).toBe(8000);
      expect(empty.totals.uninvoiced_cents).toBe(0);

      await orders.logOrderWork(database, order.id, { line_id: line.id, happened_on: '2026-07-02', quantity: 24 });
      const full = await orders.getOrder(database, order.id, { today: '2026-07-02' });
      expect(full.totals.hours_logged).toBe(24);
      expect(full.totals.uninvoiced_cents).toBe(192000);
      // An hour is never counted as a day, whatever else the order carries.
      expect(full.totals.days_logged).toBe(0);
      expect(full.entries[0].kind).toBe('hourly');
    });
  });

  it('puts hours and days on one invoice without confusing the two', async () => {
    await withOrder(async (database, order) => {
      const day = await orders.addOrderLine(database, order.id, { kind: 'daily', description: 'Shoot day', unit_cents: 45000 });
      const hour = await orders.addOrderLine(database, order.id, { kind: 'hourly', description: 'Ice bath session', unit_cents: 8000 });
      await orders.logOrderWork(database, order.id, { line_id: day.id, happened_on: '2026-09-10', quantity: 1 });
      await orders.logOrderWork(database, order.id, { line_id: hour.id, happened_on: '2026-09-11', quantity: 24 });

      const made = await orders.invoiceOrder(database, order.id, { today: '2026-09-22' });
      const lines = made.invoice.lines;
      const shoot = lines.find((l) => l.description === 'Shoot day');
      const bath = lines.find((l) => l.description.startsWith('Ice bath session'));
      expect(shoot.quantity).toBe(1);
      expect(shoot.unit_cents).toBe(45000);
      expect(bath.quantity).toBe(24);
      expect(bath.unit_cents).toBe(8000);
      expect(bath.description).toContain('per hour');
    });
  });
});

describe('turning an order into an invoice', () => {
  it('groups each line into one invoice line and stamps every charge', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'once', description: 'Website build', unit_cents: 300000 });
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care', unit_cents: 12000, starts_on: order.started_on });
      const day = await orders.addOrderLine(database, order.id, { kind: 'daily', description: 'Shoot day', unit_cents: 45000 });
      await orders.logOrderWork(database, order.id, { line_id: day.id, happened_on: '2026-09-10', quantity: 1 });
      await orders.logOrderWork(database, order.id, { line_id: day.id, happened_on: '2026-09-11', quantity: 0.5 });
      await orders.getOrder(database, order.id, { today: '2026-09-22' });

      // Pinned like the reads around it: on the real date a new month's Care
      // charge is accrued and the total moves.
      const made = await orders.invoiceOrder(database, order.id, { today: '2026-09-22' });
      const descriptions = made.invoice.lines.map((l) => l.description);
      expect(descriptions).toContain('Website build');
      expect(descriptions.some((d) => d.startsWith('Care · 2026-07'))).toBe(true);
      // Two logged days are one line of 1.5, not two lines.
      const shoot = made.invoice.lines.find((l) => l.description === 'Shoot day');
      expect(shoot.quantity).toBe(1.5);
      expect(made.invoice.total_cents).toBe(300000 + 36000 + 67500);

      const after = await orders.getOrder(database, order.id, { today: '2026-09-22' });
      expect(after.totals.uninvoiced_cents).toBe(0);
      expect(after.totals.accrued_cents).toBe(403500);
    });
  });

  it('refuses to invoice the same charges twice', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'once', description: 'Build', unit_cents: 100000 });
      await orders.invoiceOrder(database, order.id);
      await expect(orders.invoiceOrder(database, order.id)).rejects.toThrow(/not already invoiced/);
    });
  });

  it('leaves a later month to the next invoice', async () => {
    await withOrder(async (database, order) => {
      await orders.addOrderLine(database, order.id, { kind: 'monthly', description: 'Care', unit_cents: 12000, starts_on: order.started_on });
      await orders.getOrder(database, order.id, { today: '2026-08-15' });
      await orders.invoiceOrder(database, order.id, { today: '2026-08-15' });
      // September begins; one month accrues and is owed on its own.
      const next = await orders.getOrder(database, order.id, { today: '2026-09-01' });
      expect(next.totals.uninvoiced_cents).toBe(12000);
    });
  });

  it('keeps a charge that is on an invoice from being deleted', async () => {
    await withOrder(async (database, order) => {
      const line = await orders.addOrderLine(database, order.id, { kind: 'once', description: 'Build', unit_cents: 100000 });
      await orders.invoiceOrder(database, order.id);
      await expect(orders.removeOrderLine(database, order.id, line.id)).rejects.toThrow(/on an invoice/);
      await expect(orders.deleteOrder(database, order.id)).rejects.toThrow(/end it instead/);
    });
  });
});

describe('one client, several projects', () => {
  it('keeps each project’s order and its money apart', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      const client = await db.createClient(database, { name: 'One Client', initials: 'OC' });
      const site = await orders.createOrder(database, { client_id: client.id, slug: 'their-site', title: 'Website', started_on: '2026-07-01' });
      const film = await orders.createOrder(database, { client_id: client.id, slug: 'their-film', title: 'Film', started_on: '2026-07-01' });
      await orders.addOrderLine(database, site.id, { kind: 'monthly', description: 'Care', unit_cents: 12000, starts_on: site.started_on });
      await orders.addOrderLine(database, film.id, { kind: 'daily', description: 'Shoot day', unit_cents: 45000 });

      expect((await orders.listOrders(database, { clientId: client.id }))).toHaveLength(2);
      expect((await orders.listOrders(database, { slug: 'their-site' }))).toHaveLength(1);

      const siteOrder = await orders.getOrder(database, site.id, { today: '2026-08-01' });
      const filmOrder = await orders.getOrder(database, film.id, { today: '2026-08-01' });
      expect(siteOrder.totals.uninvoiced_cents).toBe(24000);
      expect(filmOrder.totals.uninvoiced_cents).toBe(0);
    } finally { await dispose(); }
  });
});

describe('orderTotals', () => {
  it('reads the agreement and the charges apart from each other', () => {
    const lines = [
      { kind: 'monthly', unit_cents: 12000, quantity: 1 },
      { kind: 'daily', unit_cents: 45000, quantity: 1 },
      { kind: 'hourly', unit_cents: 8000, quantity: 1 },
      { kind: 'once', unit_cents: 300000, quantity: 1 },
    ];
    const entries = [
      { kind: 'monthly', unit_cents: 12000, quantity: 1, invoice_id: 7 },
      { kind: 'daily', unit_cents: 45000, quantity: 2, invoice_id: null },
      { kind: 'hourly', unit_cents: 8000, quantity: 24, invoice_id: null },
    ];
    expect(orderTotals(lines, entries)).toMatchObject({
      monthly_cents: 12000, day_rate_cents: 45000, hour_rate_cents: 8000, once_cents: 300000,
      days_logged: 2, hours_logged: 24,
      accrued_cents: 294000, uninvoiced_cents: 282000, uninvoiced_count: 2,
    });
  });
});

describe('a double click never bills twice (audit, 13 Nov)', () => {
  it('two invoicing calls at once: one draft with the charges, the other refused', async () => {
    await withOrder(async (database, order) => {
      const day = await orders.addOrderLine(database, order.id, { kind: 'daily', description: 'Shoot day', unit_cents: 45000 });
      await orders.logOrderWork(database, order.id, { line_id: day.id, happened_on: '2026-09-10', quantity: 1 });
      const results = await Promise.allSettled([
        orders.invoiceOrder(database, order.id, { today: '2026-09-22' }),
        orders.invoiceOrder(database, order.id, { today: '2026-09-22' }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value);
      expect(ok).toHaveLength(1);
      const drafts = await database.prepare("SELECT id, total_cents FROM invoices WHERE number IS NULL").all();
      expect(drafts.results.filter((d) => d.total_cents > 0)).toHaveLength(1);
      expect(drafts.results.filter((d) => d.total_cents === 0)).toHaveLength(0);
      const unclaimed = await database.prepare('SELECT COUNT(*) AS n FROM order_entries WHERE invoice_id IS NULL').first();
      expect(unclaimed.n).toBe(0);
    });
  }, 30000);
});
