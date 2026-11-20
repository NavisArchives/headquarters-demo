// The morning briefing (Andy, 22 Oct: « when I open the HQ at 8 a.m. I want a
// good morning … my latest findings … the leads, the Travel leads, my important
// emails, the changes on Victor-Alexis, with quick links to everything »).
//
// Two sources, one list of findings:
// - live, from the database on every read: the pipeline (open deals, and the
//   ones and the warm leads that need Andy), the leads (new since yesterday,
//   Hot and Warm per list, the top 5 hot) and the Travel list list;
// - pushed, once a morning: a JSON briefing (emails, commits, reports…) that a
//   scheduled session builds and sends with scripts/briefing-push.mjs. It is
//   kept in settings.morning_briefing, checked here before it is stored.
//
// Behind authenticate(): only Andy reads or writes it.

import { getSetting, setSetting, nowIso, listInvoices, listMissions, hqToday } from './db.js';
import { isReadLimit, readLimitResponse } from './d1-limit.js';

export const BRIEFING_KEY = 'morning_briefing';
export const TRAVEL_DATASET = 'travel-volunteer-stays';
const TYPES = ['leads', 'travel', 'emails', 'commits', 'reports', 'note'];
// Today (the money) first; the Travel list list is personal and never in the work briefing (audit C12).
const ORDER = ['today', 'pipeline', 'leads', 'emails', 'commits', 'reports', 'note'];

