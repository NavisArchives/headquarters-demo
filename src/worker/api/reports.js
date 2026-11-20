// What the agency's numbers say (audit E18; F4, F9, F10; 14 Nov). Read-only.
//
//   GET /api/reports/funnel?by=dataset|batch|template
//       per group: sent → opened → replied → in talks → won (leads, not emails)
//   GET /api/reports/pipeline
//       open deals by stage, with their value where one is set, and won
//   GET /api/reports/money?year=YYYY
//       per month and per currency: invoiced (by issue date) and received
//       (payments, by the day they arrived), never added across currencies
import { hqToday } from '../db.js';

const OPENS_READ_MAX = 900; // KV reads per request stay well under the Worker's limit
const BY = { dataset: 'l.dataset', batch: "COALESCE(e.batch, '(no batch)')", template: "COALESCE(e.template, '(no template)')" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Leads that were sent at least one email, grouped; each stage counted once per lead. */
export async function funnel(db, { by = 'dataset', opens = null } = {}) {
  const key = BY[by];
  if (!key) throw Object.assign(new Error(`by must be one of ${Object.keys(BY).join(', ')}`), { status: 400 });
  const { results } = await db.prepare(
    `SELECT DISTINCT ${key} AS grp, l.uid AS uid, COALESCE(s.stage, 'new') AS stage, s.last_reply_at AS last_reply_at
     FROM lead_events e JOIN leads l ON l.uid = e.uid LEFT JOIN lead_state s ON s.uid = l.uid
     WHERE e.kind = 'sent' AND l.dataset <> 'travel-volunteer-stays'`,
  ).all();
  const rows = results ?? [];
  // Opens live in KV (the pixel and Brevo): read once per lead, at most OPENS_READ_MAX.
  const uids = [...new Set(rows.map((r) => r.uid))];
  const opened = new Set();
  let opensRead = 0;
  if (opens) {
    const slice = uids.slice(0, OPENS_READ_MAX);
    const lists = await Promise.all(slice.map((uid) => opens.get(`opens:${uid}`, 'json').catch(() => null)));
    slice.forEach((uid, i) => { if (Array.isArray(lists[i]) && lists[i].length) opened.add(uid); });
    opensRead = slice.length;
  }
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.grp) ?? { key: r.grp, sent: 0, opened: 0, replied: 0, talks: 0, won: 0 };
    g.sent += 1;
    if (opened.has(r.uid)) g.opened += 1;
    if (r.last_reply_at || ['replied', 'talks', 'won'].includes(r.stage)) g.replied += 1;
    if (['talks', 'won'].includes(r.stage)) g.talks += 1;
    if (r.stage === 'won') g.won += 1;
    groups.set(r.grp, g);
  }
  const list = [...groups.values()].sort((a, b) => b.sent - a.sent || String(a.key).localeCompare(String(b.key)));
  return {
    by,
    groups: list,
    opens: { read: opensRead, of: uids.length, complete: !opens || opensRead === uids.length },
  };
}

/** Open deals by stage, with what they are worth where a value is set. */
export async function pipelineValue(db) {
  const { results } = await db.prepare(
    `SELECT stage, COUNT(*) AS deals, COUNT(value_cents) AS valued, COALESCE(SUM(value_cents), 0) AS value_cents
     FROM prospects WHERE client_id IS NULL AND stage NOT IN ('won', 'lost') GROUP BY stage`,
  ).all();
  // Every won deal: a deal has no « won on » date to filter a year by.
  const won = await db.prepare(
    `SELECT COUNT(*) AS deals, COUNT(value_cents) AS valued, COALESCE(SUM(value_cents), 0) AS value_cents
     FROM prospects WHERE stage = 'won'`,
  ).first();
  const open = results ?? [];
  return {
    open,
    open_total: open.reduce((t, r) => ({ deals: t.deals + r.deals, valued: t.valued + r.valued, value_cents: t.value_cents + r.value_cents }), { deals: 0, valued: 0, value_cents: 0 }),
    won: won ?? { deals: 0, valued: 0, value_cents: 0 },
  };
}

/** Per month and currency: invoiced (issue date) and received (payment date). */
export async function moneyByMonth(db, year) {
  if (!/^\d{4}$/.test(String(year))) throw Object.assign(new Error('year must be YYYY'), { status: 400 });
  const [{ results: invoiced }, { results: received }] = await Promise.all([
    db.prepare(
      `SELECT substr(issued_on, 1, 7) AS month, currency, COALESCE(SUM(total_cents), 0) AS cents, COUNT(*) AS invoices
       FROM invoices WHERE issued_on IS NOT NULL AND status != 'void' AND substr(issued_on, 1, 4) = ?
       GROUP BY month, currency`,
    ).bind(String(year)).all(),
    db.prepare(
      `SELECT substr(p.paid_on, 1, 7) AS month, i.currency AS currency, COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(*) AS payments
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.status != 'void' AND substr(p.paid_on, 1, 4) = ?
       GROUP BY month, i.currency`,
    ).bind(String(year)).all(),
  ]);
  const rows = new Map();
  const at = (month, currency) => {
    const k = `${month}|${currency}`;
    if (!rows.has(k)) rows.set(k, { month, currency, invoiced_cents: 0, invoices: 0, received_cents: 0, payments: 0 });
    return rows.get(k);
  };
  for (const r of invoiced ?? []) Object.assign(at(r.month, r.currency), { invoiced_cents: r.cents, invoices: r.invoices });
  for (const r of received ?? []) Object.assign(at(r.month, r.currency), { received_cents: r.cents, payments: r.payments });
  const months = [...rows.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
  const totals = {};
  for (const m of months) {
    const t = totals[m.currency] ?? { invoiced_cents: 0, received_cents: 0 };
    t.invoiced_cents += m.invoiced_cents;
    t.received_cents += m.received_cents;
    totals[m.currency] = t;
  }
  return { year: String(year), months, totals };
}

export async function handleReports(request, env, url) {
  if (!url.pathname.startsWith('/api/reports/')) return null;
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  try {
    if (url.pathname === '/api/reports/funnel') return json(await funnel(env.DB, { by: url.searchParams.get('by') || 'dataset', opens: env.OPENS ?? null }));
    if (url.pathname === '/api/reports/pipeline') return json(await pipelineValue(env.DB));
    if (url.pathname === '/api/reports/money') return json(await moneyByMonth(env.DB, url.searchParams.get('year') || hqToday().slice(0, 4)));
    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error.status === 400) return json({ error: error.message }, 400);
    throw error;
  }
}
