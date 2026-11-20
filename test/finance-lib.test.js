import { describe, it, expect } from 'vitest';
import {
  FieldError, centsFromEuros, eurosFromCents, money, lineMoney, shortMoney,
  formatDate, daysOverdue, splitLine, joinLine, statusLabel, taxLine, lineAmount,
  requestLines, totalsRows, totalsText, nextNumberHint,
  printMoney, amountParts, requestedCents, printTotalsRows, logoParts,
} from '../src/public/assets/finance-lib.js';

/** Invoice 5.R.A.L.01 as /api/finance/invoices/1 answers it today. */
export const REAL_INVOICE = Object.freeze({
  id: 1,
  number: '5.R.A.L.01',
  seq: 5,
  client_id: 1,
  slug: 'marc-aubin',
  project_name: 'Marc Aubin',
  subject: 'Visual creation package - Prepayment',
  po_number: null,
  status: 'issued',
  issued_on: '2026-07-09',
  due_on: '2026-08-08',
  sent_on: '2026-07-09',
  paid_on: '2026-07-09',
  currency: 'EUR',
  vat_treatment: 'reverse_charge',
  vat_rate: 0,
  vat_mention: 'Tax (0%) - Reverse charge may apply.',
  subtotal_cents: 300000,
  vat_cents: 0,
  total_cents: 300000,
  kind: 'prepayment',
  request_cents: 170000,
  parent_id: null,
  paid_cents: 170000,
  requested_cents: 170000,
  due_cents: 0,
  balance_cents: 130000,
  not_yet_requested_cents: 130000,
  computed_status: 'paid',
  overdue: false,
  client: {
    id: 1,
    name: 'Aubin chirurgie plastique SRL',
    initials: 'L',
    slug: 'marc-aubin',
    address: 'Rue de la Démo 1\n1000 Bruxelles',
    country: 'BE',
    vat_number: 'BE 0000 000 097',
  },
  lines: [
    { id: 4, description: 'Website — Design, creation', quantity: 1, unit_cents: 200000, amount_cents: 200000, no_charge: 0, position: 0 },
    { id: 5, description: 'Website marketing — SEO + Google', quantity: 1, unit_cents: 60000, amount_cents: 60000, no_charge: 0, position: 1 },
    { id: 6, description: 'Digital marketing — Design + Post (3x a week) + website maintenance · monthly cost', quantity: 1, unit_cents: 40000, amount_cents: 40000, no_charge: 0, position: 2 },
  ],
  payments: [
    {
      id: 1,
      invoice_id: 1,
      amount_cents: 170000,
      paid_on: '2026-07-09',
      label: 'Prepayment website (50%) €1,300 + Digital marketing €400 (date = invoice date; actual payment date not recorded)',
      method: null,
    },
  ],
});

describe('euros in, cents out — the one conversion', () => {
  it('takes the forms the owner actually types', () => {
    expect(centsFromEuros('1700')).toBe(170000);
    expect(centsFromEuros('1700.00')).toBe(170000);
    expect(centsFromEuros('1700,50')).toBe(170050);
    expect(centsFromEuros(' 1 700.05 ')).toBe(170005);
    expect(centsFromEuros('0.01')).toBe(1);
    expect(centsFromEuros(2000)).toBe(200000);
  });

  it('never rounds a float into the database', () => {
    expect(centsFromEuros('0.07')).toBe(7);
    expect(centsFromEuros('19.99')).toBe(1999);
    // a third decimal is refused rather than quietly rounded
    expect(() => centsFromEuros('1.005')).toThrow(FieldError);
  });

  it('refuses what is not an amount, by field name', () => {
    for (const bad of ['', '  ', 'abc', '17.005', '-5', '1.2.3', '€1700']) {
      let thrown = null;
      try { centsFromEuros(bad, 'unit_price'); } catch (error) { thrown = error; }
      expect(thrown, bad).toBeInstanceOf(FieldError);
      expect(thrown.field).toBe('unit_price');
    }
  });

  it('refuses an amount bigger than an invoice can hold', () => {
    expect(() => centsFromEuros('100000001')).toThrow(FieldError);
  });

  it('round-trips back into the field', () => {
    expect(eurosFromCents(170000)).toBe('1700.00');
    expect(eurosFromCents(1)).toBe('0.01');
    expect(eurosFromCents(0)).toBe('0.00');
    expect(centsFromEuros(eurosFromCents(123456))).toBe(123456);
  });
});

