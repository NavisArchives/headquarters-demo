import { describe, it, expect, beforeEach } from 'vitest';
import { installDom, html } from './dom-shim.js';
import { REAL_INVOICE } from './finance-lib.test.js';

// The screens build DOM, so a DOM has to exist before they are imported.
installDom();
const {
  invoiceRow, moneyBlock, paperDoc, totalsBlock, invoiceFonts,
} = await import('../src/public/assets/screens/finance.js');

/** settings.issuer as /api/finance/issuer answers it (design addendum 4). */
const ISSUER = Object.freeze({
  name: 'Realis Studio',
  tagline: 'Visual creation studio',
  address: '1 Demo Street,\nBuilding A\nDemo District, Testville',
  tax_id_label: 'Tax ID',
  vat_number: '0000000000',
  phone: '+32 400 00 00 00',
  email: 'hello@example.com',
  payment_name: 'Huizenga Andy',
  iban: 'BE00 0000 0000 0001',
  bic: 'TRWIBEB1XXX',
  payment_terms_days: 30,
});

const FINANCE_PROJECT = Object.freeze({
  slug: 'marc-aubin',
  client: REAL_INVOICE.client,
  invoices: [REAL_INVOICE],
  totals: {
    invoiced_cents: 300000,
    paid_cents: 170000,
    owed_now_cents: 0,
    not_yet_requested_cents: 130000,
  },
});

beforeEach(() => { installDom(); });

/* ----------------------------------------------------- the printed page --- */

