// The issuer switch (Andy, 14 Nov: « it will be a switch », « always wise iban »). Each invoice
// picks Belgium or Abroad IE; what it prints is frozen on it, and it is always paid into Wise.
// Real SQLite through Miniflare, every migration applied. Fictional data only.
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { installDom, html } from './dom-shim.js';
import * as db from '../src/worker/db.js';

installDom();
const { paperDoc, issuerChoices, issuerSnapshot } = await import('../src/public/assets/screens/finance.js');

async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}

const ISSUER = { name: 'Demo Studio', tagline: 'Visual studio', address: '1 Demo Street\nTestville', vat_number: '000', email: 'a@example.com', iban: 'BE00 0000 0000 0001', bic: 'TESTBEB1', payment_name: 'Demo Studio', payment_terms_days: 30 };
const ACCOUNTS = [
  { id: 'wise', label: 'Wise (Belgium)', payment_name: 'Demo Studio', iban: 'BE00 0000 0000 0001', bic: 'TESTBEB1' },
  { id: 'bog', label: 'Second Bank', payment_name: 'Demo Studio', iban: 'GE00 TB00 0000 0000 0000 01', bic: 'TESTGE22' },
];

async function seeded(database) {
  await db.setSetting(database, 'issuer', ISSUER);
  await db.setSetting(database, 'bank_accounts', ACCOUNTS);
  await db.setIssuerProfile(database, 'be', { name: 'Demo Person', address: 'Demo Avenue 1\nDemotown' });
  await db.setIssuerProfile(database, 'ge', {
    name: 'Individual Entrepreneur Demo Person', address: 'Demo street N1\nDemo City', vat_number: '123456789',
    registered_on: '2025-01-02', phone: '+000 000 000',
  });
  const client = await db.createClient(database, { name: 'Demo Client', initials: 'DC', country: 'BE' });
  const invoice = await db.createInvoice(database, { client_id: client.id, subject: 'Site', vat_treatment: 'exempt_small' });
  await db.setInvoiceLines(database, invoice.id, [{ description: 'Website', quantity: 1, unit_cents: 100000 }]);
  return { client, invoice };
}

