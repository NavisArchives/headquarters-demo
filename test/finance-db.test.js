import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  VAT_TREATMENTS,
  listClients, createClient, updateClient,
  listInvoices, getInvoice, createInvoice, updateInvoice, setInvoiceLines,
  issueInvoice, markSent, markPaid, voidInvoice, deleteDraft,
  recordPayment, listPayments, createPartInvoice,
  financeOverview, getIssuer,
  ValidationError,
} from '../src/worker/db.js';

/**
 * The same fake-D1 harness as test/db.test.js and test/leads-db.test.js: it
 * records every statement and its bindings, so a test can assert that values
 * were bound rather than interpolated. `first` and `all` are static per-test
 * responses — every `.first()` call gets the same `responses.first`, every
 * `.all()` call gets the same `responses.all`.
 */
function fakeDb(responses = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: responses.all ?? [] }; },
        async first() { return responses.first ?? null; },
        async run() { return { success: true, meta: { last_row_id: responses.lastId ?? 1, changes: responses.changes ?? 1 } }; },
      };
      return stmt;
    },
    // D1's transaction, played statement by statement: each answers like first().
    async batch(statements) {
      const out = [];
      for (const statement of statements) {
        // eslint-disable-next-line no-await-in-loop -- in order, as D1 does
        const row = await statement.first();
        out.push({ results: row ? [row] : [], success: true });
      }
      return out;
    },
  };
}

const clientRow = (over = {}) => ({
  id: 5, name: 'Slippery Chameleon', initials: 'SC', slug: null, email: 'ap@sc.example',
  address: '1 Example St', country: 'NL', vat_number: 'NL123456789B01', company_reg: null,
  created_at: '2026-09-20T10:00:00.000Z', ...over,
});

const invoiceRow = (over = {}) => ({
  id: 5, number: null, seq: null, year: null, client_id: 5, slug: null,
  subject: 'Italiano Drop (UGC)', po_number: 'PO-42', status: 'draft',
  issued_on: null, due_on: null, sent_on: null, paid_on: null,
  currency: 'EUR', vat_treatment: 'reverse_charge',
  subtotal_cents: 0, vat_cents: 0, total_cents: 0, notes: '',
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z',
  ...over,
});

describe('VAT_TREATMENTS', () => {
  it('is frozen and describes rate + required mention for each treatment', () => {
    expect(Object.isFrozen(VAT_TREATMENTS)).toBe(true);
    expect(VAT_TREATMENTS.standard.rate).toBe(21);
    expect(VAT_TREATMENTS.reverse_charge.rate).toBe(0);
    // Addendum 4: the sentence the real invoice prints, verbatim.
    expect(VAT_TREATMENTS.reverse_charge.mention).toBe('Tax (0%) - Reverse charge may apply.');
    expect(VAT_TREATMENTS.reverse_charge.requires_vat_number).toBe(true);
    expect(VAT_TREATMENTS.exempt_small.rate).toBe(0);
    expect(VAT_TREATMENTS.export.rate).toBe(0);
  });
});

describe('getIssuer', () => {
  it('starts blank on a new database: no real details live in the code', async () => {
    const db = fakeDb({ first: null });
    const issuer = await getIssuer(db);
    expect(issuer.name).toBe('');
    expect(issuer.iban).toBe('');
    expect(issuer.address).toBe('');
    expect(issuer.payment_terms_days).toBe(30);
    // getSetting (miss) then setSetting (seed).
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO settings'))).toBe(true);
    expect(db.calls.find((c) => c.sql.includes('INSERT INTO settings')).args).toContain('issuer');
  });

  it('returns the stored value without reseeding once one exists', async () => {
    const db = fakeDb({ first: { value: JSON.stringify({ name: 'Custom Name' }) } });
    const issuer = await getIssuer(db);
    expect(issuer.name).toBe('Custom Name');
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO settings'))).toBe(false);
  });
});

