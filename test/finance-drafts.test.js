// Drafts are findable and openable (Andy, 3 Nov: « I cannot find the draft made
// for Alexis in the invoices », « why am I unable to open the draft? »).
import { describe, it, expect } from 'vitest';
import { installDom, html } from './dom-shim.js';

installDom();
globalThis.window ??= { dispatchEvent() {}, open() {} };

const { invoicesByYear, pdfName, fitFactor } = await import('../src/public/assets/screens/finance.js');

const paid = { id: 1, client_id: 1, number: '2026.1', status: 'paid', issued_on: '2026-03-02', due_on: '2026-04-01',
  total_cents: 100000, requested_cents: 100000, paid_cents: 100000, computed_status: 'paid' };
const draft = { id: 9, client_id: 2, number: null, status: 'draft', issued_on: null, subject: 'Refonte du site',
  total_cents: 67500, paid_cents: 0, computed_status: 'draft' };
const state = {
  clients: [{ id: 1, name: 'Atelier Verdier' }, { id: 2, name: 'Nord Architects SRL (Be Organic Architects)' }],
  invoices: [paid, draft], expenses: [],
};

describe('drafts in Finance', () => {
  it('show on top in a picked year, with their client in the list, and count in no total', () => {
    const out = html(invoicesByYear(state, { year: 2026, clientId: null }));
    expect(out).toContain('Drafts');
    expect(out).toContain('Refonte du site');
    expect(out).toContain('Nord Architects');
    expect(out.indexOf('Refonte du site')).toBeLessThan(out.indexOf('2026.1'));
    expect(out).toContain('€1,000'); // the year's invoiced figure is the paid invoice alone
  });

  it('show for their own client only', () => {
    expect(html(invoicesByYear(state, { year: 2026, clientId: 2 }))).toContain('Refonte du site');
    expect(html(invoicesByYear(state, { year: 2026, clientId: 1 }))).not.toContain('Refonte du site');
  });

  it('have an Open button like every other row', () => {
    const out = html(invoicesByYear(state, { year: 2026, clientId: 2 }, { onOpen: () => {} }));
    expect(out).toMatch(/Refonte du site[\s\S]*Open/);
  });
});

describe('pdfName', () => {
  it('is « Facture <client short name> », with (BROUILLON) on a draft', () => {
    expect(pdfName({ ...draft, client: { name: 'Nord Architects SRL (Be Organic Architects)' } })).toBe('Facture Nord Architects (BROUILLON)');
    expect(pdfName({ ...draft, number: '6.R.A.R.01', client: { name: 'Nord Architects SRL (Be Organic Architects)' } })).toBe('Facture Nord Architects');
    expect(pdfName({ kind: 'prepayment', number: '8.R.A.PL.01', client: { name: 'Dr Morel' } })).toBe('Facture acompte Dr Morel');
  });
});

describe('one page when it almost fits', () => {
  it('zooms a paper a little taller than A4, leaves a short or a much longer one alone', () => {
    expect(fitFactor(1000)).toBe(1);
    expect(fitFactor(1170)).toBeLessThan(1);
    expect(fitFactor(1170) * 1170).toBeLessThanOrEqual(1122);
    expect(fitFactor(2000)).toBe(1);
  });
});
