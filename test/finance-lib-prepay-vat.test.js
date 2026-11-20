// A deposit invoice with VAT shows the deposit's own base and VAT (audit A3).
import { describe, it, expect } from 'vitest';
import { totalsText, printTotalsRows, prepaymentTax, netOfGross } from '../src/public/assets/finance-lib.js';

const prepay = (extra = {}) => ({
  kind: 'prepayment', total_cents: 363000, vat_cents: 63000, subtotal_cents: 300000,
  request_cents: 121000, requested_cents: 121000, vat_treatment: 'standard', payments: [], ...extra,
});

describe('a deposit invoice with VAT', () => {
  it('splits what is asked for now into base, VAT and total', () => {
    expect(prepaymentTax(prepay())).toEqual({ rate: 21, base: 100000, vat: 21000 });
    const rows = printTotalsRows(prepay()).map((r) => `${r.label}|${r.value}`);
    expect(rows.some((r) => r.startsWith('Prepayment excl. VAT|') && r.includes('1,000.00'))).toBe(true);
    expect(rows.some((r) => r.startsWith('VAT (21%) on the prepayment|') && r.includes('210.00'))).toBe(true);
    expect(rows.at(-1)).toMatch(/^Total for prepayment\|.*1,210\.00/);
    // The whole project's VAT (€630) is no longer printed next to a deposit total.
    expect(rows.some((r) => /^Tax \(/.test(r) || /\|€?\s*630\.00$/.test(r))).toBe(false);
    expect(totalsText(prepay()).join(' ')).toContain('VAT (21%) on the prepayment');
  });

  it('prints a 0% deposit exactly as before', () => {
    const zero = prepay({ vat_treatment: 'reverse_charge', vat_cents: 0, total_cents: 300000, vat_mention: 'Tax (0%) - Reverse charge may apply.' });
    expect(prepaymentTax(zero)).toBeNull();
    expect(printTotalsRows(zero).map((r) => r.label)).toEqual(['Project total', 'Prepayment requested now', 'Tax (0%) - Reverse charge may apply.', 'Total for prepayment']);
  });

  it('agrees with the worker on the net of a gross amount', () => {
    expect(netOfGross(242000, 21)).toBe(200000);
    expect(netOfGross(130000, 0)).toBe(130000);
  });
});
