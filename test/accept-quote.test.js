/**
 * « Accept quote », against a real SQLite database: a signed quote's
 * prepayment invoice makes the lead a client in one action, says what it will
 * do first, and changes nothing the second time. The order then shows the
 * prepayment's money instead of €0.
 *
 * Every database here is created empty and thrown away. No production data.
 */
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import fileRegistry from '../projects.json';
import * as db from '../src/worker/db.js';
import * as orders from '../src/worker/orders-db.js';
import * as store from '../src/worker/registry-store.js';
import { listProspects, createProspect } from '../src/worker/prospects-db.js';
import { mergeRegistry } from '../src/shared/registry.js';
import { planAcceptQuote, acceptQuote, publicPlan } from '../src/worker/accept-quote.js';

const TODAY = '2026-10-29';

async function registryOf(database) {
  return mergeRegistry(fileRegistry, await store.readRows(database)).registry;
}

/** A surgeon from the outreach list who signed: her lead, her client, and an
 *  issued 40 % deposit on a €1500 website. */
async function withSignedQuote(fn, { email = 'dr.example@clinic-example.be', issue = true } = {}) {
  const { database, dispose } = await freshDatabase();
  try {
    await db.upsertDataset(database, { key: 'surgeons-test', business: 'Realis', title: 'Surgeons', tiers: { hot: 80, warm: 50 } });
    await db.upsertLead(database, {
      dataset: 'surgeons-test', id: 'example', business: 'Realis', name: 'Dr Example', website: 'https://clinic-example.be',
      category: 'Surgeon', country: 'Belgium', score: 90, tier: 'Hot', payload: {}, email,
    });
    await db.patchLeadState(database, 'surgeons-test/example', { stage: 'talks', notes: 'Call on 28/10.' });
    const client = await db.createClient(database, { name: 'Example Clinic', initials: 'EX', email, vat_number: 'BE 0123.456.789' });
    const draft = await db.createInvoice(database, { client_id: client.id, subject: 'Website — deposit 40 %', kind: 'prepayment', request_cents: 60000 });
    await db.setInvoiceLines(database, draft.id, [{ description: 'Website — Package 1', quantity: 1, unit_cents: 150000 }]);
    if (issue) await db.issueInvoice(database, draft.id, TODAY);
    await fn(database, { client, invoiceId: draft.id });
  } finally { await dispose(); }
}