describe('the three money formats', () => {
  it('prints totals with two decimals and no separator', () => {
    expect(money(170000)).toBe('€1700.00');
    expect(money(300000)).toBe('€3000.00');
    expect(money(0)).toBe('€0.00');
  });

  it('prints invoice lines in whole euros when they are whole', () => {
    expect(lineMoney(200000)).toBe('€2000');
    expect(lineMoney(60000)).toBe('€600');
    expect(lineMoney(40050)).toBe('€400.50');
  });

  it('prints screen figures with a thousands separator', () => {
    expect(shortMoney(300000)).toBe('€3,000');
    expect(shortMoney(170000)).toBe('€1,700');
    expect(shortMoney(130000)).toBe('€1,300');
    expect(shortMoney(0)).toBe('€0');
    expect(shortMoney(123456)).toBe('€1,234.56');
  });
});

describe('a line amount, rounded the way the server rounds it', () => {
  it('is exact where a float is not', () => {
    // db.js's own example: 0.29 x 50 is 14.499999999999998 in IEEE-754, and
    // the exact decimal 14.5 rounds half UP to 15.
    expect(lineAmount(0.29, 50)).toBe(15);
    expect(lineAmount(2.5, 999)).toBe(2498);
    expect(lineAmount(0.5, 1)).toBe(1);
    expect(lineAmount(1.5, 1)).toBe(2);
  });

  it('multiplies the plain cases exactly', () => {
    expect(lineAmount(1, 200000)).toBe(200000);
    expect(lineAmount(3, 40000)).toBe(120000);
    expect(lineAmount(0.25, 40000)).toBe(10000);
    expect(lineAmount('2', '60000')).toBe(120000);
  });

  it('counts a half-typed or impossible line as nothing', () => {
    for (const [qty, unit] of [['', 100], ['abc', 100], [0, 100], [-1, 100], [1, -1], [1, 1.5], [1, NaN]]) {
      expect(lineAmount(qty, unit), `${qty} x ${unit}`).toBe(0);
    }
  });
});

describe('dates', () => {
  it('prints the invoice style', () => {
    expect(formatDate('2026-07-09')).toBe('09 JUL 2026');
    expect(formatDate('2026-12-31')).toBe('31 DEC 2026');
    expect(formatDate('2026-01-01T00:00:00Z')).toBe('01 JAN 2026');
  });

  it('answers nothing for what is not a date', () => {
    for (const bad of [null, undefined, '', 'soon', '2026-13-01']) expect(formatDate(bad)).toBe('');
  });

  it('counts days overdue, never negative', () => {
    expect(daysOverdue('2026-08-08', '2026-09-21')).toBe(44);
    expect(daysOverdue('2026-08-08', '2026-08-09')).toBe(1);
    expect(daysOverdue('2026-08-08', '2026-08-08')).toBe(0);
    expect(daysOverdue('2026-12-08', '2026-08-08')).toBe(0);
  });
});

describe('a line is a title and a detail', () => {
  it('splits on the printed separator', () => {
    expect(splitLine('Website — Design, creation')).toEqual({ title: 'Website', detail: 'Design, creation' });
    expect(splitLine('Balance of Visual creation package')).toEqual({ title: 'Balance of Visual creation package', detail: '' });
  });

  it('round-trips', () => {
    expect(joinLine('Website', 'Design, creation')).toBe('Website — Design, creation');
    expect(joinLine('Website', '')).toBe('Website');
    expect(splitLine(joinLine('A', 'B'))).toEqual({ title: 'A', detail: 'B' });
  });
});

describe('what the pill says', () => {
  it('reads part 1 paid on the real invoice', () => {
    expect(statusLabel(REAL_INVOICE).label).toBe('Part 1 paid – part 2 open');
  });

  it('reads Paid once nothing is left to invoice', () => {
    expect(statusLabel({ ...REAL_INVOICE, not_yet_requested_cents: 0 }).label).toBe('Paid');
  });

  it('covers the other states', () => {
    expect(statusLabel({ number: null, computed_status: 'draft' }).label).toBe('Draft');
    expect(statusLabel({ number: '6.R.A.L.02', computed_status: 'sent' }).label).toBe('Sent');
    expect(statusLabel({ number: '6.R.A.L.02', computed_status: 'issued' }).label).toBe('Issued');
    expect(statusLabel({
      number: '6.R.A.L.02', computed_status: 'sent', overdue: true, due_on: '2026-08-08',
    }, '2026-08-20').label).toBe('Overdue · 12 days');
    expect(statusLabel({
      number: '6.R.A.L.02', computed_status: 'sent', overdue: true, due_on: '2026-08-08',
    }, '2026-08-09').label).toBe('Overdue · 1 day');
    expect(statusLabel({ number: '6.R.A.L.02', status: 'void', computed_status: 'void' }).label).toBe('Void');
  });
});

