import { describe, it, expect } from 'vitest';
import { moneyByYear, invoiceYear, paidIntoNames } from '../src/public/assets/finance-years.js';

const inv = (over) => ({
  id: 1, number: 'N', status: 'issued', series: 'studio', client_id: 1, year: 2026, issued_on: '2026-01-01',
  total_cents: 10000, requested_cents: 10000, paid_cents: 0, ...over,
});

const INVOICES = [
  inv({ id: 1, number: '1.R.S.L.25', series: 'archive', year: 2025, issued_on: '2025-03-31', client_id: 1, total_cents: 100000, requested_cents: 100000, paid_cents: 100000, paid_into: 'kbc' }),
  inv({ id: 2, number: '2.AA.DA', series: 'archive', year: 2025, issued_on: '2025-08-05', client_id: 2, total_cents: 30000, requested_cents: 30000, paid_cents: 30000, paid_into: 'wise' }),
  inv({ id: 3, number: '17-R.S.B.001', series: 'archive', year: 2023, issued_on: '2023-11-29', client_id: 1, total_cents: 525000, requested_cents: 525000, paid_cents: 0 }),
  inv({ id: 4, number: '5.R.A.L.01', series: 'agency', year: 2026, client_id: 3, total_cents: 300000, requested_cents: 170000, paid_cents: 170000, paid_into: 'Wise' }),
  inv({ id: 5, number: '1.R.A.SC.01', year: 2026, client_id: 1, total_cents: 50000, requested_cents: 50000, paid_cents: 10000 }),
  inv({ id: 6, number: null, status: 'draft', year: null, issued_on: null, client_id: 1, total_cents: 99999 }),
  inv({ id: 7, number: '2.R.A.SC.02', status: 'void', year: 2026, client_id: 1, total_cents: 77777 }),
  inv({ id: 8, number: '6_R.O.K.001', series: 'archive', year: 2025, issued_on: null, due_on: '2025-09-08', client_id: 2, total_cents: 150000, requested_cents: 150000, paid_cents: 150000, paid_into: 'wise' }),
];
const names = { 1: 'Lumen B.V.', 2: 'OONA 19 BV', 3: 'Aubin' };
const clientName = (id) => names[id];

describe('money by year and by client', () => {
  it('totals every year over all clients, drafts and void left out', () => {
    const { years, total } = moneyByYear(INVOICES, { clientName });
    expect(years.map((y) => y.year)).toEqual([2026, 2025, 2023]);
    const [y2026, y2025, y2023] = years;
    expect(y2025).toMatchObject({ count: 3, archive_count: 3, invoiced_cents: 280000, paid_cents: 280000, unpaid_cents: 0, unproven_cents: 0 });
    // A prepayment counts what it asked for now (1 700), not its project (3 000).
    expect(y2026).toMatchObject({ count: 2, invoiced_cents: 220000, paid_cents: 180000, unpaid_cents: 40000, unproven_cents: 0 });
    // An unpaid archive invoice is "not proven", never "unpaid".
    expect(y2023).toMatchObject({ invoiced_cents: 525000, unpaid_cents: 0, unproven_cents: 525000 });
    expect(total.invoiced_cents).toBe(280000 + 220000 + 525000);
  });

  it('per client inside one year, with the banks the money arrived in', () => {
    const { clients, invoices, total } = moneyByYear(INVOICES, { year: 2025, clientName });
    expect(clients).toEqual([
      expect.objectContaining({ client_id: 2, name: 'OONA 19 BV', count: 2, invoiced_cents: 180000, paid_cents: 180000, banks: ['Wise'] }),
      expect.objectContaining({ client_id: 1, name: 'Lumen B.V.', count: 1, invoiced_cents: 100000, banks: ['KBC'] }),
    ]);
    expect(invoices.map((i) => i.id)).toEqual([8, 2, 1]);
    expect(total.invoiced_cents).toBe(280000);
  });

  it('one client across all years, and one client in one year', () => {
    const all = moneyByYear(INVOICES, { clientId: 1, clientName });
    expect(all.years.map((y) => [y.year, y.invoiced_cents])).toEqual([[2026, 50000], [2025, 100000], [2023, 525000]]);
    expect(all.invoices.map((i) => i.id)).toEqual([5, 1, 3]);
    // The client list stays complete so another client can be picked.
    expect(all.clients.map((c) => c.client_id).sort()).toEqual([1, 2, 3]);
    const one = moneyByYear(INVOICES, { clientId: 1, year: 2023, clientName });
    expect(one.total).toMatchObject({ count: 1, invoiced_cents: 525000, unproven_cents: 525000 });
  });

  it('adds expenses to their year', () => {
    const { years } = moneyByYear(INVOICES, { expenses: [{ year: 2025, amount_cents: 56737 }, { spent_on: '2024-11-26', amount_cents: 72100 }] });
    expect(years.find((y) => y.year === 2025).expenses_cents).toBe(56737);
    expect(years.find((y) => y.year === 2024)).toMatchObject({ count: 0, expenses_cents: 72100 });
  });

  it('reads the year from the invoice, else its date; names the banks', () => {
    expect(invoiceYear({ year: 2024, issued_on: '2023-12-27' })).toBe(2024);
    expect(invoiceYear({ year: null, issued_on: '2023-12-27' })).toBe(2023);
    expect(paidIntoNames('kbc,wise')).toEqual(['KBC', 'Wise']);
    expect(paidIntoNames(null)).toEqual([]);
  });
});
