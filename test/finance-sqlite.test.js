import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';

/**
 * The finance tests next door run against a fake D1 that only records
 * statements: they prove which SQL is built and which values are bound, and
 * nothing at all about whether that SQL runs. These run the same code against
 * the engine production uses — workerd's SQLite, through Miniflare — with
 * every migration applied in order.
 *
 * That is what the numbering, the payment arithmetic and the cascade need:
 * `printf('%02d', (SELECT COUNT(*) ...))` inside an UPDATE, a correlated
 * subquery in a SET clause, and `ON DELETE CASCADE` are all things a
 * recording fake will happily accept and a database may not. It also covers
 * review finding O-5 — nothing anywhere exercised the cascade, because
 * scripts/database-smoke.mjs was the only real-SQLite check and it is not
 * part of the test suite.
 *
 * Every database here is created empty and thrown away. No production data.
 */

/** Runs `fn` against a fresh database and always disposes of it. */
async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}

/** Four settled invoices from 2025 for another client. They are paid, and
 *  paid in a different year, so they add nothing to this year's figures —
 *  and since the counter is per (series, year), they take nothing from the
 *  2026 sequence either. */
async function seedHistory(database) {
  const older = await db.createClient(database, {
    name: 'Earlier client', initials: 'SA', country: 'BE', vat_number: 'BE0000000000',
  });
  for (let n = 1; n <= 4; n += 1) {
    const invoice = await db.createInvoice(database, { client_id: older.id, subject: `Archive ${n}`, vat_treatment: 'exempt_small' });
    // eslint-disable-next-line no-await-in-loop -- the sequence is the point
    await db.setInvoiceLines(database, invoice.id, [{ description: 'Campaign', quantity: 1, unit_cents: 50000 }]);
    await db.issueInvoice(database, invoice.id, `2025-0${n}-01`);
    await db.markPaid(database, invoice.id, `2025-0${n}-15`);
  }
  return older;
}

/** Invoice 5.R.A.L.01 as the printed document has it: €3000.00 of project,
 *  €1700.00 asked for now, €1700.00 paid. */
async function seedRunningInvoice(database) {
  const client = await db.createClient(database, {
    name: 'Aubin chirurgie plastique SRL', initials: 'L', slug: 'marc-aubin',
    country: 'BE', vat_number: 'BE 0000 000 097',
  });
  const invoice = await db.createInvoice(database, {
    client_id: client.id,
    subject: 'Visual creation package - Prepayment',
    kind: 'prepayment',
    request_cents: 170000,
  });
  await db.setInvoiceLines(database, invoice.id, [
    { description: 'Website — Design, creation', quantity: 1, unit_cents: 200000 },
    { description: 'Website marketing — SEO + Google', quantity: 1, unit_cents: 60000 },
    { description: 'Digital marketing — Design + Post (3x a week) + website maintenance · monthly cost', quantity: 1, unit_cents: 40000 },
  ]);
  await db.issueInvoice(database, invoice.id, '2026-07-09');
  // The real 5.R.A.L.01 belongs to the CLOSED `agency` series and its `5`
  // came from the old global counter, which the owner's final rule
  // (addendum 4, 2026-09-21) replaces with a per-(series, year) one. So the
  // row is pinned here exactly as the one-off data statement pins it in the
  // real databases, rather than pretended to be re-allocatable: what the new
  // rule allocates is what the tests below assert, starting from 1.
  await database.prepare(
    "UPDATE invoices SET series = 'agency', seq = 5, year = 2026, number = '5.R.A.L.01' WHERE id = ?",
  ).bind(invoice.id).run();
  const issued = await db.getInvoice(database, invoice.id);
  await db.markSent(database, invoice.id, '2026-07-09');
  await db.recordPayment(database, invoice.id, {
    amount_cents: 170000,
    paid_on: '2026-07-09',
    label: 'Prepayment website (50%) €1,300 + Digital marketing €400 (date = invoice date; actual payment date not recorded)',
  });
  return { client, issued };
}

