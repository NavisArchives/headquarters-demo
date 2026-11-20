// Money, dates and invoice wording — pure functions, no DOM, no fetch.
//
// Everything the finance screens print or type passes through here, and
// nothing else converts money: the API speaks integer cents, the owner types
// euros, and `centsFromEuros`/`eurosFromCents` are the only place the two
// meet. test/finance-lib.test.js runs the whole file under plain Node.

import { dayOf } from './dates.js';

/** A validation failure the screen can put next to the field that caused it,
 *  the same shape the API's 400 has (`message` + `field`). */
export class FieldError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'FieldError';
    this.field = field;
  }
}

/** €100,000,000.00 — db.js's CENTS_MAX. Anything above it is a typo, and a
 *  typo caught here is a message next to the field instead of a 400. */
const CENTS_MAX = 10_000_000_000;

/**
 * Euros as the owner types them -> integer cents. Accepts `1700`, `1700.00`,
 * `1700,00` and spaces; refuses anything else by name, because a silent
 * `Number('1.7o0') === NaN` reaches the database as a corrupt invoice.
 */
export function centsFromEuros(value, field = 'amount', { negative = false } = {}) {
  let text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!text) throw new FieldError('Enter an amount in euros, like 1700.00', field);
  // Only an invoice line's price may be negative: a deduction, like a prepayment already paid.
  const minus = negative && /^[-−]/.test(text);
  if (minus) text = text.slice(1);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new FieldError('Amounts are euros with up to two decimals, like 1700.00', field);
  }
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents > CENTS_MAX) {
    throw new FieldError('That amount is larger than this invoice can hold', field);
  }
  return minus ? -cents : cents;
}

/** Integer cents -> the euros string an input field shows: `1700.00`. */
export function eurosFromCents(cents) {
  const n = Number(cents ?? 0);
  return (Math.abs(n) / 100).toFixed(2).replace(/^/, n < 0 ? '-' : '');
}

/** The printed totals form: `€1700.00`. No thousands separator — this is the
 *  figure as it appears on the paper invoice. */
export function money(cents) {
  const n = Number(cents ?? 0);
  return `${n < 0 ? '-' : ''}€${(Math.abs(n) / 100).toFixed(2)}`;
}

/** The printed line form: `€2000` when the amount is whole euros, `€2000.50`
 *  when it is not — as on invoice 5.R.A.L.01. */
export function lineMoney(cents) {
  const n = Number(cents ?? 0);
  const whole = Math.abs(n) % 100 === 0;
  return `${n < 0 ? '-' : ''}€${whole ? String(Math.abs(n) / 100) : (Math.abs(n) / 100).toFixed(2)}`;
}

/** The printed form the owner's template uses: `€2,000.00` — always two
 *  decimals, always a thousands separator. `money` stays as it is: the
 *  dashboard and the editor preview print the older, separator-less figure,
 *  and changing that would move numbers on screens this template never
 *  touches. */