const str = (value, max, field) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text of at most ${max} characters`);
  return value.trim();
};

/** A link a finding may carry: inside HQ (/…), the web, Gmail, the Mac's own servers, or a file path to show. */
function cleanHref(value, field) {
  const href = str(value, 600, field);
  if (!href) return '';
  if (/^\/(?!\/)/.test(href) || /^https:\/\/[^\s"'<>]+$/i.test(href) || /^http:\/\/localhost:\d{2,5}(\/[^\s"'<>]*)?$/i.test(href)) return href;
  throw new Error(`${field} must be an HQ path, an https link or a localhost address`);
}

/** The pushed briefing, checked: throws a message naming what is wrong. */
export function cleanBriefing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the briefing must be a JSON object');
  const date = str(raw.date, 10, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const findings = Array.isArray(raw.findings) ? raw.findings : null;
  if (!findings) throw new Error('findings must be a list');
  if (findings.length > 12) throw new Error('at most 12 findings');
  const ids = new Set();
  return {
    date,
    generated_at: str(raw.generated_at, 40, 'generated_at') || nowIso(),
    findings: findings.map((f, i) => {
      const where = `findings[${i}]`;
      if (!f || typeof f !== 'object') throw new Error(`${where} must be an object`);
      const id = str(f.id, 40, `${where}.id`);
      if (!/^[a-z0-9-]{1,40}$/.test(id) || ids.has(id)) throw new Error(`${where}.id must be unique, a-z 0-9 -`);
      ids.add(id);
      const type = str(f.type, 20, `${where}.type`);
      if (!TYPES.includes(type)) throw new Error(`${where}.type must be one of ${TYPES.join(', ')}`);
      const title = str(f.title, 80, `${where}.title`);
      if (!title) throw new Error(`${where}.title is required`);
      const items = Array.isArray(f.items) ? f.items : [];
      if (items.length > 20) throw new Error(`${where}: at most 20 items`);
      const counts = f.counts && typeof f.counts === 'object' && !Array.isArray(f.counts) ? f.counts : {};
      if (Object.keys(counts).length > 8 || Object.entries(counts).some(([k, v]) => k.length > 40 || !Number.isFinite(v))) {
        throw new Error(`${where}.counts: at most 8 numbers with short names`);
      }
      return {
        id, type, title,
        summary: str(f.summary, 300, `${where}.summary`),
        counts,
        items: items.map((item, j) => {
          const at = `${where}.items[${j}]`;
          if (!item || typeof item !== 'object') throw new Error(`${at} must be an object`);
          const label = str(item.label, 160, `${at}.label`);
          if (!label) throw new Error(`${at}.label is required`);
          return { label, detail: str(item.detail, 300, `${at}.detail`), href: cleanHref(item.href, `${at}.href`), meta: str(item.meta, 80, `${at}.meta`) };
        }),
      };
    }),
  };
}

/** Yesterday at this hour: what "new since yesterday" means. */
const since = (now) => new Date(now - 86400000).toISOString();

/** The leads, live: new since yesterday, Hot / Warm per list, the top 5 hot. Travel is its own card. */
export async function leadsFinding(db, now = Date.now()) {
  // Both reads at once: one round trip's wait (3 Nov).
  const [{ results: lists }, { results: top }] = await Promise.all([db.prepare(
    `SELECT d.key, d.title, COUNT(l.uid) AS total,
            SUM(CASE WHEN l.tier = 'Hot' THEN 1 ELSE 0 END) AS hot,
            SUM(CASE WHEN l.tier = 'Warm' THEN 1 ELSE 0 END) AS warm,
            SUM(CASE WHEN l.imported_at >= ? THEN 1 ELSE 0 END) AS fresh
     FROM datasets d JOIN leads l ON l.dataset = d.key
     WHERE d.key <> ? GROUP BY d.key ORDER BY hot DESC, total DESC`,
  ).bind(since(now), TRAVEL_DATASET).all(), db.prepare(
    `SELECT l.uid, l.name, l.city, l.score, d.title AS list FROM leads l JOIN datasets d ON d.key = l.dataset
     WHERE l.tier = 'Hot' AND l.dataset <> ? ORDER BY l.imported_at >= ? DESC, l.score DESC LIMIT 5`,
  ).bind(TRAVEL_DATASET, since(now)).all()]);
  if (!lists?.length) return null;
  const sum = (k) => lists.reduce((n, x) => n + (x[k] ?? 0), 0);
  return {
    id: 'leads', type: 'leads', title: 'Leads', live: true,
    summary: `${sum('fresh')} new since yesterday · ${sum('hot')} hot · ${sum('warm')} warm, across ${lists.length} lists`,
    counts: { new: sum('fresh'), hot: sum('hot'), warm: sum('warm'), total: sum('total') },
    lists: lists.map((x) => ({ key: x.key, title: x.title, hot: x.hot ?? 0, warm: x.warm ?? 0, fresh: x.fresh ?? 0, total: x.total })),
    items: (top ?? []).map((x) => ({ label: x.name, detail: [x.list, x.city].filter(Boolean).join(' · '), meta: `score ${x.score}`, href: `/leads?lead=${encodeURIComponent(x.uid)}` })),
  };
}

/** The Travel list list, live: what is new or changed since yesterday, and the best picks. */
export async function peruFinding(db, now = Date.now()) {
  const [counts, { results: picks }] = await Promise.all([db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN imported_at >= ? THEN 1 ELSE 0 END) AS fresh,
            SUM(CASE WHEN tier = 'Hot' THEN 1 ELSE 0 END) AS hot
     FROM leads WHERE dataset = ?`,
  ).bind(since(now), TRAVEL_DATASET).first(), db.prepare(
    `SELECT uid, name, city, region, score FROM leads WHERE dataset = ?
     ORDER BY imported_at >= ? DESC, score DESC LIMIT 5`,
  ).bind(TRAVEL_DATASET, since(now)).all()]);
  if (!counts?.total) return null;
  return {
    id: 'travel', type: 'travel', title: 'Travel list', live: true,
    summary: `${counts.fresh ?? 0} new or updated since yesterday · ${counts.total} stays on the list`,
    counts: { new: counts.fresh ?? 0, hot: counts.hot ?? 0, total: counts.total },
    href: '/leads?business=Travel%20trip',
    items: (picks ?? []).map((x) => ({ label: x.name, detail: [x.city, x.region].filter(Boolean).join(' · '), meta: `score ${x.score}`, href: `/leads?lead=${encodeURIComponent(x.uid)}` })),
  };
}

const DAY = 86400000;
const daysSince = (iso, now) => Math.floor((now - Date.parse(iso)) / DAY);