describe('migrations apply to real SQLite', () => {
  it('runs every migration in order, including 0006', async () => {
    await withDatabase(async (database) => {
      const tables = await database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all();
      const names = tables.results.map((r) => r.name);
      expect(names).toContain('payments');
      expect(names).toContain('invoices');

      const columns = await database.prepare('PRAGMA table_info(invoices)').all();
      const byName = Object.fromEntries(columns.results.map((c) => [c.name, c]));
      expect(byName.kind.dflt_value).toBe("'invoice'");
      expect(byName.request_cents).toBeTruthy();
      expect(byName.parent_id).toBeTruthy();
    });
  }, 30000);

  it('counts per series and per year: the unique index is on (series, year, seq)', async () => {
    await withDatabase(async (database) => {
      const index = await database.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'invoices_series_year_seq'",
      ).first();
      expect(index?.sql).toMatch(/ON invoices\(series, year, seq\) WHERE seq IS NOT NULL/);
      for (const gone of ['invoices_seq_unique', 'invoices_seq_per_year']) {
        // eslint-disable-next-line no-await-in-loop -- two lookups
        expect(await database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').bind(gone).first()).toBeNull();
      }
      const columns = await database.prepare('PRAGMA table_info(invoices)').all();
      const series = columns.results.find((c) => c.name === 'series');
      expect(series.notnull).toBe(1);
      expect(series.dflt_value).toBe("'studio'");
    });
  }, 30000);

  it('enforces the payments CHECK and the invoice kind CHECK', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE' });
      const invoice = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });

      await expect(database.prepare(
        "INSERT INTO payments (invoice_id, amount_cents, paid_on, label, created_at) VALUES (?, 0, '2026-01-01', '', 'x')",
      ).bind(invoice.id).run()).rejects.toThrow(/CHECK constraint failed/);

      await expect(database.prepare(
        "UPDATE invoices SET kind = 'quote' WHERE id = ?",
      ).bind(invoice.id).run()).rejects.toThrow(/CHECK constraint failed/);
    });
  }, 30000);
});

/** Review finding O-5: `deleteDraft` issues only `DELETE FROM invoices` and
 *  trusts `ON DELETE CASCADE`, which nothing had ever exercised. */
describe('cascade', () => {
  it('deleting a draft takes its lines with it', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE' });
      const invoice = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, invoice.id, [
        { description: 'One', quantity: 1, unit_cents: 1000 },
        { description: 'Two', quantity: 2, unit_cents: 2500 },
      ]);

      const before = await database.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?').bind(invoice.id).first();
      expect(before.n).toBe(2);

      expect(await db.deleteDraft(database, invoice.id)).toBe(true);

      const after = await database.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?').bind(invoice.id).first();
      expect(after.n).toBe(0);
    });
  }, 30000);

  it('deleting an invoice takes its payments with it', async () => {
    await withDatabase(async (database) => {
      const { issued } = await seedRunningInvoice(database);
      const before = await database.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?').bind(issued.id).first();
      expect(before.n).toBe(1);

      // db.js never deletes an issued invoice — this is the foreign key
      // itself under test, not a code path.
      await database.prepare('DELETE FROM invoices WHERE id = ?').bind(issued.id).run();
      const after = await database.prepare('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?').bind(issued.id).first();
      expect(after.n).toBe(0);
    });
  }, 30000);
});

