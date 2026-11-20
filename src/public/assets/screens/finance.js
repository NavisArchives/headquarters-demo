// Money in — the invoice list, the clients panel, the invoice editor, and
// the printed invoice at /finance/<id>.
//
// Three rules hold this screen together:
//   · euros are typed, cents are stored, and finance-lib.js is the only
//     place the two meet;
//   · every figure on the paper comes from finance-lib's totals block, so
//     the editor's live preview and the printed page cannot drift apart;
//   · an API 400 names a field, and that field shows the message — a toast
//     alone would tell the owner something failed without saying where.

import { el, hero, emptyState, tag, fillViewport } from '../dom.js';
import { dayOf } from '../dates.js';
import { apiFetch } from '../api.js';
import { ordersSection } from './orders.js';
import {
  input, select, button, modal, send, notice,
} from '../forms.js';
import {
  FieldError, centsFromEuros, eurosFromCents, shortMoney, printMoney,
  amountParts, requestedCents, printTotalsRows, logoParts,
  formatDate, splitLine, joinLine, statusLabel, totalsRows, lineAmount,
  nextNumberHint, reminderText, daysLate,
} from '../finance-lib.js';
import { copyText, toast } from '../leads-ui.js';
import { moneyByYear, paidIntoNames, invoiceYear } from '../finance-years.js';

const base = '/api/finance';

const TREATMENTS = [
  ['reverse_charge', 'Reverse charge · 0%'],
  ['standard', 'Standard · 21%'],
  ['exempt_small', 'Small business exemption · 0%'],
  ['export', 'Export · 0%'],
];

const KINDS = [
  ['invoice', 'Invoice — asks for the whole total'],
  ['prepayment', 'Prepayment — asks for part of the project now'],
];

/* ------------------------------------------------------------- plumbing --- */

/** An in-app anchor, the same behaviour as the project screen's: a real href
 *  so it can be opened in a new tab, but a plain click stays in the SPA. */
function inLink(href, text, navigate, className = 'money-link') {
  const a = el('a', className, text);
  a.href = href;
  if (navigate) {
    a.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      navigate(href);
    });
  }
  return a;
}

const LINE_FIELD = /^lines\[(\d+)\]\.(\w+)$/;
const LINE_CONTROL = { description: 'title', qty: 'qty', unit_cents: 'price', quantity: 'qty' };

/**
 * Puts an error where the owner can act on it. A 400 that names a field (the
 * API's shape, and FieldError's) writes the message under that field and
 * focuses it; anything else — a 500, a dropped connection — is said once at
 * the foot of the dialog. Never only a toast.
 */
function showError(parent, fields, lineRows, error, extras = {}) {
  for (const node of parent.querySelectorAll('.err-line')) node.remove();

  const key = error?.field ?? null;
  let target = key ? fields[key] : null;
  const lineMatch = key ? LINE_FIELD.exec(key) : null;
  if (lineMatch) {
    const row = (lineRows?.() ?? [])[Number(lineMatch[1])];
    target = row?.[LINE_CONTROL[lineMatch[2]] ?? lineMatch[2]] ?? null;
  }

  if (target) {
    const line = el('p', 'err-line', error.message);
    // A field whose fix is somewhere else says where: the client's initials
    // are edited in Clients, not on this invoice, so the message carries the
    // way there rather than leaving the owner to find it.
    const way = extras[key]?.();
    if (way) line.append(document.createTextNode(' '), way);
    target.wrap.append(line);
    target.control.focus?.();
    notice(parent, 'One field needs a change — it is marked below.', true);
    return;
  }
  notice(parent, error?.message || 'Something went wrong. Try again.', true);
}

/** A button whose failures land next to the field the API named. */
function action(label, run, {
  cls = 'btn', parent, fields = {}, lines = null, extras = {},
} = {}) {
  const node = el('button', cls, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await run();
    } catch (error) {
      showError(parent ?? node.closest('dialog') ?? node.parentElement, fields, lines, error, extras);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

/** A labelled figure: "TOTAL €3,000". The label is 12px, never smaller. */
function figure(label, value) {
  const wrap = el('span', 'ir-fig');
  wrap.append(el('i', null, label), document.createTextNode(value));
  return wrap;
}

/* ------------------------------------------------------------ the list --- */

/**
 * One invoice in the list: number · subject · client · project · the three
 * money figures · what it is · Open. Exported so the render test can read a
 * row without a browser.
 */
export function invoiceRow(invoice, { navigate, onOpen } = {}) {
  const row = el('div', 'invoice-row');

  const id = el('div', 'ir-id');
  // The title stops at two lines; the whole of it is in the tooltip (NIRMATA F1, 28 Oct).
  const subject = el('span', 'ir-subject', invoice.subject || 'Untitled');
  subject.title = invoice.subject || '';
  id.append(el('b', null, invoice.number || 'Draft'), subject);

  const who = el('div', 'ir-who');
  if (invoice.client_name) who.append(el('span', null, invoice.client_name));
  // The name as printed (billed_to) is in the open invoice, not the row.
  const when = invoice.issued_on ? formatDate(invoice.issued_on) : invoiceYear(invoice);
  if (when && invoice.number) who.append(el('i', 'sep', '·'), el('span', null, String(when)));
  if (invoice.slug) {
    if (who.childElementCount) who.append(el('i', 'sep', '·'));
    who.append(inLink(`/p/${invoice.slug}`, invoice.project_name || invoice.slug, navigate));
  }

  const figures = el('div', 'ir-figs');
  figures.append(
    figure('Total', shortMoney(invoice.total_cents)),
    figure('Paid', shortMoney(invoice.paid_cents)),
    invoice.archive
      ? figure('Not proven', shortMoney(invoice.computed_status === 'unproven' ? invoice.due_cents : 0))
      : figure('Due now', shortMoney(invoice.due_cents)),
    figure('Paid into', paidIntoNames(invoice.paid_into).join(' + ') || '—'),
  );

  const end = el('div', 'ir-end');
  const status = statusLabel(invoice);
  if (invoice.number) end.append(tag(invoice.archive ? ['t-none', 'Archive'] : ['t-idle', 'Live']));
  end.append(tag([status.cls, status.label]));
  if (onOpen) end.append(button('Open', () => onOpen(invoice), 'btn small'));

  row.append(id, who, figures, end);
  return row;
}

/* ------------------------------------------------- the project's money --- */

/**
 * The Money block the project page shows under "Where to reach it". Returns
 * null for a project with no finance at all — an empty card would be noise.
 */
export function moneyBlock(finance, navigate, onOpen) {
  const invoices = finance?.invoices ?? [];
  if (!invoices.length) return null;
  const totals = finance.totals ?? {};

  const card = el('section', 'card money-card');
  card.append(el('p', 'eyebrow', 'Money'));

  const line = el('p', 'money-totals');
  const parts = [
    ['Invoiced', totals.invoiced_cents],
    ['Paid', totals.paid_cents],
    ['Due now', totals.owed_now_cents],
    ['Not yet invoiced', totals.not_yet_requested_cents],
  ];
  parts.forEach(([label, cents], index) => {
    if (index) line.append(el('i', 'sep', '·'));
    line.append(figure(label, shortMoney(cents)));
  });
  card.append(line);

  const rows = el('div', 'money-rows');
  for (const invoice of invoices) {
    const row = el('div', 'money-row');
    const head = el('div', 'mr-id');
    head.append(el('b', null, invoice.number || 'Draft'), el('span', null, invoice.subject || 'Untitled'));

    const figs = el('div', 'mr-figs');
    figs.append(el('span', null, shortMoney(invoice.total_cents)));
    figs.append(el('i', 'sep', '·'), el('span', null, `${shortMoney(invoice.paid_cents)} paid`));
    const open = Number(invoice.not_yet_requested_cents ?? 0);
    if (open > 0) figs.append(el('i', 'sep', '·'), el('span', 'mr-open', `part 2 ${shortMoney(open)} not yet invoiced`));

    const end = el('div', 'mr-end');
    const status = statusLabel(invoice);
    end.append(tag([status.cls, status.label]));
    // Every row opens, a draft too: its paper says DRAFT and carries « Issue invoice ».
    end.append(onOpen
      ? button('Open', () => onOpen(invoice), 'btn small')
      : inLink(`/finance/${invoice.id}`, 'Open', navigate, 'btn small money-open'));

    row.append(head, figs, end);
    rows.append(row);
  }
  card.append(rows);
  return card;
}

/* ------------------------------------------------------ the paper page --- */

/** The address the owner stores as one multi-line string, as the template's
 *  muted lines. */
function addressLines(text, className) {
  const wrap = el('div', className);
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim()) wrap.append(el('p', 'muted', line.trim()));
  }
  if (className) wrap.className = className;
  return wrap;
}

/** `Invoice 5.R.A.L.01` in the hero's mono meta column: a muted word and a
 *  white value. */
function metaLine(label, value) {
  const line = el('div');
  line.append(document.createTextNode(`${label} `), el('b', null, value));
  return line;
}