describe('issuer profiles', () => {
  it('start blank, Belgium and Abroad IE, and an invoice has none until it picks one', () => withDatabase(async (database) => {
    const profiles = await db.getIssuerProfiles(database);
    expect(profiles.map((p) => [p.id, p.label, p.name])).toEqual([['be', 'Belgium', ''], ['ge', 'Abroad IE', '']]);
    const client = await db.createClient(database, { name: 'C', initials: 'CC', country: 'BE' });
    const invoice = await db.createInvoice(database, { client_id: client.id });
    expect(invoice.issuer_profile).toBeNull();
    expect(invoice.issuer_snapshot).toBeNull();
  }));

  it('a blank profile cannot be picked', () => withDatabase(async (database) => {
    await db.setSetting(database, 'bank_accounts', ACCOUNTS);
    const client = await db.createClient(database, { name: 'C', initials: 'CC', country: 'BE' });
    const invoice = await db.createInvoice(database, { client_id: client.id });
    await expect(db.updateInvoice(database, invoice.id, { issuer_profile: 'be' })).rejects.toThrow(/no name or address/);
  }));

  it('picking a profile freezes it on the invoice and pays into Wise', () => withDatabase(async (database) => {
    const { invoice } = await seeded(database);
    const saved = await db.updateInvoice(database, invoice.id, { issuer_profile: 'ge', bank_account: undefined });
    expect(saved.issuer_profile).toBe('ge');
    expect(saved.bank_account).toBe('wise');
    const snap = JSON.parse(saved.issuer_snapshot);
    expect(snap).toMatchObject({ profile: 'ge', name: 'Individual Entrepreneur Demo Person', vat_number: '123456789', brand: 'Demo Studio' });
    expect(snap.payment).toEqual({ payment_name: 'Demo Studio', iban: 'BE00 0000 0000 0001', bic: 'TESTBEB1' });

    // Editing the profile afterwards leaves the invoice as it was.
    await db.setIssuerProfile(database, 'ge', { name: 'Someone else' });
    const again = await db.getInvoice(database, invoice.id);
    expect(JSON.parse(again.issuer_snapshot).name).toBe('Individual Entrepreneur Demo Person');
  }));

  it('never another account than Wise with a profile', () => withDatabase(async (database) => {
    const { invoice } = await seeded(database);
    await expect(db.updateInvoice(database, invoice.id, { issuer_profile: 'be', bank_account: 'bog' })).rejects.toThrow(/always paid into Wise/);
    await db.updateInvoice(database, invoice.id, { issuer_profile: 'be' });
    await expect(db.updateInvoice(database, invoice.id, { bank_account: 'bog' })).rejects.toThrow(/always paid into Wise/);
    await expect(db.setInvoiceBankAccount(database, invoice.id, 'bog')).rejects.toThrow(/always paid into Wise/);
  }));

  it('the save of a draft (header and lines) carries the profile too', () => withDatabase(async (database) => {
    const { invoice } = await seeded(database);
    const saved = await db.saveInvoice(database, invoice.id, { issuer_profile: 'be' }, [{ description: 'Website', quantity: 1, unit_cents: 100000 }]);
    expect(saved.issuer_profile).toBe('be');
    expect(saved.bank_account).toBe('wise');
    const back = await db.saveInvoice(database, invoice.id, { issuer_profile: null, bank_account: 'bog' }, [{ description: 'Website', quantity: 1, unit_cents: 100000 }]);
    expect(back.issuer_profile).toBeNull();
    expect(back.issuer_snapshot).toBeNull();
    expect(back.bank_account).toBe('bog');
  }));

  it('issued and not sent: the issuer can change; once sent it cannot', () => withDatabase(async (database) => {
    const { invoice } = await seeded(database);
    await db.issueInvoice(database, invoice.id, '2026-11-14');
    const switched = await db.setInvoiceIssuerProfile(database, invoice.id, 'be');
    expect(switched.issuer_profile).toBe('be');
    await db.markSent(database, invoice.id, '2026-11-14');
    await expect(db.setInvoiceIssuerProfile(database, invoice.id, 'ge')).rejects.toThrow(/already sent/);
  }));

  it('a no-VAT issuer never carries a VAT-charging treatment', () => withDatabase(async (database) => {
    const { invoice } = await seeded(database);
    await db.setIssuerProfile(database, 'ge', { no_vat: true });
    await expect(db.updateInvoice(database, invoice.id, { issuer_profile: 'ge', vat_treatment: 'standard' })).rejects.toThrow(/VAT not applicable/);
    const ok = await db.updateInvoice(database, invoice.id, { issuer_profile: 'ge' });
    expect(JSON.parse(ok.issuer_snapshot).no_vat).toBe(true);
    await expect(db.updateInvoice(database, invoice.id, { vat_treatment: 'standard' })).rejects.toThrow(/VAT not applicable/);
    await expect(db.setIssuerProfile(database, 'ge', { no_vat: 'yes' })).rejects.toThrow(/true or false/);
    // The Belgium profile has no such line, and keeps any treatment.
    expect((await db.updateInvoice(database, invoice.id, { issuer_profile: 'be', vat_treatment: 'standard' })).issuer_profile).toBe('be');
  }));

  it('a profile date must be a date', () => withDatabase(async (database) => {
    await expect(db.setIssuerProfile(database, 'ge', { registered_on: '24/06/2025' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(db.setIssuerProfile(database, 'xx', { name: 'x' })).rejects.toThrow(/no issuer profile/);
  }));
});

describe('the paper', () => {
  const invoice = { number: '1.R.A.DC.01', subject: 'Site', total_cents: 100000, vat_treatment: 'exempt_small', lines: [], client: { name: 'Demo Client' } };
  const details = { ...ISSUER, bank_accounts: ACCOUNTS };
  const geSnap = {
    profile: 'ge', label: 'Abroad IE', name: 'Individual Entrepreneur Demo Person', address: 'Demo street N1\nDemo City',
    tax_id_label: 'ID', vat_number: '123456789', registered_on: '2025-01-02', phone: '+000 000 000',
    brand: 'Demo Studio', tagline: 'Visual studio', payment_terms_days: 30,
    payment: { payment_name: 'Demo Studio', iban: 'BE00 0000 0000 0001', bic: 'TESTBEB1' },
  };

  it('without a profile it prints Your invoice details, as before', () => {
    const page = html(paperDoc({ ...invoice, bank_account: 'bog' }, details));
    expect(page).toContain('1 Demo Street');
    expect(page).toContain('GE00 TB00');
  });

  it('with a profile it prints the frozen issuer and the Wise IBAN, whatever the details say now', () => {
    const page = html(paperDoc({ ...invoice, issuer_profile: 'ge', issuer_snapshot: JSON.stringify(geSnap), bank_account: 'wise' }, { ...details, address: 'Changed since' }));
    expect(page).toContain('Individual Entrepreneur Demo Person');
    expect(page).toContain('ID 123456789');
    expect(page).toContain('Registered 02 JAN 2025');
    expect(page).toContain('Tel. +000 000 000');
    expect(page).toContain('BE00 0000 0000 0001');
    expect(page).not.toContain('GE00');
    expect(page).not.toContain('Changed since');
    expect(page).not.toContain('VAT not applicable');
    expect(html(paperDoc({ ...invoice, issuer_snapshot: JSON.stringify({ ...geSnap, no_vat: true }) }, details))).toContain('VAT not applicable');
  });

  it('an empty tax ID prints no label at all', () => {
    const page = html(paperDoc({ ...invoice, issuer_snapshot: JSON.stringify({ ...geSnap, tax_id_label: 'VAT', vat_number: '' }) }, details));
    expect(page).not.toMatch(/>VAT\s*</);
    expect(page).not.toContain('ID 123456789');
  });

  it('a broken snapshot falls back to Your invoice details', () => {
    expect(issuerSnapshot({ issuer_snapshot: '{not json' })).toBeNull();
    expect(html(paperDoc({ ...invoice, issuer_snapshot: '{not json' }, details))).toContain('1 Demo Street');
  });

  it('the choice lists today\'s details first, then each profile, saying when one is blank', () => {
    expect(issuerChoices({ name: 'Demo Studio' }, [
      { id: 'be', label: 'Belgium', name: 'Demo Person', address: 'x' },
      { id: 'ge', label: 'Abroad IE', name: '', address: '' },
    ])).toEqual([['', 'Your invoice details (Demo Studio)'], ['be', 'Belgium · Demo Person'], ['ge', 'Abroad IE · details missing']]);
  });
});
