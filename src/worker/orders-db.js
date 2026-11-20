/**
 * Orders — what a client is charged for on one project.
 *
 * A client can have several projects; each project can carry an order, and the
 * order's lines say what is charged and how often: `once` (a build, a
 * package), `monthly` (care, hosting), `daily` (a shoot day, an editing day)
 * or `hourly` (a session, a shift). The lines are the agreement; they are not
 * money owed.
 *
 * What is owed lives in `order_entries`: one row per charge that has actually
 * happened. A `once` line writes its entry when the line is added. A `monthly`
 * line's entries are brought up to date from the order's start whenever the
 * order is read — one per calendar month, at most once per line per month, so
 * reading the screen twice never charges twice. A `daily` or `hourly` line's
 * entries are logged by hand, as the days or hours are worked.
 *
 * Invoicing takes the entries that carry no invoice_id, groups them by line
 * into invoice lines, and stamps the invoice on them. That stamp is what stops
 * a month or a day being billed a second time.
 */
import { ValidationError, nowIso, hqToday, createInvoice, setInvoiceLines } from './db.js';

const KINDS = ['once', 'monthly', 'daily', 'hourly'];
// The kinds whose charges are logged by hand, as the work happens.
const LOGGED_KINDS = ['daily', 'hourly'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertId(id, field = 'id') {
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`${field} must be a positive integer`, field);
  return id;
}
function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${field} is required`, field);
  return value.trim();
}
function textOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  return value.trim() || null;
}
function assertDate(value, field) {
  const text = requireText(value, field);
  if (!DATE.test(text)) throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`, field);
  return text;
}
function dateOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return assertDate(value, field);
}
function assertKind(value) {
  if (!KINDS.includes(value)) throw new ValidationError(`kind must be one of ${KINDS.join(', ')}`, 'kind');
  return value;
}
function assertCents(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new ValidationError(`${field} must be a whole number of cents`, field);
  return value;
}
function assertQuantity(value, field = 'quantity') {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`${field} must be greater than zero`, field);
  // Half days and quarter hours are the smallest units anybody bills; two
  // decimals is generous.
  return Math.round(n * 100) / 100;
}

const ORDER_COLUMNS = [
  'id', 'client_id', 'slug', 'title', 'status', 'started_on', 'ended_on',
  'currency', 'notes', 'created_at', 'updated_at',
].join(', ');

const LINE_COLUMNS = 'id, order_id, kind, description, unit_cents, quantity, position, starts_on';
const ENTRY_COLUMNS = 'id, order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at';

/** The months an order has run, oldest first: from its start to today, or to
 *  the month it ended in. A month counts as soon as it has begun. */