/** One party column: the eyebrow, the name, then whatever lines it has. */
function party(className, label, name, lines) {
  const wrap = el('div', className);
  wrap.append(el('div', 'label', label), el('div', 'name', name || ''));
  for (const line of lines) if (line) wrap.append(el('div', 'muted', line));
  return wrap;
}

/**
 * The printed invoice, as the owner's template draws it
 * (`docs/invoice-template.html`): a dark navy hero carrying the amount due,
 * the two parties, numbered item rows, the grey totals box, and the navy
 * payment block beside the terms — one A4 sheet, nothing on it that the API
 * did not supply.
 *
 * Exported so the render test can assert on the whole sheet without a browser.
 */
/** The account an invoice prints: its own choice, else the issuer's default. */
export function bankFor(invoice, issuer = {}) {
  const chosen = (issuer.bank_accounts ?? []).find((account) => account.id === invoice?.bank_account);
  return chosen ?? { payment_name: issuer.payment_name, iban: issuer.iban, bic: issuer.bic };
}

/** [id, label] pairs for the account select. */
export { defaultBank };
const bankChoices = (accounts) => accounts.filter((a) => !a.closed).map((a) => [a.id, `${a.label} · ${a.iban}`]);

/** [id, label] pairs for « Issued as »: Your invoice details as today, then each profile.
 *  A profile with no name or address yet says so; the server refuses it until it is filled. */
export function issuerChoices(issuer, profiles = []) {
  return [
    ['', `Your invoice details${issuer?.name ? ` (${issuer.name})` : ''}`],
    ...profiles.map((p) => [p.id, p.name && p.address ? `${p.label} · ${p.name}` : `${p.label} · details missing`]),
  ];
}

/** The account a new draft starts on: the one that matches the default in
 *  Your invoice details, else the first. */
function defaultBank(accounts, issuer) {
  // IBANs are compared without spaces: settings has held both the spaced and the unspaced form.
  const bare = (iban) => String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  return (accounts.find((a) => bare(a.iban) === bare(issuer?.iban)) ?? accounts[0])?.id ?? '';
}

/** The issuer an invoice was made out from, frozen on it (0034), or null when it has none
 *  and prints Your invoice details as before. */
export function issuerSnapshot(invoice) {
  let snap = invoice?.issuer_snapshot;
  if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch { snap = null; } }
  return snap && typeof snap === 'object' && snap.name ? snap : null;
}

/** « No VAT » (Andy, 14 Nov, Abroad IE), in each language an invoice may be written in.
 *  The paper is English today; FR and NL are ready for when an invoice carries a language. */
export const NO_VAT_NOTE = Object.freeze({ EN: 'VAT not applicable', FR: 'TVA non applicable', NL: 'Btw niet van toepassing' });

/** The « From » lines of a profile: address, tax ID, registration date, phone, and the
 *  no-VAT line. An empty field prints nothing, label included. */