describe("the printed invoice 5.R.A.L.01, on the owner's template", () => {
  const paper = () => html(paperDoc(REAL_INVOICE, ISSUER));

  it('heads the sheet with the issuer settings, never a name in the code', () => {
    const markup = paper();
    expect(markup).toContain('<div class="logo">REALIS<span>.</span>STUDIO</div>');
    expect(markup).toContain('<div class="tagline">Visual creation studio</div>');
  });

  it('prints a one-word issuer name as it is stored, with no invented dot', () => {
    const markup = html(paperDoc(REAL_INVOICE, { ...ISSUER, name: 'Realis' }));
    expect(markup).toContain('<div class="logo">Realis</div>');
  });

  it('leaves the tagline out entirely when the issuer has none', () => {
    const { tagline, ...noTagline } = ISSUER;
    expect(html(paperDoc(REAL_INVOICE, noTagline))).not.toContain('class="tagline"');
  });

  it('carries the number and both dates in the mono meta column', () => {
    const markup = paper();
    expect(markup).toContain('Invoice <b>5.R.A.L.01</b>');
    expect(markup).toContain('Date <b>09 JUL 2026</b>');
    expect(markup).toContain('Due <b>08 AUG 2026</b>');
  });

  it('puts the amount requested in the hero, split whole and cents', () => {
    const markup = paper();
    expect(markup).toContain('Amount due');
    expect(markup).toContain('<span class="cur">€</span>1,700<span class="cents">.00</span>');
    expect(markup).toContain('<div class="subject">Visual creation package - Prepayment</div>');
  });

  it('asks for the whole total on an ordinary invoice', () => {
    const markup = html(paperDoc(
      { ...REAL_INVOICE, kind: 'invoice', request_cents: null, requested_cents: 300000 },
      ISSUER,
    ));
    expect(markup).toContain('<span class="cur">€</span>3,000<span class="cents">.00</span>');
    expect(markup).toContain('<span class="l">Total</span><span class="v">€3,000.00</span>');
  });

  it('names both parties from the data', () => {
    const markup = paper();
    expect(markup).toContain('<div class="label">Billed to</div>');
    expect(markup).toContain('Aubin chirurgie plastique SRL');
    expect(markup).toContain('Rue de la Démo 1');
    expect(markup).toContain('1000 Bruxelles');
    expect(markup).toContain('VAT BE 0000 000 097');
    expect(markup).toContain('<div class="label">From</div>');
    expect(markup).toContain('1 Demo Street,');
    expect(markup).toContain('Demo District, Testville');
    expect(markup).toContain('Tax ID 0000000000');
    expect(markup).toContain('<div class="name">Realis Studio</div>');
  });

  it('numbers the item rows 01, 02, 03 and prints separated amounts', () => {
    const markup = paper();
    expect(markup).toContain('<div class="num">01</div>');
    expect(markup).toContain('<div class="num">02</div>');
    expect(markup).toContain('<div class="num">03</div>');
    expect(markup).toContain('<div class="title">Website</div><div class="desc">Design, creation</div>');
    expect(markup).toContain('<div class="right">€2,000.00</div>');
    expect(markup).toContain('<div class="title">Website marketing</div><div class="desc">SEO + Google</div>');
    expect(markup).toContain('<div class="right">€600.00</div>');
    expect(markup).toContain('<div class="title">Digital marketing</div>');
    expect(markup).toContain('<div class="right">€400.00</div>');
    expect(markup).toContain('<div>Item</div>');
    expect(markup).toContain('<div class="right">Amount</div>');
  });

  it('prints the totals box exactly as the template sets it', () => {
    const markup = paper();
    for (const [label, value] of [
      ['Project total', '€3,000.00'],
      ['Prepayment website (50%)', '€1,300.00'],
      ['Digital marketing', '€400.00'],
      ['Tax (0%) - Reverse charge may apply.', '€0.00'],
    ]) {
      expect(markup, label).toContain(`<div class="line"><span>${label}</span><span>${value}</span></div>`);
    }
    expect(markup).toContain('<span class="l">Total for prepayment</span><span class="v">€1,700.00</span>');
  });

  it('ends on how to pay and by when', () => {
    const markup = paper();
    expect(markup).toContain('<div class="label">Payment details</div>');
    expect(markup).toContain('<div class="name">Huizenga Andy</div>');
    expect(markup).toContain('<div class="acct">BE00 0000 0000 0001</div>');
    expect(markup).toContain('<div class="acct">TRWIBEB1XXX</div>');
    expect(markup).toContain('<div class="label">Terms</div>');
    expect(markup).toContain('Please pay within 30 days of receiving this invoice.');
    expect(markup).toContain('Thank you for your business.');
  });

  it('escapes what it prints instead of interpolating markup', () => {
    const markup = html(paperDoc({ ...REAL_INVOICE, subject: '<script>x</script>' }, ISSUER));
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('says VOID on a void invoice, and nothing like it otherwise', () => {
    expect(paper()).not.toContain('VOID');
    expect(html(paperDoc({ ...REAL_INVOICE, status: 'void' }, ISSUER))).toContain('VOID');
  });

  /* Review finding M6: fields the data carried and the paper dropped. */

  it('prints the PO number when the invoice has one, and nothing when it does not', () => {
    expect(paper()).not.toContain('PO ');
    const markup = html(paperDoc({ ...REAL_INVOICE, po_number: 'PO-2026-114' }, ISSUER));
    expect(markup).toContain('PO ');
    expect(markup).toContain('PO-2026-114');
  });

  it('prints the client\'s company registration when it is set', () => {
    expect(paper()).not.toContain('Reg.');
    const client = { ...REAL_INVOICE.client, company_reg: '0000.000.097' };
    const markup = html(paperDoc({ ...REAL_INVOICE, client }, ISSUER));
    expect(markup).toContain('Reg. 0000.000.097');
  });

  it('carries the void mark across the sheet, the status and the reason', () => {
    const markup = html(paperDoc({
      ...REAL_INVOICE, status: 'void', notes: 'Something else\nVoided: wrong client',
    }, ISSUER));
    expect(markup).toContain('class="paper is-void"');
    expect(markup).toContain('class="void-mark"');
    expect(markup).toContain('Status <b>VOID</b>');
    expect(markup).toContain('Voided: wrong client');
  });

  it('still says a void invoice is void when no reason was recorded', () => {
    const markup = html(paperDoc({ ...REAL_INVOICE, status: 'void', notes: '' }, ISSUER));
    expect(markup).toContain('This invoice has been voided.');
  });
});

/* ----------------------------------------------- the editor's own preview --- */

describe('the totals block the editor previews', () => {
  it('still reads in the dashboard\'s own figures', () => {
    const markup = html(totalsBlock(REAL_INVOICE));
    expect(markup).toContain('<span class="t-label">Project Total</span><span class="t-value">€3000.00</span>');
    expect(markup).toContain('<span class="t-label">Total for prepayment</span><span class="t-value">€1700.00</span>');
    expect(markup).toContain('class="total-row strong"');
  });
});

/* ------------------------------------------------------------- the fonts --- */

describe('the invoice fonts', () => {
  it('are added for the print page and taken off again when it is left', () => {
    expect(invoiceFonts(false)).toBe(null);
    const link = invoiceFonts(true);
    expect(link.href).toContain('/assets/fonts/fonts.css'); // HQ's own copy (13 Nov), JetBrains Mono inside
    expect(html(document.head)).toContain('/assets/fonts/fonts.css');
    // Rendering the same route twice does not add a second stylesheet.
    expect(invoiceFonts(true)).toBe(link);
    expect(html(document.head).match(/<link/g)).toHaveLength(1);
    invoiceFonts(false);
    expect(html(document.head)).not.toContain('/assets/fonts/fonts.css');
  });
});

/* ------------------------------------------------------------ list rows --- */

describe('a row in the invoice list', () => {
  const row = (invoice) => html(invoiceRow(
    { client_name: 'Aubin chirurgie plastique SRL', ...invoice },
    { navigate: () => {}, onOpen: () => {} },
  ));

  it('reads the real invoice out in full', () => {
    const markup = row(REAL_INVOICE);
    expect(markup).toContain('5.R.A.L.01');
    expect(markup).toContain('Visual creation package - Prepayment');
    expect(markup).toContain('Aubin chirurgie plastique SRL');
    expect(markup).toContain('€3,000');
    expect(markup).toContain('€1,700');
    expect(markup).toContain('Due now');
    expect(markup).toContain('Part 1 paid – part 2 open');
    expect(markup).toContain('>Open<');
  });

  it('links the project it belongs to, and stays inside HQ', () => {
    const markup = row(REAL_INVOICE);
    expect(markup).toContain('href="/p/marc-aubin"');
    expect(markup).toContain('>Marc Aubin<');
    expect(markup).not.toContain('target=');
  });

  it('carries no project link when the invoice has no project', () => {
    const markup = row({ ...REAL_INVOICE, slug: null, project_name: null });
    expect(markup).not.toContain('<a ');
  });

  it('says what each state is, in the owner\'s words', () => {
    expect(row({ ...REAL_INVOICE, number: null, computed_status: 'draft' })).toContain('>Draft<');
    expect(row({ ...REAL_INVOICE, not_yet_requested_cents: 0 })).toContain('>Paid<');
    expect(row({ ...REAL_INVOICE, computed_status: 'sent', due_cents: 170000, paid_cents: 0 })).toContain('>Sent<');
    expect(row({ ...REAL_INVOICE, computed_status: 'issued', due_cents: 170000, paid_cents: 0 })).toContain('>Issued<');
    // Overdue carries the count: the pill is the whole story, not half of it.
    expect(row({
      ...REAL_INVOICE, computed_status: 'sent', due_cents: 170000, paid_cents: 0, overdue: true, due_on: '2026-08-08',
    })).toMatch(/Overdue · \d+ days?/);
    expect(row({ ...REAL_INVOICE, status: 'void', computed_status: 'void' })).toContain('>Void<');
  });

  it('escapes what it prints instead of interpolating markup', () => {
    const markup = row({ ...REAL_INVOICE, subject: '<script>x</script>' });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

/* ----------------------------------------------------- the money block --- */

describe('the Money block on a project page', () => {
  it('reads the Marc Aubin project as the owner describes it', () => {
    const markup = html(moneyBlock(FINANCE_PROJECT, () => {}));
    expect(markup).toContain('Money');
    expect(markup).toContain('Invoiced');
    expect(markup).toContain('€3,000');
    expect(markup).toContain('Visual creation package');
    expect(markup).toContain('€1,700 paid');
    expect(markup).toContain('part 2 €1,300 not yet invoiced');
    expect(markup).toContain('Part 1 paid – part 2 open');
  });

  it('offers the printed invoice by its own URL', () => {
    const markup = html(moneyBlock(FINANCE_PROJECT, () => {}));
    expect(markup).toContain('href="/finance/1"');
  });

  it('shows nothing at all for a project with no finance', () => {
    expect(moneyBlock({ invoices: [], totals: {} }, () => {})).toBe(null);
    expect(moneyBlock(null, () => {})).toBe(null);
  });
});

describe('the account an invoice asks to be paid into', () => {
  const ACCOUNTS = [
    { id: 'wise', label: 'Wise (Belgium)', payment_name: 'Realis Studio', iban: 'BE00 0000 0000 0001', bic: 'TRWIBEB1XXX' },
    { id: 'bog', label: 'Second Bank', payment_name: 'Realis Studio', iban: 'GE00 BG00 0000 0000 0000 00', bic: 'DEMOGE22XXX' },
  ];
  const withAccounts = { ...ISSUER, bank_accounts: ACCOUNTS };

  it('prints the invoice\'s own account, whatever the default says', () => {
    const abroad = html(paperDoc({ ...REAL_INVOICE, bank_account: 'bog' }, withAccounts));
    expect(abroad).toContain('GE00 BG00 0000 0000 0000 00');
    expect(abroad).toContain('DEMOGE22XXX');
    expect(abroad).not.toContain('BE00 0000 0000 0001');
    const wise = html(paperDoc({ ...REAL_INVOICE, bank_account: 'wise' }, withAccounts));
    expect(wise).toContain('BE00 0000 0000 0001');
    expect(wise).not.toContain('GE00');
  });

  it('an invoice from before the choice existed prints the default from Your invoice details', () => {
    const markup = html(paperDoc({ ...REAL_INVOICE, bank_account: null }, withAccounts));
    expect(markup).toContain(ISSUER.iban);
  });
});

describe('the account a new draft starts on', () => {
  it('matches the default in Your invoice details, spaces or not', async () => {
    const { defaultBank } = await import('../src/public/assets/screens/finance.js');
    const accounts = [
      { id: 'wise', iban: 'BE00 0000 0000 0001' },
      { id: 'bog', iban: 'GE00 BG00 0000 0000 0000 00' },
    ];
    expect(defaultBank(accounts, { iban: 'BE00000000000001' })).toBe('wise');
    expect(defaultBank(accounts, { iban: 'GE00BG0000000000000000' })).toBe('bog');
    expect(defaultBank(accounts, {})).toBe('wise');
  });
});