describe('Accept quote', () => {
  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('says what it will do before it does anything', async () => {
    await withSignedQuote(async (database, { invoiceId }) => {
      const plan = publicPlan(await planAcceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, TODAY));
      expect(plan.slug).toBe('dr-example');
      expect(plan.parent).toBe('realis-studio');
      expect(plan.lead.uid).toBe('surgeons-test/example');
      expect(plan.steps.map((s) => s.key)).toEqual(['lead', 'project', 'client', 'invoice', 'order', 'onboarding', 'todo0', 'todo1', 'todo2']);
      expect(plan.steps.every((s) => !s.done)).toBe(true);
      expect(plan._ctx).toBeUndefined();
      // Reading the plan wrote nothing.
      expect((await db.getLead(database, 'surgeons-test/example')).stage).toBe('talks');
      expect(await orders.listOrders(database, {})).toHaveLength(0);
    });
  });

  // Skipped in this public snapshot: it pins a project of the private registry (projects.json), which is not here.
  it.skip('makes the lead a full client, and a second run changes nothing', async () => {
    await withSignedQuote(async (database, { client, invoiceId }) => {
      const ran = await acceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, { actor: 'test', today: TODAY });
      expect(ran.done).toHaveLength(9);

      const lead = await db.getLead(database, 'surgeons-test/example');
      expect(lead.stage).toBe('won');
      expect(lead.notes).toMatch(/^Call on 28\/10\.\n2026-10-29: quote accepted/);

      const project = (await registryOf(database)).find((p) => p.slug === 'dr-example');
      expect(project).toMatchObject({ name: 'Dr Example', kind: 'client', stage: 'not_started', parent: 'realis-studio' });
      expect((await db.listClients(database)).find((c) => c.id === client.id).slug).toBe('dr-example');
      expect((await db.getInvoice(database, invoiceId)).slug).toBe('dr-example');

      const [order] = await orders.listOrders(database, { slug: 'dr-example' });
      const full = await orders.getOrder(database, order.id, { today: TODAY });
      expect(full.lines).toHaveLength(0); // the money stays on the prepayment: never billed twice
      expect(full.totals).toMatchObject({ uninvoiced_cents: 0, prepaid_total_cents: 150000, prepaid_asked_cents: 60000, prepaid_paid_cents: 0 });

      const onboarding = (await listProspects(database)).filter((p) => p.client_id === client.id);
      expect(onboarding).toHaveLength(1);
      expect(onboarding[0]).toMatchObject({ stage: 'won', lead_uid: 'surgeons-test/example' });
      expect(onboarding[0].live_token ?? null).toBeNull(); // no link: Andy makes it and sends it

      const todos = await db.listTodos(database, {}, TODAY);
      expect(todos.map((t) => [t.due, t.title])).toEqual(expect.arrayContaining([
        ['2026-11-03', 'Dr Example: get the onboarding answers'],
        [expect.any(String), expect.stringMatching(/^Dr Example: chase deposit /)],
        [expect.any(String), expect.stringMatching(/^Dr Example: start the project once /)],
      ]));

      const again = await acceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example' }, { actor: 'test', today: TODAY });
      expect(again.done).toEqual([]);
      expect(await orders.listOrders(database, { slug: 'dr-example' })).toHaveLength(1);
      expect((await listProspects(database)).filter((p) => p.client_id === client.id)).toHaveLength(1);
      expect(await db.listTodos(database, {}, TODAY)).toHaveLength(todos.length);
    });
  });

  it('finishes a client set up by hand without touching what is there', async () => {
    await withSignedQuote(async (database, { client, invoiceId }) => {
      await db.patchLeadState(database, 'surgeons-test/example', { stage: 'won' });
      await db.updateClient(database, client.id, { slug: 'dr-example' });
      const plan = await planAcceptQuote(database, invoiceId, await registryOf(database), {}, TODAY);
      expect(plan.slug).toBe('dr-example');
      expect(plan.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['lead', 'client']);
      const ran = await acceptQuote(database, invoiceId, await registryOf(database), {}, { actor: 'test', today: TODAY });
      expect(ran.done).not.toContain('lead');
      expect((await db.getLead(database, 'surgeons-test/example')).notes).toBe('Call on 28/10.');
    });
  });

  it('refuses a draft, and an invoice that already belongs to another project', async () => {
    await withSignedQuote(async (database, { invoiceId }) => {
      await expect(planAcceptQuote(database, invoiceId, await registryOf(database), {}, TODAY)).rejects.toThrow(/Issue the prepayment invoice first/);
    }, { issue: false });
    await withSignedQuote(async (database, { client, invoiceId }) => {
      await db.updateClient(database, client.id, { slug: 'marc-aubin' });
      await expect(planAcceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example' }, TODAY)).rejects.toThrow(/already belongs/);
    });
  });

  it('never matches a lead by a free-mail domain', async () => {
    await withSignedQuote(async (database, { client, invoiceId }) => {
      await db.updateClient(database, client.id, { email: 'someone.else@gmail.com' });
      const plan = await planAcceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example' }, TODAY);
      expect(plan.lead).toBeNull();
      expect(plan.steps[0]).toMatchObject({ key: 'lead', done: true });
    }, { email: 'dr.example@gmail.com' });
  });
});

describe('an invoice is linked to its project once', () => {
  it('fills an empty project and never moves it', async () => {
    await withSignedQuote(async (database, { invoiceId }) => {
      expect(await db.linkInvoiceProject(database, invoiceId, 'dr-example')).toBe(true);
      expect(await db.linkInvoiceProject(database, invoiceId, 'other')).toBe(false);
      expect((await db.getInvoice(database, invoiceId)).slug).toBe('dr-example');
    });
  });

  // Audit A6 (code-map F3, seen in use): the deal already in the pipeline has no
  // client yet. It is that deal that is won, not a second one beside it.
  for (const how of ['lead', 'address']) {
    it(`closes the deal already in the pipeline, found by its ${how}`, async () => {
      await withSignedQuote(async (database, { client, invoiceId }) => {
        const deal = await createProspect(database, {
          name: 'Dr Example', organisation: 'Example Clinic', stage: 'proposal', brand: 'realis',
          ...(how === 'lead' ? { lead_uid: 'surgeons-test/example' } : { email: 'DR.example@clinic-example.be' }),
        });
        const plan = publicPlan(await planAcceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, TODAY));
        expect(plan.steps.find((s) => s.key === 'onboarding').label).toMatch(/^Deal « Dr Example » → won/);

        await acceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, { actor: 'test', today: TODAY });
        const all = await listProspects(database);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ id: deal.id, stage: 'won', client_id: client.id });

        // A second run finds it linked and changes nothing.
        await acceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, { actor: 'test', today: TODAY });
        expect(await listProspects(database)).toHaveLength(1);
      });
    });
  }

  it('never takes over a lost deal', async () => {
    await withSignedQuote(async (database, { client, invoiceId }) => {
      await createProspect(database, { name: 'Dr Example', stage: 'lost', lead_uid: 'surgeons-test/example', brand: 'realis' });
      await acceptQuote(database, invoiceId, await registryOf(database), { slug: 'dr-example', name: 'Dr Example' }, { actor: 'test', today: TODAY });
      const all = await listProspects(database);
      expect(all).toHaveLength(2);
      expect(all.find((p) => p.client_id === client.id).stage).toBe('won');
      expect(all.find((p) => p.client_id === null).stage).toBe('lost');
    });
  });
});
