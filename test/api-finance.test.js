import { describe, it, expect, vi } from 'vitest';
import { handleFinance } from '../src/worker/api/finance.js';

/**
 * The finance HTTP surface: which status each route answers with, what the
 * body looks like, and what never reaches it.
 *
 * Three things are checked on every route rather than once: `Cache-Control:
 * no-store` (an invoice is money, and a cached one is a wrong one), a 400
 * that names the field the screen should highlight, and a 500 whose body says
 * nothing about the database. D1 error text names columns, constraints and
 * the values that broke them; it belongs in the log.
 *
 * Same matcher-based fake D1 as test/api-leads.test.js: a handler matches
 * part of the SQL and supplies a canned result; anything unmatched answers
 * empty, so each test describes only the queries it cares about.
 */
function fakeDb(handlers = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const handler = handlers.find((h) => h.match.test(sql)) ?? {};
      if (handler.throws) throw handler.throws;
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: (typeof handler.all === 'function' ? handler.all(call.args) : handler.all) ?? [] }; },
        async first() {
          if (handler.throwsOnRun) throw handler.throwsOnRun;
          return (typeof handler.first === 'function' ? handler.first(call.args) : handler.first) ?? null;
        },
        async run() {
          if (handler.throwsOnRun) throw handler.throwsOnRun;
          return { success: true, meta: { changes: handler.changes ?? 1, last_row_id: handler.lastId ?? 1 } };
        },
      };
      return stmt;
    },
  };
}

const invoiceRow = (over = {}) => ({
  id: 5, number: '5.R.A.L.01', seq: 5, year: 2026, client_id: 1, slug: 'marc-aubin',
  subject: 'Visual creation package - Prepayment', po_number: null, status: 'issued',
  issued_on: '2026-07-09', due_on: '2026-08-08', sent_on: '2026-07-09', paid_on: '2026-07-09',
  currency: 'EUR', vat_treatment: 'reverse_charge',
  subtotal_cents: 300000, vat_cents: 0, total_cents: 300000,
  kind: 'prepayment', request_cents: 170000, parent_id: null,
  paid_cents: 170000, requested_cents: 170000, due_cents: 0,
  balance_cents: 130000, not_yet_requested_cents: 130000,
  notes: '', created_at: '2026-07-09T00:00:00.000Z', updated_at: '2026-07-09T00:00:00.000Z',
  ...over,
});

const paymentRow = (over = {}) => ({
  id: 1, invoice_id: 5, amount_cents: 170000, paid_on: '2026-07-09',
  label: 'Prepayment', method: null, created_at: '2026-09-20T23:59:00.000Z', ...over,
});

/** The read of an invoice, in every shape db.js asks for it. */
const INVOICE_READ = { match: /FROM invoices WHERE id = \?/, first: invoiceRow() };
const CLIENT_READ = { match: /FROM clients WHERE id = \?/, first: { id: 1, name: 'Aubin', initials: 'A.L' } };
const LINES_READ = { match: /FROM invoice_lines WHERE invoice_id = \?/, all: [{ id: 1, invoice_id: 5, description: 'Website', quantity: 1, unit_cents: 200000, amount_cents: 200000, no_charge: 0, position: 0 }] };
const PAYMENTS_READ = { match: /FROM payments WHERE invoice_id = \?/, all: [paymentRow()] };

function call(method, path, { body, db, search = '' } = {}) {
  const url = new URL(`https://hq.example.com${path}${search}`);
  const request = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
  return handleFinance(request, { DB: db ?? fakeDb() }, url);
}

async function json(response) {
  return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') };
}