function profileLines(snap, lang = 'EN') {
  return [
    ...String(snap.address ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
    snap.vat_number ? `${snap.tax_id_label || 'Tax ID'} ${snap.vat_number}` : '',
    snap.registered_on ? `Registered ${formatDate(snap.registered_on)}` : '',
    snap.phone ? `Tel. ${snap.phone}` : '',
    snap.no_vat ? NO_VAT_NOTE[lang] ?? NO_VAT_NOTE.EN : '',
  ];
}

export function paperDoc(invoice, details = {}) {
  // An invoice made out from a profile prints what it froze; any other prints Your invoice details.
  const snap = issuerSnapshot(invoice);
  const issuer = snap
    ? { ...snap, name: snap.brand || snap.name, bank_accounts: [] }
    : details;
  const paper = el('article', 'paper');

  /* ---- hero ---- */
  const heroBlock = el('div', 'hero');
  heroBlock.append(el('div', 'blob'), el('div', 'ring'));

  const brandRow = el('div', 'row');
  const brand = el('div');
  const logo = el('div', 'logo');
  const mark = logoParts(issuer.name);
  logo.append(document.createTextNode(mark.head));
  if (mark.dot) logo.append(el('span', null, mark.dot), document.createTextNode(mark.tail));
  brand.append(logo);
  if (issuer.tagline) brand.append(el('div', 'tagline', issuer.tagline));
  const meta = el('div', 'meta');
  meta.append(
    metaLine('Invoice', invoice.number || 'Draft'),
    metaLine('Date', formatDate(invoice.issued_on) || formatDate(invoice.created_at) || '—'),
    metaLine('Due', formatDate(invoice.due_on) || '—'),
  );
  // Legal fields the data carries and the paper used to drop (review finding
  // M6). A PO number is what the client's accounts payable matches the
  // invoice against; without it a purchase-order client cannot pay it.
  if (invoice.po_number) meta.append(metaLine('PO', invoice.po_number));
  if (invoice.status === 'void') meta.append(metaLine('Status', 'VOID'));
  brandRow.append(brand, meta);

  const dueRow = el('div', 'row hero-amount');
  const amount = amountParts(requestedCents(invoice));
  const amountValue = el('div', 'amount');
  amountValue.append(
    el('span', 'cur', '€'),
    document.createTextNode(`${amount.sign}${amount.whole}`),
    el('span', 'cents', `.${amount.cents}`),
  );
  const due = el('div');
  due.append(el('div', 'label', 'Amount due'), amountValue);
  const subject = el('div');
  subject.append(el('div', 'label label-right', 'Subject'), el('div', 'subject', invoice.subject || ''));
  dueRow.append(due, subject);

  heroBlock.append(brandRow, dueRow);

  /* ---- who ---- */
  const client = invoice.client ?? {};
  const parties = el('div', 'parties');
  parties.append(
    party('party client', 'Billed to', client.name, [
      ...String(client.address ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      client.vat_number ? `VAT ${client.vat_number}` : '',
      // The client's company registration (KvK or equivalent) is stored and
      // was never printed — M6. It identifies the legal entity being billed.
      client.company_reg ? `Reg. ${client.company_reg}` : '',
    ]),
    snap ? party('party', 'From', snap.name, profileLines(snap)) : party('party', 'From', issuer.name, [
      ...String(issuer.address ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      issuer.vat_number ? `${issuer.tax_id_label || 'Tax ID'} ${issuer.vat_number}` : '',
    ]),
  );

  /* ---- what ---- */
  const items = el('div', 'items');
  const head = el('div', 'head');
  head.append(el('div', null, '#'), el('div', null, 'Item'), el('div', 'right', 'Amount'));
  items.append(head);

  let n = 0;
  for (const line of invoice.lines ?? []) {
    n += 1;
    const { title, detail } = splitLine(line.description);
    const row = el('div', 'row');
    const text = el('div');
    text.append(el('div', 'title', title));
    if (detail) text.append(el('div', 'desc', detail));
    row.append(
      el('div', 'num', String(n).padStart(2, '0')),
      text,
      el('div', 'right', line.no_charge ? 'NO CHARGE' : printMoney(line.amount_cents)),
    );
    items.append(row);
  }

  /* ---- how much ---- */
  const totalsWrap = el('div', 'totals-wrap');
  const totals = el('div', 'totals');
  for (const row of printTotalsRows(invoice)) {
    if (row.strong) {
      const grand = el('div', 'grand');
      grand.append(el('span', 'l', row.label), el('span', 'v', row.value));
      totals.append(grand);
      continue;
    }
    const line = el('div', 'line');
    line.append(el('span', null, row.label), el('span', null, row.value));
    totals.append(line);
  }
  // What has been paid on it, and what is still due (audit B7): a reminder
  // sent with the print then says the same thing as the client's own books.
  if (invoice.number && invoice.status !== 'void' && invoice.payments?.length) {
    for (const p of invoice.payments) {
      const line = el('div', 'line paid-line');
      line.append(el('span', null, `Paid ${formatDate(p.paid_on)}`), el('span', null, `−${printMoney(p.amount_cents)}`));
      totals.append(line);
    }
    const due = el('div', 'grand balance-due');
    due.append(el('span', 'l', Number(invoice.due_cents) > 0 ? 'Balance due' : 'Paid in full'), el('span', 'v', printMoney(Math.max(0, Number(invoice.due_cents ?? 0)))));
    totals.append(due);
  }
  totalsWrap.append(totals);

  /* ---- how to pay ---- */
  const foot = el('div', 'foot');
  const pay = el('div', 'pay');
  pay.append(el('div', 'label', 'Payment details'));
  // The account this invoice asks to be paid into; an invoice from before the
  // choice existed (bank_account null) prints the default from Your invoice details.
  const bank = snap ? (snap.payment ?? {}) : bankFor(invoice, issuer);
  if (bank.payment_name) pay.append(el('div', 'name', bank.payment_name));
  for (const value of [bank.iban, bank.bic]) {
    if (value) pay.append(el('div', 'acct', value));
  }
  const terms = el('div', 'terms');
  terms.append(el('div', 'label', 'Terms'));
  terms.append(el('div', 'muted', `Please pay within ${issuer.payment_terms_days ?? 30} days of receiving this invoice.`));
  terms.append(el('div', 'muted thanks', 'Thank you for your business.'));
  foot.append(pay, terms);

  paper.append(heroBlock, parties, items, totalsWrap, foot);
  // A voided invoice must be unmistakable on paper, on every sheet it runs
  // to: the mark is fixed in the print box, so it repeats per page rather
  // than sitting once at the end of the flow (M6).
  if (invoice.status === 'void') {
    paper.className = 'paper is-void';
    const mark = el('div', 'void-mark');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(el('span', null, 'VOID'));
    paper.append(mark);
    // The reason lives in `notes`, as `voidInvoice` writes it: "Voided: ...".
    const reason = String(invoice.notes ?? '').split('\n').find((line) => line.startsWith('Voided:'));
    paper.append(el('p', 'paper-void', reason || 'This invoice has been voided.'));
  }
  return paper;
}

/** The totals block — the same rows on the paper and in the editor preview. */
export function totalsBlock(invoice, className = 'totals') {
  const wrap = el('div', className);
  for (const row of totalsRows(invoice)) {
    const line = el('div', `total-row${row.strong ? ' strong' : ''}${row.value ? '' : ' wide'}`);
    line.append(el('span', 't-label', row.label));
    if (row.value) line.append(el('span', 't-value', row.value));
    wrap.append(line);
  }
  return wrap;
}

/** The two families the owner's template is set in. Only the printed invoice
 *  needs them, so only the printed invoice pays for them: the dashboard shell
 *  loads its own fonts and never this stylesheet. */
const PRINT_FONTS_ID = 'invoice-fonts';
// Served by HQ itself (13 Nov), like the app's own fonts.
const PRINT_FONTS_HREF = '/assets/fonts/fonts.css';

/**
 * Adds the invoice's font stylesheet to <head> on the way in and takes it off
 * again on the way out. Called from app.js for every route, so leaving
 * `/finance/<id>` for any other screen removes it.
 */
export function invoiceFonts(on) {
  const head = document.head;
  if (!head) return null;
  const existing = document.getElementById?.(PRINT_FONTS_ID) ?? null;
  if (!on) {
    existing?.remove?.();
    return null;
  }
  if (existing) return existing;
  const link = el('link');
  link.id = PRINT_FONTS_ID;
  link.rel = 'stylesheet';
  link.href = PRINT_FONTS_HREF;
  head.append(link);
  return link;
}

/** `/finance/<id>` — the printed invoice, alone on the page. */
export async function renderInvoicePage(ctx, id) {
  const navigate = ctx?.navigate ?? (() => {});
  const fragment = document.createDocumentFragment();

  const back = el('button', 'back-link no-print', '← Money in');
  back.type = 'button';
  back.addEventListener('click', () => navigate('/finance'));
  fragment.append(back);

  // Two fetches, two different failures (review finding M6). The invoice not
  // being there is "it may have been deleted"; the issuer block not loading
  // is not — the invoice exists and saying it may have been deleted is simply
  // false. They are settled separately so each says its own truth.
  const [invoiceResult, issuerResult] = await Promise.allSettled([
    apiFetch(`${base}/invoices/${id}`),
    apiFetch(`${base}/issuer`),
  ]);

  if (invoiceResult.status !== 'fulfilled' || !invoiceResult.value?.invoice) {
    const card = el('section', 'card');
    card.append(emptyState(
      'This invoice could not be opened',
      invoiceResult.reason?.message || 'It may have been deleted.',
    ));
    fragment.append(card);
    return fragment;
  }

  const invoice = invoiceResult.value.invoice;
  const issuer = issuerResult.status === 'fulfilled'
    ? { ...(issuerResult.value.issuer ?? {}), bank_accounts: issuerResult.value.bank_accounts ?? [] }
    : {};
  if (issuerResult.status === 'fulfilled' && !issuer.name) {
    // A blank issuer (a new database): nothing of anyone else's is printed instead.
    const warn = el('section', 'card no-print');
    warn.append(emptyState('Your invoice details are incomplete', 'Fill in Invoice details on the Money screen before printing or sending this.'));
    fragment.append(warn);
  }
  if (issuerResult.status !== 'fulfilled') {
    // The paper renders — but without the issuer block it is missing the name,
    // the address, the tax ID and the IBAN, so it must not be printed as is.
    const warn = el('section', 'card no-print');
    warn.append(emptyState(
      'Your own invoice details could not be loaded',
      'The invoice below is missing your name, address, tax ID and payment details. Reload before printing or sending it.',
    ));
    fragment.append(warn);
  }

  const bar = el('div', 'print-bar no-print');
  const print = el('button', 'btn primary', 'Print / Save PDF');
  print.type = 'button';
  // The browser names a saved PDF after the page title, so while printing the
  // title is the invoice number (5.R.A.L.01.pdf), then it goes back.
  const fileName = pdfName(invoice);
  print.addEventListener('click', () => {
    const previous = document.title;
    document.title = fileName;
    fitOnePage(print.closest('.print-bar')?.parentNode?.querySelector('.paper') ?? document.querySelector('.paper'));
    const restore = () => { document.title = previous; window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    window.print();
    setTimeout(restore, 60_000);
  });
  bar.append(print);
  // A draft opens here too (3 Nov, #159): its paper says DRAFT, and it is issued from here.
  if (!invoice.number && invoice.status !== 'void') {
    bar.append(button('Issue invoice', () => {
      const dialog = modal('Issue this invoice?');
      dialog.append(el('p', null, `${invoice.subject || 'This invoice'} · ${shortMoney(invoice.total_cents)}. It gets its number and today's date; after that it can only be voided, not edited.`));
      dialog.append(action('Issue invoice', async () => {
        await send(`${base}/invoices/${invoice.id}/issue`, 'POST', {});
        dialog.close();
        window.location.reload();
      }, { cls: 'btn primary', parent: dialog }));
    }, 'btn'));
  }
  bar.append(el('p', null, 'Prints as A4 — one page, or as many as the lines need. The dashboard around it is not printed.'));
  invoiceFonts(true);

  fragment.append(bar, paperDoc(invoice, issuer));
  return fragment;
}

/** An A4 page is 1123px tall at 96 dpi. A paper up to a fifth taller is
 *  zoomed to fit one page (the print CSS reads --fit); a longer one keeps its
 *  size and runs onto a second page, as before. */
export function fitFactor(paperHeight, page = 1122) {
  if (!(paperHeight > page)) return 1;
  const f = Math.floor((page / paperHeight) * 0.99 * 100) / 100;
  return f >= 0.8 ? f : 1;
}

function fitOnePage(paper) {
  if (!paper) return;
  paper.style.removeProperty('--fit');
  const f = fitFactor(paper.scrollHeight);
  if (f < 1) paper.style.setProperty('--fit', String(f));
}

/** « Facture Nord Architects.pdf », « Facture acompte Dr Morel (BROUILLON).pdf »: the
 *  client's short name, never a code or a date (Andy's rule for client PDFs). */
export function pdfName(invoice) {
  const short = String(invoice?.client?.name ?? invoice?.client_name ?? '')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\b(SRL|SPRL|SA|NV|BV|BVBA|SAS|SARL|GmbH|Ltd|LLC)\b\.?/gi, '')
    .replace(/\s+/g, ' ').trim() || 'client';
  const type = invoice?.kind === 'prepayment' ? 'Facture acompte' : 'Facture';
  return `${type} ${short}${invoice?.number ? '' : ' (BROUILLON)'}`;
}

/* ------------------------------------------------------------- clients --- */

const CLIENT_FIELDS = [
  ['name', 'Name', 'text'],
  ['initials', 'Initials for the invoice number', 'text'],
  ['email', 'Email', 'text'],
  ['address', 'Address', 'textarea'],
  ['country', 'Country code', 'text'],
  ['vat_number', 'VAT number', 'text'],
];

function clientEditor(client, state, onSaved) {
  const dialog = modal(client ? 'Edit client' : 'New client');
  const fields = {};

  for (const [key, label, type] of CLIENT_FIELDS) {
    fields[key] = input(label, client?.[key] ?? (key === 'country' ? 'BE' : ''), type);
    dialog.append(fields[key].wrap);
    if (key === 'initials') {
      dialog.append(el('p', 'hint', 'The initials are stitched into the invoice number — A.L makes 5.R.A.L.01 — so an invoice cannot be issued for a client without them.'));
    }
  }

  fields.slug = select(
    'Project',
    [['', 'No project'], ...state.projects.map((project) => [project.slug, project.name])],
    client?.slug ?? '',
  );
  dialog.append(fields.slug.wrap, el('p', 'hint', 'The project this client\'s invoices belong to — it is what puts the money on the project page.'));

  dialog.append(action('Save client', async () => {
    const data = Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        field.control.value === '' && key !== 'name' && key !== 'country' ? null : field.control.value,
      ]),
    );
    const { client: saved } = await send(
      `${base}/clients${client ? `/${client.id}` : ''}`,
      client ? 'PATCH' : 'POST',
      data,
    );
    // Closed last, on success only (review finding H1). `modal()` removes the
    // dialog from the document when it closes, so anything that rejects after
    // a close has no error surface left — the owner sees nothing at all.
    await onSaved(saved);
    dialog.close();
  }, { cls: 'btn primary', parent: dialog, fields }));
}