describe('clients', () => {
  it('createClient needs only a name and defaults country to BE', async () => {
    const db = fakeDb({ first: clientRow({ country: 'BE', initials: null, vat_number: null }) });
    const c = await createClient(db, { name: 'Slippery Chameleon' });
    expect(c.name).toBe('Slippery Chameleon');
    expect(db.calls[0].args).toContain('BE');
  });

  it('rejects a missing name before querying', async () => {
    const db = fakeDb();
    await expect(createClient(db, {})).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('binds every value rather than interpolating', async () => {
    const db = fakeDb({ first: clientRow() });
    await createClient(db, { name: "Robert'); DROP TABLE clients;--" });
    expect(db.calls[0].sql).not.toContain('DROP TABLE');
    expect(db.calls[0].args).toContain("Robert'); DROP TABLE clients;--");
  });

  it('updateClient rejects an empty patch', async () => {
    const db = fakeDb();
    await expect(updateClient(db, 5, {})).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('updateClient binds only the writable fields given', async () => {
    const db = fakeDb({ first: clientRow({ vat_number: 'NL999' }) });
    await updateClient(db, 5, { vat_number: 'NL999' });
    expect(db.calls[0].sql).toContain('vat_number = ?');
    expect(db.calls[0].args).toContain('NL999');
    expect(db.calls[0].args).toContain(5);
  });

  it('listClients orders by name', async () => {
    const db = fakeDb({ all: [clientRow()] });
    const rows = await listClients(db);
    expect(rows).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/ORDER BY name ASC/);
  });

  // A TEXT column takes text or nothing; anything else binds quietly and is
  // read back as something the invoice layout never expected.
  it('refuses a non-text value for a text column, naming the field', async () => {
    await expect(createClient(fakeDb(), { name: 'X', vat_number: 42 }))
      .rejects.toMatchObject({ field: 'vat_number' });
    await expect(createClient(fakeDb(), { name: 'X', address: { line1: 'Pijpstraat 6' } }))
      .rejects.toMatchObject({ field: 'address' });
    await expect(updateClient(fakeDb(), 5, { initials: ['S', 'C'] }))
      .rejects.toMatchObject({ field: 'initials' });
  });

  it('still accepts an explicit null for an optional text column', async () => {
    const db = fakeDb({ first: clientRow({ vat_number: null }) });
    await createClient(db, { name: 'X', vat_number: null });
    expect(db.calls[0].args).toContain(null);
  });
});

describe('createInvoice', () => {
  /** A draft with no slug of its own first reads its client's project, so
   *  the INSERT is not always the first statement. */
  const insert = (db) => db.calls.find((c) => c.sql.includes('INSERT INTO invoices'));

  it('needs only a client_id, defaulting vat_treatment to reverse_charge and status to draft', async () => {
    const db = fakeDb({ first: invoiceRow() });
    const inv = await createInvoice(db, { client_id: 5 });
    expect(inv.status).toBe('draft');
    expect(inv.number).toBeNull();
    expect(insert(db).sql).toContain("'draft'");
    expect(insert(db).args).toContain('reverse_charge');
  });

  it("takes its client's project when no slug is given, and nothing when the slug is an explicit null", async () => {
    const inherits = fakeDb({ first: { slug: 'marc-aubin' } });
    await createInvoice(inherits, { client_id: 5 });
    expect(inherits.calls[0].sql).toContain('SELECT slug FROM clients WHERE id = ?');
    expect(insert(inherits).args).toContain('marc-aubin');

    const detached = fakeDb({ first: invoiceRow() });
    await createInvoice(detached, { client_id: 5, slug: null });
    expect(detached.calls.some((c) => c.sql.includes('SELECT slug FROM clients'))).toBe(false);
  });

  it('rejects a missing client_id before querying', async () => {
    const db = fakeDb();
    await expect(createInvoice(db, {})).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an unknown vat_treatment before querying', async () => {
    const db = fakeDb();
    await expect(createInvoice(db, { client_id: 5, vat_treatment: 'made_up' })).rejects.toMatchObject({ field: 'vat_treatment' });
    expect(db.calls).toHaveLength(0);
  });

  it('a draft has no number, seq or year (bound as NULL, not omitted)', async () => {
    const db = fakeDb({ first: invoiceRow() });
    await createInvoice(db, { client_id: 5 });
    expect(insert(db).sql).toMatch(/VALUES \(NULL, NULL, NULL,/);
  });
});

describe('updateInvoice', () => {
  it('drafts only: refuses to edit an already-issued invoice', async () => {
    const db = fakeDb({ first: { id: 5, number: '1.R.SC.26' } });
    await expect(updateInvoice(db, 5, { subject: 'New subject' })).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1); // only the precheck select; no UPDATE fired
  });

  it('returns null for a missing invoice', async () => {
    const db = fakeDb({ first: null });
    expect(await updateInvoice(db, 999, { subject: 'x' })).toBeNull();
  });

  it('ignores fields a caller may not set', async () => {
    // A single object serves both the draft precheck (reads only `.number`)
    // and the UPDATE...RETURNING (reads the full row) — same static-fake
    // convention as test/leads-db.test.js.
    const db = fakeDb({ first: invoiceRow({ number: null, subject: 'New subject' }) });
    const inv = await updateInvoice(db, 5, { subject: 'New subject', id: 99, created_at: 'forged' });
    expect(inv.subject).toBe('New subject');
    const setClause = db.calls[1].sql.split('WHERE')[0];
    expect(setClause).not.toContain('created_at');
    expect(db.calls[1].args).not.toContain('forged');
  });

  it('rejects a text field that is not text', async () => {
    const db = fakeDb({ first: invoiceRow({ number: null }) });
    await expect(updateInvoice(db, 5, { po_number: { toString: () => 'PO-42' } }))
      .rejects.toMatchObject({ field: 'po_number' });
  });
});

/**
 * The HIGH bug from review round 1: `vat_treatment` is writable here, but VAT
 * was only ever computed in setInvoiceLines. A draft defaults to
 * reverse_charge (0%); once its lines are set, subtotal 250000 / vat 0. Change
 * the treatment to standard and the invoice claims 21% while vat_cents is
 * still 0 — issued €525,00 short, printing "VAT 21%" against €0,00.
 */
describe('updateInvoice — VAT follows the treatment', () => {
  const storedLines = [{ amount_cents: 250000 }];

  function totalsUpdate(db) {
    return db.calls.find((c) => c.sql.includes('vat_cents = ?'));
  }

  it('reverse_charge -> standard recomputes vat_cents and total_cents from the stored lines', async () => {
    const db = fakeDb({
      first: invoiceRow({ number: null, vat_treatment: 'standard', subtotal_cents: 250000, vat_cents: 52500, total_cents: 302500 }),
      all: storedLines,
    });

    await updateInvoice(db, 5, { vat_treatment: 'standard' });

    // The lines are read back rather than trusted from the stale stored totals.
    const lineRead = db.calls.find((c) => c.sql.includes('FROM invoice_lines'));
    expect(lineRead).toBeTruthy();
    expect(lineRead.sql).toContain('amount_cents');
    expect(lineRead.args).toContain(5);

    const update = totalsUpdate(db);
    expect(update.sql).toContain('vat_treatment = ?');
    expect(update.sql).toContain('subtotal_cents = ?');
    expect(update.sql).toContain('total_cents = ?');
    // 250000 subtotal, 21% => 52500 VAT, 302500 total — bound, not left at 0.
    expect(update.args).toEqual(expect.arrayContaining(['standard', 250000, 52500, 302500]));
    expect(update.args).not.toContain(0);
    for (const arg of update.args) {
      if (typeof arg === 'number') expect(Number.isInteger(arg)).toBe(true);
    }
  });

  it('standard -> reverse_charge zeroes the VAT again and drops the total back to the subtotal', async () => {
    const db = fakeDb({
      first: invoiceRow({ number: null, vat_treatment: 'reverse_charge', subtotal_cents: 250000, vat_cents: 0, total_cents: 250000 }),
      all: storedLines,
    });

    await updateInvoice(db, 5, { vat_treatment: 'reverse_charge' });

    const update = totalsUpdate(db);
    expect(update.args).toEqual(expect.arrayContaining(['reverse_charge', 250000, 0, 250000]));
  });

  it('leaves the totals alone when the patch does not touch the treatment', async () => {
    const db = fakeDb({ first: invoiceRow({ number: null, subject: 'New subject' }), all: storedLines });
    await updateInvoice(db, 5, { subject: 'New subject' });
    expect(db.calls.some((c) => c.sql.includes('FROM invoice_lines'))).toBe(false);
    expect(db.calls.some((c) => c.sql.includes('vat_cents = ?'))).toBe(false);
  });
});

describe('setInvoiceLines — the money rule', () => {
  it('quantity 3 x 1250 and 2.5 x 999 give amount_cents 3750 and 2498, and every cents figure bound is an integer', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' }, changes: 1 });
    const result = await setInvoiceLines(db, 5, [
      { description: 'Three units', quantity: 3, unit_cents: 1250 },
      { description: 'Half unit', quantity: 2.5, unit_cents: 999 },
    ]);

    expect(result.lines[0].amount_cents).toBe(3750);
    expect(result.lines[1].amount_cents).toBe(2498);
    expect(Number.isInteger(result.lines[0].amount_cents)).toBe(true);
    expect(Number.isInteger(result.lines[1].amount_cents)).toBe(true);

    const inserts = db.calls.filter((c) => c.sql.includes('INSERT INTO invoice_lines'));
    expect(inserts).toHaveLength(2);
    // INSERT args are (invoice_id, description, quantity, unit_cents, amount_cents, no_charge, position).
    for (const insert of inserts) {
      const [, , qty, unitCents, amountCents, noCharge, position] = insert.args;
      // quantity is the one legitimately fractional number in this module —
      // the schema declares it REAL. Every cents figure must still be an integer.
      expect(typeof qty).toBe('number');
      expect(Number.isInteger(unitCents)).toBe(true);
      expect(Number.isInteger(amountCents)).toBe(true);
      expect(Number.isInteger(noCharge)).toBe(true);
      expect(Number.isInteger(position)).toBe(true);
    }
    expect(inserts[0].args[2]).toBe(3);
    expect(inserts[1].args[2]).toBe(2.5);

    const totals = db.calls.find((c) => c.sql.includes('subtotal_cents = ?'));
    for (const arg of totals.args) {
      if (typeof arg === 'number') expect(Number.isInteger(arg)).toBe(true);
    }
    expect(totals.args).toContain(3750 + 2498); // subtotal_cents = sum of the two line amounts
  });

  it('a no_charge line contributes 0 to the subtotal regardless of quantity/unit', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'reverse_charge' } });
    const result = await setInvoiceLines(db, 5, [
      { description: 'Spark Ads / Advertising rights', quantity: 1, unit_cents: 50000, no_charge: true },
    ]);
    expect(result.lines[0].amount_cents).toBe(0);
    expect(result.lines[0].no_charge).toBe(1);
  });

  it('applies the invoice vat_treatment rate to the recomputed totals', async () => {
    // The fake hands back exactly what it is told, never what the SQL would
    // actually compute — so the canned RETURNING row is the values this
    // module's own arithmetic (subtotal 10000, 21% VAT) must produce.
    const db = fakeDb({
      first: invoiceRow({ number: null, vat_treatment: 'standard', subtotal_cents: 10000, vat_cents: 2100, total_cents: 12100 }),
    });
    const result = await setInvoiceLines(db, 5, [{ description: 'Work', quantity: 1, unit_cents: 10000 }]);
    expect(result.subtotal_cents).toBe(10000);
    expect(result.vat_cents).toBe(2100);
    expect(result.total_cents).toBe(12100);

    const totals = db.calls.find((c) => c.sql.includes('subtotal_cents = ?'));
    expect(totals.args).toEqual(expect.arrayContaining([10000, 2100, 12100]));
  });

  /**
   * Policy: half-up on the EXACT DECIMAL value of quantity x unit_cents, never on
   * the binary float. `Math.round(0.29 * 50)` is 14 because 0.29 * 50 is
   * 14.499999999999998 in IEEE-754; the exact decimal is 14.5, which rounds
   * up to 15. These five cases pin the policy down: two float traps, one true
   * tie, and the two cases that must not change.
   */
  it.each([
    ['0.29 x 50 -> 15 (the float says 14.499999999999998; the exact 14.5 rounds up)', 0.29, 50, 15],
    ['2.675 x 180 -> 482 (the float says 481.49999999999994; the exact 481.5 rounds up)', 2.675, 180, 482],
    ['1.5 x 999 -> 1499 (a true tie at 1498.5: half-UP, not half-to-even)', 1.5, 999, 1499],
    ['3 x 1250 -> 3750 (whole quantity, exact)', 3, 1250, 3750],
    ['2.5 x 999 -> 2498 (a true tie at 2497.5: half-UP)', 2.5, 999, 2498],
  ])('rounds %s', async (_label, qty, unitCents, expected) => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'exempt_small' } });
    const result = await setInvoiceLines(db, 5, [{ description: 'Line', quantity: qty, unit_cents: unitCents }]);
    expect(result.lines[0].amount_cents).toBe(expected);
    expect(Number.isInteger(result.lines[0].amount_cents)).toBe(true);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO invoice_lines'));
    expect(insert.args[4]).toBe(expected);
    const totals = db.calls.find((c) => c.sql.includes('subtotal_cents = ?'));
    expect(totals.args).toContain(expected); // subtotal follows the same exact value
  });

  /** One name for it: `quantity`, as the column, the reads and every refusal
   *  have it. `qty` is still read as an input alias so a caller written
   *  against the older shape keeps working, but nothing answers in it. */
  it('answers in `quantity`, and still accepts `qty` on the way in', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'exempt_small' } });
    const result = await setInvoiceLines(db, 5, [{ description: 'Legacy', qty: 2, unit_cents: 1000 }]);
    expect(result.lines[0].quantity).toBe(2);
    expect(result.lines[0]).not.toHaveProperty('qty');
    expect(result.lines[0].amount_cents).toBe(2000);
  });

  it('names every quantity refusal lines[i].quantity, whichever spelling was sent', async () => {
    const db = () => fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' } });
    for (const line of [
      { description: 'x', qty: 0 },
      { description: 'x', quantity: 0 },
      { description: 'x', quantity: -1 },
      { description: 'x', quantity: 'two' },
      { description: 'x' },
    ]) {
      await expect(setInvoiceLines(db(), 5, [{ unit_cents: 100, ...line }]))
        .rejects.toMatchObject({ field: 'lines[0].quantity' });
    }
  });

  it('refuses a quantity finer than four decimal places rather than silently rounding it', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' } });
    // The field names the line, like every other per-line refusal, so the
    // form can highlight the row that is wrong (review finding O-2).
    await expect(setInvoiceLines(db, 5, [{ description: 'x', quantity: 1.23456, unit_cents: 100 }]))
      .rejects.toMatchObject({ field: 'lines[0].quantity' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO invoice_lines'))).toBe(false);
  });

  it('accepts exactly four decimal places', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'exempt_small' } });
    const result = await setInvoiceLines(db, 5, [{ description: 'x', quantity: 1.0625, unit_cents: 1600 }]);
    expect(result.lines[0].amount_cents).toBe(1700); // 1.0625 x 1600 is exactly 1700
  });

  it('applies 21% VAT half-up on the exact value, not on a float', async () => {
    // subtotal 9995 x 21 / 100 is exactly 2098.95 -> 2099.
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' } });
    await setInvoiceLines(db, 5, [{ description: 'x', quantity: 1, unit_cents: 9995 }]);
    const totals = db.calls.find((c) => c.sql.includes('subtotal_cents = ?'));
    expect(totals.args.slice(0, 3)).toEqual([9995, 2099, 12094]);
  });

  it('rejects a quantity above the ceiling and a unit price above €100M', async () => {
    const db = () => fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' } });
    await expect(setInvoiceLines(db(), 5, [{ description: 'x', quantity: 1_000_001, unit_cents: 100 }]))
      .rejects.toMatchObject({ field: 'lines[0].quantity' });
    await expect(setInvoiceLines(db(), 5, [{ description: 'x', quantity: 1, unit_cents: 10_000_000_001 }]))
      .rejects.toMatchObject({ field: 'lines[0].unit_cents' });
    // A negative price is a deduction line now; alone, it would make the total negative.
    await expect(setInvoiceLines(db(), 5, [{ description: 'x', quantity: 1, unit_cents: -1 }]))
      .rejects.toMatchObject({ field: 'lines' });
    await expect(setInvoiceLines(db(), 5, [{ description: 'x', quantity: 1, unit_cents: -10_000_000_001 }]))
      .rejects.toMatchObject({ field: 'lines[0].unit_cents' });
    // 1000 x €100M would be €100bn: inside neither bound, refused as an amount.
    await expect(setInvoiceLines(db(), 5, [{ description: 'x', quantity: 1000, unit_cents: 10_000_000_000 }]))
      .rejects.toMatchObject({ field: 'lines[0].amount_cents' });
  });

  it('rejects a non-integer unit_cents before touching the database', async () => {
    const db = fakeDb({ first: { id: 5, number: null, vat_treatment: 'standard' } });
    await expect(setInvoiceLines(db, 5, [{ description: 'x', quantity: 1, unit_cents: 12.5 }]))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to set lines on an already-issued invoice', async () => {
    const db = fakeDb({ first: { id: 5, number: '1.R.SC.26', vat_treatment: 'standard' } });
    await expect(setInvoiceLines(db, 5, [{ description: 'x', quantity: 1, unit_cents: 100 }]))
      .rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1);
  });

  it('rejects an empty lines array', async () => {
    const db = fakeDb();
    await expect(setInvoiceLines(db, 5, [])).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });
});