describe('invoice 5.R.A.L.01, as the owner has it', () => {
  it('numbers itself 5.R.A.L.01 and carries the project total with the prepayment paid', async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { issued } = await seedRunningInvoice(database);

      expect(issued.number).toBe('5.R.A.L.01');
      expect(issued.seq).toBe(5);
      expect(issued.year).toBe(2026);
      expect(issued.due_on).toBe('2026-08-08');

      const invoice = await db.getInvoice(database, issued.id);
      expect(invoice.total_cents).toBe(300000);
      expect(invoice.request_cents).toBe(170000);
      expect(invoice.paid_cents).toBe(170000);
      expect(invoice.due_cents).toBe(0);            // part 1 is settled
      expect(invoice.balance_cents).toBe(130000);   // part 2, not yet asked for
      expect(invoice.not_yet_requested_cents).toBe(130000);
      expect(invoice.computed_status).toBe('paid');
      expect(invoice.overdue).toBe(false);
      expect(invoice.lines.map((l) => l.amount_cents)).toEqual([200000, 60000, 40000]);
      expect(invoice.payments).toHaveLength(1);
      expect(invoice.payments[0].amount_cents).toBe(170000);
      // paid_on is a cache of the payments, recomputed, never set on its own.
      expect(invoice.paid_on).toBe('2026-07-09');
    });
  }, 30000);

  it("the owner's overview: outstanding 0, overdue 0, paid this year 170000, not yet invoiced 130000", async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      await seedRunningInvoice(database);

      const overview = await db.financeOverview(database, '2026-09-20');
      expect(overview.outstanding_cents).toBe(0);
      expect(overview.overdue_cents).toBe(0);
      expect(overview.paid_this_year_cents).toBe(170000);
      expect(overview.not_yet_requested_cents).toBe(130000);
      expect(overview.by_client).toEqual([]); // nobody owes anything today
    });
  }, 30000);

  it('would be overdue for its requested amount, and only that, if it had not been paid', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'Aubin', initials: 'L', country: 'BE', vat_number: 'BE082' });
      const invoice = await db.createInvoice(database, {
        client_id: client.id, subject: 'Prepayment', kind: 'prepayment', request_cents: 170000,
      });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Project', quantity: 1, unit_cents: 300000 }]);
      await db.issueInvoice(database, invoice.id, '2026-07-09');

      const overview = await db.financeOverview(database, '2026-09-20');
      expect(overview.outstanding_cents).toBe(170000); // never the 300000 total
      expect(overview.overdue_cents).toBe(170000);     // due 2026-08-08 < today
      expect(overview.not_yet_requested_cents).toBe(130000);
      expect(overview.by_client).toEqual([{ client_id: client.id, name: 'Aubin', outstanding_cents: 170000 }]);
    });
  }, 30000);

  it('refuses a payment above what it asked for, and records a partial one', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'Aubin', initials: 'L', country: 'BE', vat_number: 'BE082' });
      const invoice = await db.createInvoice(database, {
        client_id: client.id, kind: 'prepayment', request_cents: 170000, vat_treatment: 'exempt_small',
      });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Project', quantity: 1, unit_cents: 300000 }]);
      await db.issueInvoice(database, invoice.id, '2026-07-09');

      await expect(db.recordPayment(database, invoice.id, { amount_cents: 170001, paid_on: '2026-07-09' }))
        .rejects.toMatchObject({ field: 'amount_cents' });

      await db.recordPayment(database, invoice.id, { amount_cents: 40000, paid_on: '2026-07-09', label: 'Digital marketing' });
      const partly = await db.getInvoice(database, invoice.id);
      expect(partly.paid_cents).toBe(40000);
      expect(partly.due_cents).toBe(130000);
      expect(partly.computed_status).toBe('issued');
      expect(partly.paid_on).toBeNull(); // not settled, so no settled date

      await db.recordPayment(database, invoice.id, { amount_cents: 130000, paid_on: '2026-07-20', label: 'Website 50%' });
      const settled = await db.getInvoice(database, invoice.id);
      expect(settled.due_cents).toBe(0);
      expect(settled.computed_status).toBe('paid');
      expect(settled.paid_on).toBe('2026-07-20'); // the payment that settled it
      expect((await db.financeOverview(database, '2026-09-20')).paid_this_year_cents).toBe(170000);
    });
  }, 30000);
});

describe('numbering, on the engine that allocates it', () => {
  /** The two numbers the owner named when he restated the rule. */
  it("the studio series starts at 1: Aubin's next 2026 invoice is 1.R.A.L.02", async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { client } = await seedRunningInvoice(database);

      const second = await db.createInvoice(database, { client_id: client.id, subject: 'Second', vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, second.id, [{ description: 'More work', quantity: 1, unit_cents: 50000 }]);
      const issued = await db.issueInvoice(database, second.id, '2026-09-20');

      // 1 — first of the studio series in 2026, the agency's 5 not counting.
      // A — Andy, fixed. L — Aubin. 02 — her second invoice, all time.
      expect(issued.number).toBe('1.R.A.L.02');
      expect(issued.series).toBe('studio');
      expect(issued.seq).toBe(1);
    });
  }, 30000);

  it('a new client issued after it is 2.R.A.SC.01 — the year runs on, the client counter starts', async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { client } = await seedRunningInvoice(database);

      const second = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, second.id, [{ description: 'More work', quantity: 1, unit_cents: 50000 }]);
      await db.issueInvoice(database, second.id, '2026-09-20');

      const fresh = await db.createClient(database, { name: 'Lumen', initials: 'SC', country: 'NL', vat_number: 'NL1' });
      const invoice = await db.createInvoice(database, { client_id: fresh.id, subject: 'First', vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Campaign', quantity: 1, unit_cents: 90000 }]);
      const issued = await db.issueInvoice(database, invoice.id, '2026-09-21');

      expect(issued.number).toBe('2.R.A.SC.01');
      expect(issued.seq).toBe(2);
    });
  }, 30000);

  it('restarts in January: the first invoice of the next year is 1 again', async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { client } = await seedRunningInvoice(database);

      const same = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, same.id, [{ description: 'This year', quantity: 1, unit_cents: 10000 }]);
      await db.issueInvoice(database, same.id, '2026-12-31');

      const next = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, next.id, [{ description: 'New year', quantity: 1, unit_cents: 10000 }]);
      const issued = await db.issueInvoice(database, next.id, '2027-01-02');

      expect(issued.number).toBe('1.R.A.L.03');
      expect(issued.seq).toBe(1);
      expect(issued.year).toBe(2027);
    });
  }, 30000);

  it('the A is fixed and the initials carry no dot', async () => {
    await withDatabase(async (database) => {
      await expect(db.createClient(database, { name: 'Old shape', initials: 'A.L', country: 'BE' }))
        .rejects.toMatchObject({ field: 'initials' });
    });
  }, 30000);

  it('refuses to issue for a client with no initials', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'Nameless', country: 'BE' });
      const invoice = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Work', quantity: 1, unit_cents: 1000 }]);
      await expect(db.issueInvoice(database, invoice.id)).rejects.toMatchObject({ field: 'initials' });
    });
  }, 30000);
});