function clientsPanel(state, refresh) {
  const dialog = modal('Clients');
  dialog.append(el('p', 'hint', 'A client needs initials before an invoice can be issued, and a project if its money should show on the project page.'));

  const rows = el('div', 'client-rows');
  if (!state.clients.length) rows.append(el('p', null, 'No clients yet.'));
  for (const client of state.clients) {
    const row = el('div', 'client-row');
    const who = el('div');
    who.append(el('b', null, client.name));
    const sub = [
      client.initials ? `Initials ${client.initials}` : 'No initials — cannot issue',
      state.projects.find((project) => project.slug === client.slug)?.name || 'No project',
      client.vat_number || 'No VAT number',
    ].join(' · ');
    who.append(el('small', null, sub));
    row.append(who, button('Edit', () => {
      dialog.close();
      clientEditor(client, state, async () => { await refresh(); clientsPanel(state, refresh); });
    }, 'btn small'));
    rows.append(row);
  }

  dialog.append(rows, button('Add client', () => {
    dialog.close();
    clientEditor(null, state, async () => { await refresh(); clientsPanel(state, refresh); });
  }, 'btn primary'));
}

async function issuerEditor() {
  const { issuer } = await apiFetch(`${base}/issuer`);
  const dialog = modal('Your invoice details');
  const fields = {};
  for (const key of ['name', 'address', 'vat_number', 'phone', 'email', 'payment_name', 'iban', 'bic']) {
    fields[key] = input(key.replaceAll('_', ' '), issuer[key] ?? '', key === 'address' ? 'textarea' : 'text');
    dialog.append(fields[key].wrap);
  }
  dialog.append(action('Save details', async () => {
    await send(`${base}/issuer`, 'PUT', {
      ...issuer,
      ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.control.value])),
    });
    notice(dialog, 'Saved. The printed invoice uses these values.');
  }, { cls: 'btn primary', parent: dialog, fields }));
  const { issuer_profiles: profiles = [] } = await apiFetch(`${base}/issuer`).catch(() => ({}));
  if (profiles.length) {
    dialog.append(el('p', 'label', 'Issuer profiles · an invoice picks one in « Issued as »'));
    for (const profile of profiles) dialog.append(button(`${profile.label} profile`, () => profileEditor(profile), 'btn small'));
  }
}

/** One issuer profile. Saving changes the next invoices that pick it; an invoice that
 *  already picked it keeps what it froze (choose it again on a draft to take the new text). */
function profileEditor(profile) {
  const dialog = modal(`${profile.label} profile`);
  const fields = {};
  const labels = { name: 'Name', address: 'Address', tax_id_label: 'Tax ID label', vat_number: 'Tax ID', registered_on: 'Registered on', phone: 'Phone' };
  for (const key of Object.keys(labels)) {
    fields[key] = input(labels[key], profile[key] ?? '', key === 'address' ? 'textarea' : key === 'registered_on' ? 'date' : 'text');
    dialog.append(fields[key].wrap);
  }
  const vatLine = select('VAT line', [['', 'None'], ['no_vat', NO_VAT_NOTE.EN]], profile.no_vat ? 'no_vat' : '');
  dialog.append(vatLine.wrap);
  dialog.append(el('p', 'hint', 'Payment details are always the Wise account.'));
  dialog.append(action('Save profile', async () => {
    await send(`${base}/issuer/profiles/${profile.id}`, 'PUT', {
      ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.control.value])),
      no_vat: vatLine.control.value === 'no_vat',
    });
    toast(`${profile.label} profile saved`);
    dialog.close();
  }, { cls: 'btn primary', parent: dialog, fields }));
}

/* -------------------------------------------------------- the editor ---- */

function lineEditor(line = {}) {
  const { title, detail } = splitLine(line.description);
  const row = el('div', 'invoice-line');
  const titleField = input('Title', title);
  const detailField = input('Description', detail);
  const qty = input('Qty', line.quantity ?? 1, 'number');
  qty.control.step = '0.01';
  qty.control.min = '0.01';
  const price = input('Price (€)', eurosFromCents(line.unit_cents ?? 0), 'number');
  price.control.step = '0.01';
  price.control.min = '0';
  row.append(titleField.wrap, detailField.wrap, qty.wrap, price.wrap);
  return {
    row, title: titleField, detail: detailField, qty, price,
  };
}

/**
 * One invoice, open. A draft is edited here; an issued invoice shows what it
 * says and what can still be done to it. Both end at the printed page.
 */
async function openInvoice(ctx, id, state, refresh) {
  const { invoice } = await apiFetch(`${base}/invoices/${id}`);
  const dialog = modal(invoice.number || 'Draft invoice');
  const client = state.clients.find((c) => c.id === invoice.client_id) ?? invoice.client ?? null;

  // The refresh and the reopen happen first; this dialog closes only once the
  // replacement is up (review finding H1). A `refresh()` that fails used to
  // land its error on a dialog already removed from the document.
  const reopen = async () => { await refresh(); await openInvoice(ctx, id, state, refresh); dialog.close(); };

  if (invoice.number) {
    dialog.append(issuedInvoice(ctx, invoice, state, dialog, refresh, reopen));
    return;
  }

  const fields = {};
  const rows = [];
  const lineFields = () => rows;

  fields.client_id = select('Client', state.clients.map((c) => [String(c.id), c.name]), String(invoice.client_id));
  /** The client this draft is for, as the select currently has it. */
  const chosenClient = () => state.clients.find((c) => String(c.id) === fields.client_id.control.value) ?? null;
  fields.slug = select(
    'Project',
    [['', 'No project'], ...state.projects.map((project) => [project.slug, project.name])],
    invoice.slug ?? '',
  );
  fields.kind = select('Kind', KINDS, invoice.kind || 'invoice');
  fields.subject = input('Subject', invoice.subject ?? '');
  fields.po_number = input('PO number', invoice.po_number ?? '');
  fields.vat_treatment = select('VAT treatment', TREATMENTS, invoice.vat_treatment);
  const { issuer: issuerNow, bank_accounts: accounts = [], issuer_profiles: profiles = [] } = await apiFetch(`${base}/issuer`).catch(() => ({}));
  fields.issuer_profile = select('Issued as', issuerChoices(issuerNow, profiles), invoice.issuer_profile ?? '');
  fields.bank_account = select('Bank account', bankChoices(accounts), invoice.bank_account ?? defaultBank(accounts, issuerNow));
  const paidIntoWise = el('p', 'hint', 'Paid into Wise: both profiles always ask for the Wise IBAN.');
  const showBank = () => {
    const profiled = Boolean(fields.issuer_profile.control.value);
    fields.bank_account.wrap.hidden = profiled;
    paidIntoWise.hidden = !profiled;
  };
  fields.issuer_profile.control.addEventListener('change', showBank);
  showBank();
  fields.request_cents = input('Requested now (€)', eurosFromCents(invoice.request_cents ?? 0), 'number');
  fields.request_cents.control.step = '0.01';
  fields.request_cents.control.min = '0';

  dialog.append(
    fields.client_id.wrap, fields.slug.wrap, fields.kind.wrap,
    fields.subject.wrap, fields.po_number.wrap, fields.vat_treatment.wrap,
    fields.issuer_profile.wrap, fields.bank_account.wrap, paidIntoWise,
  );

  const prepaymentBox = el('div', 'prepay-box');
  prepaymentBox.append(
    fields.request_cents.wrap,
    el('p', 'hint', 'The lines below are the whole project. This is what this invoice asks for now — the rest becomes part 2, later, when you choose to send it.'),
  );
  dialog.append(prepaymentBox);

  const lineList = el('div', 'invoice-lines');
  function addLine(line) {
    const entry = lineEditor(line);
    entry.remove = button('Remove line', () => {
      entry.row.remove();
      rows.splice(rows.indexOf(entry), 1);
      preview();
    }, 'btn small');
    entry.row.append(entry.remove);
    for (const field of [entry.qty, entry.price]) field.control.addEventListener('input', preview);
    rows.push(entry);
    lineList.append(entry.row);
  }

  dialog.append(el('p', 'label', 'Lines'), lineList);
  dialog.append(button('Add line', () => { addLine(); preview(); }, 'btn small'));

  const previewWrap = el('div', 'totals-preview');
  dialog.append(el('p', 'label', 'What the invoice will print'), previewWrap);

  /** The draft as the totals block sees it — the same function the paper uses. */
  function draftShape() {
    let total = 0;
    for (const row of rows) {
      let unit = 0;
      try { unit = centsFromEuros(row.price.control.value, 'unit_cents', { negative: true }); } catch { unit = 0; }
      total += lineAmount(row.qty.control.value, unit);
    }
    const kind = fields.kind.control.value;
    const treatment = fields.vat_treatment.control.value;
    let requested = null;
    try { requested = centsFromEuros(fields.request_cents.control.value, 'request_cents'); } catch { requested = null; }
    // The tax sentence is the invoice's, not this screen's — it is carried
    // over while the treatment is the one the API answered with, and dropped
    // the moment the owner picks another (the next save brings the new one).
    const sameTreatment = treatment === invoice.vat_treatment;
    return {
      kind,
      vat_treatment: treatment,
      vat_rate: sameTreatment ? invoice.vat_rate : undefined,
      vat_mention: sameTreatment ? invoice.vat_mention : null,
      total_cents: total,
      request_cents: kind === 'prepayment' ? requested : null,
      requested_cents: kind === 'prepayment' ? (requested ?? total) : total,
      payments: [],
    };
  }

  function preview() {
    prepaymentBox.hidden = fields.kind.control.value !== 'prepayment';
    previewWrap.replaceChildren(totalsBlock(draftShape(), 'totals totals-dark'));
    hint.textContent = numberHint();
  }

  function numberHint() {
    const next = nextNumberHint(state.invoices, chosenClient());
    return next
      ? `Issuing allocates the next number — it will be ${next}.`
      : 'This client has no initials yet, so no number can be allocated. Add them in Clients first.';
  }

  const hint = el('p', 'hint', '');
  for (const key of ['kind', 'vat_treatment', 'client_id', 'request_cents']) {
    fields[key].control.addEventListener(key === 'request_cents' ? 'input' : 'change', preview);
  }
  fields.client_id.control.addEventListener('change', () => {
    const chosen = chosenClient();
    if (chosen?.slug) fields.slug.control.value = chosen.slug;
  });

  for (const line of invoice.lines.length ? invoice.lines : [{}]) addLine(line);
  preview();

  async function save() {
    // `quantity` — the column's word, the API's word, and the word its
    // refusals name (`lines[0].quantity`). `qty` is only an input alias.
    const lines = rows.map((row, index) => ({
      description: joinLine(row.title.control.value, row.detail.control.value),
      quantity: Number(row.qty.control.value),
      unit_cents: centsFromEuros(row.price.control.value, `lines[${index}].unit_cents`, { negative: true }),
    }));
    if (!lines.length) throw new FieldError('An invoice needs at least one line.', 'lines');
    for (const [index, line] of lines.entries()) {
      if (!line.description.trim()) throw new FieldError('Every line needs a title.', `lines[${index}].description`);
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new FieldError('Quantity must be more than zero.', `lines[${index}].quantity`);
    }

    // ONE request, one D1 batch (review finding H2). It used to be a PATCH
    // for the header followed by a PUT for the lines: a refusal on the second
    // left the first already stored — the VAT treatment changed, the totals
    // recomputed against it — while this screen said "One field needs a
    // change", which reads as nothing was saved.
    const kind = fields.kind.control.value;
    await send(`${base}/invoices/${id}`, 'PUT', {
      client_id: Number(fields.client_id.control.value),
      slug: fields.slug.control.value || null,
      kind,
      subject: fields.subject.control.value,
      po_number: fields.po_number.control.value || null,
      vat_treatment: fields.vat_treatment.control.value,
      issuer_profile: fields.issuer_profile.control.value || null,
      // A profile is always paid into Wise; the server sets it.
      ...(fields.issuer_profile.control.value ? {} : { bank_account: fields.bank_account.control.value || null }),
      request_cents: kind === 'prepayment' ? centsFromEuros(fields.request_cents.control.value, 'request_cents') : null,
      lines,
    });
  }

  // Issuing can be refused for something that is not on this invoice at all:
  // the client's initials (there is no number without them) or, under a
  // reverse charge, the client's VAT number. Neither has a control here — they
  // belong to the client — so the message lands on the Client select and
  // carries the way to that client's record, which reopens this draft once it
  // is saved.
  const CLIENT_FIX = { initials: 'Set initials', vat_number: 'Add the VAT number' };
  const extras = {};
  for (const [field, label] of Object.entries(CLIENT_FIX)) {
    fields[field] = fields.client_id;
    extras[field] = () => {
      const link = el('button', 'btn small', label);
      link.type = 'button';
      link.addEventListener('click', () => {
        const client = chosenClient();
        // This draft stays open behind the client editor and is closed by the
        // editor's own success path, so a failing refresh still has somewhere
        // to say so (review finding H1).
        clientEditor(client, state, async () => {
          await refresh();
          await openInvoice(ctx, id, state, refresh);
          dialog.close();
        });
      });
      return link;
    };
  }

  const opts = {
    parent: dialog, fields, lines: lineFields, extras,
  };
  dialog.append(
    hint,
    action('Save draft', async () => {
      await save();
      await refresh();
      notice(dialog, 'Draft saved.');
    }, { ...opts, cls: 'btn primary' }),
    action('Issue invoice', async () => {
      await save();
      await send(`${base}/invoices/${id}/issue`, 'POST', {});
      await reopen();
    }, opts),
    action('Delete draft', async () => {
      await send(`${base}/invoices/${id}`, 'DELETE', {});
      await refresh();
      dialog.close();
    }, opts),
  );
}