describe('issueInvoice — numbering', () => {
  /*
   * `<seq>.R.<CLIENT INITIALS>.<NN>` — 5.R.A.L.01 (design addendum 4). `seq`
   * is ONE running counter over every invoice ever issued, not one per year:
   * the trailing pair is that client's own counter, not a year, and nothing
   * restarts in January.
   */
  it('allocates both counters by subquery in the same UPDATE, not from a prior JS read', async () => {
    const db = fakeDb({
      first: {
        id: 5, client_id: 5, vat_treatment: 'reverse_charge', initials: 'SC', vat_number: 'NL123456789B01',
        seq: 6, year: 2026, number: '6.R.SC.01', status: 'issued', total_cents: 0,
      },
    });
    const inv = await issueInvoice(db, 5, '2026-01-15');

    expect(inv.number).toBe('6.R.SC.01');
    expect(inv.seq).toBe(6);

    const update = db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));
    expect(update.sql).toMatch(/COALESCE\(MAX\(v\.seq\), 0\) \+ 1 FROM invoices v WHERE v\.series = invoices\.series AND v\.year = \?\)/);
    expect(update.sql).toMatch(/COUNT\(\*\) \+ 1 FROM invoices WHERE client_id = \? AND number IS NOT NULL/);
    expect(update.sql).toMatch(/WHERE id = \? AND number IS NULL/);
  });

  /** The counter runs within a (series, year), as the owner's final rule has
   *  it: it restarts each January and it never crosses from the closed agency
   *  series into the studio one. */
  it('scopes the running sequence to this invoice\'s own series and year', async () => {
    const db = fakeDb({ first: { id: 5, client_id: 5, vat_treatment: 'standard', initials: 'SC', vat_number: null } });
    await issueInvoice(db, 5, '2026-01-15');

    const update = db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));
    expect(update.sql).toMatch(/v\.series = invoices\.series AND v\.year = \?/);
    // The series is read from the invoice's own row, never bound in from a
    // request: nothing outside this module can choose which series an
    // invoice is numbered in.
    expect(update.args).not.toContain('studio');
    expect(update.args).not.toContain('agency');
    // The year is bound three times — twice for the counter's two
    // occurrences, once for the column — and never as a two-digit fragment.
    expect(update.args.filter((a) => a === 2026)).toHaveLength(3);
    expect(update.args).not.toContain('26');
  });

  /*
   * The number format is asserted from the SQL itself, never from the fake's
   * canned RETURNING row. A test that cans `number: '6.R.SC.01'` and asserts
   * '6.R.SC.01' back only proves the fake works — `6.R.01.SC` would pass it
   * just as happily. What decides the format is the concatenation
   * `<seq subquery> || '.R.' || ? || '.' || printf('%02d', <client subquery>)`
   * and which value lands in which placeholder, so that is what is checked.
   */
  const NEXT_SEQ = /\(SELECT COALESCE\(MAX\(v\.seq\), 0\) \+ 1 FROM invoices v WHERE v\.series = invoices\.series AND v\.year = \?\)/;
  const NUMBER_CONCAT = /number = \(SELECT COALESCE\(MAX\(v\.seq\), 0\) \+ 1 FROM invoices v WHERE v\.series = invoices\.series AND v\.year = \?\) \|\| '\.R\.A\.' \|\| \? \|\| '\.' \|\| printf\('%02d', \(SELECT COUNT\(\*\) \+ 1 FROM invoices WHERE client_id = \? AND number IS NOT NULL AND series != 'archive'\)\)/;

  /** Where the initials placeholder sits in the bind list: the number of `?`
   *  that precede it in the statement text. */
  function initialsBindIndex(sql) {
    const match = sql.match(NUMBER_CONCAT);
    expect(match, 'the number is not built by the expected concatenation').toBeTruthy();
    const upToInitials = sql.slice(0, match.index + match[0].indexOf("|| '.R.A.'"));
    return (upToInitials.match(/\?/g) ?? []).length;
  }

  function issuingUpdate(db) {
    return db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));
  }

  it("builds <n>.R.A.<LETTERS>.<NN> in that order: the year's counter, the fixed A, the client's letters, then that client's own counter", async () => {
    const db = fakeDb({ first: { id: 5, client_id: 7, vat_treatment: 'standard', initials: 'SC', vat_number: null } });
    await issueInvoice(db, 5, '2026-03-01');

    const update = issuingUpdate(db);
    // The whole shape in one go — '.R.' before the initials, the initials
    // before the per-client counter. `6.R.01.SC` cannot match this.
    expect(update.sql).toMatch(NUMBER_CONCAT);
    // The `A` is the format's, not the client's: `6.R.SC.01` cannot match.
    expect(update.sql).toContain("'.R.A.'");
    // ... and `seq` is the same in-statement subquery, scoped to this
    // invoice's own series and the year being bound.
    expect(update.sql).toMatch(new RegExp(`seq = ${NEXT_SEQ.source}`));
    expect(update.sql).toMatch(/WHERE id = \? AND number IS NULL/);

    const at = initialsBindIndex(update.sql);
    expect(update.args[at]).toBe('SC');  // the <INITIALS> placeholder
    expect(update.args[at + 1]).toBe(7); // the client the <NN> subquery counts
  });

  it('pads the per-client counter to two digits in SQL, not in JS', async () => {
    const db = fakeDb({ first: { id: 5, client_id: 7, vat_treatment: 'standard', initials: 'L', vat_number: null } });
    await issueInvoice(db, 5, '2026-03-01');
    expect(issuingUpdate(db).sql).toContain("printf('%02d'");
  });

  it('binds the client, never the year, as the per-client counter\'s scope', async () => {
    const db = fakeDb({ first: { id: 9, client_id: 3, vat_treatment: 'standard', initials: 'RA', vat_number: null } });
    await issueInvoice(db, 9, '2031-07-04');

    const update = issuingUpdate(db);
    const at = initialsBindIndex(update.sql);
    expect(update.args[at]).toBe('RA');
    expect(update.args[at + 1]).toBe(3);
    expect(update.args[at + 1]).not.toBe('31'); // the old <YY> is gone
    // The year column itself is still filled, four digits — and the year is
    // now also the scope of the running counter, bound before the initials.
    expect(update.args).toContain(2031);
    expect(update.args.slice(0, at)).toEqual([2031, 2031, 2031]);
  });

  it('never computes either counter in JS: no SELECT of seq precedes the allocating UPDATE', async () => {
    const db = fakeDb({ first: { id: 5, client_id: 5, vat_treatment: 'standard', initials: 'SC', vat_number: null } });
    await issueInvoice(db, 5, '2026-01-10');

    const update = issuingUpdate(db);
    const before = db.calls.slice(0, db.calls.indexOf(update));
    for (const call of before) expect(call.sql).not.toMatch(/\bMAX\(seq\)|\bseq\b\s*FROM/);
    for (const call of before) expect(call.sql).not.toMatch(/COUNT\(\*\)/);
  });

  it('sets due_on to issued_on + 30 days', async () => {
    const db = fakeDb({
      first: {
        id: 5, client_id: 5, vat_treatment: 'standard', initials: 'SC', vat_number: null,
        seq: 1, year: 2026, number: '1.R.SC.01', issued_on: '2026-01-15', due_on: '2026-02-14',
      },
    });
    await issueInvoice(db, 5, '2026-01-15');
    const update = db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));
    expect(update.args).toContain('2026-02-14');
  });

  it('refuses to issue a reverse_charge invoice when the client has no VAT number', async () => {
    const db = fakeDb({
      first: { id: 5, client_id: 5, vat_treatment: 'reverse_charge', initials: 'SC', vat_number: null },
    });
    await expect(issueInvoice(db, 5, '2026-01-15')).rejects.toMatchObject({ field: 'vat_number' });
    // Refused before the allocating UPDATE ever runs.
    expect(db.calls.some((c) => c.sql.trim().startsWith('UPDATE invoices'))).toBe(false);
  });

  it('refuses to issue without client initials', async () => {
    const db = fakeDb({ first: { id: 5, client_id: 5, vat_treatment: 'standard', initials: null, vat_number: null } });
    await expect(issueInvoice(db, 5, '2026-01-15')).rejects.toMatchObject({ field: 'initials' });
  });

  it('refuses to issue when the stored initials are not usable in a number', async () => {
    const db = fakeDb({ first: { id: 5, client_id: 5, vat_treatment: 'standard', initials: '   ', vat_number: null } });
    await expect(issueInvoice(db, 5, '2026-01-15')).rejects.toMatchObject({ field: 'initials' });
  });

  it('returns null for a missing invoice', async () => {
    const db = fakeDb({ first: null });
    expect(await issueInvoice(db, 999, '2026-01-15')).toBeNull();
  });

  it('throws when the guarded UPDATE affects no row (already issued)', async () => {
    // The static fakeDb can only hand back one canned value per call type, so
    // this one case — precheck succeeds, the guarded UPDATE affects 0 rows —
    // needs a call-indexed fake rather than test/db.test.js's static one.
    const calls = [];
    const responses = [
      { id: 5, client_id: 5, vat_treatment: 'standard', initials: 'SC', vat_number: null }, // the precheck select
      null, // the guarded UPDATE ... RETURNING: no row, because it was already issued
    ];
    const db = {
      calls,
      prepare(sql) {
        const call = { sql, args: [] };
        calls.push(call);
        const index = calls.length - 1;
        const stmt = {
          bind(...args) { call.args = args; return stmt; },
          async all() { return { results: [] }; },
          async first() { return responses[index] ?? null; },
          async run() { return { success: true, meta: { last_row_id: 1, changes: 1 } }; },
        };
        return stmt;
      },
    };
    await expect(issueInvoice(db, 5, '2026-01-15')).rejects.toMatchObject({ field: 'status' });
  });
});

