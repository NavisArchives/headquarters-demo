// Chasing an overdue invoice (audit B7): the reminder, Home's list, the
// snooze, and the print view's payments and balance.
import { describe, it, expect } from 'vitest';
import { installDom, html } from './dom-shim.js';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { reminderText, daysLate } from '../src/public/assets/finance-lib.js';

installDom();
const { homeItems } = await import('../src/public/assets/todos.js');
const { paperDoc } = await import('../src/public/assets/screens/finance.js');

const INV = { id: 7, number: '9.R.A.S.02', issued_on: '2026-10-01', due_on: '2026-10-31', due_cents: 130050, currency: 'EUR' };

describe('the reminder Andy pastes into his own email', () => {
  it('names the invoice, the amount and the dates in each language, with no link', () => {
    const fr = reminderText(INV, 'FR');
    expect(fr).toMatch(/^Bonjour,\n\nPetit rappel concernant la facture 9\.R\.A\.S\.02 du 1 octobre 2026/);
    expect(fr).toMatch(/1\s?300,50\s?€/);
    expect(fr).toContain('le 31 octobre 2026');
    const nl = reminderText(INV, 'NL');
    expect(nl).toMatch(/^Beste,\n\nEen korte herinnering voor factuur 9\.R\.A\.S\.02 van 1 oktober 2026/);
    expect(nl).toMatch(/€\s?1\.300,50/);
    const en = reminderText(INV, 'EN');
    expect(en).toMatch(/^Hello,\n\nA quick reminder about invoice 9\.R\.A\.S\.02 of 1 October 2026, for €1,300\.50, which fell due on 31 October 2026\./);
    for (const t of [fr, nl, en]) {
      expect(t).not.toMatch(/https?:|www\.|\{\{/);
      expect(t.endsWith('\nAndy')).toBe(true);
    }
  });

  it('uses the wording NIRMATA approved (14 Nov)', () => {
    expect(reminderText(INV, 'FR')).toContain('Si le paiement a déjà été effectué, merci, et ne tenez pas compte de ce message.');
    expect(reminderText(INV, 'NL')).toContain('Is de betaling al gebeurd, dan alvast bedankt en mag u dit bericht negeren.');
  });

  it('names the balance due after a part payment, never the total', () => {
    const part = { ...INV, total_cents: 260100, requested_cents: 260100, paid_cents: 130050, due_cents: 130050 };
    for (const lang of ['FR', 'NL', 'EN']) {
      const t = reminderText(part, lang);
      expect(t).toMatch(/1[\s.,\u202f]?300[,.]50/);
      expect(t).not.toMatch(/2[\s.,\u202f]?601[,.]00/);
    }
  });

  it('counts the days late', () => {
    expect(daysLate('2026-10-31', '2026-11-14')).toBe(14);
    expect(daysLate('2026-11-20', '2026-11-14')).toBe(0);
  });
});

describe("Home's chase list", () => {
  const overdue = [
    { id: 7, number: '9.R.A.S.02', subject: 'Website', due_on: '2026-10-31' },
    { id: 8, number: '9.R.A.S.03', subject: 'Care', due_on: '2026-10-31', chase_snoozed_until: '2026-11-17' },
    { id: 9, number: '9.R.A.S.04', subject: 'Old', due_on: '2026-10-31', chase_snoozed_until: '2026-11-14' },
  ];
  it('opens the invoice on Finance, and leaves a snoozed one out until its date', () => {
    const items = homeItems({ overdue, today: '2026-11-14' }).filter((i) => i.title.startsWith('Chase'));
    expect(items.map((i) => i.title)).toEqual(['Chase 9.R.A.S.02 · Website', 'Chase 9.R.A.S.04 · Old']);
    expect(items[0].to).toBe('/finance?invoice=7');
  });
});

describe('the printed invoice', () => {
  const issued = {
    ...INV, kind: 'invoice', status: 'sent', subject: 'Website', total_cents: 260100, subtotal_cents: 260100, vat_cents: 0,
    vat_treatment: 'reverse_charge', client: { name: 'A Client' }, lines: [{ description: 'Site', quantity: 1, unit_cents: 260100, amount_cents: 260100 }],
    payments: [{ paid_on: '2026-11-05', amount_cents: 130050 }],
  };
  it('lists what was paid and what is still due', () => {
    const page = html(paperDoc(issued, { name: 'Realis Studio' }));
    expect(page).toContain('Paid 05 NOV 2026'); // the paper's own date format
    expect(page).toMatch(/Balance due/);
    expect(page).toMatch(/1,300\.50/);
  });
  it('says paid in full once nothing is due, and prints nothing extra with no payment', () => {
    expect(html(paperDoc({ ...issued, due_cents: 0 }, { name: 'Realis Studio' }))).toContain('Paid in full');
    expect(html(paperDoc({ ...issued, payments: [] }, { name: 'Realis Studio' }))).not.toMatch(/Balance due|Paid in full/);
  });
});

describe('snoozing a chase', () => {
  async function withIssued(fn) {
    const { database, dispose } = await freshDatabase();
    try {
      const client = await db.createClient(database, { name: 'A Client', initials: 'AC' });
      const draft = await db.createInvoice(database, { client_id: client.id, vat_treatment: 'exempt_small' });
      await db.setInvoiceLines(database, draft.id, [{ description: 'Work', quantity: 1, unit_cents: 1000 }]);
      const issued = await db.issueInvoice(database, draft.id, '2026-10-01');
      await fn(database, issued, draft);
    } finally { await dispose(); }
  }

  it('puts it aside for some days, and back with 0', async () => {
    await withIssued(async (database, issued) => {
      expect((await db.snoozeInvoiceChase(database, issued.id, 3, '2026-11-14')).chase_snoozed_until).toBe('2026-11-17');
      expect((await db.snoozeInvoiceChase(database, issued.id, 0, '2026-11-14')).chase_snoozed_until).toBeNull();
    });
  }, 30000);

  it('refuses a draft, a void invoice and silly numbers', async () => {
    await withIssued(async (database, issued) => {
      const client = (await db.listClients(database))[0];
      const draft = await db.createInvoice(database, { client_id: client.id });
      await expect(db.snoozeInvoiceChase(database, draft.id, 3)).rejects.toMatchObject({ field: 'status' });
      await expect(db.snoozeInvoiceChase(database, issued.id, 31)).rejects.toMatchObject({ field: 'days' });
      await expect(db.snoozeInvoiceChase(database, issued.id, 1.5)).rejects.toMatchObject({ field: 'days' });
      await db.voidInvoice(database, issued.id, 'test');
      await expect(db.snoozeInvoiceChase(database, issued.id, 3)).rejects.toMatchObject({ field: 'status' });
    });
  }, 30000);
});