describe('the tax line is the sentence the API served', () => {
  it('prints the invoice\'s own vat_mention, verbatim', () => {
    expect(taxLine(REAL_INVOICE)).toEqual({ label: 'Tax (0%) - Reverse charge may apply.', value: '' });
  });

  it('never composes a sentence of its own over the one it was given', () => {
    expect(taxLine({ ...REAL_INVOICE, vat_mention: 'Tax (0%) - Export outside the EU.' }).label)
      .toBe('Tax (0%) - Export outside the EU.');
  });

  it('prints the rate and the amount when the treatment has no sentence', () => {
    expect(taxLine({ vat_treatment: 'standard', vat_rate: 21, vat_mention: null, vat_cents: 42000 }))
      .toEqual({ label: 'Tax (21%)', value: '€420.00' });
  });

  it('falls back to the rate alone for a draft the API has not seen', () => {
    expect(taxLine({ vat_treatment: 'standard' })).toEqual({ label: 'Tax (21%)', value: '€0.00' });
    expect(taxLine({ vat_treatment: 'reverse_charge' })).toEqual({ label: 'Tax (0%)', value: '' });
  });
});

describe('the request lines of a prepayment', () => {
  it('reads the breakdown out of the payment label', () => {
    expect(requestLines(REAL_INVOICE)).toEqual([
      { label: 'Prepayment website (50%)', cents: 130000 },
      { label: 'Digital marketing', cents: 40000 },
    ]);
  });

  it('shows one line when the label carries only one', () => {
    const invoice = {
      ...REAL_INVOICE,
      payments: [{ label: 'Deposit €1,700', amount_cents: 170000 }],
    };
    expect(requestLines(invoice)).toEqual([{ label: 'Deposit', cents: 170000 }]);
  });

  it('falls back to the plain figure when the label does not add up', () => {
    for (const label of ['bank transfer', 'Website €900 + marketing €100', '']) {
      expect(requestLines({ ...REAL_INVOICE, payments: [{ label }] }))
        .toEqual([{ label: 'Prepayment requested now', cents: 170000 }]);
    }
    expect(requestLines({ ...REAL_INVOICE, payments: [] }))
      .toEqual([{ label: 'Prepayment requested now', cents: 170000 }]);
  });

  it('has none at all on an ordinary invoice', () => {
    expect(requestLines({ ...REAL_INVOICE, kind: 'invoice' })).toEqual([]);
  });
});

describe('the totals block', () => {
  it('is exactly what 5.R.A.L.01 prints', () => {
    expect(totalsText(REAL_INVOICE)).toEqual([
      'Project Total €3000.00',
      'Prepayment website (50%) €1300.00',
      'Digital marketing €400.00',
      'Tax (0%) - Reverse charge may apply.',
      'Total for prepayment €1700.00',
    ]);
    expect(totalsRows(REAL_INVOICE).at(-1).strong).toBe(true);
  });

  it('says plain "Total" on an ordinary invoice', () => {
    const plain = { ...REAL_INVOICE, kind: 'invoice', request_cents: null, requested_cents: 300000 };
    expect(totalsText(plain)).toEqual([
      'Project Total €3000.00',
      'Tax (0%) - Reverse charge may apply.',
      'Total €3000.00',
    ]);
  });

  it('previews a draft that has no payments yet', () => {
    const draft = {
      kind: 'prepayment', vat_treatment: 'reverse_charge',
      vat_rate: 0, vat_mention: 'Tax (0%) - Reverse charge may apply.',
      total_cents: 300000, request_cents: 170000, payments: [],
    };
    expect(totalsText(draft)).toEqual([
      'Project Total €3000.00',
      'Prepayment requested now €1700.00',
      'Tax (0%) - Reverse charge may apply.',
      'Total for prepayment €1700.00',
    ]);
  });
});