describe('markSent / markPaid', () => {
  const issued = (over) => invoiceRow({ number: '1.R.SC.26', status: 'issued', ...over });
  const update = (db) => db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));

  it('markSent binds the sent_on date and guards status != void', async () => {
    const db = fakeDb({ first: issued({ sent_on: '2026-02-01' }) });
    const inv = await markSent(db, 5, '2026-02-01');
    expect(inv.sent_on).toBe('2026-02-01');
    expect(update(db).sql).toMatch(/status != 'void'/);
    expect(update(db).sql).toMatch(/sent_on = \?/);
    expect(update(db).args).toContain('2026-02-01');
  });

  /** markPaid is now a thin wrapper: "paid in full" is one payment for
   *  whatever is still due, so money arrives by exactly one path. */
  it('markPaid records a payment for the whole amount still due, on the given date', async () => {
    const db = fakeDb({ first: issued({ total_cents: 130000, request_cents: null, paid_cents: 0, due_cents: 130000 }) });
    await markPaid(db, 5, '2026-03-01');

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO payments'));
    expect(insert).toBeTruthy();
    expect(insert.args).toContain(130000);
    expect(insert.args).toContain('2026-03-01'); // bound, not interpolated
    expect(insert.sql).not.toContain('2026-03-01');
    // No UPDATE writes paid_on directly any more: it is recomputed from the
    // payments, inside the statement that follows the insert.
    const paidOnUpdate = db.calls.find((c) => c.sql.includes('SET paid_on'));
    expect(paidOnUpdate.sql).toMatch(/SELECT CASE WHEN COALESCE\(SUM\(p\.amount_cents\), 0\)/);
    expect(paidOnUpdate.sql).not.toMatch(/paid_on = \?/);
  });

  it('markPaid refuses an invoice with nothing left due rather than writing a zero payment', async () => {
    const db = fakeDb({ first: issued({ total_cents: 170000, request_cents: 170000, paid_cents: 170000, due_cents: 0 }) });
    await expect(markPaid(db, 5, '2026-03-01')).rejects.toMatchObject({ field: 'status' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO payments'))).toBe(false);
  });

  // Previously a silent null — the caller could not tell "that is a draft"
  // from "no such invoice".
  it('markSent refuses a draft with a status error rather than returning null', async () => {
    const db = fakeDb({ first: invoiceRow({ number: null, status: 'draft' }) });
    await expect(markSent(db, 5, '2026-02-01')).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1); // the guard read only; no UPDATE fired
  });

  it('markPaid refuses a draft with a status error rather than returning null', async () => {
    const db = fakeDb({ first: invoiceRow({ number: null, status: 'draft' }) });
    await expect(markPaid(db, 5, '2026-03-01')).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1);
  });

  it('refuses a void invoice too', async () => {
    const db = fakeDb({ first: issued({ status: 'void' }) });
    await expect(markSent(db, 5, '2026-02-01')).rejects.toMatchObject({ field: 'status' });
    await expect(markPaid(fakeDb({ first: issued({ status: 'void' }) }), 5, '2026-03-01'))
      .rejects.toMatchObject({ field: 'status' });
  });

  it('still returns null when there is no such invoice', async () => {
    expect(await markSent(fakeDb({ first: null }), 999, '2026-02-01')).toBeNull();
    expect(await markPaid(fakeDb({ first: null }), 999, '2026-03-01')).toBeNull();
  });
});