/** What an issued invoice offers: the facts, then the four things that can
 *  still happen to it, then the printed page. */
/**
 * Chasing an overdue invoice (audit B7, M3, P8): how late, how much, a reminder
 * to paste into Andy's own email in the client's language, and a few days'
 * rest from Home's list. Recording the payment is just below, in this dialog.
 */
function chaseBox(invoice, opts, reopen) {
  const box = el('div', 'sub-form chase-box');
  const late = daysLate(invoice.due_on);
  box.append(el('p', 'label', `Overdue · ${late} day${late === 1 ? '' : 's'} late · ${shortMoney(invoice.due_cents)} due`));
  const row = el('div', 'chase-actions');
  for (const lang of ['FR', 'NL', 'EN']) {
    row.append(action(`Copy reminder ${lang}`, () => copyText(reminderText(invoice, lang), `Reminder (${lang})`), { ...opts, cls: 'btn small' }));
  }
  box.append(row);
  const rest = el('div', 'chase-actions');
  const today = dayOf();
  if (invoice.chase_snoozed_until && invoice.chase_snoozed_until > today) {
    rest.append(action(`Snoozed until ${formatDate(invoice.chase_snoozed_until)} · put it back now`, async () => {
      await send(`${base}/invoices/${invoice.id}/snooze`, 'POST', { days: 0 });
      toast('Back on Home\'s chase list');
      await reopen();
    }, { ...opts, cls: 'btn small quiet' }));
  } else {
    for (const days of [3, 7]) {
      rest.append(action(`Chased · snooze ${days} days`, async () => {
        await send(`${base}/invoices/${invoice.id}/snooze`, 'POST', { days });
        toast(`Off Home's chase list for ${days} days`);
        await reopen();
      }, { ...opts, cls: 'btn small quiet' }));
    }
  }
  box.append(rest);
  return box;
}

