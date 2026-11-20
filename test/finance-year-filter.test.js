// The Finance « Invoices » block, filtered by one year dropdown (Andy, 27 Oct):
// no row of year cards; the chosen year drives the client list, the invoice
// list and the one-line totals, which show Expenses only when there are any.
import { describe, it, expect } from 'vitest';
import { installDom, html } from './dom-shim.js';

installDom();
globalThis.window ??= { dispatchEvent() {}, open() {} };

const { invoicesByYear, yearChoices } = await import('../src/public/assets/screens/finance.js');

const inv = (id, client_id, year, total, paid = total) => ({
  id, client_id, number: `${year}.${id}`, status: 'paid', issued_on: `${year}-03-0${id % 9 + 1}`,
  due_on: `${year}-04-01`, total_cents: total, requested_cents: total, paid_cents: paid, computed_status: 'paid',
});

const state = {
  clients: [{ id: 1, name: 'Atelier Verdier' }, { id: 2, name: 'Lumen Skincare' }],
  invoices: [inv(1, 1, 2026, 100000), inv(2, 2, 2025, 50000), inv(3, 2, 2024, 20000)],
  expenses: [{ year: 2026, spent_on: '2026-02-01', amount_cents: 3000, vendor: 'Adobe' }],
};

describe('Finance invoices: one year at a time', () => {
  it('draws no year cards', () => {
    const out = html(invoicesByYear(state, { year: 2026, clientId: null }));
    expect(out).not.toContain('year-card');
  });

  it('lists only the chosen year\'s clients and invoices', () => {
    const out = html(invoicesByYear(state, { year: 2025, clientId: null }));
    expect(out).toContain('Lumen Skincare');
    expect(out).not.toContain('Atelier Verdier');
    expect(out).toContain('2025.2');
    expect(out).not.toContain('2026.1');
  });

  it('adds Expenses to the totals line only for a year that has them', () => {
    expect(html(invoicesByYear(state, { year: 2026, clientId: null }))).toContain('Expenses');
    expect(html(invoicesByYear(state, { year: 2025, clientId: null }))).not.toContain('Expenses');
    // A client has no expenses of its own.
    expect(html(invoicesByYear(state, { year: 2026, clientId: 1 }))).not.toContain('Expenses');
  });

  it('All years still shows every invoice', () => {
    const out = html(invoicesByYear(state, { year: null, clientId: null }));
    for (const n of ['2026.1', '2025.2', '2024.3']) expect(out).toContain(n);
  });

  it('offers every year with data, newest first, and always this year', () => {
    const years = yearChoices(state);
    expect(years.slice(0, 3)).toEqual([...new Set([new Date().getFullYear(), 2026, 2025, 2024])].sort((a, b) => b - a).slice(0, 3));
    expect(years).toContain(new Date().getFullYear());
    expect([...years].sort((a, b) => b - a)).toEqual(years);
  });
});

describe('void invoices (audit B8)', () => {
  const withVoid = {
    ...state,
    invoices: [...state.invoices, { ...inv(4, 1, 2026, 70000, 0), number: '2026.VOID', status: 'void', computed_status: 'void' }],
  };
  it('count in no total but stay findable behind one button', () => {
    const hidden = html(invoicesByYear({ ...withVoid, showVoid: false }, { year: 2026, clientId: null }));
    expect(hidden).toContain('Show void (1)');
    expect(hidden).not.toContain('2026.VOID');
    const shown = html(invoicesByYear({ ...withVoid, showVoid: true }, { year: 2026, clientId: null }));
    expect(shown).toContain('Hide void (1)');
    expect(shown).toContain('2026.VOID');
    expect(html(invoicesByYear(withVoid, { year: 2025, clientId: null }))).not.toContain('void (');
  });
});