describe('part 2 of the prepayment', () => {
  it('drafts the balance, and the parent stops reporting it once part 2 is issued', async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { issued: parent } = await seedRunningInvoice(database);

      const part = await db.createPartInvoice(database, parent.id);
      expect(part.subject).toBe('Visual creation package - Part 2 (final invoice)');
      expect(part.parent_id).toBe(parent.id);
      expect(part.total_cents).toBe(130000);
      expect(part.lines).toHaveLength(1);
      expect(part.lines[0].description).toBe('Balance of Visual creation package — project total €3,000.00, prepayment €1,700.00 invoiced on 5.R.A.L.01');
      expect(part.computed_status).toBe('draft');

      // A draft is not an invoice anyone has been sent: the parent still
      // reports the balance as not yet invoiced.
      expect((await db.getInvoice(database, parent.id)).not_yet_requested_cents).toBe(130000);
      expect((await db.financeOverview(database, '2026-09-20')).not_yet_requested_cents).toBe(130000);

      const issuedPart = await db.issueInvoice(database, part.id, '2026-09-20');
      expect(issuedPart.number).toBe('5.R.A.L.02');

      expect((await db.getInvoice(database, parent.id)).not_yet_requested_cents).toBe(0);
      const overview = await db.financeOverview(database, '2026-09-20');
      expect(overview.not_yet_requested_cents).toBe(0);
      expect(overview.outstanding_cents).toBe(130000); // now it really is owed
      expect(overview.overdue_cents).toBe(0);          // due 2026-10-20
    });
  }, 30000);

  // Audit A3 (13 Nov): the balance came from VAT-inclusive totals and was then
  // taxed again as a line. No live invoice ever carried VAT, so none was wrong.
  it('at 21% VAT, part 2 asks for exactly the rest of the project, VAT included once', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'A Studio', initials: 'S', country: 'BE', vat_number: 'BE0123' });
      const invoice = await db.createInvoice(database, {
        client_id: client.id, subject: 'Website - Prepayment', kind: 'prepayment', request_cents: 121000, vat_treatment: 'standard',
      });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Website', quantity: 1, unit_cents: 300000 }]);
      const parent = await db.issueInvoice(database, invoice.id, '2026-11-02');
      expect(parent.total_cents).toBe(363000);

      const part = await db.createPartInvoice(database, parent.id);
      expect(part.vat_treatment).toBe('standard');
      expect(part.lines[0].unit_cents).toBe(200000); // net
      expect(part.subtotal_cents).toBe(200000);
      expect(part.vat_cents).toBe(42000);
      expect(part.total_cents).toBe(242000);         // 363000 − 121000, not 292820
    });
  }, 30000);

  it('at 21% VAT, an amount no net lands on is never billed over', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'B Studio', initials: 'B', country: 'BE', vat_number: 'BE0456' });
      const invoice = await db.createInvoice(database, {
        client_id: client.id, subject: 'Site - Prepayment', kind: 'prepayment', request_cents: 50000, vat_treatment: 'standard',
      });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Site', quantity: 1, unit_cents: 100001 }]);
      const parent = await db.issueInvoice(database, invoice.id, '2026-11-02');
      const remaining = parent.total_cents - 50000;
      const part = await db.createPartInvoice(database, parent.id);
      expect(part.total_cents).toBeLessThanOrEqual(remaining);
      expect(remaining - part.total_cents).toBeLessThanOrEqual(1);
    });
  }, 30000);

  it('finds the net of a gross amount for every treatment', () => {
    expect(db.netForGross(130000, 'exempt_small')).toBe(130000);
    expect(db.netForGross(130000, 'reverse_charge')).toBe(130000);
    expect(db.netForGross(242000, 'standard')).toBe(200000);
    for (let gross = 1; gross < 3000; gross += 7) {
      const net = db.netForGross(gross, 'standard');
      const total = net + Math.round((net * 21) / 100);
      expect(total).toBeLessThanOrEqual(gross);
      expect(gross - total).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a second part once nothing is left', async () => {
    await withDatabase(async (database) => {
      const { issued: parent } = await seedRunningInvoice(database);
      const part = await db.createPartInvoice(database, parent.id);
      await db.issueInvoice(database, part.id, '2026-09-20');
      await expect(db.createPartInvoice(database, parent.id)).rejects.toMatchObject({ field: 'request_cents' });
    });
  }, 30000);
});