function issuedInvoice(ctx, invoice, state, dialog, refresh, reopen) {
  if (invoice.archive) return archivedInvoice(invoice, dialog, reopen);
  const wrap = el('div', 'issued');
  const status = statusLabel(invoice);

  const head = el('p', 'issued-head');
  head.append(tag([status.cls, status.label]));
  head.append(el('span', null, `${invoice.subject || 'Untitled'} · issued ${formatDate(invoice.issued_on)} · due ${formatDate(invoice.due_on)}`));
  wrap.append(head);

  wrap.append(totalsBlock(invoice, 'totals totals-dark'));

  const fields = {};
  const opts = { parent: dialog, fields };

  if (invoice.payments?.length) {
    const paid = el('div', 'payments');
    paid.append(el('p', 'label', 'Payments'));
    for (const payment of invoice.payments) {
      const line = el('div', 'payment-line');
      line.append(el('p', null, `${formatDate(payment.paid_on)} · ${shortMoney(payment.amount_cents)}${payment.label ? ` · ${payment.label}` : ''}`));
      // A mistyped payment is taken back here (audit B8); voiding the whole
      // invoice was the only way before. The notes keep a line about it.
      line.append(action('Remove', async () => {
        if (!window.confirm(`Remove the payment of ${shortMoney(payment.amount_cents)} of ${formatDate(payment.paid_on)}? The invoice's notes keep a line about it.`)) return;
        await send(`${base}/invoices/${invoice.id}/payments/${payment.id}`, 'DELETE');
        toast('Payment removed');
        await reopen();
      }, { ...opts, cls: 'btn small quiet' }));
      paid.append(line);
    }
    wrap.append(paid);
  }

  if (invoice.overdue) wrap.append(chaseBox(invoice, opts, reopen));

  wrap.append(action('Open print view', () => {
    dialog.close();
    (ctx?.navigate ?? ((path) => { window.location.href = path; }))(`/finance/${invoice.id}`);
  }, { ...opts, cls: 'btn primary' }));

  // Until it is sent, an issued invoice can still change the account it asks
  // to be paid into (the account is not part of its number or its totals).
  if (invoice.status !== 'void' && !invoice.sent_on) {
    const bankBox = el('div', 'bank-box');
    wrap.append(bankBox);
    apiFetch(`${base}/issuer`).then(({ issuer, bank_accounts: accounts = [], issuer_profiles: profiles = [] }) => {
      if (profiles.length) {
        fields.issuer_profile = select('Issued as', issuerChoices(issuer, profiles), invoice.issuer_profile ?? '');
        bankBox.append(fields.issuer_profile.wrap, action('Use this issuer', async () => {
          await send(`${base}/invoices/${invoice.id}/issuer`, 'PUT', { issuer_profile: fields.issuer_profile.control.value || null });
          toast('Issuer changed');
          await reopen();
        }, { ...opts, cls: 'btn small' }));
      }
      // With a profile the account is Wise, always: no account choice.
      if (!accounts.length || invoice.issuer_profile) return;
      fields.bank_account = select('Bank account', bankChoices(accounts), invoice.bank_account ?? defaultBank(accounts, issuer));
      bankBox.append(fields.bank_account.wrap, action('Use this account', async () => {
        await send(`${base}/invoices/${invoice.id}/bank`, 'PUT', { bank_account: fields.bank_account.control.value });
        await reopen();
      }, { ...opts, cls: 'btn small' }));
    }).catch(() => {});
  }

  if (invoice.status !== 'void' && !invoice.sent_on) {
    wrap.append(action('Mark sent', async () => {
      await send(`${base}/invoices/${invoice.id}/sent`, 'POST', {});
      await reopen();
    }, opts));
  }

  if (invoice.status !== 'void' && invoice.due_cents > 0) {
    const pay = el('div', 'sub-form');
    pay.append(el('p', 'label', 'Record a payment'));
    fields.amount_cents = input('Amount (€)', eurosFromCents(invoice.due_cents), 'number');
    fields.amount_cents.control.step = '0.01';
    fields.paid_on = input('Date', dayOf(), 'date');
    fields.label = input('Label (what this payment covers)', '');
    pay.append(fields.amount_cents.wrap, fields.paid_on.wrap, fields.label.wrap);
    pay.append(el('p', 'hint', 'The label is printed as the request line — "Prepayment website (50%) €1,300 + Digital marketing €400" becomes two lines on the invoice.'));
    pay.append(action('Record payment', async () => {
      await send(`${base}/invoices/${invoice.id}/payments`, 'POST', {
        amount_cents: centsFromEuros(fields.amount_cents.control.value, 'amount_cents'),
        paid_on: fields.paid_on.control.value || null,
        label: fields.label.control.value,
      });
      await reopen();
    }, opts));
    wrap.append(pay);
  }

  // A signed quote, in one action: lead won, project, order, onboarding
  // questionnaire (no link, nothing sent) and the follow-ups. It says what
  // will change first; steps already done are skipped, so it is safe to run
  // again (NIRMATA, 29 Oct — the Dr Morel set-up, made repeatable).
  if (invoice.kind === 'prepayment' && invoice.number && invoice.status !== 'void' && !invoice.parent_id) {
    const accept = el('div', 'sub-form');
    accept.append(el('p', 'label', 'Quote accepted'));
    accept.append(el('p', null, 'Make this a full client in one go: lead won, project, order, onboarding questionnaire (no link is made, nothing is sent) and the follow-ups. You see the list before anything changes.'));
    fields.slug = input('Project address', invoice.slug || invoice.client?.slug || '');
    fields.slug.control.placeholder = 'dr-lastname';
    fields.name = input('Project name', invoice.project_name || '');
    fields.name.control.placeholder = invoice.client?.name || '';
    // The brands are HQ's own businesses, read from the registry, never a fixed list.
    const brands = (state.projects ?? []).filter((p) => p.kind === 'business' && !p.parent);
    fields.parent = select('Brand', [['', 'No brand'], ...brands.map((p) => [p.slug, p.name])],
      brands.some((p) => p.slug === 'realis-studio') ? 'realis-studio' : '');
    accept.append(fields.slug.wrap, fields.name.wrap, fields.parent.wrap);
    accept.append(action('Accept quote', async () => {
      const chosen = Object.fromEntries(Object.entries({
        slug: fields.slug.control.value.trim(),
        name: fields.name.control.value.trim(),
        parent: fields.parent.control.value,
      }).filter(([, value]) => value));
      const { plan } = await apiFetch(`${base}/invoices/${invoice.id}/accept?${new URLSearchParams(chosen)}`);
      const left = plan.steps.filter((step) => !step.done);
      if (left.length) {
        const list = left.map((step) => `• ${step.label}`).join('\n');
        if (!window.confirm(`Accept the quote for ${plan.client.name}? This will do:\n\n${list}`)) return;
        await send(`${base}/invoices/${invoice.id}/accept`, 'POST', chosen);
        await refresh();
      }
      dialog.close();
      ctx?.navigate?.(`/p/${plan.slug}`);
    }, opts));
    wrap.append(accept);
  }

  if (invoice.kind === 'prepayment' && invoice.status !== 'void' && Number(invoice.not_yet_requested_cents ?? 0) > 0) {
    const part = el('div', 'sub-form');
    part.append(el('p', 'label', 'Part 2'));
    part.append(el('p', null, `${shortMoney(invoice.not_yet_requested_cents)} of this project has not been invoiced. Creating part 2 drafts a new invoice for that amount, linked to this one — it is not sent, and nothing is owed until you issue it.`));
    part.append(action('Create part 2', async () => {
      const { invoice: draft } = await send(`${base}/invoices/${invoice.id}/part`, 'POST', {});
      await refresh();
      await openInvoice(ctx, draft.id, state, refresh);
      dialog.close();
    }, opts));
    wrap.append(part);
  }

  // Numbered by mistake and never sent: it can go back to being a draft (and
  // then be fixed or deleted) as long as no newer number follows it — the
  // server checks that and says which invoice to undo first.
  if (invoice.number && !invoice.sent_on && !invoice.payments?.length) {
    const undo = el('div', 'sub-form');
    undo.append(el('p', 'label', 'Not sent yet?'));
    undo.append(el('p', null, `${invoice.number} was never sent. Undo the issue to turn it back into a draft, or delete it outright. Either way its number is freed. Only the newest invoice can be undone, so the numbering never has a gap.`));
    undo.append(action('Undo issue', async () => {
      await send(`${base}/invoices/${invoice.id}/unissue`, 'POST', {});
      await reopen();
    }, opts));
    // Made by mistake and never sent: gone in one click. Same guard as above —
    // the number is freed first, so nothing is left with a gap.
    undo.append(action('Delete invoice', async () => {
      if (!window.confirm(`Delete ${invoice.number} for good? It was never sent, so its number is freed for the next invoice.`)) return;
      await send(`${base}/invoices/${invoice.id}/unissue`, 'POST', {});
      await send(`${base}/invoices/${invoice.id}`, 'DELETE', {});
      await refresh();
      dialog.close();
    }, opts));
    wrap.append(undo);
  }

  if (invoice.status !== 'void') {
    const voidBox = el('div', 'sub-form');
    voidBox.append(el('p', 'label', 'Void'));
    fields.reason = input('Reason (required — it stays on the record)', '');
    voidBox.append(fields.reason.wrap, action('Void invoice', async () => {
      if (!fields.reason.control.value.trim()) throw new FieldError('A void needs a reason.', 'reason');
      await send(`${base}/invoices/${invoice.id}/void`, 'POST', { reason: fields.reason.control.value });
      await refresh();
      dialog.close();
    }, opts));
    wrap.append(voidBox);
  }

  return wrap;
}

/** An archive invoice (before HQ), open: what it says, exactly as printed,
 *  who paid what into which account, and where the record comes from. It
 *  cannot be changed — only a payment found later can still be recorded. */
function archivedInvoice(invoice, dialog, reopen) {
  const wrap = el('div', 'issued archive-view');
  const status = statusLabel(invoice);
  const head = el('p', 'issued-head');
  head.append(tag(['t-none', 'Archive']), tag([status.cls, status.label]));
  const dates = [
    invoice.issued_on ? `dated ${formatDate(invoice.issued_on)}` : `${invoiceYear(invoice)} · no invoice date`,
    invoice.due_on ? `due ${formatDate(invoice.due_on)}` : null,
  ].filter(Boolean).join(' · ');
  head.append(el('span', null, `${invoice.subject || 'Untitled'} · ${dates}`));
  wrap.append(head);

  const facts = el('dl', 'archive-facts');
  const fact = (label, value) => { if (value) facts.append(el('dt', null, label), el('dd', null, value)); };
  fact('Issued by', invoice.issuer_entity);
  fact('Billed to', invoice.billed_to || invoice.client?.name);
  fact('PO / reference', invoice.po_number);
  fact('Asked to pay into', paidIntoNames(invoice.bank_account).join(''));
  fact('Paid into', paidIntoNames(invoice.paid_into).join(' + ') || 'not proven');
  fact('Source', invoice.source);
  wrap.append(facts);

  const lines = el('div', 'archive-lines');
  for (const line of invoice.lines ?? []) {
    const row = el('div', 'archive-line');
    row.append(el('span', null, line.description), el('span', null, line.no_charge ? 'NO CHARGE' : shortMoney(line.amount_cents)));
    lines.append(row);
  }
  const total = el('div', 'archive-line archive-total');
  total.append(el('b', null, 'Total'), el('b', null, shortMoney(invoice.total_cents)));
  lines.append(total);
  wrap.append(lines);

  if (invoice.payments?.length) {
    const paid = el('div', 'payments');
    paid.append(el('p', 'label', 'Payments'));
    for (const p of invoice.payments) {
      const bank = paidIntoNames(p.bank_account ?? p.method).join('') || 'account not proven';
      paid.append(el('p', null, `${formatDate(p.paid_on)} · ${shortMoney(p.amount_cents)} · ${bank}${p.reference ? ` · ref. ${p.reference}` : ''}${p.label ? ` · ${p.label}` : ''}`));
    }
    wrap.append(paid);
  }
  if (invoice.notes) wrap.append(el('p', 'archive-notes', invoice.notes));

  if (invoice.due_cents > 0) {
    const fields = {};
    const pay = el('div', 'sub-form');
    pay.append(el('p', 'label', 'Found the payment?'));
    fields.amount_cents = input('Amount (€)', eurosFromCents(invoice.due_cents), 'number');
    fields.amount_cents.control.step = '0.01';
    fields.paid_on = input('Date it arrived', dayOf(), 'date');
    fields.label = input('Account and reference (e.g. KBC · 9.R.S.L.25)', '');
    pay.append(fields.amount_cents.wrap, fields.paid_on.wrap, fields.label.wrap, action('Record payment', async () => {
      await send(`${base}/invoices/${invoice.id}/payments`, 'POST', {
        amount_cents: centsFromEuros(fields.amount_cents.control.value, 'amount_cents'),
        paid_on: fields.paid_on.control.value || null,
        label: fields.label.control.value,
      });
      await reopen();
    }, { parent: dialog, fields }));
    wrap.append(pay);
  }
  return wrap;
}