export function monthsDue(startedOn, today, endedOn = null) {
  const start = String(startedOn).slice(0, 7);
  const last = [String(today).slice(0, 7), endedOn ? String(endedOn).slice(0, 7) : null]
    .filter(Boolean).sort()[0];
  const months = [];
  let [year, month] = start.split('-').map(Number);
  for (let guard = 0; guard < 600; guard += 1) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (period > last) break;
    months.push(period);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

export async function listOrders(db, { clientId = null, slug = null } = {}) {
  const where = [];
  const args = [];
  if (clientId !== null) { where.push('o.client_id = ?'); args.push(assertId(clientId, 'client_id')); }
  if (slug !== null) { where.push('o.slug = ?'); args.push(slug); }
  const { results } = await db.prepare(
    `SELECT ${ORDER_COLUMNS.split(', ').map((c) => `o.${c}`).join(', ')}, c.name AS client_name
     FROM orders o JOIN clients c ON c.id = o.client_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.started_on DESC, o.id DESC`,
  ).bind(...args).all();
  return results ?? [];
}

async function linesOf(db, id) {
  const { results } = await db.prepare(
    `SELECT ${LINE_COLUMNS} FROM order_lines WHERE order_id = ? ORDER BY position, id`,
  ).bind(id).all();
  return results ?? [];
}

async function entriesOf(db, id) {
  const { results } = await db.prepare(
    `SELECT ${ENTRY_COLUMNS} FROM order_entries WHERE order_id = ? ORDER BY happened_on DESC, id DESC`,
  ).bind(id).all();
  return results ?? [];
}

/** Every month that has begun and has no entry yet gets one, at the line's
 *  rate as it stands today. Returns how many were written. */
export async function accrueMonths(db, id, today = hqToday()) {
  const order = await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).bind(id).first();
  if (!order) return 0;
  const lines = (await linesOf(db, id)).filter((l) => l.kind === 'monthly');
  if (!lines.length) return 0;

  const months = monthsDue(order.started_on, today, order.ended_on);
  if (!months.length) return 0;

  const { results } = await db.prepare(
    'SELECT line_id, period FROM order_entries WHERE order_id = ? AND period IS NOT NULL',
  ).bind(id).all();
  const have = new Set((results ?? []).map((r) => `${r.line_id}:${r.period}`));

  const at = nowIso();
  const writes = [];
  for (const line of lines) {
    // A line starts with the order, or later on its own date (0029, audit B10):
    // never a month before either.
    const from = line.starts_on && line.starts_on > order.started_on ? line.starts_on : order.started_on;
    const own = from === order.started_on ? months : monthsDue(from, today, order.ended_on);
    for (const period of own) {
      if (have.has(`${line.id}:${period}`)) continue;
      writes.push(db.prepare(
        `INSERT INTO order_entries (order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at)
         VALUES (?, ?, 'monthly', ?, ?, 1, ?, ?, NULL, ?)`,
      ).bind(id, line.id, `${period}-01`, period, line.unit_cents, line.description, at));
    }
  }
  if (!writes.length) return 0;
  await db.batch(writes);
  return writes.length;
}

/** What the order says, what it has accrued, and what is waiting to be
 *  invoiced. Reading it brings the months up to date first. */
export async function getOrder(db, id, { today } = {}) {
  assertId(id);
  const exists = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
  if (!exists) return null;
  await accrueMonths(db, id, today);

  const order = await db.prepare(
    `SELECT ${ORDER_COLUMNS.split(', ').map((c) => `o.${c}`).join(', ')}, c.name AS client_name
     FROM orders o JOIN clients c ON c.id = o.client_id WHERE o.id = ?`,
  ).bind(id).first();
  const lines = await linesOf(db, id);
  const entries = await entriesOf(db, id);
  const prepayments = await prepaymentsOf(db, order);
  return { ...order, lines, entries, prepayments, totals: orderTotals(lines, entries, prepayments) };
}

/** The prepayment invoices this order's project is billed through. A website
 *  quoted at €1500 is asked for as a deposit and a balance on ONE prepayment
 *  invoice (and its part 2), never as order lines — a once-line would bill it
 *  a second time — so the order reads its figures from there instead of
 *  saying €0. Issued, not void, same client and project. */
async function prepaymentsOf(db, order) {
  if (!order.slug) return [];
  const { results } = await db.prepare(
    `SELECT i.id, i.number, i.total_cents,
            MIN(i.total_cents, COALESCE(i.request_cents, i.total_cents)
              + (SELECT COALESCE(SUM(ch.total_cents), 0) FROM invoices ch
                 WHERE ch.parent_id = i.id AND ch.number IS NOT NULL AND ch.status != 'void')) AS asked_cents,
            (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
              WHERE p.invoice_id = i.id
                 OR p.invoice_id IN (SELECT ch.id FROM invoices ch WHERE ch.parent_id = i.id AND ch.status != 'void')) AS paid_cents
     FROM invoices i
     WHERE i.client_id = ? AND i.slug = ? AND i.kind = 'prepayment' AND i.parent_id IS NULL
       AND i.number IS NOT NULL AND i.status != 'void'
     ORDER BY i.id ASC`,
  ).bind(order.client_id, order.slug).all();
  return results ?? [];
}