/**
 * "The website I'm making IS the invoice": the project slug is the join.
 * `marc-aubin` is the slug in projects.json, on the client, and on the
 * invoice — the project page and the finance screen are looking at one thing.
 */
describe('a project and its money', () => {
  it('a draft inherits its client project, and the project totals add up', async () => {
    await withDatabase(async (database) => {
      await seedHistory(database);
      const { issued } = await seedRunningInvoice(database);

      // The invoice was created without a slug; it took the client's.
      expect(issued.slug).toBe('marc-aubin');

      const project = await db.financeProject(database, 'marc-aubin');
      expect(project.client.name).toBe('Aubin chirurgie plastique SRL');
      expect(project.invoices).toHaveLength(1);
      expect(project.invoices[0].number).toBe('5.R.A.L.01');
      expect(project.totals).toEqual({
        invoiced_cents: 300000,
        paid_cents: 170000,
        owed_now_cents: 0,
        not_yet_requested_cents: 130000,
      });
    });
  }, 30000);

  it('an explicit null slug keeps a draft off the project', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', slug: 'marc-aubin', country: 'BE' });
      const invoice = await db.createInvoice(database, { client_id: client.id, slug: null, vat_treatment: 'exempt_small' });
      expect(invoice.slug).toBeNull();
      expect((await db.financeProject(database, 'marc-aubin')).invoices).toHaveLength(0);
    });
  }, 30000);

  it('part 2 does not invoice the project twice', async () => {
    await withDatabase(async (database) => {
      const { issued: parent } = await seedRunningInvoice(database);
      const part = await db.createPartInvoice(database, parent.id);
      await db.issueInvoice(database, part.id, '2026-09-20');

      const project = await db.financeProject(database, 'marc-aubin');
      expect(project.invoices).toHaveLength(2);
      // The parent already carries the whole €3000.00 project.
      expect(project.totals.invoiced_cents).toBe(300000);
      expect(project.totals.paid_cents).toBe(170000);
      expect(project.totals.owed_now_cents).toBe(130000);
      expect(project.totals.not_yet_requested_cents).toBe(0);
    });
  }, 30000);

  it('an empty project answers with nothing rather than failing', async () => {
    await withDatabase(async (database) => {
      const project = await db.financeProject(database, 'realis-studio');
      expect(project.client).toBeNull();
      expect(project.invoices).toEqual([]);
      expect(project.totals.invoiced_cents).toBe(0);
    });
  }, 30000);
});

/**
 * The three things a recording fake cannot answer: whether a second part
 * draft is really refused, whether the payment guard really holds when two
 * requests race, and whether a written row really comes back in the same
 * shape as a read one.
 */