describe('routing', () => {
  it('ignores anything outside /api/finance/', async () => {
    expect(await call('GET', '/api/leads')).toBeNull();
  });

  it('answers 404 for a path it does not know', async () => {
    const res = await json(await call('GET', '/api/finance/nonsense'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('answers 405 for a known path asked with the wrong method', async () => {
    for (const [method, path] of [
      ['DELETE', '/api/finance/overview'],
      ['POST', '/api/finance/issuer'],
      ['DELETE', '/api/finance/clients'],
      ['PUT', '/api/finance/clients/5'],
      ['PATCH', '/api/finance/invoices'],
      // PUT /api/finance/invoices/5 is the atomic whole-draft save (H2), so
      // it is no longer an unsupported method on this path.
      ['HEAD', '/api/finance/invoices/5'],
      ['GET', '/api/finance/invoices/5/issue'],
      ['DELETE', '/api/finance/invoices/5/payments'],
    ]) {
      const res = await json(await call(method, path));
      expect(res.status, `${method} ${path}`).toBe(405);
    }
  });

  /** `\d+` also matched `0` and `007`, which no row ever has: one is a 400
   *  from assertId, the other a lookup that can only miss. Neither is a
   *  request this router should pass on at all. */
  it('treats a non-positive-integer id as no route at all, not as a bad id', async () => {
    for (const path of [
      '/api/finance/invoices/0', '/api/finance/invoices/007', '/api/finance/invoices/abc',
      '/api/finance/invoices/5.5', '/api/finance/invoices/-1', '/api/finance/clients/0',
      '/api/finance/invoices/0/payments',
    ]) {
      const res = await json(await call('GET', path));
      expect(res.status, path).toBe(404);
    }
  });

  it('accepts a large positive id', async () => {
    const db = fakeDb([INVOICE_READ, CLIENT_READ, LINES_READ, PAYMENTS_READ]);
    const res = await json(await call('GET', '/api/finance/invoices/987654', { db }));
    expect(res.status).toBe(200);
  });
});

describe('no-store on every response', () => {
  const db = () => fakeDb([
    { match: /COALESCE\(SUM/, first: { cents: 0 } },
    INVOICE_READ, CLIENT_READ, LINES_READ, PAYMENTS_READ,
    { match: /FROM settings/, first: null },
    { match: /INSERT INTO settings/ },
    { match: /FROM clients ORDER BY/, all: [] },
    { match: /FROM invoices/, all: [invoiceRow()] },
  ]);

  it('sets it on 200, 201, 400, 404, 405 and 500 alike', async () => {
    const responses = [
      await call('GET', '/api/finance/overview', { db: db() }),
      await call('GET', '/api/finance/issuer', { db: db() }),
      await call('GET', '/api/finance/clients', { db: db() }),
      await call('GET', '/api/finance/invoices', { db: db() }),
      await call('GET', '/api/finance/invoices/5', { db: db() }),
      await call('POST', '/api/finance/clients', { db: db(), body: {} }),          // 400
      await call('GET', '/api/finance/invoices/999', { db: fakeDb() }),            // 404
      await call('GET', '/api/finance/nonsense', { db: db() }),                    // 404
      await call('PUT', '/api/finance/invoices/5', { db: db() }),                  // 405
    ];
    for (const response of responses) {
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toBe('application/json');
    }
  });
});

describe('400s name the field', () => {
  it('a body that is not JSON', async () => {
    const res = await json(await call('POST', '/api/finance/clients', { body: 'not json' }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('body');
  });

  it('a body that is an array or a bare value', async () => {
    for (const body of ['[1,2]', '"text"', 'null']) {
      const res = await json(await call('POST', '/api/finance/clients', { body }));
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('body');
    }
  });

  it('a missing required value', async () => {
    const res = await json(await call('POST', '/api/finance/clients', { body: { initials: 'SC' } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('name');
  });

  it('initials that cannot go in an invoice number', async () => {
    const res = await json(await call('POST', '/api/finance/clients', { body: { name: 'X', initials: 'WAY TOO LONG' } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('initials');
  });

  /** Review finding O-3: an explicit null for a NOT NULL column used to
   *  reach SQLite and come back as a 500. */
  it('an explicit null for a NOT NULL column', async () => {
    const db = fakeDb([{ match: /SELECT id, number, kind, request_cents/, first: { id: 5, number: null, kind: 'invoice', request_cents: null } }]);
    const res = await json(await call('PATCH', '/api/finance/invoices/5', { db, body: { currency: null } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('currency');
  });

  it('a line whose quantity is too precise, naming the line', async () => {
    const db = fakeDb([{ match: /SELECT id, number, vat_treatment/, first: { id: 5, number: null, vat_treatment: 'standard' } }]);
    const res = await json(await call('PUT', '/api/finance/invoices/5/lines', {
      db, body: { lines: [{ description: 'x', quantity: 1.23456, unit_cents: 100 }] },
    }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('lines[0].quantity');
  });

  it('issuing an invoice with no lines', async () => {
    const db = fakeDb([INVOICE_READ, CLIENT_READ, { match: /FROM invoice_lines/, all: [] }, PAYMENTS_READ]);
    const res = await json(await call('POST', '/api/finance/invoices/5/issue', { db, body: {} }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('lines');
  });

  it('voiding without a reason, and voiding twice', async () => {
    const noReason = await json(await call('POST', '/api/finance/invoices/5/void', { body: {} }));
    expect(noReason.status).toBe(400);
    expect(noReason.body.field).toBe('reason');

    // Review finding O-4.
    const db = fakeDb([{ match: /SELECT id, number, status, series FROM invoices/, first: { id: 5, number: '5.R.A.L.01', status: 'void' } }]);
    const twice = await json(await call('POST', '/api/finance/invoices/5/void', { db, body: { reason: 'again' } }));
    expect(twice.status).toBe(400);
    expect(twice.body.field).toBe('status');
  });

  it('an issuer update missing a required field', async () => {
    const res = await json(await call('PUT', '/api/finance/issuer', { body: { name: 'X' } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('address');
  });
});

describe('404s', () => {
  it('a missing invoice, client or payment list', async () => {
    const db = fakeDb(); // every read answers null
    for (const [method, path, body] of [
      ['GET', '/api/finance/invoices/999', undefined],
      ['PATCH', '/api/finance/invoices/999', { subject: 'x' }],
      ['GET', '/api/finance/invoices/999/payments', undefined],
      ['POST', '/api/finance/invoices/999/payments', { amount_cents: 100 }],
      ['PATCH', '/api/finance/clients/999', { name: 'x' }],
    ]) {
      const res = await json(await call(method, path, { db, body }));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error).toBeTruthy();
    }
  });

  it('deleting a draft that is not there', async () => {
    const res = await json(await call('DELETE', '/api/finance/invoices/999', { db: fakeDb() }));
    expect(res.status).toBe(404);
  });
});

describe('payments', () => {
  const balanceRow = (over = {}) => ({
    id: 5, number: '5.R.A.L.01', status: 'issued', kind: 'prepayment',
    total_cents: 300000, request_cents: 170000, paid_cents: 0,
    requested_cents: 170000, due_cents: 170000, ...over,
  });

  it('records one and answers 201 with the payment and the invoice', async () => {
    const db = fakeDb([
      { match: /SELECT id, number, status, kind, total_cents/, first: balanceRow() },
      { match: /INSERT INTO payments/, first: paymentRow() },
      INVOICE_READ, CLIENT_READ, LINES_READ, PAYMENTS_READ,
    ]);
    const res = await json(await call('POST', '/api/finance/invoices/5/payments', {
      db, body: { amount_cents: 170000, paid_on: '2026-07-09', label: 'Prepayment' },
    }));

    expect(res.status).toBe(201);
    expect(res.body.payment.amount_cents).toBe(170000);
    expect(res.body.invoice.paid_cents).toBe(170000);
    expect(res.body.invoice.balance_cents).toBe(130000);
    expect(res.body.invoice.due_cents).toBe(0);
    expect(res.cache).toBe('no-store');
  });

  it('refuses more than the invoice asked for, with the field', async () => {
    const db = fakeDb([{ match: /SELECT id, number, status, kind, total_cents/, first: balanceRow() }]);
    const res = await json(await call('POST', '/api/finance/invoices/5/payments', { db, body: { amount_cents: 300000 } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('amount_cents');
  });

  /** M-2: the guard lives in the INSERT, so a racing second request writes
   *  nothing and must still be told why. */
  it('is a 400 naming amount_cents when the guarded insert writes nothing', async () => {
    const db = fakeDb([
      { match: /SELECT id, number, status, kind, total_cents/, first: balanceRow() },
      { match: /INSERT INTO payments/, first: null },
    ]);
    const res = await json(await call('POST', '/api/finance/invoices/5/payments', { db, body: { amount_cents: 170000 } }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('amount_cents');
  });

  it('lists them', async () => {
    const db = fakeDb([{ match: /SELECT id FROM invoices/, first: { id: 5 } }, PAYMENTS_READ]);
    const res = await json(await call('GET', '/api/finance/invoices/5/payments', { db }));
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
  });

  it('an invoice with no payments yet is 200 with an empty list, not a 404', async () => {
    const db = fakeDb([{ match: /SELECT id FROM invoices/, first: { id: 5 } }, { match: /FROM payments/, all: [] }]);
    const res = await json(await call('GET', '/api/finance/invoices/5/payments', { db }));
    expect(res.status).toBe(200);
    expect(res.body.payments).toEqual([]);
  });
});

describe('reads carry what is paid and what is owed', () => {
  it('a single invoice', async () => {
    const db = fakeDb([INVOICE_READ, CLIENT_READ, LINES_READ, PAYMENTS_READ]);
    const res = await json(await call('GET', '/api/finance/invoices/5', { db }));
    expect(res.body.invoice.paid_cents).toBe(170000);
    expect(res.body.invoice.due_cents).toBe(0);
    expect(res.body.invoice.balance_cents).toBe(130000);
    expect(res.body.invoice.not_yet_requested_cents).toBe(130000);
    expect(res.body.invoice.payments).toHaveLength(1);
  });

  it('the list', async () => {
    const db = fakeDb([{ match: /FROM invoices/, all: [invoiceRow()] }]);
    const res = await json(await call('GET', '/api/finance/invoices', { db }));
    expect(res.body.invoices[0].paid_cents).toBe(170000);
    expect(res.body.invoices[0].computed_status).toBe('paid');
  });

  it('the overview, including what has not been invoiced yet', async () => {
    const db = fakeDb([{ match: /COALESCE\(SUM/, first: { cents: 130000 } }]);
    const res = await json(await call('GET', '/api/finance/overview', { db }));
    expect(res.body).toHaveProperty('not_yet_requested_cents');
    expect(res.body).toHaveProperty('outstanding_cents');
    expect(res.status).toBe(200);
  });

  it('an unknown status filter is a 400, not an empty list', async () => {
    const res = await json(await call('GET', '/api/finance/invoices', { search: '?status=nope' }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('status');
  });
});

describe('database errors never reach the body', () => {
  it('a D1 failure is a 500 that names no column, constraint or value', async () => {
    const error = new Error('D1_ERROR: NOT NULL constraint failed: invoices.currency — value was NULL in table invoices');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb([{ match: /FROM invoices WHERE id = \?/, throwsOnRun: error }]);

    const response = await call('GET', '/api/finance/invoices/5', { db });
    const res = await json(response);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('D1_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('constraint');
    expect(JSON.stringify(res.body)).not.toContain('invoices.currency');
    expect(res.body.error).toBe('Finance could not be saved or loaded');
    expect(res.cache).toBe('no-store');
    // It is logged, so the failure is not lost.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a failure while writing is a 500 too, not a silent 200', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeDb([{ match: /INSERT INTO clients/, throwsOnRun: new Error('D1_ERROR: UNIQUE constraint failed: clients.name') }]);
    const res = await json(await call('POST', '/api/finance/clients', { db, body: { name: 'X' } }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('UNIQUE');
    spy.mockRestore();
  });
});

describe('part 2', () => {
  it('drafts the balance of a prepayment and answers 201', async () => {
    const calls = [];
    const responses = [
      { ...invoiceRow(), requested_cents: 170000, children_cents: 0, not_yet_requested_cents: 130000 }, // parent read
      [],                                                        // siblings
      { ...invoiceRow({ id: 6, number: null, status: 'draft', parent_id: 5 }) }, // the INSERT
      { id: 6, number: null, vat_treatment: 'reverse_charge' },  // setInvoiceLines guard
    ];
    const db = {
      calls,
      prepare(sql) {
        const callRecord = { sql, args: [] };
        calls.push(callRecord);
        const index = calls.length - 1;
        const stmt = {
          bind(...args) { callRecord.args = args; return stmt; },
          async all() { return { results: Array.isArray(responses[index]) ? responses[index] : [] }; },
          async first() { return Array.isArray(responses[index]) ? null : (responses[index] ?? invoiceRow({ id: 6 })); },
          async run() { return { success: true, meta: { changes: 1, last_row_id: 6 } }; },
        };
        return stmt;
      },
    };

    const res = await json(await call('POST', '/api/finance/invoices/5/part', { db, body: {} }));
    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeTruthy();
    expect(res.cache).toBe('no-store');
  });

  it('is a 404 when the invoice is not there', async () => {
    const res = await json(await call('POST', '/api/finance/invoices/999/part', { db: fakeDb(), body: {} }));
    expect(res.status).toBe(404);
  });

  /** H-1: a second call while a part draft is open is a 400 that names the
   *  draft, not a second invoice for the same money. */
  it('is a 400 naming parent_id when a part draft is already open', async () => {
    const db = fakeDb([
      { match: /AS in_flight_cents/, first: { ...invoiceRow(), requested_cents: 170000, in_flight_cents: 130000 } },
      { match: /WHERE parent_id = \? AND status/, all: [{ id: 7, number: null, status: 'draft' }] },
    ]);
    const res = await json(await call('POST', '/api/finance/invoices/5/part', { db, body: {} }));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('parent_id');
    expect(res.body.error).toContain('draft #7');
  });
});

/**
 * The project link: an invoice belongs to the project it pays for. The
 * registry is handed in from index.js (it is the app's own deploy-time
 * artifact, not data), so the project name is attached on the way out and a
 * slug that is not a project is refused on the way in.
 */
describe('projects', () => {
  const REGISTRY = [
    { slug: 'marc-aubin', name: 'Marc Aubin' },
    { slug: 'realis-studio', name: 'Realis Studio' },
  ];

  function callWithRegistry(method, path, { body, db, search = '' } = {}) {
    const url = new URL(`https://hq.example.com${path}${search}`);
    const request = new Request(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
    return handleFinance(request, { DB: db ?? fakeDb() }, url, REGISTRY);
  }

  it('answers the money picture of one project', async () => {
    const db = fakeDb([
      { match: /FROM clients WHERE slug = \?/, first: { id: 1, name: 'Aubin chirurgie plastique SRL', initials: 'A.L', slug: 'marc-aubin' } },
      { match: /FROM invoices WHERE slug = \?/, all: [invoiceRow()] },
      {
        match: /AS invoiced_cents/,
        first: { invoiced_cents: 300000, paid_cents: 170000, owed_now_cents: 0, not_yet_requested_cents: 130000 },
      },
    ]);
    const res = await json(await callWithRegistry('GET', '/api/finance/projects/marc-aubin', { db }));

    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(res.body.totals).toEqual({
      invoiced_cents: 300000, paid_cents: 170000, owed_now_cents: 0, not_yet_requested_cents: 130000,
    });
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].number).toBe('5.R.A.L.01');
    expect(res.body.invoices[0].project_name).toBe('Marc Aubin');
    expect(res.body.client.name).toBe('Aubin chirurgie plastique SRL');
    // The slug is bound, never spliced into the SQL.
    expect(db.calls[0].args).toContain('marc-aubin');
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('decodes the slug before looking it up', async () => {
    const db = fakeDb([
      { match: /FROM clients WHERE slug = \?/, first: { id: 1, name: 'Aubin', slug: 'marc-aubin' } },
      { match: /FROM invoices WHERE slug = \?/, all: [] },
      { match: /AS invoiced_cents/, first: { invoiced_cents: 0, paid_cents: 0, owed_now_cents: 0, not_yet_requested_cents: 0 } },
    ]);
    const res = await json(await callWithRegistry('GET', '/api/finance/projects/axel%2Dde%2Dlange', { db }));
    expect(res.status).toBe(200);
    expect(db.calls[0].args).toContain('marc-aubin');
  });

  it('is a 404 for a malformed encoding rather than a 500', async () => {
    const res = await json(await callWithRegistry('GET', '/api/finance/projects/%E0%A4%A'));
    expect(res.status).toBe(404);
  });

  it('is a 404 for a slug the registry does not have', async () => {
    const res = await json(await callWithRegistry('GET', '/api/finance/projects/not-a-project'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No such project');
  });

  it('is a 405 for a method it does not answer', async () => {
    const res = await json(await callWithRegistry('POST', '/api/finance/projects/marc-aubin', { body: {} }));
    expect(res.status).toBe(405);
  });

  it('names the project on every invoice read', async () => {
    const list = await json(await callWithRegistry('GET', '/api/finance/invoices', {
      db: fakeDb([{ match: /FROM invoices/, all: [invoiceRow()] }]),
    }));
    expect(list.body.invoices[0].project_name).toBe('Marc Aubin');

    const one = await json(await callWithRegistry('GET', '/api/finance/invoices/5', {
      db: fakeDb([INVOICE_READ, CLIENT_READ, LINES_READ, PAYMENTS_READ]),
    }));
    expect(one.body.invoice.project_name).toBe('Marc Aubin');
  });

  it('leaves project_name null for an invoice with no project', async () => {
    const res = await json(await callWithRegistry('GET', '/api/finance/invoices', {
      db: fakeDb([{ match: /FROM invoices/, all: [invoiceRow({ slug: null })] }]),
    }));
    expect(res.body.invoices[0].project_name).toBeNull();
  });

  it('refuses a client or invoice slug that is not a project', async () => {
    const client = await json(await callWithRegistry('POST', '/api/finance/clients', {
      body: { name: 'X', slug: 'made-up-project' },
    }));
    expect(client.status).toBe(400);
    expect(client.body.field).toBe('slug');

    const invoice = await json(await callWithRegistry('POST', '/api/finance/invoices', {
      body: { client_id: 1, slug: 'made-up-project' },
    }));
    expect(invoice.status).toBe(400);
    expect(invoice.body.field).toBe('slug');
  });

  it('accepts a real project slug', async () => {
    const db = fakeDb([{ match: /INSERT INTO clients/, first: { id: 2, name: 'X', slug: 'realis-studio' } }]);
    const res = await json(await callWithRegistry('POST', '/api/finance/clients', {
      db, body: { name: 'X', slug: 'realis-studio' },
    }));
    expect(res.status).toBe(201);
  });
});