export function printMoney(cents) {
  const n = Number(cents ?? 0);
  const euros = (Math.abs(n) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${n < 0 ? '-' : ''}€${euros}`;
}

/**
 * The hero's "Amount due", split the way the template sets it: a big
 * separated whole number and a faded `.NN` beside it — `€1,700` + `.00` on
 * the owner's rendered reference.
 */
export function amountParts(cents) {
  const n = Math.abs(Number(cents ?? 0));
  return {
    sign: Number(cents ?? 0) < 0 ? '-' : '',
    whole: Math.trunc(n / 100).toLocaleString('en-US'),
    cents: String(n % 100).padStart(2, '0'),
  };
}

/**
 * The issuer's name as the hero's logo: `Realis Studio` -> `REALIS` · `.` ·
 * `STUDIO`, the dot being the template's blue accent. The split is on the
 * first space only, so "ANDY's ARCHIVES" is one word and one dot, and a
 * single-word name is printed as it is stored — nothing is invented.
 */
export function logoParts(name) {
  const text = String(name ?? '').trim();
  const at = text.indexOf(' ');
  if (at === -1) return { head: text, dot: '', tail: '' };
  return {
    head: text.slice(0, at).toUpperCase(),
    dot: '.',
    tail: text.slice(at + 1).trim().toUpperCase(),
  };
}

/** What this invoice is asking for now: the request on a prepayment, the
 *  whole total otherwise. The one place that choice is made. */
export function requestedCents(invoice = {}) {
  const total = Number(invoice.total_cents ?? 0);
  if (invoice.kind !== 'prepayment') return total;
  return Number(invoice.requested_cents ?? invoice.request_cents ?? total);
}

/** The on-screen form, for the dark dashboard: `€3,000`, `€1,234.56`. */
export function shortMoney(cents) {
  const n = Number(cents ?? 0);
  const euros = Math.abs(n) / 100;
  const body = Math.abs(n) % 100 === 0
    ? euros.toLocaleString('en-US')
    : euros.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}€${body}`;
}

/** Exact half-up division of non-negative integers, in BigInt — the same
 *  rule `db.js` uses, so the editor's preview and the invoice the server
 *  stores can never disagree about a cent. */
const divideHalfUp = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

/** Quantities are billed to at most four decimals (db.js: QTY_MAX_DECIMALS). */
const QTY_SCALE = 10_000n;

/**
 * One line's amount in cents: `quantity x unit_cents`, rounded half up on the
 * exact decimal value rather than on a binary float. 0.29 x 50 is
 * 14.499999999999998 in IEEE-754 — it must still come out 15, as it does on
 * the server. A quantity or price that is not yet a usable number counts as
 * nothing, because this also runs on every keystroke of a half-typed field.
 */
export function lineAmount(quantity, unitCents) {
  const qty = Number(quantity);
  const unit = Number(unitCents);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isInteger(unit) || unit < 0) return 0;
  const scaled = BigInt(Math.round(qty * Number(QTY_SCALE)));
  return Number(divideHalfUp(scaled * BigInt(unit), QTY_SCALE));
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** `2026-07-09` -> `09 JUL 2026`, the invoice's own date style. Anything that
 *  is not a stored date answers '' rather than "Invalid Date". */
export function formatDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [year, month, day] = iso.slice(0, 10).split('-');
  const name = MONTHS[Number(month) - 1];
  if (!name) return '';
  return `${day} ${name} ${year}`;
}