/**
 * Dates are stored and compared as text. '2026-9-5' binds without complaint
 * and then sorts after '2026-12-01' and before '2026-10-01' forever, so due
 * dates and the overdue total are wrong from then on. Each entry point that
 * takes a day refuses a malformed one, naming its own parameter.
 */
describe('date validation', () => {
  it('issueInvoice refuses a malformed `on` before reading anything', async () => {
    const db = fakeDb({ first: { id: 5, vat_treatment: 'standard', initials: 'SC', vat_number: null } });
    await expect(issueInvoice(db, 5, '2026-9-5')).rejects.toMatchObject({ field: 'on' });
    expect(db.calls).toHaveLength(0);
  });

  it('markSent refuses a malformed `on`', async () => {
    const db = fakeDb({ first: invoiceRow({ number: '1.R.SC.26', status: 'issued' }) });
    await expect(markSent(db, 5, '01/02/2026')).rejects.toMatchObject({ field: 'on' });
    expect(db.calls).toHaveLength(0);
  });

  it('markPaid refuses a malformed `on`', async () => {
    const db = fakeDb({ first: invoiceRow({ number: '1.R.SC.26', status: 'issued' }) });
    await expect(markPaid(db, 5, '2026-3-1')).rejects.toMatchObject({ field: 'on' });
    expect(db.calls).toHaveLength(0);
  });

  it('financeOverview refuses a malformed `today`', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await expect(financeOverview(db, '2026-9-20')).rejects.toMatchObject({ field: 'today' });
    expect(db.calls).toHaveLength(0);
  });

  it('refuses a well-shaped day that is not a real date', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await expect(financeOverview(db, '2026-02-30')).rejects.toMatchObject({ field: 'today' });
    await expect(financeOverview(db, '2026-13-01')).rejects.toMatchObject({ field: 'today' });
  });

  it('accepts a real leap day', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await expect(financeOverview(db, '2028-02-29')).resolves.toBeTruthy();
  });
});

describe('voidInvoice', () => {
  it('keeps the number: void never clears or reassigns it', async () => {
    const db = fakeDb({
      first: invoiceRow({ number: '1.R.SC.01', status: 'issued', notes: 'Voided: client cancelled the campaign' }),
    });
    const inv = await voidInvoice(db, 5, 'client cancelled the campaign');
    expect(inv.number).toBe('1.R.SC.01');
    const update = db.calls.find((c) => c.sql.trim().startsWith('UPDATE invoices'));
    const setClause = update.sql.split('WHERE')[0];
    expect(setClause).not.toMatch(/\bnumber\s*=/);
    expect(update.sql).toContain("status = 'void'");
  });

  /** Review finding O-4: voiding a void invoice passed the number guard and
   *  appended a second "Voided: ..." line to its notes. */
  it('refuses to void an invoice that is already void', async () => {
    const db = fakeDb({ first: invoiceRow({ number: '1.R.SC.01', status: 'void' }) });
    await expect(voidInvoice(db, 5, 'again')).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1); // the guard read only; no UPDATE fired
  });

  it('requires a reason', async () => {
    const db = fakeDb();
    await expect(voidInvoice(db, 5, '')).rejects.toMatchObject({ field: 'reason' });
    expect(db.calls).toHaveLength(0);
  });

  // Previously a silent null: the guarded UPDATE matched no row and the
  // caller could not tell a draft from a missing invoice.
  it('refuses a draft with a status error rather than returning null', async () => {
    const db = fakeDb({ first: invoiceRow({ number: null, status: 'draft' }) });
    await expect(voidInvoice(db, 5, 'changed my mind')).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1); // the guard read only; no UPDATE fired
  });

  it('still returns null when there is no such invoice', async () => {
    const db = fakeDb({ first: null });
    expect(await voidInvoice(db, 999, 'gone')).toBeNull();
  });
});

describe('deleteDraft', () => {
  it('refuses to delete an issued invoice', async () => {
    const db = fakeDb({ first: { id: 5, number: '1.R.SC.26' } });
    await expect(deleteDraft(db, 5)).rejects.toMatchObject({ field: 'status' });
    expect(db.calls).toHaveLength(1); // no DELETE fired
  });

  it('deletes a draft (number is null)', async () => {
    const db = fakeDb({ first: { id: 5, number: null }, changes: 1 });
    expect(await deleteDraft(db, 5)).toBe(true);
    expect(db.calls.some((c) => c.sql.startsWith('DELETE FROM invoices'))).toBe(true);
  });

  it('returns false for a missing invoice, without deleting', async () => {
    const db = fakeDb({ first: null });
    expect(await deleteDraft(db, 999)).toBe(false);
    expect(db.calls).toHaveLength(1);
  });
});