/** Money, three ways: the agreement's shape, what has accrued, what is owed
 *  but not yet on an invoice. */
export function orderTotals(lines, entries, prepayments = []) {
  const cents = (e) => Math.round(e.unit_cents * e.quantity);
  const accrued = entries.reduce((sum, e) => sum + cents(e), 0);
  const uninvoiced = entries.filter((e) => !e.invoice_id);
  return {
    monthly_cents: lines.filter((l) => l.kind === 'monthly').reduce((s, l) => s + l.unit_cents, 0),
    day_rate_cents: lines.filter((l) => l.kind === 'daily').reduce((s, l) => Math.max(s, l.unit_cents), 0),
    hour_rate_cents: lines.filter((l) => l.kind === 'hourly').reduce((s, l) => Math.max(s, l.unit_cents), 0),
    once_cents: lines.filter((l) => l.kind === 'once').reduce((s, l) => s + Math.round(l.unit_cents * l.quantity), 0),
    days_logged: entries.filter((e) => e.kind === 'daily').reduce((s, e) => s + e.quantity, 0),
    hours_logged: entries.filter((e) => e.kind === 'hourly').reduce((s, e) => s + e.quantity, 0),
    accrued_cents: accrued,
    uninvoiced_cents: uninvoiced.reduce((sum, e) => sum + cents(e), 0),
    uninvoiced_count: uninvoiced.length,
    prepaid_total_cents: prepayments.reduce((s, p) => s + p.total_cents, 0),
    prepaid_asked_cents: prepayments.reduce((s, p) => s + p.asked_cents, 0),
    prepaid_paid_cents: prepayments.reduce((s, p) => s + p.paid_cents, 0),
  };
}

export async function createOrder(db, input = {}) {
  const clientId = assertId(Number(input.client_id), 'client_id');
  const at = nowIso();
  return db.prepare(
    `INSERT INTO orders (client_id, slug, title, status, started_on, ended_on, currency, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
     RETURNING ${ORDER_COLUMNS}`,
  ).bind(
    clientId,
    textOrNull(input.slug, 'slug'),
    typeof input.title === 'string' ? input.title.trim() : '',
    input.started_on ? assertDate(input.started_on, 'started_on') : at.slice(0, 10),
    dateOrNull(input.ended_on, 'ended_on'),
    typeof input.currency === 'string' && input.currency ? input.currency : 'EUR',
    typeof input.notes === 'string' ? input.notes : '',
    at, at,
  ).first();
}

const ORDER_WRITABLE = ['slug', 'title', 'status', 'started_on', 'ended_on', 'notes'];

