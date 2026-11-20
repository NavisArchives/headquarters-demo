// The deposit is paid: the project starts and Home stops saying « chase » (audit B9, F5).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import fileRegistry from '../projects.json';
import * as db from '../src/worker/db.js';
import * as store from '../src/worker/registry-store.js';
import { mergeRegistry } from '../src/shared/registry.js';
import { acceptQuote } from '../src/worker/accept-quote.js';
import { onPrepaymentSettled } from '../src/worker/deposit-paid.js';

const TODAY = '2026-10-29';
const registryOf = async (database) => mergeRegistry(fileRegistry, await store.readRows(database)).registry;

async function withAcceptedQuote(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    const client = await db.createClient(database, { name: 'Example Clinic', initials: 'EX', email: 'a@clinic-example.be', vat_number: 'BE 0123.456.789' });
    const draft = await db.createInvoice(database, { client_id: client.id, subject: 'Website — deposit 40 %', kind: 'prepayment', request_cents: 60000 });
    await db.setInvoiceLines(database, draft.id, [{ description: 'Website', quantity: 1, unit_cents: 150000 }]);
    await db.issueInvoice(database, draft.id, TODAY);
    await acceptQuote(database, draft.id, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, { actor: 'test', today: TODAY });
    await fn(database, draft.id);
  } finally { await dispose(); }
}
const openTodos = async (database) => (await database.prepare('SELECT title FROM todos WHERE done_at IS NULL ORDER BY id').all()).results.map((r) => r.title);

describe('a paid deposit', () => {
  it('starts the project and ticks off its two deposit to-dos, nothing else', async () => {
    await withAcceptedQuote(async (database, id) => {
      expect((await registryOf(database)).find((p) => p.slug === 'dr-example').stage).toBe('not_started');
      expect(await openTodos(database)).toHaveLength(3);
      await db.recordPayment(database, id, { amount_cents: 60000, paid_on: '2026-11-02' });
      const out = await onPrepaymentSettled(database, await db.getInvoice(database, id), { registry: await registryOf(database), file: fileRegistry });
      expect(out).toEqual({ started: true, cleared: 2 });
      expect((await registryOf(database)).find((p) => p.slug === 'dr-example').stage).toBe('active');
      expect(await openTodos(database)).toEqual(['Dr Example: get the onboarding answers']);
    });
  }, 30000);

  it('does nothing while the deposit is only partly paid', async () => {
    await withAcceptedQuote(async (database, id) => {
      await db.recordPayment(database, id, { amount_cents: 20000, paid_on: '2026-11-02' });
      const out = await onPrepaymentSettled(database, await db.getInvoice(database, id), { registry: await registryOf(database), file: fileRegistry });
      expect(out).toEqual({ started: false, cleared: 0 });
      expect((await registryOf(database)).find((p) => p.slug === 'dr-example').stage).toBe('not_started');
      expect(await openTodos(database)).toHaveLength(3);
    });
  }, 30000);

  it('leaves an active project and an ordinary invoice alone', async () => {
    await withAcceptedQuote(async (database, id) => {
      await db.recordPayment(database, id, { amount_cents: 60000, paid_on: '2026-11-02' });
      const inv = await db.getInvoice(database, id);
      await onPrepaymentSettled(database, inv, { registry: await registryOf(database), file: fileRegistry });
      // Second time: already active, nothing left to tick.
      expect(await onPrepaymentSettled(database, inv, { registry: await registryOf(database), file: fileRegistry })).toEqual({ started: false, cleared: 0 });
      expect(await onPrepaymentSettled(database, { ...inv, kind: 'invoice' }, { registry: await registryOf(database) })).toEqual({ started: false, cleared: 0 });
    });
  }, 30000);
});