describe('listInvoices / getInvoice — derived status and overdue', () => {
  it('a draft (number null) reads with computed_status "draft"', async () => {
    const db = fakeDb({ all: [invoiceRow()] });
    const [inv] = await listInvoices(db);
    expect(inv.computed_status).toBe('draft');
    expect(inv.overdue).toBe(false);
  });

  it('an issued invoice past its due_on with no paid_on reads overdue: true', async () => {
    const db = fakeDb({
      all: [invoiceRow({ number: '1.R.SC.26', status: 'issued', issued_on: '2020-01-01', due_on: '2020-01-31' })],
    });
    const [inv] = await listInvoices(db);
    expect(inv.computed_status).toBe('issued');
    expect(inv.overdue).toBe(true); // due_on is safely in the past regardless of when this test runs
  });

  it('a paid invoice is never reported overdue even if due_on has passed', async () => {
    const db = fakeDb({
      all: [invoiceRow({
        number: '1.R.SC.01', status: 'issued', due_on: '2020-01-01', paid_on: '2020-06-01',
        total_cents: 24200, paid_cents: 24200, requested_cents: 24200, due_cents: 0, balance_cents: 0,
      })],
    });
    const [inv] = await listInvoices(db);
    expect(inv.computed_status).toBe('paid');
    expect(inv.overdue).toBe(false);
  });

  /** Invoice 5.R.A.L.01: €3000.00 total, €1700.00 asked for, €1700.00 paid.
   *  The remaining €1300.00 is part 2 — not yet invoiced, so the invoice is
   *  paid, is not overdue, and owes nothing today. */
  it('a prepayment whose requested amount is paid reads paid, not overdue, with the rest still to invoice', async () => {
    const db = fakeDb({
      all: [invoiceRow({
        number: '5.R.A.L.01', status: 'issued', kind: 'prepayment',
        issued_on: '2026-07-09', due_on: '2026-08-08', sent_on: '2026-07-09', paid_on: '2026-07-09',
        subtotal_cents: 300000, total_cents: 300000, request_cents: 170000,
        paid_cents: 170000, requested_cents: 170000, due_cents: 0,
        balance_cents: 130000, not_yet_requested_cents: 130000,
      })],
    });
    const [inv] = await listInvoices(db);
    expect(inv.computed_status).toBe('paid');
    expect(inv.overdue).toBe(false);
    expect(inv.due_cents).toBe(0);
    expect(inv.balance_cents).toBe(130000);
    expect(inv.not_yet_requested_cents).toBe(130000);
  });

  it('an unpaid prepayment is overdue only for what it actually asked for', async () => {
    const db = fakeDb({
      all: [invoiceRow({
        number: '5.R.A.L.01', status: 'issued', kind: 'prepayment',
        due_on: '2020-01-01', total_cents: 300000, request_cents: 170000,
        paid_cents: 0, requested_cents: 170000, due_cents: 170000,
        balance_cents: 300000, not_yet_requested_cents: 130000,
      })],
    });
    const [inv] = await listInvoices(db);
    expect(inv.overdue).toBe(true);
    expect(inv.due_cents).toBe(170000); // never the 300000 project total
  });

  it('reads paid_cents / due_cents / balance_cents from SQL, not from a stored column', async () => {
    const db = fakeDb({ all: [] });
    await listInvoices(db);
    const sql = db.calls[0].sql;
    expect(sql).toMatch(/SUM\(p\.amount_cents\)[\s\S]*FROM payments p WHERE p\.invoice_id = invoices\.id/);
    expect(sql).toContain('AS paid_cents');
    expect(sql).toContain('AS due_cents');
    expect(sql).toContain('AS balance_cents');
    expect(sql).toContain('AS not_yet_requested_cents');
  });

  it('a void invoice is never overdue regardless of dates', async () => {
    const db = fakeDb({ all: [invoiceRow({ number: '1.R.SC.26', status: 'void', due_on: '2020-01-01' })] });
    const [inv] = await listInvoices(db);
    expect(inv.computed_status).toBe('void');
    expect(inv.overdue).toBe(false);
  });

  it('rejects an unknown status filter instead of querying', async () => {
    const db = fakeDb({ all: [] });
    await expect(listInvoices(db, { status: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('binds client_id and year filters rather than interpolating', async () => {
    const db = fakeDb({ all: [] });
    await listInvoices(db, { client_id: 5, year: 2026 });
    expect(db.calls[0].sql).not.toContain('client_id = 5');
    expect(db.calls[0].sql).not.toContain('year = 2026');
    expect(db.calls[0].args).toEqual(expect.arrayContaining([5, 2026]));
  });

  it('getInvoice returns lines and client alongside the invoice', async () => {
    const db = fakeDb({ first: invoiceRow(), all: [{ id: 1, invoice_id: 5, description: 'x', quantity: 1, unit_cents: 100, amount_cents: 100, no_charge: 0, position: 0 }] });
    const inv = await getInvoice(db, 5);
    expect(inv.lines).toHaveLength(1);
  });

  it('getInvoice returns null for a missing invoice without querying lines/client', async () => {
    const db = fakeDb({ first: null });
    expect(await getInvoice(db, 999)).toBeNull();
    expect(db.calls).toHaveLength(1);
  });
});

describe('financeOverview', () => {
  it('computes overdue_cents from due_on against the given "today", never a stored column', async () => {
    const db = fakeDb({ first: { cents: 50000 }, all: [] });
    await financeOverview(db, '2026-09-20');

    const overdueCall = db.calls.find((c) => c.sql.includes('due_on < ?'));
    expect(overdueCall).toBeTruthy();
    expect(overdueCall.sql).not.toMatch(/status\s*=\s*'overdue'/);
    expect(overdueCall.sql).not.toMatch(/\boverdue\b/); // no such column exists — always computed
    expect(overdueCall.args).toContain('2026-09-20');
  });

  it('returns the documented shape', async () => {
    // The static fake answers every .all() call with the same array — real
    // by_month/by_client rows differ in shape, but this only checks that
    // financeOverview assembles its five fields from the right queries.
    const db = fakeDb({
      first: { cents: 1000 },
      all: [{ month: '2026-01', cents: 500 }],
    });
    const overview = await financeOverview(db, '2026-09-20');
    expect(Object.keys(overview).sort()).toEqual(
      ['by_client', 'by_month', 'not_yet_requested_cents', 'outstanding_cents', 'overdue_cents', 'paid_this_year_cents'].sort(),
    );
    expect(overview.outstanding_cents).toBe(1000);
    expect(overview.overdue_cents).toBe(1000);
    expect(overview.not_yet_requested_cents).toBe(1000);
    expect(overview.paid_this_year_cents).toBe(1000);
    expect(overview.by_month).toEqual([{ month: '2026-01', cents: 500 }]);
    expect(overview.by_client).toEqual([{ month: '2026-01', cents: 500 }]);
  });

  it('defaults "today" to now when not given', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await financeOverview(db);
    expect(db.calls.some((c) => c.args.some((a) => typeof a === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a)))).toBe(true);
  });
});

/**
 * 0003 declared `status` and `vat_treatment` in comments only, while 0001 and
 * 0002 constrain their vocabularies with CHECK. SQLite cannot add a constraint
 * in place, so 0005 drops and recreates the three finance tables — safe only
 * because finance starts from zero and they are empty on both databases.
 */
describe('0005_finance_constraints.sql', () => {
  const sql = readFileSync(new URL('../migrations/0005_finance_constraints.sql', import.meta.url), 'utf8');
  const sql0003 = readFileSync(new URL('../migrations/0003_finance.sql', import.meta.url), 'utf8');

  it('constrains status to draft | issued | void', () => {
    expect(sql).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'draft'\s*,\s*'issued'\s*,\s*'void'\s*\)\s*\)/);
  });

  it('constrains vat_treatment to exactly the treatments db.js knows', () => {
    expect(sql).toMatch(
      /CHECK\s*\(\s*vat_treatment\s+IN\s*\(\s*'standard'\s*,\s*'reverse_charge'\s*,\s*'exempt_small'\s*,\s*'export'\s*\)\s*\)/,
    );
    for (const treatment of Object.keys(VAT_TREATMENTS)) expect(sql).toContain(`'${treatment}'`);
  });

  it('keeps the partial unique index that makes seq unbroken per year', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS invoices_seq_per_year ON invoices\(year, seq\) WHERE seq IS NOT NULL/,
    );
    for (const index of ['invoices_by_client', 'invoices_by_status', 'invoice_lines_by_invoice']) {
      expect(sql, `${index} missing from 0005`).toContain(index);
    }
  });

  it('drops children before parents and recreates in the reverse order', () => {
    const drops = ['invoice_lines', 'invoices', 'clients']
      .map((t) => sql.indexOf(`DROP TABLE IF EXISTS ${t};`));
    expect(drops.every((i) => i >= 0)).toBe(true);
    expect(drops).toEqual([...drops].sort((a, b) => a - b));

    const creates = ['clients', 'invoices', 'invoice_lines']
      .map((t) => sql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`));
    expect(creates.every((i) => i >= 0)).toBe(true);
    expect(creates).toEqual([...creates].sort((a, b) => a - b));
    expect(Math.max(...drops)).toBeLessThan(Math.min(...creates));
  });

  it('keeps every column 0003 declared', () => {
    // Column names as they appear at the start of a line inside 0003's CREATEs.
    const columns = [...sql0003.matchAll(/^\s{2}([a-z_]+)\s+(?:TEXT|INTEGER|REAL)\b/gm)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(20);
    for (const column of new Set(columns)) {
      expect(sql, `column ${column} dropped by 0005`).toMatch(new RegExp(`^\\s{2}${column}\\s+`, 'm'));
    }
  });

  it('says in its header that it is safe only because the tables are empty', () => {
    const header = sql.slice(0, sql.indexOf('DROP TABLE'));
    expect(header).toMatch(/2026-09-20/);
    expect(header).toMatch(/empty/i);
  });
});

/**
 * Payments (0006). The fact that forced them: invoice 5.R.A.L.01 has a
 * €3000.00 total, asked for €1700.00, and has been paid €1700.00. `paid_on`
 * alone can only say "paid" or "not paid", and both are wrong about it.
 */
describe('recordPayment', () => {
  const issued = (over) => invoiceRow({
    id: 5, number: '5.R.A.L.01', status: 'issued', total_cents: 300000,
    kind: 'prepayment', request_cents: 170000, requested_cents: 170000,
    paid_cents: 0, due_cents: 170000, ...over,
  });

  it('inserts an integer-cent payment with every value bound', async () => {
    const db = fakeDb({ first: issued() });
    await recordPayment(db, 5, {
      amount_cents: 170000,
      paid_on: '2026-07-09',
      label: "Prepayment website (50%) €1,300 + Digital marketing €400",
    });

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO payments'));
    expect(insert.args).toEqual([
      5, 170000, '2026-07-09', "Prepayment website (50%) €1,300 + Digital marketing €400", null,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      // ... and again for the guard the insert carries: invoice, amount, invoice.
      5, 170000, 5,
    ]);
    expect(insert.sql).not.toContain('170000');
  });

  /** The read-then-insert in between is not a lock: two double-clicked
   *  requests both read the same balance and both pass the check. The
   *  condition therefore rides inside the INSERT, as it does in
   *  issueInvoice — no row inserted means someone got there first. */
  it('carries its own guard: the insert refuses to take the invoice past what it asked for', async () => {
    const db = fakeDb({ first: issued() });
    await recordPayment(db, 5, { amount_cents: 170000, paid_on: '2026-07-09' });

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO payments'));
    expect(insert.sql).toMatch(/SELECT \?, \?, \?, \?, \?, \?/);
    expect(insert.sql).toMatch(/WHERE \(SELECT COALESCE\(SUM\(p\.amount_cents\), 0\) FROM payments p WHERE p\.invoice_id = \?\) \+ \?/);
    expect(insert.sql).toMatch(/<= \(SELECT COALESCE\(request_cents, total_cents\) FROM invoices WHERE id = \?\)/);
  });

  it('refuses with the field when the guarded insert takes no row', async () => {
    // The precheck passes (the read says 170000 is due) and the insert still
    // writes nothing: another payment landed in between.
    const calls = [];
    const responses = [issued(), null];
    const db = {
      calls,
      prepare(sql) {
        const record = { sql, args: [] };
        calls.push(record);
        const index = calls.length - 1;
        const stmt = {
          bind(...args) { record.args = args; return stmt; },
          async all() { return { results: [] }; },
          async first() { return responses[index] ?? null; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return stmt;
      },
    };
    await expect(recordPayment(db, 5, { amount_cents: 170000 }))
      .rejects.toMatchObject({ field: 'amount_cents' });
    // Nothing was written, so paid_on is never recomputed.
    expect(calls.some((c) => c.sql.includes('SET paid_on'))).toBe(false);
  });

  it('refuses an amount above what the invoice asked for, naming the field', async () => {
    const db = fakeDb({ first: issued({ paid_cents: 170000, due_cents: 0 }) });
    await expect(recordPayment(db, 5, { amount_cents: 1 }))
      .rejects.toMatchObject({ field: 'amount_cents' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO payments'))).toBe(false);
  });

  it('never lets a prepayment be paid beyond its request — the rest is a later invoice', async () => {
    const db = fakeDb({ first: issued() });
    // 300000 is the project total; only 170000 was ever asked for here.
    await expect(recordPayment(db, 5, { amount_cents: 300000 }))
      .rejects.toMatchObject({ field: 'amount_cents' });
  });

  it('refuses a non-integer, zero or negative amount before touching the database', async () => {
    for (const amount of [1.5, 0, -100, '100', null, undefined]) {
      const db = fakeDb({ first: issued() });
      await expect(recordPayment(db, 5, { amount_cents: amount }))
        .rejects.toMatchObject({ field: 'amount_cents' });
      expect(db.calls).toHaveLength(0);
    }
  });

  it('refuses a malformed or impossible date', async () => {
    await expect(recordPayment(fakeDb({ first: issued() }), 5, { amount_cents: 100, paid_on: '2026-7-9' }))
      .rejects.toMatchObject({ field: 'paid_on' });
    await expect(recordPayment(fakeDb({ first: issued() }), 5, { amount_cents: 100, paid_on: '2026-02-30' }))
      .rejects.toMatchObject({ field: 'paid_on' });
  });

  it('refuses a draft and a void invoice with a status error, not a silent null', async () => {
    await expect(recordPayment(fakeDb({ first: issued({ number: null, status: 'draft' }) }), 5, { amount_cents: 100 }))
      .rejects.toMatchObject({ field: 'status' });
    await expect(recordPayment(fakeDb({ first: issued({ status: 'void' }) }), 5, { amount_cents: 100 }))
      .rejects.toMatchObject({ field: 'status' });
  });

  it('returns null for a missing invoice', async () => {
    expect(await recordPayment(fakeDb({ first: null }), 999, { amount_cents: 100 })).toBeNull();
  });

  it('recomputes invoices.paid_on from the payments rather than setting it', async () => {
    const db = fakeDb({ first: issued() });
    await recordPayment(db, 5, { amount_cents: 170000, paid_on: '2026-07-09' });

    const sync = db.calls.find((c) => c.sql.includes('SET paid_on'));
    expect(sync.sql).toMatch(/FROM payments p WHERE p\.invoice_id = invoices\.id/);
    expect(sync.sql).toMatch(/MAX\(p\.paid_on\)/);
    // It settles against what was asked for, not the project total.
    expect(sync.sql).toContain('COALESCE(invoices.request_cents, invoices.total_cents)');
  });

  it('refuses a label or method that is not text', async () => {
    await expect(recordPayment(fakeDb({ first: issued() }), 5, { amount_cents: 100, label: 42 }))
      .rejects.toMatchObject({ field: 'label' });
    await expect(recordPayment(fakeDb({ first: issued() }), 5, { amount_cents: 100, method: { via: 'wise' } }))
      .rejects.toMatchObject({ field: 'method' });
  });
});

describe('listPayments', () => {
  it('returns the invoice payments oldest first', async () => {
    const db = fakeDb({
      first: { id: 5 },
      all: [{ id: 1, invoice_id: 5, amount_cents: 170000, paid_on: '2026-07-09', label: '', method: null, created_at: 'x' }],
    });
    const payments = await listPayments(db, 5);
    expect(payments).toHaveLength(1);
    expect(db.calls[1].sql).toMatch(/ORDER BY paid_on ASC, id ASC/);
    expect(db.calls[1].args).toEqual([5]);
  });

  // `[]` means "issued, nothing paid yet"; `null` means "no such invoice".
  it('answers null — not [] — for a missing invoice', async () => {
    const db = fakeDb({ first: null });
    expect(await listPayments(db, 999)).toBeNull();
    expect(db.calls).toHaveLength(1);
  });
});

describe('prepayment invoices (kind / request_cents)', () => {
  const insertInvoice = (db) => db.calls.find((c) => c.sql.includes('INSERT INTO invoices'));

  it('createInvoice defaults to kind invoice with no request_cents', async () => {
    const db = fakeDb({ first: invoiceRow() });
    await createInvoice(db, { client_id: 5 });
    expect(insertInvoice(db).args).toContain('invoice');
    expect(insertInvoice(db).sql).toContain('kind, request_cents');
  });

  it('accepts a prepayment with the amount asked for now', async () => {
    const db = fakeDb({ first: invoiceRow({ kind: 'prepayment', request_cents: 170000 }) });
    const inv = await createInvoice(db, { client_id: 5, kind: 'prepayment', request_cents: 170000 });
    expect(inv.kind).toBe('prepayment');
    expect(insertInvoice(db).args).toContain(170000);
  });

  it('refuses an unknown kind', async () => {
    await expect(createInvoice(fakeDb(), { client_id: 5, kind: 'quote' }))
      .rejects.toMatchObject({ field: 'kind' });
  });

  // request_cents says "this asks for less than the total", which is exactly
  // what a prepayment is; on an ordinary invoice it is a contradiction.
  it('refuses request_cents on an ordinary invoice', async () => {
    await expect(createInvoice(fakeDb(), { client_id: 5, request_cents: 170000 }))
      .rejects.toMatchObject({ field: 'request_cents' });
  });

  it('refuses a request_cents that is not whole cents above zero', async () => {
    for (const amount of [0, -1, 1700.5]) {
      await expect(createInvoice(fakeDb(), { client_id: 5, kind: 'prepayment', request_cents: amount }))
        .rejects.toMatchObject({ field: 'request_cents' });
    }
  });

  it('updateInvoice clears request_cents when a draft goes back to an ordinary invoice', async () => {
    const db = fakeDb({ first: { id: 5, number: null, kind: 'prepayment', request_cents: 170000 } });
    await updateInvoice(db, 5, { kind: 'invoice' });
    const update = db.calls.find((c) => c.sql.startsWith('UPDATE invoices SET'));
    expect(update.sql).toContain('request_cents = NULL');
  });
});

describe('createPartInvoice — part 2 of a prepayment', () => {
  const parent = (over = {}) => invoiceRow({
    id: 1, number: '5.R.A.L.01', status: 'issued', kind: 'prepayment',
    subject: 'Visual creation package - Prepayment',
    subtotal_cents: 300000, total_cents: 300000, request_cents: 170000,
    requested_cents: 170000, children_cents: 0, not_yet_requested_cents: 130000,
    ...over,
  });

  /** The static fake answers every `.first()` with the same row, and this
   *  path reads a parent (issued) and then writes a draft (not issued), so it
   *  needs a call-indexed fake — same shape as the one in the numbering
   *  tests. Anything past the listed responses answers null. */
  function sequencedDb(responses) {
    const calls = [];
    return {
      calls,
      prepare(sql) {
        const call = { sql, args: [] };
        calls.push(call);
        const index = calls.length - 1;
        const stmt = {
          bind(...args) { call.args = args; return stmt; },
          async all() { return { results: Array.isArray(responses[index]) ? responses[index] : [] }; },
          async first() { return Array.isArray(responses[index]) ? null : (responses[index] ?? null); },
          async run() { return { success: true, meta: { last_row_id: 1, changes: 1 } }; },
        };
        return stmt;
      },
    };
  }

  /** parent read, sibling list, the INSERT, then setInvoiceLines' own guard. */
  const partCalls = (over = {}) => [
    parent(over), [], invoiceRow({ id: 2, number: null, parent_id: 1 }),
    { id: 2, number: null, vat_treatment: 'reverse_charge' },
  ];

  it('drafts a new invoice for what has not been invoiced yet, pointing at its parent', async () => {
    const db = sequencedDb(partCalls());
    await createPartInvoice(db, 1);

    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO invoices'));
    expect(insert.args).toContain('Visual creation package - Part 2 (final invoice)');
    expect(insert.args).toContain(1); // parent_id, bound
    const line = db.calls.find((c) => c.sql.includes('INSERT INTO invoice_lines'));
    expect(line.args.some((arg) => String(arg).startsWith('Balance of Visual creation package — project total'))).toBe(true);
    expect(line.args).toContain(130000);
  });

  it('refuses when nothing is left to invoice', async () => {
    const db = fakeDb({ first: parent({ requested_cents: 300000, in_flight_cents: 0 }), all: [] });
    await expect(createPartInvoice(db, 1)).rejects.toMatchObject({ field: 'request_cents' });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO invoices'))).toBe(false);
  });

  /** H-1: the reported figure ignores drafts (nobody has been sent one), so
   *  drafting from it twice handed out the same €1300.00 balance twice and
   *  issuing both billed €4300.00 on a €3000.00 project. */
  it('refuses a second draft while one is already open, naming it', async () => {
    const db = fakeDb({ first: parent(), all: [{ id: 7, number: null, status: 'draft' }] });
    await expect(createPartInvoice(db, 1)).rejects.toMatchObject({
      field: 'parent_id',
      message: 'part 2 already exists (draft #7)',
    });
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO invoices'))).toBe(false);
  });

  it('subtracts every child that exists, issued or not, from what may still be drafted', async () => {
    const db = fakeDb({ first: parent({ in_flight_cents: 130000 }), all: [{ id: 7, number: '6.R.A.L.02', status: 'issued' }] });
    await expect(createPartInvoice(db, 1)).rejects.toMatchObject({ field: 'request_cents' });

    const read = db.calls[0];
    expect(read.sql).toContain('AS in_flight_cents');
    expect(read.sql).toMatch(/WHERE ch\.parent_id = invoices\.id AND ch\.status != 'void'\)\s+AS in_flight_cents/);
  });

  it('refuses an ordinary invoice, a draft and a void one', async () => {
    await expect(createPartInvoice(fakeDb({ first: parent({ kind: 'invoice' }) }), 1))
      .rejects.toMatchObject({ field: 'kind' });
    await expect(createPartInvoice(fakeDb({ first: parent({ number: null, status: 'draft' }) }), 1))
      .rejects.toMatchObject({ field: 'status' });
    await expect(createPartInvoice(fakeDb({ first: parent({ status: 'void' }) }), 1))
      .rejects.toMatchObject({ field: 'status' });
  });

  it('returns null for a missing invoice', async () => {
    expect(await createPartInvoice(fakeDb({ first: null }), 999)).toBeNull();
  });

  /** The child's total stops being "not yet invoiced" on the parent only once
   *  the child is issued — a draft is not an invoice anyone has been sent. */
  it('counts only issued children against the parent figure', async () => {
    const db = sequencedDb(partCalls());
    await createPartInvoice(db, 1);
    const read = db.calls[0];
    expect(read.sql).toMatch(/FROM invoices ch\s+WHERE ch\.parent_id = invoices\.id AND ch\.number IS NOT NULL AND ch\.status != 'void'/);
  });
});

describe('client initials', () => {
  it('accepts the real shapes: L, SC, SA — letters only, no dots', async () => {
    for (const initials of ['L', 'SC', 'SA']) {
      const db = fakeDb({ first: clientRow({ initials }) });
      await createClient(db, { name: 'X', initials });
      expect(db.calls[0].args).toContain(initials);
    }
  });

  // They are stitched into `number`, which is on a legal document forever.
  it('refuses initials that cannot go in an invoice number', async () => {
    // 'A.L' is the OLD stored shape: the dot belonged to the format's fixed
    // A, never to the client, and it is refused now (addendum 4, 2026-09-21).
    for (const initials of ['', '   ', 'TOO LONG', 'A/L', 'A.L', 'ABCDE', '123', '...']) {
      const value = initials.trim() === '' ? 'x' : initials; // '' is "not given", tested below
      if (value === 'x') continue;
      await expect(createClient(fakeDb(), { name: 'X', initials }))
        .rejects.toMatchObject({ field: 'initials' });
    }
  });

  it('treats blank initials as none rather than as a number fragment', async () => {
    const db = fakeDb({ first: clientRow({ initials: null }) });
    await createClient(db, { name: 'X', initials: '   ' });
    expect(db.calls[0].args).toContain(null);
  });

  it('validates them on update too', async () => {
    await expect(updateClient(fakeDb(), 5, { initials: 'WAY TOO LONG' }))
      .rejects.toMatchObject({ field: 'initials' });
  });
});

/**
 * Review finding O-3: `requireTextOrNull` answered `null` for an explicit
 * `null`, which then reached SQLite as a NOT NULL constraint failure — a 500
 * where the round's whole intent was a 400 naming the field.
 */
describe('NOT NULL text columns refuse an explicit null by name', () => {
  it('invoices.subject / currency / notes', async () => {
    for (const field of ['subject', 'currency', 'notes']) {
      const db = fakeDb({ first: { id: 5, number: null, kind: 'invoice', request_cents: null } });
      await expect(updateInvoice(db, 5, { [field]: null })).rejects.toMatchObject({ field });
      expect(db.calls.some((c) => c.sql.startsWith('UPDATE invoices SET'))).toBe(false);
    }
  });

  it('clients.country', async () => {
    await expect(updateClient(fakeDb(), 5, { country: null })).rejects.toMatchObject({ field: 'country' });
  });

  it('but an optional column still takes one', async () => {
    const db = fakeDb({ first: { id: 5, number: null, kind: 'invoice', request_cents: null } });
    await updateInvoice(db, 5, { po_number: null });
    expect(db.calls.find((c) => c.sql.startsWith('UPDATE invoices SET')).args).toContain(null);
  });
});

describe('financeOverview — every figure comes from the payments', () => {
  it('outstanding and overdue count what was asked for, minus what was paid', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await financeOverview(db, '2026-09-20');

    const outstanding = db.calls[0];
    expect(outstanding.sql).toContain('COALESCE(invoices.request_cents, invoices.total_cents)');
    expect(outstanding.sql).toMatch(/FROM payments p WHERE p\.invoice_id = invoices\.id/);
    expect(outstanding.sql).not.toMatch(/paid_on IS NULL/); // no all-or-nothing column any more
  });

  it('paid this year sums the payments by their own date, not the invoice total', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await financeOverview(db, '2026-09-20');

    const paid = db.calls.find((c) => c.sql.includes('substr(p.paid_on, 1, 4)'));
    expect(paid.sql).toMatch(/SUM\(p\.amount_cents\)/);
    expect(paid.sql).toMatch(/JOIN invoices i ON i\.id = p\.invoice_id/);
    expect(paid.sql).toMatch(/i\.status != 'void'/); // a void invoice's money is not revenue
    expect(paid.args).toContain('2026');
  });

  it('reports what has not been invoiced yet separately, and only for prepayments', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await financeOverview(db, '2026-09-20');

    const notYet = db.calls.find((c) => c.sql.includes("kind = 'prepayment'"));
    expect(notYet).toBeTruthy();
    expect(notYet.sql).toMatch(/MAX\(invoices\.total_cents - COALESCE/);
  });

  it('by_client owes what its invoices asked for and were not paid', async () => {
    const db = fakeDb({ first: { cents: 0 }, all: [] });
    await financeOverview(db, '2026-09-20');

    const byClient = db.calls.find((c) => c.sql.includes('AS outstanding_cents'));
    expect(byClient.sql).toContain('COALESCE(i.request_cents, i.total_cents)');
    expect(byClient.sql).toMatch(/FROM payments p WHERE p\.invoice_id = i\.id/);
  });
});

/**
 * 0006 is additive: by the time it runs, `clients`, `invoices` and
 * `invoice_lines` hold the real running invoice, so unlike 0005 it may not
 * drop a finance table.
 */
describe('0006_payments.sql', () => {
  const sql = readFileSync(new URL('../migrations/0006_payments.sql', import.meta.url), 'utf8');

  it('never drops a finance table — the tables are no longer empty', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it('creates payments with a positive-cents CHECK and a cascade from invoices', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payments/);
    expect(sql).toMatch(/amount_cents INTEGER NOT NULL CHECK \(amount_cents > 0\)/);
    expect(sql).toMatch(/invoice_id\s+INTEGER NOT NULL REFERENCES invoices\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS payments_by_invoice ON payments\(invoice_id, paid_on\)/);
  });

  it('adds kind, request_cents and parent_id to invoices', () => {
    expect(sql).toMatch(/ALTER TABLE invoices ADD COLUMN kind TEXT NOT NULL DEFAULT 'invoice' CHECK \(kind IN \('invoice','prepayment'\)\)/);
    expect(sql).toMatch(/ALTER TABLE invoices ADD COLUMN request_cents INTEGER/);
    expect(sql).toMatch(/ALTER TABLE invoices ADD COLUMN parent_id INTEGER REFERENCES invoices\(id\)/);
  });

  // The real numbering does not restart in January: 5.R.A.L.01 is followed by
  // 6.R.…, so the counter may not be unique per year only.
  it('moves the unique sequence off (year, seq) onto seq alone', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS invoices_seq_per_year/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS invoices_seq_unique ON invoices\(seq\) WHERE seq IS NOT NULL/);
  });
});
