// Reports (audit E18): the funnel, the pipeline value, the money by month, and
// the 0031 fields they count by.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import * as pdb from '../src/worker/prospects-db.js';
import { recordOwnSend } from '../src/worker/lead-sends.js';
import { funnel, pipelineValue, moneyByMonth } from '../src/worker/api/reports.js';

async function withLeads(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('surg', 'Plastic surgeons', 'S', 70, 50, 'x'), ('arch', 'Architects', 'A', 70, 50, 'x')").run();
    for (const [uid, ds] of [['surg/a', 'surg'], ['surg/b', 'surg'], ['surg/c', 'surg'], ['arch/d', 'arch']]) {
      // eslint-disable-next-line no-await-in-loop -- setup
      await database.prepare("INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at) VALUES (?, ?, ?, 'X', ?, '', 'c', 'BE', ?, 80, 'Hot', '{}', 'x')")
        .bind(uid, ds, uid.split('/')[1], uid, `${uid.split('/')[1]}@x.be`).run();
    }
    await fn(database);
  } finally { await dispose(); }
}

describe('0031: batch and template as fields', () => {
  it('logs them on every new send', async () => {
    await withLeads(async (database) => {
      await recordOwnSend(database, 'surg/a', { mode: 'email', at: '2026-11-02T10:00:00.000Z' });
      const row = await database.prepare("SELECT batch, template FROM lead_events WHERE uid = 'surg/a' AND kind = 'sent'").first();
      expect(row).toEqual({ batch: 'hq-popup', template: 'first-email' });
    });
  }, 30000);
});

describe('0031: the back-fill from the send log text', () => {
  it('reads batch and template from « batch X · template Y · … », and leaves other rows alone', async () => {
    await withLeads(async (database) => {
      const add = (detail, kind = 'sent') => database.prepare("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('surg/a', ?, ?, 'x')").bind(kind, detail).run();
      await add('batch 2026-10-27-b2 · template v3-short · to a@x.be · message m1');
      await add('batch b1');
      await add('batch b9 · to c@x.be');
      await add('Marked as sent in HQ');
      await add('batch b3 · template t', 'note');
      const sql = readFileSync(new URL('../migrations/0031_reports_fields.sql', import.meta.url), 'utf8');
      for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter((x) => x.startsWith('UPDATE'))) {
        // eslint-disable-next-line no-await-in-loop -- in order
        await database.prepare(stmt).run();
      }
      const { results } = await database.prepare('SELECT kind, batch, template FROM lead_events ORDER BY id').all();
      expect(results).toEqual([
        { kind: 'sent', batch: '2026-10-27-b2', template: 'v3-short' },
        { kind: 'sent', batch: 'b1', template: null },
        { kind: 'sent', batch: 'b9', template: null },
        { kind: 'sent', batch: null, template: null },
        { kind: 'note', batch: null, template: null },
      ]);
    });
  }, 30000);
});

describe('the funnel', () => {
  it('counts leads, not emails, through each step, by list, batch and template, with opens from KV', async () => {
    await withLeads(async (database) => {
      const ev = (uid, batch, template, at) => database.prepare("INSERT INTO lead_events (uid, kind, detail, at, batch, template) VALUES (?, 'sent', 'x', ?, ?, ?)").bind(uid, at, batch, template).run();
      await ev('surg/a', 'b1', 'letter', '2026-09-30T08:00:00Z');
      await ev('surg/a', 'b2', 'followup', '2026-10-07T08:00:00Z');
      await ev('surg/b', 'b1', 'letter', '2026-09-30T08:00:00Z');
      await ev('arch/d', 'b2', 'letter', '2026-10-07T08:00:00Z');
      await db.patchLeadState(database, 'surg/a', { stage: 'talks' });
      await db.patchLeadState(database, 'surg/b', { stage: 'sent' });
      await db.patchLeadState(database, 'arch/d', { stage: 'won' });
      const kv = { get: async (k) => (k === 'opens:surg/b' ? ['2026-10-01T09:00:00Z'] : null) };

      const byList = await funnel(database, { by: 'dataset', opens: kv });
      expect(byList.groups).toEqual([
        { key: 'surg', sent: 2, opened: 1, replied: 1, talks: 1, won: 0 },
        { key: 'arch', sent: 1, opened: 0, replied: 1, talks: 1, won: 1 },
      ]);
      expect(byList.opens).toEqual({ read: 3, of: 3, complete: true });
      const byBatch = await funnel(database, { by: 'batch' });
      expect(byBatch.groups.map((g) => [g.key, g.sent])).toEqual([['b1', 2], ['b2', 2]]);
      const byTemplate = await funnel(database, { by: 'template' });
      expect(byTemplate.groups.find((g) => g.key === 'letter').sent).toBe(3);
      await expect(funnel(database, { by: 'nope' })).rejects.toMatchObject({ status: 400 });
    });
  }, 30000);
});

describe('the pipeline value', () => {
  it('sums open deals by stage where a value is set, and the won ones', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      await pdb.createProspect(database, { name: 'A', stage: 'proposal', value_cents: 300000 });
      await pdb.createProspect(database, { name: 'B', stage: 'proposal' });
      await pdb.createProspect(database, { name: 'C', stage: 'meeting', value_cents: 150000 });
      await pdb.createProspect(database, { name: 'D', stage: 'won', value_cents: 200000 });
      await pdb.createProspect(database, { name: 'E', stage: 'lost', value_cents: 999900 });
      await expect(pdb.createProspect(database, { name: 'F', stage: 'lead', value_cents: -5 })).rejects.toMatchObject({ field: 'value_cents' });
      const out = await pipelineValue(database);
      expect(out.open.find((r) => r.stage === 'proposal')).toMatchObject({ deals: 2, valued: 1, value_cents: 300000 });
      expect(out.open_total).toEqual({ deals: 3, valued: 2, value_cents: 450000 });
      expect(out.won).toEqual({ deals: 1, valued: 1, value_cents: 200000 });
    } finally { await dispose(); }
  }, 30000);
});

describe('money by month', () => {
  it('keeps invoiced and received apart, and never adds two currencies', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      const client = await db.createClient(database, { name: 'A Client', initials: 'AC' });
      const issue = async (cents, currency, on) => {
        const d = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small', currency });
        await db.setInvoiceLines(database, d.id, [{ description: 'Work', quantity: 1, unit_cents: cents }]);
        return db.issueInvoice(database, d.id, on);
      };
      const eur = await issue(100000, 'EUR', '2026-10-05');
      await issue(50000, 'USD', '2026-10-06');
      await db.recordPayment(database, eur.id, { amount_cents: 40000, paid_on: '2026-11-02' });
      const out = await moneyByMonth(database, 2026);
      expect(out.months).toEqual([
        { month: '2026-10', currency: 'EUR', invoiced_cents: 100000, invoices: 1, received_cents: 0, payments: 0 },
        { month: '2026-10', currency: 'USD', invoiced_cents: 50000, invoices: 1, received_cents: 0, payments: 0 },
        { month: '2026-11', currency: 'EUR', invoiced_cents: 0, invoices: 0, received_cents: 40000, payments: 1 },
      ]);
      expect(out.totals).toEqual({ EUR: { invoiced_cents: 100000, received_cents: 40000 }, USD: { invoiced_cents: 50000, received_cents: 0 } });
      await expect(moneyByMonth(database, 'soon')).rejects.toMatchObject({ status: 400 });
    } finally { await dispose(); }
  }, 30000);
});