/* ------------------------------------------------- by year, by client --- */

function clientLine(c, selected, onPick) {
  const row = el('button', `client-sum${selected ? ' is-on' : ''}`);
  row.type = 'button';
  row.setAttribute('aria-pressed', selected ? 'true' : 'false');
  const who = el('span', 'cs-who');
  who.append(el('b', null, c.name), el('small', null, [
    `${c.count} invoice${c.count === 1 ? '' : 's'}`,
    c.banks?.length ? `into ${c.banks.join(' + ')}` : null,
  ].filter(Boolean).join(' · ')));
  const figs = el('span', 'cs-figs');
  figs.append(el('b', null, shortMoney(c.invoiced_cents)));
  // Owed (live) and not proven (archive) are different things and are never
  // added together under one word.
  if (c.unpaid_cents) figs.append(el('small', 'cs-due', `unpaid ${shortMoney(c.unpaid_cents)}`));
  if (c.unproven_cents) figs.append(el('small', 'cs-unproven', `not proven ${shortMoney(c.unproven_cents)}`));
  if (!c.unpaid_cents && !c.unproven_cents) figs.append(el('small', 'cs-clear', `paid ${shortMoney(c.paid_cents)}`));
  row.append(who, figs);
  row.addEventListener('click', onPick);
  return row;
}

/**
 * The Invoices card: the clients of the chosen year on the left, that view's
 * invoices on the right — each list scrolls on its own. The year itself is
 * picked in the page's year dropdown (Andy, 27 Oct: no row of year cards).
 * Exported so the render test can build it without the API.
 */
export function invoicesByYear(state, view, { navigate, onOpen, onChange, onExpenses } = {}) {
  const clientName = (id) => state.clients.find((c) => c.id === id)?.name ?? '';
  const all = moneyByYear(state.invoices, { clientName, expenses: state.expenses });
  const picked = moneyByYear(state.invoices, {
    clientName, year: view.year, clientId: view.clientId, expenses: state.expenses,
  });
  const frag = document.createDocumentFragment();

  const sum = (key) => all.years.reduce((s, y) => s + (y[key] ?? 0), 0);
  const allFigs = {
    count: sum('count'), invoiced_cents: sum('invoiced_cents'), paid_cents: sum('paid_cents'),
    unpaid_cents: sum('unpaid_cents'), unproven_cents: sum('unproven_cents'), expenses_cents: sum('expenses_cents'),
  };
  const zero = { count: 0, invoiced_cents: 0, paid_cents: 0, unpaid_cents: 0, unproven_cents: 0, expenses_cents: 0 };
  const yearTotal = view.year == null ? allFigs : (all.years.find((y) => y.year === view.year) ?? zero);

  const split = el('div', 'money-split');
  const left = el('div', 'by-client');
  const leftHead = el('div', 'split-head');
  leftHead.append(el('p', 'eyebrow', `By client · ${view.year ?? 'all years'}`));
  if (onExpenses) leftHead.append(button('Expenses', () => onExpenses(view.year), 'btn small'));
  left.append(leftHead);
  const clientList = el('div', 'split-scroll');
  clientList.append(clientLine({
    name: 'All clients', count: yearTotal.count, invoiced_cents: yearTotal.invoiced_cents,
    paid_cents: yearTotal.paid_cents, unpaid_cents: yearTotal.unpaid_cents, unproven_cents: yearTotal.unproven_cents,
  }, view.clientId == null, () => onChange?.({ ...view, clientId: null })));
  for (const c of picked.clients) {
    clientList.append(clientLine(c, view.clientId === c.client_id, () => onChange?.({ ...view, clientId: c.client_id })));
  }
  // A client whose only invoice this year is a draft still belongs in the list:
  // drafts count in no total, but Andy has to be able to find them (3 Nov, #159).
  const draftsAll = state.invoices.filter((i) => !i.number && i.status !== 'void');
  const listed = new Set(picked.clients.map((c) => c.client_id));
  for (const id of [...new Set(draftsAll.map((i) => i.client_id))]) {
    if (listed.has(id)) continue;
    const c = { client_id: id, name: clientName(id), count: 0, invoiced_cents: 0, paid_cents: 0, unpaid_cents: 0, unproven_cents: 0 };
    clientList.append(clientLine(c, view.clientId === id, () => onChange?.({ ...view, clientId: id })));
  }
  left.append(clientList);

  const right = el('div', 'by-invoice');
  const rightHead = el('div', 'split-head');
  const title = [view.year ?? 'All years', view.clientId != null ? clientName(view.clientId) : null].filter(Boolean).join(' · ');
  rightHead.append(el('p', 'eyebrow', title));
  const t = picked.total;
  const line = el('p', 'money-totals view-totals');
  // Expenses belong to a year, not a client, so they join the line only when
  // no client is picked, and only when there are any.
  const expenses = view.clientId == null ? yearTotal.expenses_cents : 0;
  [['Invoiced', t.invoiced_cents], ['Paid', t.paid_cents], ['Unpaid', t.unpaid_cents], ['Not proven', t.unproven_cents],
    ...(expenses ? [['Expenses', expenses]] : [])]
    .forEach(([label, cents], i) => { if (i) line.append(el('i', 'sep', '·')); line.append(figure(label, shortMoney(cents))); });
  rightHead.append(line);
  right.append(rightHead);

  const rows = el('div', 'invoice-rows split-scroll');
  let lastYear;
  // Drafts sit on top in every view (any year; the picked client's only), in no total.
  const drafts = draftsAll.filter((i) => view.clientId == null || i.client_id === view.clientId);
  for (const invoice of [...drafts, ...picked.invoices]) {
    const y = invoice.number ? invoiceYear(invoice) : 'Drafts';
    if ((view.year == null || y === 'Drafts' || (drafts.length && lastYear === 'Drafts')) && y !== lastYear) {
      const figs = y === 'Drafts' ? null : all.years.find((x) => x.year === y);
      const yh = el('div', 'year-head');
      yh.append(el('b', null, String(y ?? 'No year')));
      if (figs && view.clientId == null) yh.append(el('span', null, `${shortMoney(figs.invoiced_cents)} invoiced · ${shortMoney(figs.paid_cents)} paid`));
      rows.append(yh);
      lastYear = y;
    }
    rows.append(invoiceRow(invoice, { navigate, onOpen: onOpen ? () => onOpen(invoice) : null }));
  }
  if (!picked.invoices.length && !drafts.length) rows.append(el('p', 'hint', 'No invoices in this view.'));
  // Void invoices count in no total, but they stay findable (audit B8): one
  // button lists those of this view at the end.
  const voids = state.invoices.filter((i) => i.number && i.status === 'void'
    && (view.year == null || invoiceYear(i) === view.year)
    && (view.clientId == null || i.client_id === view.clientId));
  if (voids.length) {
    const toggle = el('button', 'btn small quiet void-toggle', state.showVoid ? `Hide void (${voids.length})` : `Show void (${voids.length})`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => { state.showVoid = !state.showVoid; onChange?.({ ...view }); });
    rows.append(toggle);
    if (state.showVoid) {
      for (const invoice of voids) rows.append(invoiceRow(invoice, { navigate, onOpen: onOpen ? () => onOpen(invoice) : null }));
    }
  }
  right.append(rows);

  split.append(left, right);
  frag.append(split);
  return frag;
}