describe('the guards, on the engine that enforces them', () => {
  it('refuses a second part draft, and the parent clears once part 2 is issued', async () => {
    await withDatabase(async (database) => {
      const { issued: parent } = await seedRunningInvoice(database);

      const part = await db.createPartInvoice(database, parent.id);
      expect(part.total_cents).toBe(130000);

      // H-1: the reported figure ignores drafts, so drafting twice used to
      // hand out the same €1300.00 balance again — and issuing both billed
      // €4300.00 on a €3000.00 project.
      await expect(db.createPartInvoice(database, parent.id)).rejects.toMatchObject({
        field: 'parent_id',
        message: `part 2 already exists (draft #${part.id})`,
      });
      const invoices = await db.listInvoices(database);
      expect(invoices).toHaveLength(2); // the prepayment and its one draft

      await db.issueInvoice(database, part.id, '2026-09-20');
      expect((await db.getInvoice(database, parent.id)).not_yet_requested_cents).toBe(0);

      // And with the balance now on its own invoice, there is nothing to
      // continue — the project is invoiced exactly once.
      await expect(db.createPartInvoice(database, parent.id)).rejects.toMatchObject({ field: 'request_cents' });
      const project = await db.financeProject(database, 'marc-aubin');
      expect(project.totals.invoiced_cents).toBe(300000);
      expect(project.totals.owed_now_cents).toBe(130000);
    });
  }, 30000);

  it('a voided part draft gives the balance back', async () => {
    await withDatabase(async (database) => {
      const { issued: parent } = await seedRunningInvoice(database);
      const part = await db.createPartInvoice(database, parent.id);
      await db.deleteDraft(database, part.id);

      const again = await db.createPartInvoice(database, parent.id);
      expect(again.total_cents).toBe(130000);
      expect(again.subject).toBe('Visual creation package - Part 2 (final invoice)');
    });
  }, 30000);

  /** M-2: read-then-insert is not a lock. The condition is inside the INSERT,
   *  so whichever of two racing payments lands second writes nothing. */
  it('two payments that would together exceed the request: one lands, one is refused', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'Aubin', initials: 'L', country: 'BE', vat_number: 'BE082' });
      const invoice = await db.createInvoice(database, {
        client_id: client.id, kind: 'prepayment', request_cents: 170000, vat_treatment: 'exempt_small',
      });
      await db.setInvoiceLines(database, invoice.id, [{ description: 'Project', quantity: 1, unit_cents: 300000 }]);
      await db.issueInvoice(database, invoice.id, '2026-07-09');

      const results = await Promise.allSettled([
        db.recordPayment(database, invoice.id, { amount_cents: 170000, paid_on: '2026-07-09', label: 'A' }),
        db.recordPayment(database, invoice.id, { amount_cents: 170000, paid_on: '2026-07-09', label: 'B' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ field: 'amount_cents' });

      const after = await db.getInvoice(database, invoice.id);
      expect(after.paid_cents).toBe(170000);
      expect(after.due_cents).toBe(0);     // never negative
      expect(after.payments).toHaveLength(1);
    });
  }, 30000);

  it('a sequential second payment past the request is refused too', async () => {
    await withDatabase(async (database) => {
      const { issued } = await seedRunningInvoice(database); // already paid in full
      await expect(db.recordPayment(database, issued.id, { amount_cents: 1, paid_on: '2026-08-01' }))
        .rejects.toMatchObject({ field: 'amount_cents' });
      expect((await db.getInvoice(database, issued.id)).payments).toHaveLength(1);
    });
  }, 30000);

  /** M-1: one shape for an invoice, read or written. A screen that
   *  re-renders from a mutation response must not get a thinner row. */
  it('every mutation answers with the same row a GET does', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, {
        name: 'Aubin', initials: 'L', slug: 'marc-aubin', country: 'BE', vat_number: 'BE082',
      });
      const { lines, client: _client, payments, ...draft } = await db.getInvoice(
        database,
        (await db.createInvoice(database, { client_id: client.id, kind: 'prepayment', request_cents: 170000, vat_treatment: 'exempt_small' })).id,
      );
      const id = draft.id;

      /** The detail read, minus the three collections only it carries. */
      const readBack = async () => {
        const { lines: _l, client: _c, payments: _p, ...row } = await db.getInvoice(database, id);
        return row;
      };

      const patched = await db.updateInvoice(database, id, { subject: 'Visual creation package' });
      expect(patched).toEqual(await readBack());

      const { lines: _lines, ...withLines } = await db.setInvoiceLines(database, id, [
        { description: 'Project', quantity: 1, unit_cents: 300000 },
      ]);
      expect(withLines).toEqual(await readBack());

      const issued = await db.issueInvoice(database, id, '2026-07-09');
      expect(issued).toEqual(await readBack());
      expect(issued.computed_status).toBe('issued');
      expect(issued.not_yet_requested_cents).toBe(130000);

      const sent = await db.markSent(database, id, '2026-07-09');
      expect(sent).toEqual(await readBack());
      expect(sent.computed_status).toBe('sent');

      await db.recordPayment(database, id, { amount_cents: 170000, paid_on: '2026-07-09' });
      const paid = await readBack();
      expect(paid.computed_status).toBe('paid');
      expect(paid.overdue).toBe(false);

      const voided = await db.voidInvoice(database, id, 'test');
      expect(voided).toEqual(await readBack());
      expect(voided.computed_status).toBe('void');
    });
  }, 30000);
});

/**
 * Review finding H2. The editor used to PATCH the header and then PUT the
 * lines. A refusal on the second left the first stored — and, when the VAT
 * treatment was in the patch, the totals already recomputed against it —
 * while the screen reported a field error, which reads as "nothing saved".
 * `saveInvoice` writes both in one `db.batch`, so this is about the database
 * actually rolling the header back, not about the SQL that was built.
 */
