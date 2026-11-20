// Applies every file in migrations/ to a real D1 (workerd's SQLite, through
// Miniflare) and drives the invoice lifecycle through src/worker/db.js.
// The unit tests under test/ use a fake D1 that only records bindings, so this
// is the only check that the migration SQL actually parses and that the
// constraints, indexes and money maths hold on the engine production uses.
//
// Run: node scripts/database-smoke.mjs   (also part of `npm run validate`)
import { Miniflare } from 'miniflare';
import { sqlStatements } from './sql-statements.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as db from '../src/worker/db.js';

// Miniflare 5 (bundled with wrangler 4.135+) takes a `workers` array whose
// entries carry a Workers `config` object: script via `manifest`, bindings via
// `env`. The old flat `{ modules, script, d1Databases }` shape is rejected.
const mf = new Miniflare({
  workers: [{
    config: {
      name: 'hq-database-smoke',
      type: 'worker',
      compatibilityDate: '2025-07-18',
      manifest: {
        mainModule: 'index.mjs',
        modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } },
      },
      env: { DB: { type: 'd1', id: 'DB' } },
    },
  }],
});

try {
  const database = await mf.getD1Database('DB');

  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    for (const statement of sqlStatements(sql)) await database.prepare(statement).run();
  }
  assert.ok(migrations.includes('0005_finance_constraints.sql'), 'expected the finance constraints migration to be present');

  // 0005 recreated the finance tables with CHECK constraints; prove SQLite enforces them.
  // A real client first: D1 enforces foreign keys, so a bad client_id would be rejected for the wrong reason.
  const nlClient = await db.createClient(database, { name: 'Smoke test EU client', initials: 'EU', country: 'NL', vat_number: 'NL123456789B01' });
  const badInsert = (status, vat) => database.prepare(
    "INSERT INTO invoices (client_id, status, currency, vat_treatment, created_at, updated_at) VALUES (?, ?, 'EUR', ?, 'x', 'x')",
  ).bind(nlClient.id, status, vat).run();
  await assert.rejects(badInsert('sent', 'standard'), /CHECK constraint failed/, 'status CHECK not enforced');
  await assert.rejects(badInsert('draft', 'made_up'), /CHECK constraint failed/, 'vat_treatment CHECK not enforced');
  // 0007 moves the partial unique index onto (series, year, seq): the
  // real numbering is one running counter and does not restart in January.
  const seqIndex = await database.prepare("SELECT sql FROM sqlite_master WHERE name = 'invoices_series_year_seq'").first();
  assert.match(seqIndex?.sql ?? '', /ON invoices\(series, year, seq\) WHERE seq IS NOT NULL/, 'partial unique index invoices_series_year_seq missing after 0007');

  // Changing vat_treatment must recompute vat/total from the stored lines (fixed in 7904dec).
  const rc = await db.createInvoice(database, { client_id: nlClient.id, subject: 'VAT recompute' }); // defaults to reverse_charge
  await db.setInvoiceLines(database, rc.id, [{ description: 'Campaign', quantity: 1, unit_cents: 250000 }]);
  const money = async (id) => { const r = await db.getInvoice(database, id); return [r.subtotal_cents, r.vat_cents, r.total_cents]; };
  assert.deepEqual(await money(rc.id), [250000, 0, 250000]);
  await db.updateInvoice(database, rc.id, { vat_treatment: 'standard' });
  assert.deepEqual(await money(rc.id), [250000, 52500, 302500], 'vat_cents/total_cents went stale after switching to standard');
  await db.updateInvoice(database, rc.id, { vat_treatment: 'reverse_charge' });
  assert.deepEqual(await money(rc.id), [250000, 0, 250000], 'vat_cents/total_cents went stale after switching back to reverse_charge');
  await assert.rejects(db.updateInvoice(database, rc.id, { vat_treatment: 'made_up' }), 'db.js accepted an unknown vat_treatment');

  // Invoice lifecycle end to end.
  const client = await db.createClient(database, { name: 'Smoke test client', initials: 'TEST', country: 'BE', vat_number: 'BE1234567890' });
  const invoice = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'standard', subject: 'Test' });
  await db.setInvoiceLines(database, invoice.id, [{ description: 'Service', quantity: 2, unit_cents: 10000 }, { description: 'Included', quantity: 1, unit_cents: 5000, no_charge: true }]);
  let detail = await db.getInvoice(database, invoice.id);
  assert.equal(detail.total_cents, 24200); assert.equal(detail.lines.length, 2);
  await assert.rejects(db.setInvoiceLines(database, invoice.id, [{ description: '', quantity: 1, unit_cents: 5 }]));
  assert.equal((await db.getInvoice(database, invoice.id)).lines.length, 2);
  const issued = await db.issueInvoice(database, invoice.id, '2026-09-20');
  assert.equal(issued.number, '1.R.A.TEST.01'); // <n>.R.A.<client letters>.<that client's NN>
  await assert.rejects(db.issueInvoice(database, invoice.id, '2026-09-20'));
  await assert.rejects(db.deleteDraft(database, invoice.id));
  await db.markSent(database, invoice.id, '2026-09-20');
  assert.equal((await db.financeOverview(database, '2026-11-01')).overdue_cents, 24200);
  // Payments (0006): a part payment leaves a balance, markPaid clears it.
  await db.recordPayment(database, invoice.id, { amount_cents: 4200, paid_on: '2026-10-01', label: 'Part' });
  assert.equal((await db.getInvoice(database, invoice.id)).due_cents, 20000);
  assert.equal((await db.financeOverview(database, '2026-11-01')).outstanding_cents, 20000);
  await db.markPaid(database, invoice.id, '2026-10-01');
  assert.equal((await db.financeOverview(database, '2026-11-01')).outstanding_cents, 0);
  assert.equal((await db.financeOverview(database, '2026-11-01')).paid_this_year_cents, 24200);
  assert.equal((await db.getInvoice(database, invoice.id)).computed_status, 'paid');
  await db.voidInvoice(database, invoice.id, 'Test finished');
  assert.equal((await db.getInvoice(database, invoice.id)).computed_status, 'void');

  console.log(`PASS: ${migrations.length} migrations applied to real D1 (Miniflare), CHECK constraints enforced, VAT recomputed on treatment change, invoice totals, invalid-line rollback, numbering, issue lock, sent, overdue, part payments and void lifecycle. No production data used.`);
} finally { await mf.dispose(); }