export async function updateOrder(db, id, patch = {}) {
  assertId(id);
  const sets = [];
  const args = [];
  for (const field of ORDER_WRITABLE) {
    if (patch[field] === undefined) continue;
    let value = patch[field];
    if (field === 'status') {
      if (!['active', 'ended'].includes(value)) throw new ValidationError('status must be active or ended', 'status');
    } else if (field === 'started_on') value = assertDate(value, field);
    else if (field === 'ended_on') value = dateOrNull(value, field);
    else if (field === 'slug') value = textOrNull(value, field);
    else value = typeof value === 'string' ? value : '';
    sets.push(`${field} = ?`);
    args.push(value);
  }
  if (!sets.length) return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).bind(id).first();
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  return db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? RETURNING ${ORDER_COLUMNS}`).bind(...args).first();
}

export async function deleteOrder(db, id) {
  assertId(id);
  const invoiced = await db.prepare(
    'SELECT COUNT(*) AS n FROM order_entries WHERE order_id = ? AND invoice_id IS NOT NULL',
  ).bind(id).first();
  if (Number(invoiced?.n ?? 0) > 0) {
    throw new ValidationError('this order has charges on an invoice already — end it instead of deleting it', 'id');
  }
  const row = await db.prepare('DELETE FROM orders WHERE id = ? RETURNING id').bind(id).first();
  return Boolean(row);
}

/** Add a line. A `once` line is a charge the moment it is agreed, so it writes
 *  its entry immediately; a monthly line waits for a month to begin, and a
 *  daily or hourly line waits for the work to be logged. */
export async function addOrderLine(db, id, input = {}, { today } = {}) {
  assertId(id);
  const order = await db.prepare('SELECT id, started_on FROM orders WHERE id = ?').bind(id).first();
  if (!order) return null;

  const kind = assertKind(input.kind);
  const description = requireText(input.description, 'description');
  const unitCents = assertCents(Number(input.unit_cents), 'unit_cents');
  const quantity = kind === 'once' ? assertQuantity(input.quantity ?? 1) : 1;
  // A monthly charge (a care plan) starts at go-live: the date given, else the
  // day it is added — never back at the order's start (audit B10).
  const startsOn = kind === 'monthly'
    ? (input.starts_on === undefined || input.starts_on === null || input.starts_on === '' ? (today ?? hqToday()) : assertDate(input.starts_on, 'starts_on'))
    : null;

  const next = await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM order_lines WHERE order_id = ?')
    .bind(id).first();
  const line = await db.prepare(
    `INSERT INTO order_lines (order_id, kind, description, unit_cents, quantity, position, starts_on)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${LINE_COLUMNS}`,
  ).bind(id, kind, description, unitCents, quantity, Number(next?.n ?? 0), startsOn).first();

  if (kind === 'once') {
    const at = nowIso();
    await db.prepare(
      `INSERT INTO order_entries (order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at)
       VALUES (?, ?, 'once', ?, NULL, ?, ?, ?, NULL, ?)`,
    ).bind(id, line.id, order.started_on, quantity, unitCents, description, at).run();
  }
  return line;
}

export async function removeOrderLine(db, id, lineId) {
  assertId(id);
  assertId(lineId, 'line_id');
  const invoiced = await db.prepare(
    'SELECT COUNT(*) AS n FROM order_entries WHERE line_id = ? AND invoice_id IS NOT NULL',
  ).bind(lineId).first();
  if (Number(invoiced?.n ?? 0) > 0) {
    throw new ValidationError('this line has charges on an invoice already', 'line_id');
  }
  const row = await db.prepare('DELETE FROM order_lines WHERE id = ? AND order_id = ? RETURNING id')
    .bind(lineId, id).first();
  return Boolean(row);
}

/** Work done against a line that is logged by hand: days against a `daily`
 *  line, hours against an `hourly` one. The line decides which — the caller
 *  never says — so an hour can never be written at a day rate. */
export async function logOrderWork(db, id, input = {}) {
  assertId(id);
  const lineId = assertId(Number(input.line_id), 'line_id');
  const line = await db.prepare(`SELECT ${LINE_COLUMNS} FROM order_lines WHERE id = ? AND order_id = ?`)
    .bind(lineId, id).first();
  if (!line) return null;
  if (!LOGGED_KINDS.includes(line.kind)) {
    throw new ValidationError('work is logged against a daily or an hourly line', 'line_id');
  }

  const happenedOn = input.happened_on ? assertDate(input.happened_on, 'happened_on') : hqToday();
  const quantity = assertQuantity(input.quantity ?? 1, 'quantity');
  const at = nowIso();
  return db.prepare(
    `INSERT INTO order_entries (order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?) RETURNING ${ENTRY_COLUMNS}`,
  ).bind(
    id, lineId, line.kind, happenedOn, quantity, line.unit_cents,
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : line.description,
    at,
  ).first();
}

/** Only a charge that has not been invoiced can be taken back. */
export async function removeOrderEntry(db, id, entryId) {
  assertId(id);
  assertId(entryId, 'entry_id');
  const entry = await db.prepare('SELECT id, invoice_id FROM order_entries WHERE id = ? AND order_id = ?')
    .bind(entryId, id).first();
  if (!entry) return false;
  if (entry.invoice_id) throw new ValidationError('this charge is on an invoice already', 'entry_id');
  await db.prepare('DELETE FROM order_entries WHERE id = ?').bind(entryId).run();
  return true;
}

/**
 * Everything accrued and not yet invoiced becomes one draft invoice: the
 * entries are grouped by line, so twelve logged days are one line reading
 * "Shoot day · 12 × €450", and each entry is stamped with the invoice so it
 * can never be billed again.
 */
export async function invoiceOrder(db, id, { subject, upto, today } = {}) {
  assertId(id);
  // Months are brought up to date first, so an invoice raised today includes
  // the month that has just begun rather than leaving it behind.
  const order = await getOrder(db, id, { today: today ?? upto });
  if (!order) return null;

  const cutoff = upto ? assertDate(upto, 'upto') : null;
  const pending = order.entries
    .filter((e) => !e.invoice_id)
    .filter((e) => (cutoff ? e.happened_on <= cutoff : true));
  if (!pending.length) throw new ValidationError('nothing has accrued that is not already invoiced', 'entries');

  const byLine = new Map();
  for (const entry of pending) {
    const key = `${entry.line_id}:${entry.unit_cents}`;
    const group = byLine.get(key) ?? { description: entry.description, unit_cents: entry.unit_cents, quantity: 0, kind: entry.kind, ids: [] };
    group.quantity += entry.quantity;
    group.ids.push(entry.id);
    byLine.set(key, group);
  }

  const period = (() => {
    const months = pending.filter((e) => e.period).map((e) => e.period).sort();
    if (!months.length) return null;
    return months[0] === months[months.length - 1] ? months[0] : `${months[0]} – ${months[months.length - 1]}`;
  })();

  const invoice = await createInvoice(db, {
    client_id: order.client_id,
    slug: order.slug ?? null,
    // An invoice of monthly charges only is named after them (« Care plan ·
    // 2026-11 »), not after the build the order was opened for (audit B10).
    subject: typeof subject === 'string' && subject.trim()
      ? subject.trim()
      : [
        pending.every((e) => e.kind === 'monthly')
          ? [...new Set(pending.map((e) => e.description))].join(' + ')
          : (order.title || 'Order'),
        period,
      ].filter(Boolean).join(' · '),
    currency: order.currency,
  });

  // Claim the charges before writing anything else (audit, 13 Nov): a second
  // click arriving now finds them taken and stops, instead of billing twice.
  const ids = pending.map((e) => e.id);
  const claims = await db.batch(ids.map((entryId) => db.prepare(
    'UPDATE order_entries SET invoice_id = ? WHERE id = ? AND invoice_id IS NULL',
  ).bind(invoice.id, entryId)));
  const claimed = claims.reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0);
  if (claimed !== ids.length) {
    // Someone else is invoicing these: hand back what was claimed and drop the
    // empty draft made a moment ago (no number, no lines).
    await db.batch([
      db.prepare('UPDATE order_entries SET invoice_id = NULL WHERE invoice_id = ?').bind(invoice.id),
      db.prepare('DELETE FROM invoices WHERE id = ? AND number IS NULL AND total_cents = 0').bind(invoice.id),
    ]);
    throw new ValidationError('these charges are already being invoiced', 'order');
  }

  const lines = [...byLine.values()].map((group) => ({
    description: group.kind === 'monthly' && period
      ? `${group.description} · ${period}`
      : (group.kind === 'hourly' ? `${group.description} (per hour)` : group.description),
    quantity: Math.round(group.quantity * 100) / 100,
    unit_cents: group.unit_cents,
  }));
  const withLines = await setInvoiceLines(db, invoice.id, lines);

  return { invoice: withLines ?? invoice, entries: ids.length };
}