describe('saveInvoice writes the header and the lines atomically', () => {
  it('applies both halves and recomputes the totals against the NEW treatment', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE', vat_number: 'BE0000000097' });
      const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'reverse_charge' });
      await db.setInvoiceLines(database, draft.id, [{ description: 'Old', quantity: 1, unit_cents: 100000 }]);

      const saved = await db.saveInvoice(database, draft.id, {
        subject: 'Visual creation package', vat_treatment: 'standard',
      }, [
        { description: 'Website', quantity: 2, unit_cents: 100000 },
      ]);

      expect(saved.subject).toBe('Visual creation package');
      expect(saved.vat_treatment).toBe('standard');
      expect(saved.lines).toHaveLength(1);
      expect(saved.lines[0].description).toBe('Website');
      // 21% of the NEW lines, not of the old ones and not at the old rate.
      expect(saved.subtotal_cents).toBe(200000);
      expect(saved.vat_cents).toBe(42000);
      expect(saved.total_cents).toBe(242000);
      expect(saved).toEqual(await db.getInvoice(database, draft.id));
    });
  }, 30000);

  it('a refused line leaves the header exactly as it was', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE' });
      const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'reverse_charge' });
      await db.setInvoiceLines(database, draft.id, [{ description: 'Old', quantity: 1, unit_cents: 100000 }]);
      const before = await db.getInvoice(database, draft.id);

      await expect(db.saveInvoice(database, draft.id, { vat_treatment: 'standard' }, [
        { description: 'Website', quantity: 0, unit_cents: 100000 },
      ])).rejects.toMatchObject({ field: 'lines[0].quantity' });

      const after = await db.getInvoice(database, draft.id);
      expect(after.vat_treatment).toBe('reverse_charge');
      expect(after.vat_cents).toBe(0);
      expect(after).toEqual(before);
    });
  }, 30000);

  it('a statement the database refuses rolls the whole batch back — lines included', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE' });
      const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'reverse_charge' });
      await db.setInvoiceLines(database, draft.id, [{ description: 'Old', quantity: 1, unit_cents: 100000 }]);
      const before = await db.getInvoice(database, draft.id);

      // The header UPDATE is the LAST statement in the batch: the line DELETE
      // and INSERTs have already run when this foreign key is refused. If the
      // batch were not a transaction the invoice would be left with the new
      // lines and the old header — exactly H2's half-saved state.
      await expect(db.saveInvoice(database, draft.id, { client_id: 999999 }, [
        { description: 'Website', quantity: 1, unit_cents: 250000 },
      ])).rejects.toThrow();

      const after = await db.getInvoice(database, draft.id);
      expect(after.lines).toHaveLength(1);
      expect(after.lines[0].description).toBe('Old');
      expect(after).toEqual(before);
    });
  }, 30000);

  it('refuses to touch an issued invoice', async () => {
    await withDatabase(async (database) => {
      const { issued } = await seedRunningInvoice(database);
      await expect(db.saveInvoice(database, issued.id, { subject: 'No' }, [
        { description: 'X', quantity: 1, unit_cents: 100 },
      ])).rejects.toMatchObject({ field: 'status' });
    });
  }, 30000);

  it('needs at least one line, and answers null for an invoice that is not there', async () => {
    await withDatabase(async (database) => {
      const client = await db.createClient(database, { name: 'X', initials: 'X', country: 'BE' });
      const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await expect(db.saveInvoice(database, draft.id, {}, [])).rejects.toMatchObject({ field: 'lines' });
      expect(await db.saveInvoice(database, 999999, {}, [{ description: 'X', quantity: 1, unit_cents: 100 }])).toBeNull();
    });
  }, 30000);
});