/** Whole days between a due date and today, 0 when it is not yet due. */
export function daysOverdue(dueOn, today) {
  if (typeof dueOn !== 'string' || typeof today !== 'string') return 0;
  const due = Date.parse(`${dueOn.slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

/**
 * An invoice line is stored as one `description`; the print wants a bold
 * title and a muted detail under it. The two are kept in one column with
 * ' — ' between them, which is exactly how 5.R.A.L.01's lines were entered.
 */
export function splitLine(description) {
  const text = String(description ?? '');
  const at = text.indexOf(' — ');
  if (at === -1) return { title: text.trim(), detail: '' };
  return { title: text.slice(0, at).trim(), detail: text.slice(at + 3).trim() };
}

/** The inverse, for the editor's two fields. */
export function joinLine(title, detail) {
  const head = String(title ?? '').trim();
  const tail = String(detail ?? '').trim();
  return tail ? `${head} — ${tail}` : head;
}

/**
 * What the list's pill says. Derived from the invoice's own fields, never
 * from a stored label: a prepayment whose part 1 is settled while part 2 is
 * still uninvoiced is not simply "Paid", and it is not a debt either.
 *
 * The whole set, and there is no sixth: **Draft** · **Issued** (numbered, not
 * sent yet — a real state, because "Mark sent" is a separate action the owner
 * takes) · **Sent** · **Overdue · <n> days** (only when the API itself says
 * `overdue`, and it carries the count so the pill is the whole story) ·
 * **Paid** · **Part 1 paid – part 2 open** · **Void**.
 *
 * `today` is injectable so the day count is deterministic under test.
 */
export function statusLabel(invoice = {}, today = dayOf()) {
  const status = invoice.computed_status ?? (invoice.number ? 'issued' : 'draft');
  if (invoice.status === 'void' || status === 'void') return { label: 'Void', cls: 't-none' };
  if (status === 'draft' || !invoice.number) return { label: 'Draft', cls: 't-idle' };

  const openPart = invoice.kind === 'prepayment' && Number(invoice.not_yet_requested_cents ?? 0) > 0;
  if (status === 'paid') {
    return openPart
      ? { label: 'Part 1 paid – part 2 open', cls: 't-run' }
      : { label: 'Paid', cls: 't-live' };
  }
  // An archive invoice (from before HQ) no payment covers: no bank record of
  // the money was found. Not a debt, so never "overdue".
  if (status === 'unproven') return { label: 'Payment not proven', cls: 't-idle' };
  if (invoice.overdue) {
    const days = daysOverdue(invoice.due_on, today);
    return { label: days ? `Overdue · ${days === 1 ? '1 day' : `${days} days`}` : 'Overdue', cls: 't-bad' };
  }
  if (status === 'sent') return { label: 'Sent', cls: 't-warn' };
  return { label: 'Issued', cls: 't-warn' };
}

/** The rate an unsaved draft assumes while it is still only a form. Every
 *  invoice the API has seen carries `vat_rate` and `vat_mention` of its own
 *  (db.js VAT_TREATMENTS), and those win — this exists so the editor's live
 *  preview has something to show before the draft has been saved once. */
const DRAFT_RATE = Object.freeze({
  reverse_charge: 0, standard: 21, exempt_small: 0, export: 0,
});

/**
 * The printed tax line. The sentence is the API's — `vat_mention`, which is
 * the wording on the real invoice (addendum 4) — and this composes nothing of
 * its own; a treatment with no sentence (the standard 21%) prints the rate and
 * the amount instead.
 */
export function taxLine(invoice = {}) {
  const rate = Number(invoice.vat_rate ?? DRAFT_RATE[invoice.vat_treatment] ?? 0);
  const mention = invoice.vat_mention ?? null;
  return {
    label: mention || `Tax (${rate}%)`,
    value: rate ? money(invoice.vat_cents ?? 0) : '',
  };
}

/** The net part of a VAT-inclusive amount: the net whose VAT, rounded half up
 *  as the worker does, brings it back to exactly `grossCents` (or the largest
 *  that stays under it). Mirrors `netForGross` in src/worker/db.js. */
export function netOfGross(grossCents, rate) {
  const gross = Number(grossCents) || 0;
  if (!rate) return gross;
  const guess = Math.round((gross * 100) / (100 + rate));
  let best = null;
  for (let net = guess - 3; net <= guess + 3; net += 1) {
    if (net < 0) continue;
    const total = net + Math.round((net * rate) / 100);
    if (total === gross) return net;
    if (total < gross && (best === null || net > best)) best = net;
  }
  return best ?? 0;
}

/** On a prepayment with VAT, the deposit's own base and VAT (audit A3): the
 *  tax line used to print the whole project's VAT beside a total that is only
 *  the deposit, so the three figures did not add up. Null when there is no VAT
 *  to split, and the print stays as it always was. */
export function prepaymentTax(invoice = {}) {
  if (invoice.kind !== 'prepayment') return null;
  const rate = Number(invoice.vat_rate ?? DRAFT_RATE[invoice.vat_treatment] ?? 0);
  if (!rate) return null;
  const requested = Number(invoice.requested_cents ?? invoice.request_cents ?? invoice.total_cents ?? 0);
  const base = netOfGross(requested, rate);
  return { rate, base, vat: requested - base };
}

/** `1,300` / `400` / `1.300,50` as written inside a payment label -> cents. */
function parseEuroText(text) {
  let t = String(text ?? '').trim();
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** "Prepayment website (50%) €1,300 + Digital marketing €400 (a note)" ->
 *  the two request lines the print shows. A trailing parenthetical is the
 *  bookkeeping note the owner wrote for himself, not a line of the invoice. */
function parseLabel(label) {
  const cleaned = String(label ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim();
  if (!cleaned) return null;
  const out = [];
  for (const segment of cleaned.split(/\s+\+\s+/)) {
    const match = /^(.+?)\s*€\s*([\d.,]+)$/.exec(segment.trim());
    if (!match) return null;
    const cents = parseEuroText(match[2]);
    if (cents === null) return null;
    out.push({ label: match[1].trim(), cents });
  }
  return out.length ? out : null;
}

/**
 * What a prepayment is asking for now, broken into the lines the invoice
 * prints ("Prepayment website (50%)", "Digital marketing"). The breakdown
 * lives in the payment labels the owner already writes; it is used only when
 * it adds up to exactly what the invoice requested, so a half-parsed label
 * can never turn into a wrong invoice — it falls back to the one figure.
 */
export function requestLines(invoice = {}) {
  const requested = Number(
    invoice.requested_cents ?? invoice.request_cents ?? invoice.total_cents ?? 0,
  );
  if (invoice.kind !== 'prepayment') return [];

  const parsed = [];
  for (const payment of invoice.payments ?? []) {
    const lines = parseLabel(payment.label);
    if (lines) parsed.push(...lines);
  }
  const sum = parsed.reduce((total, line) => total + line.cents, 0);
  if (parsed.length && sum === requested) return parsed;

  return [{ label: 'Prepayment requested now', cents: requested }];
}

/**
 * The print's totals block, as rows. One function so the editor's live
 * preview and the printed page can never drift apart.
 *
 * On 5.R.A.L.01 this is exactly:
 *   Project Total €3000.00
 *   Prepayment website (50%) €1300.00
 *   Digital marketing €400.00
 *   Tax (0%) - Reverse charge may apply.
 *   Total for prepayment €1700.00
 */
export function totalsRows(invoice = {}) {
  const prepayment = invoice.kind === 'prepayment';
  const total = Number(invoice.total_cents ?? 0);
  const requested = prepayment
    ? Number(invoice.requested_cents ?? invoice.request_cents ?? total)
    : total;

  const rows = [{ label: 'Project Total', value: money(total) }];
  if (prepayment) {
    for (const line of requestLines(invoice)) rows.push({ label: line.label, value: money(line.cents) });
  }
  const split = prepaymentTax(invoice);
  if (split) {
    rows.push({ label: 'Prepayment excl. VAT', value: money(split.base) });
    rows.push({ label: `VAT (${split.rate}%) on the prepayment`, value: money(split.vat) });
  } else {
    rows.push(taxLine(invoice));
  }
  rows.push({
    label: prepayment ? 'Total for prepayment' : 'Total',
    value: money(requested),
    strong: true,
  });
  return rows;
}

/** The totals block as plain lines — what a test and a hint string read. */
export const totalsText = (invoice) => totalsRows(invoice)
  .map((row) => `${row.label} ${row.value}`.trim());

/**
 * The totals box on the owner's template. The same four kinds of line as
 * `totalsRows`, in his wording and his figures:
 *
 *   Project total                             €3,000.00
 *   Prepayment website (50%)                  €1,300.00
 *   Digital marketing                           €400.00
 *   Tax (0%) · Reverse charge may apply            €0.00
 *   Total for prepayment                      €1,700.00
 *
 * Two differences from `totalsRows`, both the template's: every figure is
 * separated and two-decimal (`printMoney`), and the tax line always carries an
 * amount — the template's grey box has a right-hand column on every row, and a
 * 0% treatment that printed nothing would leave a hole in it.
 */
export function printTotalsRows(invoice = {}) {
  const prepayment = invoice.kind === 'prepayment';
  const rows = [{ label: 'Project total', value: printMoney(invoice.total_cents ?? 0) }];
  if (prepayment) {
    for (const line of requestLines(invoice)) rows.push({ label: line.label, value: printMoney(line.cents) });
  }
  const split = prepaymentTax(invoice);
  if (split) {
    rows.push({ label: 'Prepayment excl. VAT', value: printMoney(split.base) });
    rows.push({ label: `VAT (${split.rate}%) on the prepayment`, value: printMoney(split.vat) });
  } else {
    const tax = taxLine(invoice);
    rows.push({ label: tax.label, value: printMoney(invoice.vat_cents ?? 0) });
  }
  rows.push({
    label: prepayment ? 'Total for prepayment' : 'Total',
    value: printMoney(requestedCents(invoice)),
    strong: true,
  });
  return rows;
}

/** The live series. 5.R.A.L.01 was issued as Realis *Agency*; everything from
 *  now is Realis *Studio*, whose first invoice is number 1. */
export const SERIES = 'studio';

/**
 * The number this draft WILL be given: `<n>.R.A.<client letters>.<NN>`, the
 * same two counters `issueInvoice` allocates — `n` within this series and
 * this year, `NN` that client's running index over every series. The `A` is
 * Andy and is fixed. A hint, not a promise: issuing another invoice first
 * moves both.
 */
export function nextNumberHint(invoices = [], client = null, { series = SERIES, year = new Date().getFullYear() } = {}) {
  const initials = String(client?.initials ?? '').trim();
  if (!initials) return null;
  const seq = invoices.reduce(
    (max, invoice) => ((invoice.series ?? SERIES) === series && Number(invoice.year) === Number(year)
      ? Math.max(max, Number(invoice.seq) || 0)
      : max),
    0,
  ) + 1;
  const mine = invoices.filter((invoice) => invoice.client_id === client.id && invoice.number).length + 1;
  return `${seq}.R.A.${initials}.${String(mine).padStart(2, '0')}`;
}

/* ---------- chasing an overdue invoice (audit B7, 14 Nov) ---------- */

const REMINDER_LOCALE = { FR: 'fr-BE', NL: 'nl-BE', EN: 'en-IE' };

/** Whole days between the due date and today (both YYYY-MM-DD). */
export function daysLate(dueOn, today = dayOf()) {
  if (!dueOn) return 0;
  return Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(dueOn).slice(0, 10)}T00:00:00Z`)) / 86400000));
}