function expensesPanel(expenses, year) {
  const list = year == null ? expenses : expenses.filter((e) => Number(e.year) === year);
  const dialog = modal(`Business expenses · ${year ?? 'all years'}`);
  if (!list.length) dialog.append(el('p', null, 'No expenses recorded for this year.'));
  const total = list.reduce((s, e) => s + Number(e.amount_cents ?? 0), 0);
  if (list.length) dialog.append(el('p', 'hint', `${list.length} purchase${list.length === 1 ? '' : 's'} · ${shortMoney(total)}`));
  for (const e of list) {
    const row = el('div', 'expense-row');
    const who = el('div');
    who.append(el('b', null, `${formatDate(e.spent_on)} · ${e.vendor}`));
    who.append(el('small', null, [
      e.description, e.order_ref ? `order ${e.order_ref}` : null,
      e.original_currency ? `${(Number(e.original_amount_cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${e.original_currency}` : null,
      e.paid_with ? `paid with ${paidIntoNames(e.paid_with).join('') || e.paid_with}` : null,
    ].filter(Boolean).join(' · ')));
    if (e.notes) who.append(el('small', null, e.notes));
    row.append(who, el('b', 'expense-amount', shortMoney(e.amount_cents)));
    if (e.flag) row.append(el('p', 'expense-flag', `⚑ ${e.flag}`));
    dialog.append(row);
  }
}

/* --------------------------------------------------------- the screen --- */

/* The year dropdown: « All years » and every year with an invoice or an
   expense, newest first, plus this year so the default always exists. */
const YEAR_KEY = 'hq.finance.year';
function savedYear() {
  let v = null;
  try { v = localStorage.getItem(YEAR_KEY); } catch { /* private window: this year */ }
  if (v === 'all') return null;
  return Number(v) || new Date().getFullYear();
}
function saveYear(year) {
  try { localStorage.setItem(YEAR_KEY, year == null ? 'all' : String(year)); } catch { /* not remembered */ }
}
export function yearChoices(state) {
  const { years } = moneyByYear(state.invoices, { expenses: state.expenses });
  const set = new Set(years.map((y) => y.year).filter((y) => y != null));
  set.add(new Date().getFullYear());
  return [...set].sort((a, b) => b - a);
}
function fillYears(select, state, current) {
  const options = [['all', 'All years'], ...yearChoices(state).map((y) => [String(y), String(y)])];
  select.replaceChildren(...options.map(([value, label]) => {
    const o = el('option', null, label);
    o.value = value;
    return o;
  }));
  select.value = current == null ? 'all' : String(current);
}

const STATS = [
  ['Outstanding', 'outstanding_cents', 'Asked for and not paid yet.'],
  ['Overdue', 'overdue_cents', 'Past its due date.'],
  ['Paid this year', 'paid_this_year_cents', 'Money actually received.'],
  ['Not yet invoiced', 'not_yet_requested_cents', 'Part 2 money — yours to send when you choose.'],
];

export async function renderFinance(ctx) {
  const navigate = ctx?.navigate ?? ((path) => { window.location.href = path; });
  // On a phone (P6 block 4) the page stays still: the open tab's card is the one region that scrolls.
  const root = el('div', 'grid phone-frame finance-screen');
  const head = hero('Money', 'in', 'Clients, invoices and payments · amounts in EUR');
  const actions = el('div', 'hero-actions');
  head.append(actions);

  const totals = el('div', 'grid g-cards g-4');
  const list = el('section', 'card invoices');
  // What each client is charged for, project by project — the agreements the
  // invoices above come out of.
  const orders = el('div');

  const state = {
    clients: [], invoices: [], projects: [], overview: null, expenses: [],
  };
  // Which year and client the Invoices card shows: the year Andy last picked
  // (this year until he picks one), all clients.
  const view = { year: savedYear(), clientId: null };
  const yearPick = el('select', 'sortsel finance-year');
  yearPick.setAttribute('aria-label', 'Year');
  yearPick.addEventListener('change', () => {
    view.year = yearPick.value === 'all' ? null : Number(yearPick.value);
    saveYear(view.year);
    drawList();
  });

  async function refresh() {
    const [overview, clientsBody, invoicesBody, projectsBody, expensesBody] = await Promise.all([
      apiFetch(`${base}/overview`),
      apiFetch(`${base}/clients`),
      apiFetch(`${base}/invoices`),
      apiFetch('/api/projects'),
      // Expenses are a side figure: a database without them (before 0019) is
      // still a working Finance screen.
      apiFetch(`${base}/expenses`).catch(() => ({ expenses: [] })),
    ]);
    state.expenses = expensesBody?.expenses ?? [];
    state.overview = overview;
    state.clients = clientsBody.clients ?? [];
    state.projects = projectsBody.projects ?? [];
    state.invoices = (invoicesBody.invoices ?? []).map((invoice) => ({
      ...invoice,
      client_name: state.clients.find((c) => c.id === invoice.client_id)?.name || '',
    }));

    totals.replaceChildren();
    for (const [label, key, note] of STATS) {
      const card = el('section', 'card stat');
      card.append(el('p', 'eyebrow', label), el('h2', null, shortMoney(overview[key])), el('p', 'stat-note', note));
      totals.append(card);
    }

    list.replaceChildren(el('h2', null, 'Invoices'));
    yearPick.hidden = !state.invoices.length;
    if (!state.invoices.length) {
      list.append(emptyState(
        'Your first invoice starts here',
        'Add a client with their initials, then a draft invoice. The number is allocated when you issue it.',
      ));
      return;
    }
    drawList();
  }

  function drawList() {
    fillYears(yearPick, state, view.year);
    list.replaceChildren(el('h2', null, 'Invoices'));
    list.append(invoicesByYear(state, view, {
      navigate,
      onOpen: (invoice) => openInvoice(ctx, invoice.id, state, refresh),
      onChange: (next) => { Object.assign(view, next); drawList(); },
      onExpenses: (year) => expensesPanel(state.expenses, year),
    }));
    // Each list fills what is left of the screen and scrolls inside itself:
    // the page never does (on a desktop; phones keep the ordinary scroll).
    for (const scroller of list.querySelectorAll('.split-scroll')) fillViewport(scroller, { bottom: 52, min: 160 });
  }

  actions.append(
    button('New invoice', async () => {
      if (!state.clients.length) { clientEditor(null, state, refresh); return; }
      const dialog = modal('New draft invoice');
      const fields = {};
      fields.client_id = select('Client', state.clients.map((c) => [String(c.id), c.name]), String(state.clients[0].id));
      fields.kind = select('Kind', KINDS, 'invoice');
      fields.subject = input('Subject / campaign');
      dialog.append(fields.client_id.wrap, fields.kind.wrap, fields.subject.wrap);
      dialog.append(action('Create draft', async () => {
        const { invoice } = await send(`${base}/invoices`, 'POST', {
          client_id: Number(fields.client_id.control.value),
          kind: fields.kind.control.value,
          subject: fields.subject.control.value,
        });
        await refresh();
        await openInvoice(ctx, invoice.id, state, refresh);
        dialog.close();
      }, { cls: 'btn primary', parent: dialog, fields }));
    }, 'btn primary'),
    button('Clients', () => clientsPanel(state, refresh)),
    button('Invoice details', issuerEditor),
    yearPick,
  );
  // On a phone the actions take short labels (P6 block 4); the full name stays the button's name.
  for (const [long, short] of [['New invoice', '+ New'], ['Invoice details', 'Details']]) {
    const b = [...actions.querySelectorAll('button')].find((x) => x.textContent === long);
    if (!b) continue;
    b.setAttribute('aria-label', long);
    b.replaceChildren(el('span', 'lbl-long', long), el('span', 'lbl-short', short));
  }

  // Invoices and Orders share one place under the figures, one at a time, so
  // the page itself never scrolls (house rule; NIRMATA, 27 Oct). The tab
  // Andy left it on is remembered.
  const TAB_KEY = 'hq.finance.tab';
  let tab = 'invoices';
  try { if (localStorage.getItem(TAB_KEY) === 'orders') tab = 'orders'; } catch { /* default */ }
  const tabs = el('div', 'tabs finance-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabButton = (key, label) => {
    const b = el('button', 'tab', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => { tab = key; showTab(); });
    return b;
  };
  const invoicesTab = tabButton('invoices', 'Invoices');
  const ordersTab = tabButton('orders', 'Orders');
  tabs.append(invoicesTab, ordersTab);
  function showTab() {
    invoicesTab.setAttribute('aria-selected', String(tab === 'invoices'));
    ordersTab.setAttribute('aria-selected', String(tab === 'orders'));
    list.hidden = tab !== 'invoices';
    orders.hidden = tab !== 'orders';
    list.classList.toggle('scroll-region', tab === 'invoices');
    orders.classList.toggle('scroll-region', tab === 'orders');
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* not remembered */ }
  }
  showTab();

  root.append(head, totals, tabs, list, orders);
  ordersSection(navigate).then((card) => orders.replaceChildren(card)).catch(() => {});
  await refresh();
  // Home's « Chase » links here with ?invoice=<id>: that invoice's dialog opens
  // at once (audit B7), and the address goes back to plain /finance.
  if (typeof window !== 'undefined' && window.location?.search) {
    const asked = Number(new URLSearchParams(window.location.search).get('invoice'));
    if (Number.isInteger(asked) && asked > 0) {
      window.history?.replaceState?.(null, '', '/finance');
      openInvoice(ctx, asked, state, refresh).catch((error) => toast(error?.message || 'That invoice could not be opened'));
    }
  }
  return root;
}