describe('undoing an issue that never left the building', () => {
  /** The 1 Oct 2026 situation: a stray second prepayment was numbered
   *  1.R.A.L.02, then part 2 was numbered 2.R.A.L.03. Neither was sent. */
  async function strayThenPart(database) {
    const { issued: parent, client } = await seedRunningInvoice(database);
    const stray = await db.createInvoice(database, {
      client_id: client.id, subject: 'Visual creation package - Prepayment', kind: 'prepayment', request_cents: 130000,
    });
    await db.setInvoiceLines(database, stray.id, [{ description: 'Website', quantity: 1, unit_cents: 300000 }]);
    const strayIssued = await db.issueInvoice(database, stray.id, '2026-10-01');
    const part = await db.createPartInvoice(database, parent.id);
    const partIssued = await db.issueInvoice(database, part.id, '2026-10-01');
    return { parent, strayIssued, partIssued };
  }

  it('refuses the older one while a newer number follows, then lets both unwind with no gap', async () => {
    await withDatabase(async (database) => {
      const { strayIssued, partIssued } = await strayThenPart(database);
      expect(strayIssued.number).toBe('1.R.A.L.02');
      expect(partIssued.number).toBe('5.R.A.L.03');

      await expect(db.unissueInvoice(database, strayIssued.id))
        .rejects.toMatchObject({ field: 'number' });

      const partDraft = await db.unissueInvoice(database, partIssued.id);
      expect(partDraft.number).toBeNull();
      expect(partDraft.status).toBe('draft');

      await db.unissueInvoice(database, strayIssued.id);
      expect(await db.deleteDraft(database, strayIssued.id)).toBe(true);

      // Re-issued, part 2 continues its prepayment: 5.R.A.L.01 -> 5.R.A.L.02.
      const again = await db.issueInvoice(database, partIssued.id, '2026-10-01');
      expect(again.number).toBe('5.R.A.L.02');
      expect(again.seq).toBeNull();

      // The next ordinary invoice still starts the studio series at 1.
      const client = await database.prepare('SELECT client_id FROM invoices WHERE id = ?').bind(partIssued.id).first();
      const next = await db.createInvoice(database, { client_id: client.client_id, subject: 'Care', vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, next.id, [{ description: 'Care', quantity: 1, unit_cents: 12000 }]);
      expect((await db.issueInvoice(database, next.id, '2026-10-02')).number).toBe('1.R.A.L.03');
    });
  }, 30000);

  it('refuses a sent invoice, a paid one, and a parent with a live part', async () => {
    await withDatabase(async (database) => {
      const { parent, partIssued } = await strayThenPart(database);
      await expect(db.unissueInvoice(database, parent.id)).rejects.toMatchObject({ field: 'status' });

      await db.markSent(database, partIssued.id);
      await expect(db.unissueInvoice(database, partIssued.id))
        .rejects.toMatchObject({ message: expect.stringContaining('credit note') });
    });
  }, 30000);
});

describe('naming a follow-up invoice', () => {
  it('drops the parent role from the subject', () => {
    expect(db.projectSubject('Visual creation package - Prepayment')).toBe('Visual creation package');
    expect(db.projectSubject('Visual creation package - Prepayment - Part 2')).toBe('Visual creation package');
    expect(db.projectSubject('Website — Deposit')).toBe('Website');
    expect(db.projectSubject('Brand film')).toBe('Brand film');
  });
});

describe('a void that was never sent', () => {
  it('can be undone and deleted, freeing the client index for part 2', async () => {
    await withDatabase(async (database) => {
      const { issued: parent, client } = await seedRunningInvoice(database);
      const stray = await db.createInvoice(database, { client_id: client.id, subject: 'Stray', vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, stray.id, [{ description: 'Website', quantity: 1, unit_cents: 130000 }]);
      await db.issueInvoice(database, stray.id, '2026-10-01');
      await db.voidInvoice(database, stray.id, 'made by mistake');

      await db.unissueInvoice(database, stray.id);
      expect(await db.deleteDraft(database, stray.id)).toBe(true);

      const part = await db.createPartInvoice(database, parent.id);
      expect((await db.issueInvoice(database, part.id, '2026-10-01')).number).toBe('5.R.A.L.02');
    });
  }, 30000);
});

describe('the bank account on an invoice', () => {
  async function draftFor(database) {
    const client = await db.createClient(database, { name: 'Klant', initials: 'K', country: 'BE', vat_number: 'BE1' });
    const invoice = await db.createInvoice(database, { client_id: client.id, subject: 'Work', vat_treatment: 'exempt_small' });
    return invoice;
  }
  const line = [{ description: 'Work', quantity: 1, unit_cents: 10000 }];

  it('seeds Wise, Second Bank and the closed KBC account, with no real numbers', async () => {
    await withDatabase(async (database) => {
      const accounts = await db.getBankAccounts(database);
      expect(accounts.map((a) => a.id)).toEqual(['wise', 'bog', 'kbc']);
      // KBC is closed: the archive invoices name it, no new invoice can.
      const open = accounts.filter((a) => !a.closed);
      expect(open.map((a) => a.id)).toEqual(['wise', 'bog']);
      // Blank in the code: the real account numbers live in the live settings row.
      expect(accounts.every((a) => a.iban === '')).toBe(true);
    });
  }, 30000);

  it('a draft stores the chosen account; an unknown one is refused by name', async () => {
    await withDatabase(async (database) => {
      const draft = await draftFor(database);
      const saved = await db.saveInvoice(database, draft.id, { bank_account: 'bog' }, line);
      expect(saved.bank_account).toBe('bog');
      await expect(db.saveInvoice(database, draft.id, { bank_account: 'paypal' }, line))
        .rejects.toMatchObject({ field: 'bank_account' });
      await expect(db.updateInvoice(database, draft.id, { bank_account: 'DROP TABLE' }))
        .rejects.toMatchObject({ field: 'bank_account' });
    });
  }, 30000);

  it('can still change on an issued invoice until it is sent, never after', async () => {
    await withDatabase(async (database) => {
      const draft = await draftFor(database);
      await db.saveInvoice(database, draft.id, { bank_account: 'wise' }, line);
      const issued = await db.issueInvoice(database, draft.id, '2026-10-14');
      expect((await db.setInvoiceBankAccount(database, issued.id, 'bog')).bank_account).toBe('bog');
      await db.markSent(database, issued.id, '2026-10-14');
      await expect(db.setInvoiceBankAccount(database, issued.id, 'wise')).rejects.toMatchObject({ field: 'bank_account' });
      expect((await db.getInvoice(database, issued.id)).bank_account).toBe('bog');
    });
  }, 30000);
});