/**
 * A short reminder Andy pastes into his own email. No link (the Gmail
 * connector rewrites them) and no send button: he sends it himself. Money and
 * dates in the language's own format.
 */
export function reminderText(invoice = {}, lang = 'FR') {
  const l = REMINDER_LOCALE[lang] ? lang : 'EN';
  const locale = REMINDER_LOCALE[l];
  // What is still due (asked for minus paid), never the total: after a part
  // payment the reminder names the balance (NIRMATA, 14 Nov).
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: invoice.currency || 'EUR' })
    .format(Number(invoice.due_cents ?? invoice.requested_cents ?? invoice.total_cents ?? 0) / 100);
  const day = (iso) => (iso
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${String(iso).slice(0, 10)}T00:00:00Z`))
    : '');
  const n = invoice.number || '';
  const issued = day(invoice.issued_on);
  const due = day(invoice.due_on);
  const text = {
    FR: `Bonjour,\n\nPetit rappel concernant la facture ${n} du ${issued}, d'un montant de ${money}, arrivée à échéance le ${due}.\n\nPourriez-vous me dire quand le paiement est prévu ? Si le paiement a déjà été effectué, merci, et ne tenez pas compte de ce message.\n\nBien à vous,\nAndy`,
    NL: `Beste,\n\nEen korte herinnering voor factuur ${n} van ${issued}, voor een bedrag van ${money}, vervallen op ${due}.\n\nKunt u me laten weten wanneer de betaling gepland is? Is de betaling al gebeurd, dan alvast bedankt en mag u dit bericht negeren.\n\nMet vriendelijke groet,\nAndy`,
    EN: `Hello,\n\nA quick reminder about invoice ${n} of ${issued}, for ${money}, which fell due on ${due}.\n\nCould you let me know when the payment is planned? If it has already gone out, thank you, and please ignore this message.\n\nKind regards,\nAndy`,
  };
  return text[l];
}