/**
 * The pipeline, live (A4, NIRMATA's review of 29 Oct): open deals, and what
 * needs Andy, most urgent first. A deal gets one reason:
 *   a proposal out with nothing moving for 5+ days → chase it;
 *   no next step date → give it one;
 *   untouched for 7+ days → look at it.
 * A lead that replied or is in talks, with no deal and quiet for 7+ days, is
 * listed too: that is a conversation going cold. Client onboardings are not deals.
 */
export async function pipelineFinding(db, now = Date.now()) {
  const [{ results: deals }, { results: quiet }] = await Promise.all([db.prepare(
    // The lead's last reply too: a deal whose lead wrote since it was touched
    // is not « untouched », it is waiting for Andy's answer (audit C12, M4).
    `SELECT p.id, p.name, p.organisation, p.stage, p.next_at, p.updated_at,
            (SELECT COALESCE(s.last_reply_at, s.replied_at) FROM lead_state s WHERE s.uid = p.lead_uid) AS lead_reply_at
     FROM prospects p
     WHERE p.client_id IS NULL AND p.stage NOT IN ('won', 'lost')`,
  ).all(), db.prepare(
    `SELECT s.uid, l.name, s.stage, s.updated_at FROM lead_state s JOIN leads l ON l.uid = s.uid
     WHERE s.stage IN ('replied', 'talks') AND s.updated_at < ? AND l.dataset <> ?
       -- A lead that already has a deal (linked, or the same address or name) is
       -- covered by that deal's own line (NIRMATA F2, 30 Oct).
       AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.lead_uid = s.uid
         OR (p.email IS NOT NULL AND p.email <> '' AND LOWER(p.email) = LOWER(l.email))
         OR LOWER(p.name) = LOWER(l.name) OR (p.organisation <> '' AND LOWER(p.organisation) = LOWER(l.name)))
     ORDER BY s.updated_at ASC LIMIT 20`,
  ).bind(new Date(now - 7 * DAY).toISOString(), TRAVEL_DATASET).all()]);
  const open = deals ?? [];
  if (!open.length && !quiet?.length) return null;

  const alerts = [];
  const nowIsoText = new Date(now).toISOString();
  for (const d of open) {
    const idle = daysSince(d.updated_at, now);
    const who = d.organisation ? `${d.name} · ${d.organisation}` : d.name;
    const href = `/pipeline/${d.id}`;
    // A next step still ahead, or a reply newer than the deal's last change:
    // the deal is moving, so never « chase it » or « untouched » (audit C12, M4).
    const planned = d.next_at && String(d.next_at) > nowIsoText.slice(0, String(d.next_at).length);
    const answered = d.lead_reply_at && d.lead_reply_at > d.updated_at;
    if (answered) alerts.push({ label: who, detail: 'They wrote since: answer them', meta: d.stage, href, idle, rank: -1 });
    else if (planned) continue;
    else if (d.stage === 'proposal' && idle >= 5) alerts.push({ label: who, detail: `Proposal sent, no movement for ${idle} days: chase it`, meta: 'proposal', href, idle, rank: 0 });
    else if (!d.next_at) alerts.push({ label: who, detail: 'No next step date', meta: d.stage, href, idle, rank: 3 });
    else if (idle >= 7) alerts.push({ label: who, detail: `Untouched for ${idle} days`, meta: d.stage, href, idle, rank: 2 });
  }
  for (const l of quiet ?? []) {
    const idle = daysSince(l.updated_at, now);
    alerts.push({ label: l.name, detail: `${l.stage === 'talks' ? 'In talks' : 'Replied'}, quiet for ${idle} days, with no deal`, meta: 'lead', href: `/leads?lead=${encodeURIComponent(l.uid)}`, idle, rank: 1, isLead: true });
  }
  // Money first: a proposal waiting, then a conversation going cold, then the rest; oldest first within each.
  alerts.sort((a, b) => a.rank - b.rank || b.idle - a.idle);
  const proposals = open.filter((d) => d.stage === 'proposal').length;
  const leadAlerts = alerts.filter((a) => a.isLead).length;
  const dealAlerts = alerts.length - leadAlerts;
  return {
    id: 'pipeline', type: 'pipeline', title: 'Pipeline', live: true,
    summary: [
      `${open.length} open deal${open.length === 1 ? '' : 's'}`,
      `${proposals} proposal${proposals === 1 ? '' : 's'} out`,
      alerts.length ? `${[
        dealAlerts && `${dealAlerts} deal${dealAlerts === 1 ? '' : 's'}`,
        leadAlerts && `${leadAlerts} conversation${leadAlerts === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' and ')} need${alerts.length === 1 ? 's' : ''} you` : 'nothing needs you',
    ].join(' · '),
    counts: { open: open.length, proposals, 'need you': alerts.length },
    href: '/pipeline',
    items: alerts.map(({ idle, rank, isLead, ...item }) => item),
  };
}

/**
 * « Today »: what brings money in, first (audit C12, M6). Overdue invoices not
 * snoozed, and replies waiting for Andy's answer. The same facts Home lists,
 * in the same words, so the two never disagree.
 */
export async function todayFinding(db, now = Date.now()) {
  const day = hqToday(new Date(now));
  const [overdue, missions] = await Promise.all([
    listInvoices(db, { status: 'overdue' }).catch(() => []),
    listMissions(db).catch(() => []),
  ]);
  const items = [];
  for (const inv of overdue) {
    if (inv.chase_snoozed_until && inv.chase_snoozed_until > day) continue;
    const late = Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${inv.due_on}T00:00:00Z`)) / DAY));
    items.push({ label: `Chase ${inv.number}`, detail: `${inv.subject || 'Invoice'} · ${late} day${late === 1 ? '' : 's'} late`, meta: 'money', href: `/finance?invoice=${inv.id}` });
  }
  const replies = missions.filter((m) => m.lead_uid && m.turn === 'yours' && m.status !== 'done');
  for (const m of replies) {
    items.push({ label: m.title.replace(/ — they replied, your turn to answer$/, ''), detail: 'They replied: your turn to answer', meta: 'reply', href: `/leads?lead=${encodeURIComponent(m.lead_uid)}` });
  }
  if (!items.length) return null;
  const money = items.filter((i) => i.meta === 'money').length;
  return {
    id: 'today', type: 'today', title: 'Today', live: true,
    summary: [
      money && `${money} invoice${money === 1 ? '' : 's'} to chase`,
      replies.length && `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} to answer`,
    ].filter(Boolean).join(' · '),
    counts: { invoices: money, replies: replies.length },
    href: '/',
    items,
  };
}