describe('the number a draft will be given', () => {
  const client = { id: 1, initials: 'L' };
  const IN_2026 = { year: 2026 };

  it("starts the studio series at 1 and carries the client's own counter", () => {
    // REAL_INVOICE is 5.R.A.L.01 of the CLOSED agency series, so it takes
    // nothing from the studio counter — but it is still Aubin's first.
    expect(nextNumberHint([REAL_INVOICE], client, IN_2026)).toBe('1.R.A.L.02');
  });

  it('starts a new client at 01', () => {
    expect(nextNumberHint([REAL_INVOICE], { id: 2, initials: 'SC' }, IN_2026)).toBe('1.R.A.SC.01');
  });

  it("counts only this series and this year: a studio invoice moves it on, another year's does not", () => {
    const studio = {
      ...REAL_INVOICE, id: 9, series: 'studio', seq: 1, year: 2026, client_id: 1,
    };
    expect(nextNumberHint([REAL_INVOICE, studio], { id: 2, initials: 'SC' }, IN_2026)).toBe('2.R.A.SC.01');
    expect(nextNumberHint([REAL_INVOICE, { ...studio, year: 2025 }], { id: 2, initials: 'SC' }, IN_2026)).toBe('1.R.A.SC.01');
  });

  it('has nothing to promise without initials', () => {
    expect(nextNumberHint([REAL_INVOICE], { id: 2, initials: '' })).toBe(null);
    expect(nextNumberHint([REAL_INVOICE], null)).toBe(null);
  });
});

/* ----------------------------------------- the owner's printed template --- */

describe("the template's money, dates and totals", () => {
  it('prints every figure separated and to two decimals', () => {
    expect(printMoney(200000)).toBe('€2,000.00');
    expect(printMoney(60000)).toBe('€600.00');
    expect(printMoney(40000)).toBe('€400.00');
    expect(printMoney(0)).toBe('€0.00');
    expect(printMoney(50)).toBe('€0.50');
    expect(printMoney(123456789)).toBe('€1,234,567.89');
    expect(printMoney(-130000)).toBe('-€1,300.00');
    expect(printMoney(null)).toBe('€0.00');
  });

  it('leaves the dashboard\'s own formatter alone', () => {
    expect(money(300000)).toBe('€3000.00');
    expect(lineMoney(200000)).toBe('€2000');
    expect(shortMoney(300000)).toBe('€3,000');
  });

  it('splits the hero amount into a whole number and two cents', () => {
    expect(amountParts(170000)).toEqual({ sign: '', whole: '1,700', cents: '00' });
    expect(amountParts(123456)).toEqual({ sign: '', whole: '1,234', cents: '56' });
    expect(amountParts(5)).toEqual({ sign: '', whole: '0', cents: '05' });
    expect(amountParts(-170000)).toEqual({ sign: '-', whole: '1,700', cents: '00' });
  });

  it('asks for the request on a prepayment and the total otherwise', () => {
    expect(requestedCents(REAL_INVOICE)).toBe(170000);
    expect(requestedCents({ ...REAL_INVOICE, kind: 'invoice' })).toBe(300000);
    expect(requestedCents({ kind: 'prepayment', total_cents: 300000 })).toBe(300000);
  });

  it('splits the issuer name on its first space, and only there', () => {
    expect(logoParts('Realis Studio')).toEqual({ head: 'REALIS', dot: '.', tail: 'STUDIO' });
    expect(logoParts("ANDY's ARCHIVES")).toEqual({ head: 'ANDY\'S', dot: '.', tail: 'ARCHIVES' });
    expect(logoParts('Realis')).toEqual({ head: 'Realis', dot: '', tail: '' });
    expect(logoParts(null)).toEqual({ head: '', dot: '', tail: '' });
  });

  it('lays out the totals box the template draws', () => {
    expect(printTotalsRows(REAL_INVOICE)).toEqual([
      { label: 'Project total', value: '€3,000.00' },
      { label: 'Prepayment website (50%)', value: '€1,300.00' },
      { label: 'Digital marketing', value: '€400.00' },
      { label: 'Tax (0%) - Reverse charge may apply.', value: '€0.00' },
      { label: 'Total for prepayment', value: '€1,700.00', strong: true },
    ]);
  });

  it('shows one total, and a taxed one, on an ordinary invoice', () => {
    expect(printTotalsRows({
      kind: 'invoice', total_cents: 121000, vat_rate: 21, vat_cents: 21000, vat_mention: null,
    })).toEqual([
      { label: 'Project total', value: '€1,210.00' },
      { label: 'Tax (21%)', value: '€210.00' },
      { label: 'Total', value: '€1,210.00', strong: true },
    ]);
  });
});
