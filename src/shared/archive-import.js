// The invoice archive (2023–2026): validation, summary and the SQL that
// imports it. Pure functions — no database, no network — so the same code is
// what the CLI (scripts/import-archive.mjs) runs, what the tests run, and what
// produced data/archive/import-archive.sql.
//
// The SQL is IDEMPOTENT and ADDITIVE, because it is meant for HQ's live
// database (localhost:8787 and `wrangler d1 --remote` are the same D1):
//   · every INSERT is `INSERT ... SELECT ... WHERE NOT EXISTS (...)` on a
//     natural key — an invoice by its number, a line by (invoice, position),
//     a payment by (invoice, date, amount, reference), a client by its
//     archive key / slug / VAT number / name, an expense by its ref;
//   · an invoice whose number is already in HQ (5.R.A.L.01, or anything Andy
//     typed in by hand) is skipped, and so are its lines and payments;
//   · the only UPDATE adds the KBC account to settings.bank_accounts, and only
//     when no account with id 'kbc' is there yet.
// Running it twice changes nothing the second time.

export const ARCHIVE_SERIES = 'archive';
const VAT = ['standard', 'reverse_charge', 'exempt_small', 'export'];
const BANKS = ['kbc', 'wise', 'bog'];
const BANK_METHOD = { kbc: 'KBC', wise: 'Wise', bog: 'Second Bank' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
const cents = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000_000_000;
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** "NL 8503.97.820.B01" -> "NL850397820B01": how two VAT numbers are compared. */
export function normaliseVat(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The year an invoice belongs to: its own `year`, else its invoice date. */
export function archiveYear(invoice) {
  if (Number.isInteger(invoice?.year)) return invoice.year;
  return invoice?.issued_on ? Number(String(invoice.issued_on).slice(0, 4)) : null;
}

const paidOf = (invoice) => (invoice.payments ?? []).reduce((sum, p) => sum + (p.amount_cents ?? 0), 0);

/**
 * Checks the archive file. `problems` stop the import; `warnings` are facts
 * Andy should see (a printed discrepancy, a payment not proven) but that the
 * file records on purpose.
 */
export function validateArchive(data) {
  const problems = [];
  const warnings = [];
  const p = (where, message) => problems.push(`${where}: ${message}`);
  const w = (where, message) => warnings.push(`${where}: ${message}`);

  if (!data || typeof data !== 'object') return { problems: ['the file is not a JSON object'], warnings };
  if (data.version !== 1) p('file', 'version must be 1');
  const entities = data.entities ?? {};
  if (!text(entities.be) || !text(entities.ge)) p('file', 'entities.be and entities.ge are required');

  const clients = new Map();
  for (const [i, c] of (data.clients ?? []).entries()) {
    const where = `client ${c?.key ?? `#${i}`}`;
    if (!/^[a-z0-9-]{2,30}$/.test(c?.key ?? '')) { p(where, 'key must be 2-30 lowercase letters, digits or dashes'); continue; }
    if (clients.has(c.key)) p(where, 'key used twice');
    if (!text(c.name)) p(where, 'name is required');
    if (!/^[A-Z]{2}$/.test(c.country ?? '')) p(where, 'country must be a 2-letter code');
    if (!text(c.source)) p(where, 'source is required');
    clients.set(c.key, c);
  }

  const excluded = new Set((data.excluded ?? []).map((e) => e.number));
  const numbers = new Set();
  for (const [i, inv] of (data.invoices ?? []).entries()) {
    const where = `invoice ${inv?.number ?? `#${i}`}`;
    if (!text(inv?.number) || inv.number.length > 60) { p(where, 'number is required (as printed, at most 60 characters)'); continue; }
    if (numbers.has(inv.number)) p(where, 'number appears twice - a corrected re-send counts once');
    numbers.add(inv.number);
    if (excluded.has(inv.number)) p(where, 'this number is listed as excluded (already in HQ)');
    if (!entities[inv.entity]) p(where, `entity must be one of ${Object.keys(entities).join(', ')}`);
    if (!clients.has(inv.client)) p(where, `no client "${inv.client}"`);
    if (!Number.isInteger(inv.year) || inv.year < 2020 || inv.year > 2030) p(where, 'year must be a whole year');
    for (const field of ['issued_on', 'due_on', 'sent_on']) {
      if (inv[field] != null && !realDate(inv[field])) p(where, `${field} must be a real YYYY-MM-DD date or null`);
    }
    if (inv.issued_on && realDate(inv.issued_on) && Number(inv.issued_on.slice(0, 4)) !== inv.year) {
      p(where, `year ${inv.year} does not match the invoice date ${inv.issued_on}`);
    }
    if (!inv.issued_on) w(where, 'no invoice date (filed under its year only)');
    if (!VAT.includes(inv.vat_treatment)) p(where, `vat_treatment must be one of ${VAT.join(', ')}`);
    if (!BANKS.includes(inv.bank_account)) p(where, `bank_account must be one of ${BANKS.join(', ')}`);
    if (!cents(inv.total_cents) || inv.total_cents <= 0) p(where, 'total_cents must be a positive whole number of cents');
    if (!text(inv.source)) p(where, 'source is required');
    if (!text(inv.subject)) p(where, 'subject is required');

    const lines = inv.lines ?? [];
    if (!lines.length) p(where, 'at least one line is required');
    let linesSum = 0;
    for (const [j, line] of lines.entries()) {
      const lw = `${where} line ${j + 1}`;
      if (!text(line.description)) p(lw, 'description is required');
      if (typeof line.quantity !== 'number' || line.quantity < 0) p(lw, 'quantity must be a number, 0 or more');
      if (!cents(line.unit_cents)) p(lw, 'unit_cents must be whole cents');
      if (!cents(line.amount_cents)) p(lw, 'amount_cents must be whole cents');
      linesSum += line.amount_cents ?? 0;
      if (cents(line.unit_cents) && cents(line.amount_cents)
        && Math.round(line.quantity * line.unit_cents) !== line.amount_cents && !line.no_charge) {
        w(lw, `printed amount ${line.amount_cents} is not quantity x rate (${line.quantity} x ${line.unit_cents})`);
      }
    }
    if (lines.length && cents(inv.total_cents) && linesSum !== inv.total_cents) {
      if (text(inv.discrepancy)) w(where, `lines add to ${linesSum}, total is ${inv.total_cents} - ${inv.discrepancy}`);
      else p(where, `lines add to ${linesSum} but total_cents is ${inv.total_cents}; explain it in "discrepancy" or fix it`);
    }

    let paid = 0;
    const seen = new Set();
    for (const [j, pay] of (inv.payments ?? []).entries()) {
      const pw = `${where} payment ${j + 1}`;
      if (!realDate(pay.paid_on)) p(pw, 'paid_on must be a real date');
      if (!cents(pay.amount_cents) || pay.amount_cents <= 0) p(pw, 'amount_cents must be positive whole cents');
      if (pay.bank_account !== null && !BANKS.includes(pay.bank_account)) p(pw, `bank_account must be one of ${BANKS.join(', ')} or null`);
      if (pay.bank_account === null && !text(pay.label)) p(pw, 'a payment with no proven account needs a label saying so');
      if (!text(pay.source)) p(pw, 'source is required');
      const key = `${pay.paid_on}|${pay.amount_cents}|${pay.reference ?? ''}`;
      if (seen.has(key)) p(pw, 'the same payment is listed twice');
      seen.add(key);
      if (pay.paid_on && inv.issued_on && pay.paid_on < inv.issued_on && !pay.label) {
        w(pw, `paid ${pay.paid_on}, before the invoice date ${inv.issued_on}`);
      }
      paid += pay.amount_cents ?? 0;
    }
    if (paid > inv.total_cents) p(where, `payments (${paid}) exceed the total (${inv.total_cents})`);
    else if (paid < inv.total_cents) w(where, `payment not proven for ${inv.total_cents - paid} cents (no bank record found)`);
    for (const flag of inv.flags ?? []) w(where, flag);
  }

  const refs = new Set();
  for (const [i, e] of (data.expenses ?? []).entries()) {
    const where = `expense ${e?.ref ?? `#${i}`}`;
    if (!text(e?.ref)) { p(where, 'ref is required'); continue; }
    if (refs.has(e.ref)) p(where, 'ref used twice');
    refs.add(e.ref);
    if (!realDate(e.spent_on)) p(where, 'spent_on must be a real date');
    if (!text(e.vendor)) p(where, 'vendor is required');
    if (!cents(e.amount_cents)) p(where, 'amount_cents must be whole cents');
    if (!text(e.source)) p(where, 'source is required');
    if (e.flag) w(where, e.flag);
  }

  // The figures Andy already gave the accountant must come out of this file.
  const summary = summarizeArchive(data);
  for (const [year, expected] of Object.entries(data.expected_totals ?? {})) {
    const got = summary.years.find((y) => String(y.year) === year)?.invoiced_cents ?? 0;
    if (got !== expected.invoiced_cents) p(`total ${year}`, `invoiced ${got} cents, expected ${expected.invoiced_cents}`);
  }

  return { problems, warnings };
}

/** Per year and per client (within each year): how many, invoiced, paid and
 *  not proven, plus each year's expenses. */
export function summarizeArchive(data) {
  const clientName = new Map((data?.clients ?? []).map((c) => [c.key, c.name]));
  const years = new Map();
  for (const inv of data?.invoices ?? []) {
    const year = archiveYear(inv);
    if (!years.has(year)) {
      years.set(year, {
        year, count: 0, invoiced_cents: 0, paid_cents: 0, unproven_cents: 0, expenses_cents: 0, clients: new Map(),
      });
    }
    const y = years.get(year);
    const paid = Math.min(paidOf(inv), inv.total_cents ?? 0);
    y.count += 1;
    y.invoiced_cents += inv.total_cents ?? 0;
    y.paid_cents += paid;
    y.unproven_cents += (inv.total_cents ?? 0) - paid;
    const name = clientName.get(inv.client) ?? inv.client;
    if (!y.clients.has(name)) y.clients.set(name, { name, count: 0, invoiced_cents: 0, paid_cents: 0, unproven_cents: 0 });
    const c = y.clients.get(name);
    c.count += 1;
    c.invoiced_cents += inv.total_cents ?? 0;
    c.paid_cents += paid;
    c.unproven_cents += (inv.total_cents ?? 0) - paid;
  }
  for (const e of data?.expenses ?? []) {
    const year = Number(String(e.spent_on).slice(0, 4));
    if (!years.has(year)) {
      years.set(year, {
        year, count: 0, invoiced_cents: 0, paid_cents: 0, unproven_cents: 0, expenses_cents: 0, clients: new Map(),
      });
    }
    years.get(year).expenses_cents += e.amount_cents ?? 0;
  }
  return {
    years: [...years.values()]
      .sort((a, b) => b.year - a.year)
      .map((y) => ({ ...y, clients: [...y.clients.values()].sort((a, b) => b.invoiced_cents - a.invoiced_cents) })),
  };
}

/* ------------------------------------------------------------------ SQL --- */

/** A SQL literal. Strings are single-quoted with quotes doubled; nothing in
 *  this file is ever interpolated any other way. */
export function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** How a client is recognised in a database that may already hold it: the
 *  archive's own key first, then the project slug, the VAT number, the name. */
export function clientMatchSql(client, alias = 'clients') {
  const terms = [`${alias}.archive_key = ${lit(client.key)}`];
  if (client.slug) terms.push(`${alias}.slug = ${lit(client.slug)}`);
  if (client.vat_number && client.match_vat !== false) {
    terms.push(`upper(replace(replace(replace(replace(COALESCE(${alias}.vat_number, ''), ' ', ''), '.', ''), '-', ''), '/', '')) = ${lit(normaliseVat(client.vat_number))}`);
  }
  terms.push(`lower(trim(${alias}.name)) = lower(${lit(client.name.trim())})`);
  return `(${terms.join(' OR ')})`;
}

function clientIdSql(client) {
  return `(SELECT c.id FROM clients c WHERE ${clientMatchSql(client, 'c')} ORDER BY (c.archive_key = ${lit(client.key)}) DESC, c.id ASC LIMIT 1)`;
}

const invoiceIdSql = (number) => `(SELECT id FROM invoices WHERE number = ${lit(number)} AND series = ${lit(ARCHIVE_SERIES)})`;

function invoiceNotes(inv) {
  const parts = [];
  if (inv.notes) parts.push(inv.notes);
  if (inv.discrepancy) parts.push(`Discrepancy: ${inv.discrepancy}`);
  for (const flag of inv.flags ?? []) parts.push(`Check: ${flag}`);
  return parts.join('\n');
}

/** The date an archive invoice was settled: the last payment, once the
 *  payments cover the total; NULL otherwise (the same rule db.js applies). */
export function settledOn(inv) {
  const pays = inv.payments ?? [];
  if (!pays.length || paidOf(inv) < inv.total_cents) return null;
  return pays.map((p) => p.paid_on).sort().at(-1);
}

/** The KBC account, as settings.bank_accounts stores an account. */
function kbcAccount(data) {
  const k = data.bank_accounts?.kbc ?? {};
  return {
    id: 'kbc', label: k.label ?? 'KBC Business PRO (closed)', payment_name: k.payment_name ?? '',
    iban: k.iban ?? '', bic: k.bic ?? '', closed: true,
  };
}

/** Every statement of the import, in order. `at` is the created_at stamp. */
export function buildImportStatements(data, { at, defaultAccounts = [] } = {}) {
  const stamp = at ?? `${data.compiled_on ?? '2026-10-22'}T12:00:00.000Z`;
  const out = [];

  // settings.bank_accounts: add KBC if it is missing. If the setting has never
  // been written (getBankAccounts seeds it on first read), seed it with the
  // usual accounts plus KBC, so the first read does not drop KBC again.
  const kbc = JSON.stringify(kbcAccount(data));
  out.push(`INSERT INTO settings (key, value, updated_at) SELECT 'bank_accounts', ${lit(JSON.stringify([...defaultAccounts, kbcAccount(data)]))}, ${lit(stamp)} WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'bank_accounts');`);
  out.push(`UPDATE settings SET value = json_insert(value, '$[#]', json(${lit(kbc)})), updated_at = ${lit(stamp)} WHERE key = 'bank_accounts' AND json_valid(value) AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) j WHERE json_extract(j.value, '$.id') = 'kbc');`);

  const clients = new Map((data.clients ?? []).map((c) => [c.key, c]));
  const used = new Set((data.invoices ?? []).map((i) => i.client));
  for (const c of data.clients ?? []) {
    if (!used.has(c.key)) continue;
    out.push(`INSERT INTO clients (name, initials, slug, email, address, country, vat_number, company_reg, notes, archive_key, created_at) SELECT ${[
      c.name, null, c.slug ?? null, c.email ?? null, c.address ?? null, c.country, c.vat_number ?? null,
      c.company_reg ?? null, c.notes ?? '', c.key, stamp,
    ].map(lit).join(', ')} WHERE NOT EXISTS (SELECT 1 FROM clients WHERE ${clientMatchSql(c)});`);
  }

  for (const inv of data.invoices ?? []) {
    const client = clients.get(inv.client);
    const entity = data.entities[inv.entity];
    out.push(`INSERT INTO invoices (number, seq, year, client_id, slug, subject, po_number, status, issued_on, due_on, sent_on, paid_on, currency, vat_treatment, subtotal_cents, vat_cents, total_cents, kind, request_cents, parent_id, notes, bank_account, series, billed_to, issuer_entity, source, created_at, updated_at) SELECT ${[
      inv.number, null, inv.year,
    ].map(lit).join(', ')}, ${clientIdSql(client)}, ${[
      client.slug ?? null, inv.subject, inv.po_number ?? null, 'issued', inv.issued_on ?? null, inv.due_on ?? null,
      inv.sent_on ?? null, settledOn(inv), 'EUR', inv.vat_treatment, inv.total_cents, 0, inv.total_cents,
      'invoice', null, null, invoiceNotes(inv), inv.bank_account, ARCHIVE_SERIES, inv.billed_to ?? null, entity,
      inv.source, stamp, stamp,
    ].map(lit).join(', ')} WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE number = ${lit(inv.number)});`);

    for (const [position, line] of (inv.lines ?? []).entries()) {
      out.push(`INSERT INTO invoice_lines (invoice_id, description, quantity, unit_cents, amount_cents, no_charge, position) SELECT ${invoiceIdSql(inv.number)}, ${[
        line.description, line.quantity, line.unit_cents, line.amount_cents, line.no_charge ? 1 : 0, position,
      ].map(lit).join(', ')} WHERE ${invoiceIdSql(inv.number)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = ${invoiceIdSql(inv.number)} AND position = ${position});`);
    }

    for (const pay of inv.payments ?? []) {
      const label = pay.label ?? (pay.payer ? `Paid by ${pay.payer}` : '');
      const method = BANK_METHOD[pay.bank_account] ?? null;
      out.push(`INSERT INTO payments (invoice_id, amount_cents, paid_on, label, method, bank_account, reference, source, created_at) SELECT ${invoiceIdSql(inv.number)}, ${[
        pay.amount_cents, pay.paid_on, label, method, pay.bank_account, pay.reference ?? null, pay.source, stamp,
      ].map(lit).join(', ')} WHERE ${invoiceIdSql(inv.number)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments WHERE invoice_id = ${invoiceIdSql(inv.number)} AND paid_on = ${lit(pay.paid_on)} AND amount_cents = ${pay.amount_cents} AND COALESCE(reference, '') = ${lit(pay.reference ?? '')});`);
    }
  }

  for (const e of data.expenses ?? []) {
    out.push(`INSERT INTO expenses (ref, spent_on, year, vendor, description, order_ref, amount_cents, currency, original_amount_cents, original_currency, paid_with, flag, notes, source, created_at) SELECT ${[
      e.ref, e.spent_on, Number(e.spent_on.slice(0, 4)), e.vendor, e.description ?? '', e.order_ref ?? null,
      e.amount_cents, 'EUR', e.original_amount_cents ?? null, e.original_currency ?? null, e.paid_with ?? null,
      e.flag ?? null, e.notes ?? '', e.source, stamp,
    ].map(lit).join(', ')} WHERE NOT EXISTS (SELECT 1 FROM expenses WHERE ref = ${lit(e.ref)});`);
  }
  return out;
}

/** The read-only look at a database before the write: which archive numbers
 *  are already there (they will be skipped), which clients will be matched
 *  rather than created, and whether migration 0019 has been applied. */
export function buildPrecheckStatements(data) {
  const numbers = (data.invoices ?? []).map((i) => lit(i.number)).join(', ');
  const used = new Set((data.invoices ?? []).map((i) => i.client));
  // One SELECT with a CASE, not a UNION per client: D1 caps compound SELECTs.
  const cases = (data.clients ?? []).filter((c) => used.has(c.key))
    .map((c) => `WHEN ${clientMatchSql(c)} THEN ${lit(c.key)}`).join(' ');
  const clientRows = `SELECT archive_client, id, name FROM (SELECT CASE ${cases} END AS archive_client, id, name FROM clients) WHERE archive_client IS NOT NULL ORDER BY id`;
  return [
    "SELECT name AS migration_0019_applied FROM sqlite_master WHERE type = 'table' AND name = 'expenses';",
    `SELECT number AS already_in_hq_will_be_skipped, series FROM invoices WHERE number IN (${numbers});`,
    `${clientRows};`,
    "SELECT value AS bank_accounts FROM settings WHERE key = 'bank_accounts';",
  ];
}

export function toSqlFile(statements, header) {
  return `${header.map((line) => `-- ${line}`).join('\n')}\n\n${statements.join('\n')}\n`;
}