/** Everything the briefing shows: the live cards, then the pushed ones, in Andy's order. */
export async function readBriefing(db, now = Date.now()) {
  // Independent reads at once: one round trip's wait instead of four (3 Nov).
  // The Travel list list is personal: never in the work briefing (audit C12).
  const [pushed, ...cards] = await Promise.all([
    getSetting(db, BRIEFING_KEY), todayFinding(db, now), pipelineFinding(db, now), leadsFinding(db, now),
  ]);
  const live = cards.filter(Boolean);
  const rest = (pushed?.findings ?? []).filter((f) => f.type !== 'travel'
    && !live.some((l) => l.type === f.type && f.type === 'leads'));
  // A pushed leads/travel card adds to the live one rather than replacing it.
  for (const card of live) {
    const extra = (pushed?.findings ?? []).find((f) => f.type === card.type);
    if (extra?.summary) card.note = extra.summary;
  }
  const findings = [...live, ...rest].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return { date: pushed?.date ?? null, generated_at: pushed?.generated_at ?? null, findings };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** GET /api/briefing (the cards) and POST /api/briefing (store a checked briefing). */
export async function handleBriefing(request, env, url) {
  if (url.pathname !== '/api/briefing') return null;
  try {
    if (request.method === 'GET') return json({ briefing: await readBriefing(env.DB) });
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'body must be valid JSON' }, 400); }
      let clean;
      try { clean = cleanBriefing(body); } catch (error) { return json({ error: error.message }, 400); }
      // Checked above; written here, in a step of its own.
      await setSetting(env.DB, BRIEFING_KEY, clean);
      return json({ ok: true, date: clean.date, findings: clean.findings.length }, 201);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    if (isReadLimit(error)) return readLimitResponse();
    console.error('briefing api:', error);
    return json({ error: 'something went wrong' }, 500);
  }
}
