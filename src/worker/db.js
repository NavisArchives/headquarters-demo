/**
 * `proposed` comes first because it comes before everything: a mission read
 * out of a reply starts there and stays there until the owner accepts it.
 * Accepting is `proposed -> pending` and nothing else (see updateMission).
 */

import { dayOf, addDays as addCalendarDays } from '../public/assets/dates.js';
export const MISSION_STATUSES = Object.freeze(['proposed', 'pending', 'in_progress', 'blocked', 'done']);

/** The one status a proposal may be moved to. Accepting is a deliberate act. */
export const ACCEPTED_FROM_PROPOSED = 'pending';

const TITLE_MAX = 200;

/** The fields a caller is allowed to set. Anything else in a patch is ignored. */
const WRITABLE = Object.freeze(['title', 'detail', 'slug', 'status', 'blocked_on', 'due', 'position']);

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** One source of timestamps. SQLite's CURRENT_TIMESTAMP has a different format
 *  and mixing the two makes ordering silently wrong. */
export function nowIso() {
  return new Date().toISOString();
}

/** Andy's own zone (wrangler var HQ_TIME_ZONE, e.g. America/Lima). « Today »
 *  for due dates, follow-ups and invoice dates is his calendar day, not UTC's:
 *  in Lima, UTC's day turns at 19:00. Set once per request by the Worker. */
let hqTimeZone = 'Europe/Brussels';
export function setHqTimeZone(zone) {
  if (!zone) return;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); hqTimeZone = zone; } catch { /* unknown zone: keep the last good one */ }
}

/** Today's calendar day in Andy's zone, `YYYY-MM-DD`. */
export function hqToday(now = new Date()) {
  return dayOf(now, hqTimeZone);
}

function assertId(id) {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('id must be a positive integer', 'id');
  return id;
}

function cleanTitle(value) {
  if (typeof value !== 'string') throw new ValidationError('title is required', 'title');
  const title = value.trim();
  if (!title) throw new ValidationError('title is required', 'title');
  if (title.length > TITLE_MAX) throw new ValidationError(`title must be ${TITLE_MAX} characters or fewer`, 'title');
  return title;
}

function assertStatus(status) {
  if (!MISSION_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${MISSION_STATUSES.join(', ')}`, 'status');
  }
  return status;
}

/** A blocked mission must say what blocks it. "Blocked" with no reason is where
 *  task lists go to die, so it is refused here as well as by the schema. */
function assertBlockedReason(status, blockedOn) {
  if (status !== 'blocked') return null;
  const reason = typeof blockedOn === 'string' ? blockedOn.trim() : '';
  if (!reason) throw new ValidationError('a blocked mission must say what blocks it', 'blocked_on');
  return reason;
}

const COLUMNS = 'id, title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid, source, source_ref';

export async function listMissions(db, filter = {}) {
  const where = [];
  const args = [];

  if (filter.status !== undefined) {
    where.push('status = ?');
    args.push(assertStatus(filter.status));
  }
  if (filter.slug !== undefined) {
    where.push('slug = ?');
    args.push(filter.slug);
  }

  // A lead mission says whose turn it is (audit C11, M2): « yours » once the
  // lead wrote after Andy's last email, « theirs » while Andy waits. Computed
  // as the warm-lead view does (0014), from the lead's own mail times.
  const turn = `(SELECT CASE
      WHEN missions.lead_uid IS NULL THEN NULL
      WHEN COALESCE(s.last_sent_at, s.sent_at) IS NOT NULL
           AND (COALESCE(s.last_reply_at, s.replied_at) IS NULL OR COALESCE(s.last_sent_at, s.sent_at) > COALESCE(s.last_reply_at, s.replied_at))
        THEN 'theirs'
      WHEN COALESCE(s.last_reply_at, s.replied_at) IS NOT NULL THEN 'yours'
      ELSE NULL END
    FROM lead_state s WHERE s.uid = missions.lead_uid) AS turn`;
  const sql = `SELECT ${COLUMNS}, ${turn} FROM missions`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY position ASC, id ASC';

  const { results } = await db.prepare(sql).bind(...args).all();
  return results ?? [];
}

export async function getMission(db, id) {
  assertId(id);
  return db.prepare(`SELECT ${COLUMNS} FROM missions WHERE id = ?`).bind(id).first();
}

export async function createMission(db, input = {}) {
  const title = cleanTitle(input.title);
  const status = input.status === undefined ? 'pending' : assertStatus(input.status);
  const blockedOn = assertBlockedReason(status, input.blocked_on);
  const at = nowIso();

  return db.prepare(
    `INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${COLUMNS}`,
  ).bind(
    title,
    typeof input.detail === 'string' ? input.detail : '',
    input.slug ?? null,
    status,
    blockedOn,
    input.due ?? null,
    Number.isInteger(input.position) ? input.position : 0,
    at,
    at,
    status === 'done' ? at : null,
  ).first();
}

export async function updateMission(db, id, patch = {}) {
  assertId(id);

  const sets = [];
  const args = [];

  for (const field of WRITABLE) {
    if (patch[field] === undefined) continue;

    // A title Andy writes himself is his: HQ stops keeping it up to date.
    if (field === 'title') { sets.push('title = ?', 'auto_title = 0'); args.push(cleanTitle(patch.title)); continue; }
    if (field === 'status') continue; // handled below, with done_at and blocked_on
    if (field === 'blocked_on') continue;

    sets.push(`${field} = ?`);
    args.push(patch[field]);
  }

  if (patch.status !== undefined) {
    const status = assertStatus(patch.status);
    const blockedOn = assertBlockedReason(status, patch.blocked_on);

    // The whole safety mechanism of the reply funnel, enforced here rather
    // than in the screen: a mission that was proposed by reading an email can
    // only be accepted (-> pending) or deleted. It can never be started, done
    // or blocked while still a proposal, and a real mission can never be
    // pushed back into the proposal tray.
    const current = await db.prepare('SELECT status FROM missions WHERE id = ?').bind(id).first();
    if (current) {
      if (current.status === 'proposed' && status !== ACCEPTED_FROM_PROPOSED) {
        throw new ValidationError('a proposed mission has to be accepted before it can move', 'status');
      }
      if (current.status !== 'proposed' && status === 'proposed') {
        throw new ValidationError('a mission cannot be turned back into a proposal', 'status');
      }
    }

    sets.push('status = ?');
    args.push(status);
    // Leaving blocked clears the reason; a stale "waiting on X" on a running
    // mission is worse than none.
    sets.push('blocked_on = ?');
    args.push(blockedOn);
    sets.push('done_at = ?');
    args.push(status === 'done' ? nowIso() : null);
  } else if (patch.blocked_on !== undefined) {
    sets.push('blocked_on = ?');
    args.push(patch.blocked_on);
  }

  if (!sets.length) throw new ValidationError('nothing to update', 'patch');

  sets.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);

  return db.prepare(
    `UPDATE missions SET ${sets.join(', ')} WHERE id = ? RETURNING ${COLUMNS}`,
  ).bind(...args).first();
}

export async function deleteMission(db, id) {
  assertId(id);
  const result = await db.prepare('DELETE FROM missions WHERE id = ?').bind(id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/* ---------------------------------------------------------------------- *
 * To-dos (migrations/0015): the things Andy has to do himself. A to-do can
 * sit inside a mission and can point at a lead; its date goes to Google
 * Calendar through the private feed (calendar.js).
 * ---------------------------------------------------------------------- */

const NOTE_MAX = 2000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Done to-dos stay on the list this long, so a tick can be seen and undone. */
const DONE_SHOWN_DAYS = 30;
const TODO_SELECT = `SELECT t.id, t.title, t.note, t.due, t.mission_id, t.lead_uid, t.source, t.position,
    t.created_at, t.updated_at, t.done_at, m.title AS mission_title, l.name AS lead_name
  FROM todos t
  LEFT JOIN missions m ON m.id = t.mission_id
  LEFT JOIN leads l ON l.uid = t.lead_uid`;

/** A calendar day, YYYY-MM-DD, that exists. Empty means no date. */
export function cleanDay(value, field = 'due') {
  if (value === null || value === undefined || value === '') return null;
  const day = typeof value === 'string' ? value.trim() : '';
  const real = ISO_DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if (!real) throw new ValidationError(`${field} must be a date like 2026-10-20`, field);
  return day;
}

function cleanNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError('note must be text', 'note');
  const note = value.trim();
  if (note.length > NOTE_MAX) throw new ValidationError(`note must be ${NOTE_MAX} characters or fewer`, 'note');
  return note;
}

async function todoMission(db, value) {
  if (value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('mission_id must be a mission', 'mission_id');
  if (!await db.prepare('SELECT id FROM missions WHERE id = ?').bind(id).first()) {
    throw new ValidationError('no such mission', 'mission_id');
  }
  return id;
}

async function todoLead(db, value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('lead_uid must be a lead', 'lead_uid');
  if (!await db.prepare('SELECT uid FROM leads WHERE uid = ?').bind(value).first()) {
    throw new ValidationError('no such lead', 'lead_uid');
  }
  return value;
}

/**
 * Open to-dos first, the soonest date first and the undated last; then the
 * ones ticked off in the last month. `open` leaves the done ones out;
 * `mission_id` keeps one mission's.
 */
export async function listTodos(db, filter = {}, today = hqToday()) {
  const where = [];
  const args = [];
  if (filter.open) {
    where.push('t.done_at IS NULL');
  } else {
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - DONE_SHOWN_DAYS * 86400000).toISOString();
    where.push('(t.done_at IS NULL OR t.done_at >= ?)');
    args.push(since);
  }
  if (filter.mission_id !== undefined) {
    where.push('t.mission_id = ?');
    args.push(Number(filter.mission_id));
  }
  const sql = `${TODO_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.done_at IS NOT NULL, t.due IS NULL, t.due, t.position, t.id`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return results ?? [];
}

export async function getTodo(db, id) {
  assertId(id);
  return db.prepare(`${TODO_SELECT} WHERE t.id = ?`).bind(id).first();
}

export async function createTodo(db, input = {}) {
  const title = cleanTitle(input.title);
  const at = nowIso();
  const row = await db.prepare(
    `INSERT INTO todos (title, note, due, mission_id, lead_uid, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    title,
    cleanNote(input.note),
    cleanDay(input.due),
    await todoMission(db, input.mission_id ?? null),
    await todoLead(db, input.lead_uid ?? null),
    Number.isInteger(input.position) ? input.position : 0,
    at,
    at,
  ).first();
  return getTodo(db, row.id);
}

/** `done: true` ticks it off, `done: false` puts it back. */
export async function updateTodo(db, id, patch = {}) {
  assertId(id);
  const sets = [];
  const args = [];
  if (patch.title !== undefined) { sets.push('title = ?'); args.push(cleanTitle(patch.title)); }
  if (patch.note !== undefined) { sets.push('note = ?'); args.push(cleanNote(patch.note)); }
  if (patch.due !== undefined) { sets.push('due = ?'); args.push(cleanDay(patch.due)); }
  if (patch.mission_id !== undefined) { sets.push('mission_id = ?'); args.push(await todoMission(db, patch.mission_id)); }
  if (patch.lead_uid !== undefined) { sets.push('lead_uid = ?'); args.push(await todoLead(db, patch.lead_uid)); }
  if (patch.position !== undefined) {
    if (!Number.isInteger(patch.position)) throw new ValidationError('position must be a whole number', 'position');
    sets.push('position = ?');
    args.push(patch.position);
  }
  if (patch.done !== undefined) {
    if (typeof patch.done !== 'boolean') throw new ValidationError('done must be true or false', 'done');
    // Ticking twice keeps the first time it was done.
    sets.push(patch.done ? 'done_at = COALESCE(done_at, ?)' : 'done_at = NULL');
    if (patch.done) args.push(nowIso());
  }
  if (!sets.length) throw new ValidationError('nothing to update', 'patch');
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  const row = await db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? RETURNING id`).bind(...args).first();
  return row ? getTodo(db, row.id) : null;
}

export async function deleteTodo(db, id) {
  assertId(id);
  const result = await db.prepare('DELETE FROM todos WHERE id = ?').bind(id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/* ---- the private calendar feed ---- */

const CALENDAR_TOKEN_KEY = 'calendar_feed_token';

function freshToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The secret in the feed's address. Made on first use; `reset` makes a new
 * one, and the old address stops working at once. Two first calls at the
 * same moment agree on one token: only the first insert lands.
 */
export async function calendarToken(db, { reset = false } = {}) {
  if (reset) {
    const token = freshToken();
    await setSetting(db, CALENDAR_TOKEN_KEY, token);
    return token;
  }
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).bind(CALENDAR_TOKEN_KEY, JSON.stringify(freshToken()), nowIso()).run();
  return getSetting(db, CALENDAR_TOKEN_KEY);
}

/** The stored token, or null. Reading never makes one. */
export async function storedCalendarToken(db) {
  const token = await getSetting(db, CALENDAR_TOKEN_KEY);
  return typeof token === 'string' && token.length >= 32 ? token : null;
}

/**
 * Everything with a deadline that is still open: to-dos, and missions that
 * are not a lead's (those move every few days with the mail, and live in HQ).
 */
export async function calendarItems(db) {
  const [todos, missions] = await Promise.all([
    db.prepare(`${TODO_SELECT} WHERE t.done_at IS NULL AND t.due IS NOT NULL ORDER BY t.due, t.id`).all(),
    db.prepare(`SELECT id, title, detail, due FROM missions
      WHERE status IN ('pending', 'in_progress', 'blocked') AND due IS NOT NULL AND due <> '' AND lead_uid IS NULL
      ORDER BY due, id`).all(),
  ]);
  return { todos: todos.results ?? [], missions: missions.results ?? [] };
}

/* ---------------------------------------------------------------------- *
 * Leads: absorbed from the standalone lead-pipeline app (phase 4).
 * Facts (`leads`, written only by the importer) and state (`lead_state`,
 * written only by the person) are deliberately kept in separate tables —
 * see migrations/0002_leads.sql.
 * ---------------------------------------------------------------------- */

/** The `leads` columns the importer writes, in the order every INSERT uses. */
export const LEAD_COLUMNS = Object.freeze([
  'uid', 'dataset', 'id', 'business', 'name', 'website', 'category', 'subcategory',
  'city', 'area', 'region', 'country', 'languages', 'email', 'phone', 'contact',
  'contact_type', 'score', 'tier', 'verified', 'payload', 'imported_at',
]);

/** The old app's stage vocabulary, verbatim. `won` is labelled "Accepted" in the UI. */
export const STATE_STAGES = Object.freeze([
  'new', 'looked', 'shortlist', 'sent', 'replied', 'talks', 'won', 'passed',
]);

const LEAD_TIERS = Object.freeze(['Hot', 'Warm', 'Cool']);

/** Stage -> the lead_state column stamped the first time a lead reaches it,
 *  matching the old app's DATE_FIELD map (assets/app.js). */
const STAGE_STAMP = Object.freeze({
  looked: 'looked_at',
  sent: 'sent_at',
  replied: 'replied_at',
  won: 'won_at',
  passed: 'passed_at',
});

const LEAD_STATE_WRITABLE = Object.freeze(['stage', 'starred', 'notes', 'follow_up']);

function assertStage(stage) {
  if (!STATE_STAGES.includes(stage)) {
    throw new ValidationError(`stage must be one of ${STATE_STAGES.join(', ')}`, 'stage');
  }
  return stage;
}

function assertTier(tier) {
  if (!LEAD_TIERS.includes(tier)) {
    throw new ValidationError(`tier must be one of ${LEAD_TIERS.join(', ')}`, 'tier');
  }
  return tier;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required`, field);
  }
  return value;
}

function requireInt(value, field) {
  if (!Number.isInteger(value)) throw new ValidationError(`${field} must be an integer`, field);
  return value;
}

/** Escapes the characters LIKE treats specially, so a search term is matched
 *  literally rather than as a pattern. Paired with `LIKE ? ESCAPE '\'`. */
function escapeLikeTerm(term) {
  return String(term).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Facts + state, LEFT JOINed and coalesced so a lead with no lead_state row
 *  reads as stage: 'new', starred: 0, notes: ''. */
const LEAD_JOIN_SELECT = [
  ...LEAD_COLUMNS.map((c) => `l.${c}`),
  "COALESCE(s.stage, 'new') AS stage",
  'COALESCE(s.starred, 0) AS starred',
  "COALESCE(s.notes, '') AS notes",
  's.follow_up AS follow_up',
  's.looked_at AS looked_at',
  's.sent_at AS sent_at',
  's.replied_at AS replied_at',
  's.won_at AS won_at',
  's.passed_at AS passed_at',
  's.updated_at AS updated_at',
].join(', ');

const LEAD_JOIN_FROM = 'FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid';

/** The list carries only what the list and Quick personalization read; the pop-up
 *  loads one lead's whole record when it opens (getLead), and search reads the
 *  whole payload in SQL. Dropped from the list (13 Nov, ~6 s from Lima): the
 *  import's copies of the columns, pitch, research, openingLine, and every extra
 *  field but the five the screens use. The Travel list list keeps its full payload:
 *  91 rows, and its culling reads more of it. */
const LIST_EXTRA_KEYS = ['code', 'tier', 'Listing', 'sendable', 'sendRule'];
// json_patch onto {} drops every key whose value is null (RFC 7396), so a lead
// without, say, a sendRule sends nothing for it rather than "sendRule":null.
const LEAD_LIST_PAYLOAD = `CASE WHEN NOT json_valid(l.payload) OR l.dataset = 'travel-volunteer-stays' THEN l.payload ELSE json_patch('{}', json_object(${
  ['scoreLabel', 'evidence', 'evidenceUrl', 'contactAlt']
    .map((k) => `'${k}', l.payload->'$.${k}'`).join(', ')
}, 'extra', json_object(${LIST_EXTRA_KEYS.map((k) => `'${k}', l.payload->'$.extra.${k}'`).join(', ')}))) END AS payload`;
// An address that unsubscribed or bounced, on any list (0027): the screens refuse to write to it.
const SUPPRESSED = "EXISTS (SELECT 1 FROM email_suppression es WHERE es.email = lower(trim(l.email))) AS suppressed";
// « LinkedIn sent » (NIRMATA, 14 Nov): Andy's own LinkedIn message, logged as a 'linkedin' event.
// A separate channel: it never moves the email stage or the follow-up rhythm.
const LINKEDIN = "(SELECT MAX(e.at) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'linkedin') AS linkedin_sent_at";
const LEAD_LIST_SELECT = `${LEAD_JOIN_SELECT.replace(/\bl\.payload\b/, LEAD_LIST_PAYLOAD)}, ${SUPPRESSED}, ${LINKEDIN}`;

/** Belt-and-braces JS-side coalesce, in case a caller (or a test double) hands
 *  back a raw, un-joined row. The SQL above already guarantees this shape. */
function normalizeLeadRow(row) {
  if (!row) return null;
  return {
    ...row,
    stage: row.stage ?? 'new',
    starred: row.starred ?? 0,
    notes: row.notes ?? '',
  };
}

const LEAD_SORTS = Object.freeze({
  score: 'l.score DESC, l.name ASC',
  name: 'l.name ASC',
  area: 'l.area ASC, l.score DESC',
  category: 'l.category ASC, l.score DESC',
  stage: 'stage DESC, l.score DESC',
  touched: 'updated_at DESC, l.score DESC',
});

export async function upsertDataset(db, meta = {}) {
  await upsertDatasetStatement(db, meta).run();
}

/** The dataset upsert as one bound statement, for a caller that writes a
 *  whole batch in one transaction (lead-batches.js). */
export function upsertDatasetStatement(db, meta = {}) {
  const key = requireString(meta.key, 'key');
  const business = requireString(meta.business, 'business');
  const title = requireString(meta.title, 'title');
  const tierHot = requireInt(meta.tiers?.hot, 'tiers.hot');
  const tierWarm = requireInt(meta.tiers?.warm, 'tiers.warm');
  const at = nowIso();

  return db.prepare(
    `INSERT INTO datasets (key, business, title, subtitle, collected, method, scoring, tier_hot, tier_warm, row_count, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       business = excluded.business, title = excluded.title, subtitle = excluded.subtitle,
       collected = excluded.collected, method = excluded.method, scoring = excluded.scoring,
       tier_hot = excluded.tier_hot, tier_warm = excluded.tier_warm,
       row_count = excluded.row_count, imported_at = excluded.imported_at`,
  ).bind(
    key, business, title,
    meta.subtitle ?? null, meta.collected ?? null, meta.method ?? null, meta.scoring ?? null,
    tierHot, tierWarm, Number.isInteger(meta.count) ? meta.count : 0, at,
  );
}

/** Facts only. Never references lead_state — the importer must not be able
 *  to touch what the person owns. */
export async function upsertLead(db, row = {}) {
  await upsertLeadStatement(db, row).run();
}

/** The lead upsert as one bound statement (see upsertDatasetStatement). */
export function upsertLeadStatement(db, row = {}) {
  const dataset = requireString(row.dataset, 'dataset');
  const id = requireString(row.id, 'id');
  const business = requireString(row.business, 'business');
  const name = requireString(row.name, 'name');
  const website = requireString(row.website, 'website');
  const category = requireString(row.category, 'category');
  const country = requireString(row.country, 'country');
  const score = requireInt(row.score, 'score');
  const tier = assertTier(row.tier);
  if (row.payload === undefined || row.payload === null) {
    throw new ValidationError('payload is required', 'payload');
  }

  // Always derived, never trusted from the caller — the state migration
  // keys everything on this exact string.
  const uid = `${dataset}/${id}`;
  const languages = Array.isArray(row.languages) ? JSON.stringify(row.languages) : (row.languages ?? '[]');
  const payload = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const at = nowIso();

  const values = {
    uid, dataset, id, business, name, website, category,
    subcategory: row.subcategory ?? null,
    city: row.city ?? null,
    area: row.area ?? null,
    region: row.region ?? null,
    country,
    languages,
    email: row.email ?? null,
    phone: row.phone ?? null,
    contact: row.contact ?? null,
    contact_type: row.contact_type ?? null,
    score,
    tier,
    verified: row.verified ?? null,
    payload,
    imported_at: at,
  };

  const args = LEAD_COLUMNS.map((c) => values[c]);
  const setClause = LEAD_COLUMNS.filter((c) => c !== 'uid').map((c) => `${c} = excluded.${c}`).join(', ');

  return db.prepare(
    `INSERT INTO leads (${LEAD_COLUMNS.join(', ')})
     VALUES (${LEAD_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT(uid) DO UPDATE SET ${setClause}`,
  ).bind(...args);
}

export async function listLeads(db, filter = {}) {
  const where = [];
  const args = [];

  if (filter.business !== undefined) { where.push('l.business = ?'); args.push(filter.business); }
  if (filter.category !== undefined) { where.push('l.category = ?'); args.push(filter.category); }
  if (filter.area !== undefined) { where.push('l.area = ?'); args.push(filter.area); }
  if (filter.tier !== undefined) { where.push('l.tier = ?'); args.push(assertTier(filter.tier)); }
  if (filter.contact !== undefined) { where.push('l.contact_type = ?'); args.push(filter.contact); }

  if (filter.stage !== undefined) {
    where.push("COALESCE(s.stage, 'new') = ?");
    args.push(assertStage(filter.stage));
  }
  if (filter.starred !== undefined) {
    where.push('COALESCE(s.starred, 0) = ?');
    args.push(filter.starred ? 1 : 0);
  }
  if (filter.language !== undefined) {
    where.push('l.languages LIKE ?');
    args.push(`%"${filter.language}"%`);
  }
  if (filter.q !== undefined && String(filter.q).trim() !== '') {
    const like = `%${escapeLikeTerm(String(filter.q).trim())}%`;
    // The fields the old app's search covered (assets/app.js `_hay` + notes).
    // pitch/research aren't their own columns — they live inside `payload`.
    where.push(
      `(l.name LIKE ? ESCAPE '\\' OR l.city LIKE ? ESCAPE '\\' OR l.category LIKE ? ESCAPE '\\'`
      + ` OR l.payload LIKE ? ESCAPE '\\' OR COALESCE(s.notes, '') LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like, like);
  }

  let orderBy = LEAD_SORTS.score;
  if (filter.sort !== undefined) {
    if (!LEAD_SORTS[filter.sort]) {
      throw new ValidationError(`sort must be one of ${Object.keys(LEAD_SORTS).join(', ')}`, 'sort');
    }
    orderBy = LEAD_SORTS[filter.sort];
  }

  // shape: 'list' (default, the trimmed payload), 'full' (whole records, for
  // the CSV export) or 'uids' (only the uids, for the screen's server search).
  const shape = filter.shape ?? 'list';
  const select = shape === 'uids' ? 'l.uid AS uid'
    : shape === 'full' ? `${LEAD_JOIN_SELECT}, ${SUPPRESSED}, ${LINKEDIN}`
      : LEAD_LIST_SELECT;
  const sql = `SELECT ${select} ${LEAD_JOIN_FROM}`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ` ORDER BY ${orderBy}`;

  const { results } = await db.prepare(sql).bind(...args).all();
  if (shape === 'uids') return (results ?? []).map((row) => row.uid);
  return (results ?? []).map(normalizeLeadRow);
}

async function selectLeadWithState(db, uid) {
  const row = await db.prepare(
    `SELECT ${LEAD_JOIN_SELECT}, ${SUPPRESSED}, ${LINKEDIN} ${LEAD_JOIN_FROM} WHERE l.uid = ?`,
  ).bind(uid).first();
  return normalizeLeadRow(row);
}

export async function getLead(db, uid) {
  const lead = await selectLeadWithState(db, uid);
  if (!lead) return null;

  const { results: events } = await db.prepare(
    'SELECT id, kind, detail, at FROM lead_events WHERE uid = ? ORDER BY at DESC, id DESC LIMIT 20',
  ).bind(uid).all();

  return { ...lead, events: events ?? [] };
}

/** The mailbox sync's way in: Gmail knows an address, HQ knows uids.
 *  Compared lowercased and trimmed on both sides. Returns the uid or null. */
export async function findLeadUidByEmail(db, email) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address.includes('@')) return null;

  const row = await db.prepare(
    'SELECT uid FROM leads WHERE LOWER(TRIM(email)) = ? LIMIT 1',
  ).bind(address).first();
  return row?.uid ?? null;
}

/** The sync's fallback: you often write to a named person rather than the
 *  published inbox, so the company domain identifies the lead. Deliberately
 *  refuses to guess — two leads at one domain match nothing. Free-mail
 *  domains are filtered out by the caller (see api/gmail.js). */
export async function findLeadUidByEmailDomain(db, domain) {
  const host = String(domain ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;

  const { results } = await db.prepare(
    `SELECT uid FROM leads WHERE LOWER(TRIM(email)) LIKE ? ESCAPE '\\' LIMIT 2`,
  ).bind(`%@${escapeLikeTerm(host)}`).all();
  const rows = results ?? [];
  return rows.length === 1 ? rows[0].uid : null;
}

/** The follow-up rhythm (A5, NIRMATA's review of 29 Oct; SALES works on +7):
 *  7 days after the first email, 14 after the second, and after the third the
 *  sequence ends — no more chasing a lead that has not answered three times.
 *  Emails are counted since their last reply, so a conversation that picks
 *  up again starts the rhythm over. */
export const FOLLOW_UP_CADENCE = Object.freeze([7, 14]);
/** The first step, which the Leads screen's « follow-up due » filter uses too. */
export const FOLLOW_UP_DAYS = FOLLOW_UP_CADENCE[0];

/** How many emails went to this lead since its last reply: the « sent »
 *  events (each outreach_sent logs one), at least 1 for the email just seen. */
async function sendsSinceReply(db, uid, lastReply) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM lead_events WHERE uid = ? AND kind = 'sent' AND (? IS NULL OR at > ?)",
  ).bind(uid, lastReply, lastReply).first();
  return Math.max(1, Number(row?.n ?? 0));
}

/**
 * What the mailbox says about one lead: the newest time Andy wrote to them
 * and the newest time they wrote back. Times only ever move forward.
 *
 * Follow-ups keep themselves current ("keep following up", Andy 14 Oct):
 *   - Andy wrote again and they have not answered since: the follow-up moves
 *     to the next step of FOLLOW_UP_CADENCE after that email, or ends.
 *   - They answered after Andy's last email: a follow-up date already in the
 *     past is cleared, because it is now Andy's turn, not a chase.
 * Returns true when anything changed.
 */
export async function recordMailTimes(db, uid, { sentAt = null, repliedAt = null } = {}, today = hqToday()) {
  const row = await db.prepare(
    'SELECT last_sent_at, last_reply_at, follow_up FROM lead_state WHERE uid = ?',
  ).bind(uid).first();
  if (!row) return false;

  const later = (a, b) => (a && (!b || a > b) ? a : b);
  const lastSent = later(sentAt, row.last_sent_at) ?? null;
  const lastReply = later(repliedAt, row.last_reply_at) ?? null;
  const theirTurn = Boolean(lastSent && (!lastReply || lastSent > lastReply));

  let followUp = row.follow_up ?? null;
  if (lastSent !== (row.last_sent_at ?? null) && theirTurn) {
    const days = FOLLOW_UP_CADENCE[(await sendsSinceReply(db, uid, lastReply)) - 1];
    if (days === undefined) {
      followUp = null; // the third email ended the sequence
    } else {
      followUp = addCalendarDays(dayOf(lastSent, hqTimeZone), days);
    }
  }
  if (lastReply !== (row.last_reply_at ?? null) && !theirTurn && followUp && followUp <= today) followUp = null;

  if (lastSent === (row.last_sent_at ?? null) && lastReply === (row.last_reply_at ?? null) && followUp === (row.follow_up ?? null)) {
    return false;
  }
  await db.prepare(
    'UPDATE lead_state SET last_sent_at = ?, last_reply_at = ?, follow_up = ?, updated_at = ? WHERE uid = ?',
  ).bind(lastSent, lastReply, followUp, nowIso(), uid).run();
  return true;
}

/** Where a lead stands right now, without the detail view's event query.
 *  Null means there is no such lead; a lead with no state row reads 'new'. */
export async function getLeadStage(db, uid) {
  const row = await db.prepare(
    "SELECT COALESCE(s.stage, 'new') AS stage FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid WHERE l.uid = ?",
  ).bind(uid).first();
  return row?.stage ?? null;
}

/** Writes lead_state, appends the matching lead_events rows, and stamps
 *  looked_at/sent_at/replied_at/won_at/passed_at the first time a lead
 *  reaches that stage — matching the old app's DATE_FIELD stamping. */
export async function patchLeadState(db, uid, patch = {}, at) {
  const provided = LEAD_STATE_WRITABLE.filter((f) => patch[f] !== undefined);
  if (!provided.length) throw new ValidationError('nothing to update', 'patch');

  if (patch.stage !== undefined) assertStage(patch.stage);
  if (patch.notes !== undefined && typeof patch.notes !== 'string') {
    throw new ValidationError('notes must be a string', 'notes');
  }
  if (patch.follow_up !== undefined && patch.follow_up !== null && typeof patch.follow_up !== 'string') {
    throw new ValidationError('follow_up must be a date string or null', 'follow_up');
  }

  // Validation above never touches the database — an invalid patch is
  // rejected before any query runs.
  const current = await selectLeadWithState(db, uid);
  if (!current) return null;

  const stamp = at ?? nowIso();

  const next = {
    stage: patch.stage !== undefined ? patch.stage : current.stage,
    starred: patch.starred !== undefined ? (patch.starred ? 1 : 0) : current.starred,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    follow_up: patch.follow_up !== undefined ? patch.follow_up : current.follow_up,
    looked_at: current.looked_at ?? null,
    sent_at: current.sent_at ?? null,
    replied_at: current.replied_at ?? null,
    won_at: current.won_at ?? null,
    passed_at: current.passed_at ?? null,
  };

  if (patch.stage !== undefined) {
    const field = STAGE_STAMP[patch.stage];
    if (field && !next[field]) next[field] = stamp;
  }

  await db.prepare(
    `INSERT INTO lead_state (uid, stage, starred, notes, follow_up, looked_at, sent_at, replied_at, won_at, passed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       stage = excluded.stage, starred = excluded.starred, notes = excluded.notes,
       follow_up = excluded.follow_up, looked_at = excluded.looked_at, sent_at = excluded.sent_at,
       replied_at = excluded.replied_at, won_at = excluded.won_at, passed_at = excluded.passed_at,
       updated_at = excluded.updated_at`,
  ).bind(
    uid, next.stage, next.starred, next.notes, next.follow_up,
    next.looked_at, next.sent_at, next.replied_at, next.won_at, next.passed_at, stamp,
  ).run();

  const logEvent = (kind, detail) => db.prepare(
    'INSERT INTO lead_events (uid, kind, detail, at) VALUES (?, ?, ?, ?)',
  ).bind(uid, kind, detail, stamp).run();

  if (patch.stage !== undefined) await logEvent('stage', patch.stage);
  if (patch.starred !== undefined) await logEvent('star', String(next.starred));
  if (patch.notes !== undefined) await logEvent('note', '');
  if (patch.follow_up !== undefined) await logEvent('followup', next.follow_up ?? '');

  return { ...current, ...next, updated_at: stamp };
}

export async function getDraft(db, uid, lang) {
  return db.prepare(
    'SELECT uid, lang, subject, body, to_name, updated_at FROM lead_drafts WHERE uid = ? AND lang = ?',
  ).bind(uid, lang).first();
}

export async function saveDraft(db, uid, lang, patch = {}) {
  requireString(uid, 'uid');
  requireString(lang, 'lang');
  const at = nowIso();

  return db.prepare(
    `INSERT INTO lead_drafts (uid, lang, subject, body, to_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid, lang) DO UPDATE SET
       subject = excluded.subject, body = excluded.body, to_name = excluded.to_name,
       updated_at = excluded.updated_at
     RETURNING uid, lang, subject, body, to_name, updated_at`,
  ).bind(
    uid, lang,
    typeof patch.subject === 'string' ? patch.subject : '',
    typeof patch.body === 'string' ? patch.body : '',
    typeof patch.to_name === 'string' ? patch.to_name : '',
    at,
  ).first();
}

export async function clearDraft(db, uid, lang) {
  const result = await db.prepare('DELETE FROM lead_drafts WHERE uid = ? AND lang = ?').bind(uid, lang).run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function setSetting(db, key, value) {
  const at = nowIso();
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), at).run();
}

/* ---------------------------------------------------------------------- *
 * Finance (phase 6): clients, invoices, invoice_lines — migrations/0003.
 * Money is integer cents everywhere; the only fractional number that is ever
 * bound is a line's `quantity`, which the schema itself declares REAL (a
 * client can be billed for 2.5 hours). Every cents figure — unit_cents,
 * amount_cents, subtotal/vat/total_cents — is always Number.isInteger.
 *
 * Invoice numbers (`<n>.R.A.<CLIENT LETTERS>.<NN>`, e.g. 5.R.A.L.01) are
 * allocated at issue, inside the single UPDATE that flips a draft to issued,
 * via correlated subqueries — so two concurrent issues cannot collide and
 * neither counter is ever computed in JS from a prior read. `seq` counts
 * within (series, year) — it restarts each January and each series — and the
 * `A` is Andy, fixed, never the client's letter; `NN` counts that client's
 * numbered invoices, all time. The trailing pair is not a year — design
 * addendum 4, as restated 2026-09-21.
 *
 * What has been paid is never a boolean: it is the `payments` rows (0006).
 * `paid_cents`/`balance_cents` are derived in SQL on every read, an invoice
 * is settled when its payments cover its total, and `invoices.paid_on` is
 * kept only as the date the last payment settled it — recomputed from the
 * payments, never set on its own.
 * ---------------------------------------------------------------------- */

/** The series of invoices imported from before HQ (migrations/0019). They
 *  keep their printed numbers, never take a seq, and are read-only. */
export const ARCHIVE_SERIES = 'archive';
const ARCHIVE_READ_ONLY = 'an archive invoice is kept exactly as it was sent and cannot be changed';

/** Treatment -> rate and the tax line it requires on the printed invoice.
 *  Not a rate on its own: which treatment applies is a legal question for
 *  the accountant, not something this module decides.
 *
 *  `mention` is the sentence as it is PRINTED, verbatim from invoice
 *  5.R.A.L.01 (design addendum 4) — the screen prints what this says, it does
 *  not compose a sentence of its own. Addendum 2's Dutch "BTW verlegd …" was
 *  never what the real invoice carries. */
export const VAT_TREATMENTS = Object.freeze({
  standard: Object.freeze({ rate: 21, mention: null }),
  reverse_charge: Object.freeze({
    rate: 0,
    mention: 'Tax (0%) - Reverse charge may apply.',
    requires_vat_number: true,
  }),
  exempt_small: Object.freeze({ rate: 0, mention: null }),
  export: Object.freeze({ rate: 0, mention: 'Tax (0%) - Export outside the EU.' }),
});

/** What a database with no settings.issuer starts from: blank, so the invoice
 *  says its details are incomplete. Andy's real details live in the settings
 *  row (live database), never in the repository (3 Nov). */
const ISSUER_DEFAULTS = Object.freeze({
  name: '',
  address: '', // Three printed lines; the invoice layout renders it with white-space: pre-line.
  tax_id_label: 'Tax ID',
  vat_number: '',
  company_reg: '',
  phone: '',
  email: '',
  payment_name: '',
  iban: '',
  bic: '',
  payment_terms_days: 30,
});

/** Reads settings.issuer, seeding it with the blank defaults the first
 *  time anything asks. Every later read returns whatever is stored, so an
 *  edit from the Admin screen (a later task) sticks. */
export async function getIssuer(db) {
  const existing = await getSetting(db, 'issuer');
  if (existing) return existing;
  await setSetting(db, 'issuer', ISSUER_DEFAULTS);
  return ISSUER_DEFAULTS;
}

/** The accounts an invoice can ask to be paid into, both in the studio's
 *  name (Andy, 6 Oct: "I don't want my name to be anywhere"). Seeded into
 *  settings.bank_accounts on first read; each invoice stores the id of the
 *  one it was sent with (invoices.bank_account), so changing the default
 *  never rewrites an invoice that already went out. */
export const BANK_ACCOUNT_DEFAULTS = Object.freeze([
  Object.freeze({ id: 'wise', label: 'Wise (Belgium)', payment_name: '', iban: '', bic: '' }),
  Object.freeze({ id: 'bog', label: 'Second Bank', payment_name: '', iban: '', bic: '' }),
  // The Belgian business account, closed: the 2023–2025 archive invoices ask
  // for it and were paid into it. `closed` keeps it out of the choice for a
  // new invoice; it stays so an archive payment can name it.
  Object.freeze({ id: 'kbc', label: 'KBC Business PRO (closed)', payment_name: '', iban: '', bic: '', closed: true }),
]);

export async function getBankAccounts(db) {
  const existing = await getSetting(db, 'bank_accounts');
  if (Array.isArray(existing) && existing.length) return existing;
  await setSetting(db, 'bank_accounts', BANK_ACCOUNT_DEFAULTS);
  return BANK_ACCOUNT_DEFAULTS;
}

/** The two issuers an invoice can be made out from (Andy, 14 Nov: « it will be a switch »).
 *  Seeded blank, like the issuer: Andy's details live in the settings row, never here.
 *  Both are paid into the Wise account, always (« always wise iban »). */
export const PAY_ACCOUNT = 'wise';
const PROFILE_FIELDS = Object.freeze(['name', 'address', 'tax_id_label', 'vat_number', 'registered_on', 'phone']);
export const ISSUER_PROFILE_DEFAULTS = Object.freeze([
  Object.freeze({ id: 'be', label: 'Belgium', name: '', address: '', tax_id_label: 'VAT', vat_number: '', registered_on: '', phone: '' }),
  Object.freeze({ id: 'ge', label: 'Abroad IE', name: '', address: '', tax_id_label: 'ID', vat_number: '', registered_on: '', phone: '' }),
]);

export async function getIssuerProfiles(db) {
  const existing = await getSetting(db, 'issuer_profiles');
  if (Array.isArray(existing) && existing.length) return existing;
  await setSetting(db, 'issuer_profiles', ISSUER_PROFILE_DEFAULTS);
  return ISSUER_PROFILE_DEFAULTS;
}

/** One profile's printed fields, edited from Your invoice details. `id` and `label` stay. */
export async function setIssuerProfile(db, id, input = {}) {
  const profiles = await getIssuerProfiles(db);
  const at = profiles.findIndex((p) => p.id === id);
  if (at < 0) throw new ValidationError(`no issuer profile "${id}"`, 'issuer_profile');
  const next = { ...profiles[at] };
  for (const field of PROFILE_FIELDS) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string') throw new ValidationError(`${field} must be text`, field);
    next[field] = input[field].trim();
  }
  // « No VAT » (Andy, 14 Nov, Abroad IE): the invoice prints « VAT not applicable ».
  if (input.no_vat !== undefined) {
    if (typeof input.no_vat !== 'boolean') throw new ValidationError('no_vat must be true or false', 'no_vat');
    next.no_vat = input.no_vat;
  }
  if (next.registered_on && !/^\d{4}-\d{2}-\d{2}$/.test(next.registered_on)) {
    throw new ValidationError('registered_on must be a date (YYYY-MM-DD)', 'registered_on');
  }
  const all = profiles.map((p, i) => (i === at ? next : p));
  await setSetting(db, 'issuer_profiles', all);
  return next;
}

/** What an invoice keeps of its issuer when a profile is chosen: the profile's printed
 *  fields, the logo and terms of Your invoice details, and the Wise payment block. */
async function issuerSnapshot(db, profileId) {
  const profile = (await getIssuerProfiles(db)).find((p) => p.id === profileId);
  if (!profile) throw new ValidationError(`no issuer profile "${profileId}"`, 'issuer_profile');
  if (!String(profile.name ?? '').trim() || !String(profile.address ?? '').trim()) {
    throw new ValidationError(`the ${profile.label} profile has no name or address yet: fill it in Your invoice details`, 'issuer_profile');
  }
  const issuer = await getIssuer(db);
  const wise = (await getBankAccounts(db)).find((a) => a.id === PAY_ACCOUNT);
  if (!wise?.iban || wise.closed) throw new ValidationError('the Wise account has no IBAN in Your invoice details', 'bank_account');
  const printed = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, profile[f] ?? '']));
  return {
    profile: profile.id, label: profile.label, ...printed, no_vat: profile.no_vat === true,
    brand: issuer.name ?? '', tagline: issuer.tagline ?? '', payment_terms_days: issuer.payment_terms_days ?? 30,
    payment: { payment_name: wise.payment_name ?? '', iban: wise.iban, bic: wise.bic ?? '' },
  };
}

/** The issuer half of an edit, resolved before the synchronous header sets: a profile
 *  brings its snapshot and the Wise account; null goes back to Your invoice details. */
const NO_VAT_REFUSAL = 'this issuer prints « VAT not applicable »: choose a VAT treatment without VAT';
const keptSnapshot = (text) => { try { return JSON.parse(text ?? 'null'); } catch { return null; } };

async function issuerProfileSets(db, patch, current) {
  const chosen = patch.issuer_profile === undefined ? current?.issuer_profile ?? null : patch.issuer_profile;
  if (chosen && patch.bank_account !== undefined && patch.bank_account !== PAY_ACCOUNT) {
    throw new ValidationError('an invoice with an issuer profile is always paid into Wise', 'bank_account');
  }
  const treatment = patch.vat_treatment ?? current?.vat_treatment;
  if (patch.issuer_profile === undefined) {
    // A kept no-VAT issuer and a treatment that charges VAT would contradict each other on paper.
    if (chosen && keptSnapshot(current?.issuer_snapshot)?.no_vat && VAT_TREATMENTS[treatment]?.rate > 0) {
      throw new ValidationError(NO_VAT_REFUSAL, 'vat_treatment');
    }
    return { sets: [], args: [] };
  }
  if (patch.issuer_profile === null) return { sets: ['issuer_profile = NULL', 'issuer_snapshot = NULL'], args: [] };
  if (typeof patch.issuer_profile !== 'string') throw new ValidationError('issuer_profile must be a profile id', 'issuer_profile');
  const snapshot = await issuerSnapshot(db, patch.issuer_profile);
  if (snapshot.no_vat && VAT_TREATMENTS[treatment]?.rate > 0) throw new ValidationError(NO_VAT_REFUSAL, 'vat_treatment');
  const sets = ['issuer_profile = ?', 'issuer_snapshot = ?'];
  const args = [snapshot.profile, JSON.stringify(snapshot)];
  if (patch.bank_account === undefined) { sets.push('bank_account = ?'); args.push(PAY_ACCOUNT); }
  return { sets, args };
}

/** The issuer of an issued invoice that has not been sent yet (like its account). */
export async function setInvoiceIssuerProfile(db, id, profileId) {
  assertId(id);
  if (profileId === undefined) throw new ValidationError('issuer_profile is required', 'issuer_profile');
  const current = await db.prepare('SELECT id, sent_on, status, series, issuer_profile, issuer_snapshot, vat_treatment FROM invoices WHERE id = ?').bind(id).first();
  if (!current) return null;
  if (current.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'issuer_profile');
  if (current.sent_on) throw new ValidationError('this invoice was already sent with its issuer on it', 'issuer_profile');
  if (current.status === 'void') throw new ValidationError('this invoice is void', 'status');
  const { sets, args } = await issuerProfileSets(db, { issuer_profile: profileId }, current);
  return withBalance(db, await db.prepare(
    `UPDATE invoices SET ${[...sets, 'updated_at = ?'].join(', ')} WHERE id = ? RETURNING ${INVOICE_COLUMNS}`,
  ).bind(...args, nowIso(), id).first());
}

function assertBankAccountId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(value)) {
    throw new ValidationError('bank_account must be the id of one of your accounts', 'bank_account');
  }
  return value;
}

async function assertBankAccountKnown(db, value) {
  if (value === undefined || value === null) return;
  assertBankAccountId(value);
  const accounts = await getBankAccounts(db);
  if (!accounts.some((a) => a.id === value)) throw new ValidationError(`no bank account "${value}"`, 'bank_account');
  if (accounts.find((a) => a.id === value)?.closed) throw new ValidationError(`the account "${value}" is closed`, 'bank_account');
}

/** Which account an invoice asks to be paid into — on a draft, or on an
 *  issued invoice that has not been sent yet. Once it is sent, the client
 *  holds a copy with that account on it, and HQ's copy must not differ. */
export async function setInvoiceBankAccount(db, id, accountId) {
  assertId(id);
  if (accountId === undefined) throw new ValidationError('bank_account is required', 'bank_account');
  await assertBankAccountKnown(db, accountId);
  const current = await db.prepare('SELECT id, sent_on, status, series, issuer_profile FROM invoices WHERE id = ?').bind(id).first();
  if (!current) return null;
  if (current.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'bank_account');
  if (current.issuer_profile && accountId !== PAY_ACCOUNT) {
    throw new ValidationError('an invoice with an issuer profile is always paid into Wise', 'bank_account');
  }
  if (current.sent_on) throw new ValidationError('this invoice was already sent with its account on it', 'bank_account');
  if (current.status === 'void') throw new ValidationError('this invoice is void', 'status');
  return withBalance(db, await db.prepare(
    `UPDATE invoices SET bank_account = ?, updated_at = ? WHERE id = ? RETURNING ${INVOICE_COLUMNS}`,
  ).bind(assertBankAccountId(accountId), nowIso(), id).first());
}

function assertVatTreatment(value) {
  if (!Object.prototype.hasOwnProperty.call(VAT_TREATMENTS, value)) {
    throw new ValidationError(`vat_treatment must be one of ${Object.keys(VAT_TREATMENTS).join(', ')}`, 'vat_treatment');
  }
  return value;
}

/** €100,000,000.00. Far above any invoice this agency will ever write, far
 *  below 2^53, so every cents figure stays exactly representable through the
 *  arithmetic below. */
const CENTS_MAX = 10_000_000_000;
const QTY_MAX = 1_000_000;
/** A quantity is hours, days or units — four decimal places is already more
 *  precision than any of those are ever billed in. */
const QTY_MAX_DECIMALS = 4;

/** Every cents figure this module binds or computes. Integer, non-negative,
 *  and inside CENTS_MAX — a float in a money column is a corrupt invoice. */
function assertCents(value, field) {
  if (!Number.isInteger(value)) throw new ValidationError(`${field} must be a whole number of cents`, field);
  if (value < 0) throw new ValidationError(`${field} must not be negative`, field);
  if (value > CENTS_MAX) throw new ValidationError(`${field} must be at most ${CENTS_MAX} cents`, field);
  return value;
}

/** A TEXT column takes text or nothing. Anything else (an object, a number, a
 *  boolean) binds without complaint and is read back as something the screen
 *  never expected, so it is refused by name here. */
function requireTextOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text or null`, field);
  return value;
}

/** The same, for a NOT NULL text column. `requireTextOrNull` answers null for
 *  an explicit null, which then reaches SQLite as a constraint failure — a 500
 *  where naming the field is a 400. `invoices.subject/currency/notes` and
 *  `clients.country` are NOT NULL, so they come through here instead. */
function requireText(value, field) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  return value;
}

/** The client's letters in an invoice number: Aubin is `L`, Lumen `SC`.
 *
 *  Letters only, one to four, NO DOTS. The format is
 *  `<n>.R.A.<letters>.<NN>` and the `A` in it is Andy — it is fixed, part of
 *  the format, and was never the client's. Aubin's initials used to be
 *  stored as `A.L` because the old format was `<n>.R.<initials>.<NN>` and the
 *  A had to be smuggled through them; the printed number is the same either
 *  way, which is exactly why it went unnoticed. A dot in the stored initials
 *  now makes an unparseable number, so it is refused. */
const INITIALS_RE = /^[A-Za-z]{1,4}$/;

function requireInitialsOrNull(value, field = 'initials') {
  const text = requireTextOrNull(value, field);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!INITIALS_RE.test(trimmed)) {
    throw new ValidationError(`${field} must be 1-4 letters, no dots — the A in the number is fixed`, field);
  }
  return trimmed;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Dates are stored and compared as text: '2026-9-5' binds happily and then
 *  sorts before '2026-10-01' and after '2026-12-01' forever, so due dates and
 *  the overdue total silently go wrong. The shape is checked, and then that it
 *  is a real calendar day — 2026-02-30 matches the regex but does not exist. */
function requireDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD form`, field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} is not a real date`, field);
  }
  return value;
}

/** One source of "today", matching nowIso()'s clock so financeOverview and
 *  issueInvoice never disagree about what day it is. */
function todayDate() {
  return hqToday();
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* --- Clients ------------------------------------------------------------ */

const CLIENT_COLUMNS = 'id, name, initials, slug, email, address, country, vat_number, company_reg, notes, archive_key, created_at';
const CLIENT_WRITABLE = Object.freeze(['name', 'initials', 'slug', 'email', 'address', 'country', 'vat_number', 'company_reg']);

export async function listClients(db) {
  const { results } = await db.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients ORDER BY name ASC`).bind().all();
  return results ?? [];
}

export async function createClient(db, input = {}) {
  const name = requireString(input.name, 'name');
  const at = nowIso();

  return db.prepare(
    `INSERT INTO clients (name, initials, slug, email, address, country, vat_number, company_reg, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${CLIENT_COLUMNS}`,
  ).bind(
    name,
    requireInitialsOrNull(input.initials),
    requireTextOrNull(input.slug, 'slug'),
    requireTextOrNull(input.email, 'email'),
    requireTextOrNull(input.address, 'address'),
    typeof input.country === 'string' && input.country ? input.country : 'BE',
    requireTextOrNull(input.vat_number, 'vat_number'),
    requireTextOrNull(input.company_reg, 'company_reg'),
    at,
  ).first();
}

export async function updateClient(db, id, patch = {}) {
  assertId(id);

  const sets = [];
  const args = [];

  for (const field of CLIENT_WRITABLE) {
    if (patch[field] === undefined) continue;
    if (field === 'name') { sets.push('name = ?'); args.push(requireString(patch.name, 'name')); continue; }
    if (field === 'initials') { sets.push('initials = ?'); args.push(requireInitialsOrNull(patch.initials)); continue; }
    // country is NOT NULL: an explicit null is refused by name rather than
    // handed to SQLite as a constraint failure.
    if (field === 'country') { sets.push('country = ?'); args.push(requireText(patch.country, 'country')); continue; }
    sets.push(`${field} = ?`);
    args.push(requireTextOrNull(patch[field], field));
  }

  if (!sets.length) throw new ValidationError('nothing to update', 'patch');
  args.push(id);

  return db.prepare(
    `UPDATE clients SET ${sets.join(', ')} WHERE id = ? RETURNING ${CLIENT_COLUMNS}`,
  ).bind(...args).first();
}

/* --- Invoices ------------------------------------------------------------ */

const INVOICE_COLUMNS = [
  'id', 'number', 'series', 'seq', 'year', 'client_id', 'slug', 'subject', 'po_number', 'status',
  'issued_on', 'due_on', 'sent_on', 'paid_on', 'currency', 'vat_treatment',
  'subtotal_cents', 'vat_cents', 'total_cents', 'kind', 'request_cents', 'parent_id',
  'notes', 'bank_account', 'billed_to', 'issuer_entity', 'issuer_profile', 'issuer_snapshot', 'source', 'chase_snoozed_until', 'created_at', 'updated_at',
].join(', ');

const INVOICE_WRITABLE = Object.freeze([
  'client_id', 'slug', 'subject', 'po_number', 'vat_treatment', 'currency',
  'kind', 'request_cents', 'notes', 'bank_account',
]);

const INVOICE_KINDS = Object.freeze(['invoice', 'prepayment']);

const LINE_COLUMNS = 'id, invoice_id, description, quantity, unit_cents, amount_cents, no_charge, position';

const PAYMENT_COLUMNS = 'id, invoice_id, amount_cents, paid_on, label, method, bank_account, reference, source, created_at';

/** What has been paid against an invoice, in SQL, from the payments rows.
 *  Every read derives it; nothing stores it, so it can never disagree with
 *  the payments. `table` is the name or alias the enclosing statement gives
 *  `invoices` — it is never caller data, only a literal from this module. */
const paidCentsSql = (table = 'invoices') =>
  `(SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.invoice_id = ${table}.id)`;

/** What this invoice ASKS FOR — the whole total, or a prepayment's
 *  `request_cents`. The difference is the whole point of `kind`: on
 *  5.R.A.L.01 the total is €3000.00 but only €1700.00 was ever asked for, so
 *  only €1700.00 could ever be owed or overdue on it. */
const requestedCentsSql = (table = 'invoices') =>
  `COALESCE(${table}.request_cents, ${table}.total_cents)`;

/** Still owed NOW: what was asked for, minus what was paid. Never negative in
 *  practice — recordPayment refuses a payment above it. */
const dueCentsSql = (table = 'invoices') =>
  `(${requestedCentsSql(table)} - ${paidCentsSql(table)})`;

/** Totals of this invoice's issued children (a part-2 invoice points back at
 *  its parent). Money that has moved onto another document is no longer
 *  waiting to be invoiced here. */
const issuedChildrenCentsSql = (table = 'invoices') =>
  `(SELECT COALESCE(SUM(ch.total_cents), 0) FROM invoices ch
     WHERE ch.parent_id = ${table}.id AND ch.number IS NOT NULL AND ch.status != 'void')`;

/** The same, but counting a child that exists and is not void even if it has
 *  not been issued yet. Only `createPartInvoice` uses it, and it must: a
 *  draft part 2 is invisible to the figure above (correctly — nobody has been
 *  sent it), so drafting from that figure twice would hand the client the
 *  same €1300.00 balance on two invoices, and issuing both would bill €4300.00
 *  on a €3000.00 project. What may still be drafted is the remainder after
 *  every child that already exists. */
const childrenInFlightCentsSql = (table = 'invoices') =>
  `(SELECT COALESCE(SUM(ch.total_cents), 0) FROM invoices ch
     WHERE ch.parent_id = ${table}.id AND ch.status != 'void')`;

/** The part of a prepayment's project that has not been asked for on any
 *  invoice yet — €1300.00 (part 2) on 5.R.A.L.01, and 0 the moment part 2 is
 *  issued. Reported on its own; never counted as outstanding or overdue. */
const notYetRequestedCentsSql = (table = 'invoices') =>
  `MAX(${table}.total_cents - ${requestedCentsSql(table)} - ${issuedChildrenCentsSql(table)}, 0)`;

/** An invoice is settled when its payments cover what it asked for — never
 *  when a flag says so. The `> 0` keeps a €0 invoice with no payments out. */
const settledSql = (table = 'invoices') =>
  `(${paidCentsSql(table)} >= ${requestedCentsSql(table)} AND ${paidCentsSql(table)} > 0)`;

/** The net amount whose total, under `vatTreatment`, is exactly `grossCents`
 *  (audit A3). The balance of a prepayment is worked out from VAT-inclusive
 *  totals, but an invoice line is net: taking the gross as the line added VAT
 *  a second time. Where no net amount lands on the cent, the largest one that
 *  stays at or under the gross is used, so a client is never asked for more. */
export function netForGross(grossCents, vatTreatment) {
  const gross = Number(grossCents);
  const rate = VAT_TREATMENTS[vatTreatment]?.rate ?? 0;
  if (!rate) return gross;
  const guess = Math.round((gross * 100) / (100 + rate));
  let best = null;
  for (let net = guess - 3; net <= guess + 3; net += 1) {
    if (net < 0) continue;
    const total = net + Number(divideHalfUp(BigInt(net) * BigInt(rate), 100n));
    if (total === gross) return net;
    if (total < gross && (best === null || net > best)) best = net;
  }
  return best ?? 0;
}

/** The read projection: every stored column plus the derived money figures.
 *  Not usable in RETURNING — SQLite forbids subqueries there — so mutations
 *  go through `withBalance` instead.
 *
 *  `due_cents` is what the client owes on this invoice today; `balance_cents`
 *  is what is left of the whole project on it (they differ only on a
 *  prepayment, where the rest is a later invoice, not a debt). */
const INVOICE_READ_COLUMNS = [
  INVOICE_COLUMNS,
  `${paidCentsSql()} AS paid_cents`,
  `${requestedCentsSql()} AS requested_cents`,
  `${dueCentsSql()} AS due_cents`,
  `total_cents - ${paidCentsSql()} AS balance_cents`,
  `${notYetRequestedCentsSql()} AS not_yet_requested_cents`,
  // Which account(s) the money arrived in — the payments' own, not the one
  // the invoice asked for (Lumen paid into KBC invoices that asked Wise).
  `(SELECT group_concat(DISTINCT COALESCE(p.bank_account, p.method)) FROM payments p WHERE p.invoice_id = invoices.id) AS paid_into`,
].join(', ');

/** draft (no number) -> issued -> sent (has sent_on) -> paid (payments cover
 *  the total); void overrides all of it. Never stored — computed here, at read
 *  time, every time, so it can never go stale. */
function withComputedStatus(row, day) {
  const paidCents = Number(row.paid_cents ?? 0);
  const requestedCents = Number(row.requested_cents ?? row.request_cents ?? row.total_cents);
  const dueCents = Number(row.due_cents ?? (requestedCents - paidCents));
  const balanceCents = Number(row.balance_cents ?? (row.total_cents - paidCents));
  const settled = paidCents > 0 && dueCents <= 0;

  let computedStatus = 'void';
  if (row.status !== 'void') {
    if (!row.number) computedStatus = 'draft';
    else if (settled) computedStatus = 'paid';
    else if (row.sent_on) computedStatus = 'sent';
    else computedStatus = 'issued';
  }

  // An archive invoice (series 'archive', imported from before HQ) that no
  // payment covers is not a debt HQ knows about: its payment was simply not
  // found in the bank records that exist. It is "payment not proven", never
  // overdue, and it stays out of Outstanding and Overdue.
  const archive = row.series === ARCHIVE_SERIES;
  if (archive && computedStatus !== 'void' && computedStatus !== 'paid') computedStatus = 'unproven';

  const overdue = row.status !== 'void' && !archive
    && !!row.due_on && row.due_on < day && !settled;

  // The rate and the printed tax line travel with the invoice: they belong to
  // its treatment, and the screen that prints them must not keep a second copy
  // of the wording. Derived on every read, like every figure above.
  const treatment = VAT_TREATMENTS[row.vat_treatment] ?? VAT_TREATMENTS.reverse_charge;

  return {
    ...row,
    paid_cents: paidCents,
    requested_cents: requestedCents,
    due_cents: dueCents,
    balance_cents: balanceCents,
    not_yet_requested_cents: Number(row.not_yet_requested_cents ?? Math.max(row.total_cents - requestedCents, 0)),
    vat_rate: treatment.rate,
    vat_mention: treatment.mention,
    computed_status: computedStatus,
    overdue,
    archive,
  };
}

const INVOICE_STATUS_FILTERS = Object.freeze({
  draft: 'number IS NULL',
  issued: `number IS NOT NULL AND sent_on IS NULL AND status != 'void' AND NOT ${settledSql()}`,
  sent: `sent_on IS NOT NULL AND status != 'void' AND NOT ${settledSql()}`,
  paid: `status != 'void' AND ${settledSql()}`,
  void: "status = 'void'",
});

export async function listInvoices(db, filter = {}) {
  const where = [];
  const args = [];

  if (filter.client_id !== undefined) { where.push('client_id = ?'); args.push(requireInt(filter.client_id, 'client_id')); }
  if (filter.year !== undefined) { where.push('year = ?'); args.push(requireInt(filter.year, 'year')); }
  // The project an invoice belongs to: the same slug the registry and the
  // project page use, so "the website I am making" and "the invoice for it"
  // are one thing in two places.
  if (filter.slug !== undefined) { where.push('slug = ?'); args.push(requireString(filter.slug, 'slug')); }

  const day = todayDate();
  if (filter.status !== undefined) {
    if (filter.status === 'overdue') {
      where.push(`number IS NOT NULL AND due_on IS NOT NULL AND due_on < ? AND status != 'void' AND series != 'archive' AND NOT ${settledSql()}`);
      args.push(day);
    } else if (INVOICE_STATUS_FILTERS[filter.status]) {
      where.push(INVOICE_STATUS_FILTERS[filter.status]);
    } else {
      const allowed = [...Object.keys(INVOICE_STATUS_FILTERS), 'overdue'].join(', ');
      throw new ValidationError(`status must be one of ${allowed}`, 'status');
    }
  }

  const sql = `SELECT ${INVOICE_READ_COLUMNS} FROM invoices`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY id DESC';

  const { results } = await db.prepare(sql).bind(...args).all();
  return (results ?? []).map((row) => withComputedStatus(row, day));
}

export async function getInvoice(db, id) {
  assertId(id);

  const invoice = await db.prepare(`SELECT ${INVOICE_READ_COLUMNS} FROM invoices WHERE id = ?`).bind(id).first();
  if (!invoice) return null;

  const client = await db.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients WHERE id = ?`).bind(invoice.client_id).first();
  const { results: lines } = await db.prepare(
    `SELECT ${LINE_COLUMNS} FROM invoice_lines WHERE invoice_id = ? ORDER BY position ASC, id ASC`,
  ).bind(id).all();
  const { results: payments } = await db.prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE invoice_id = ? ORDER BY paid_on ASC, id ASC`,
  ).bind(id).all();

  return {
    ...withComputedStatus(invoice, todayDate()),
    client: client ?? null,
    lines: lines ?? [],
    payments: payments ?? [],
  };
}

/** ONE shape for an invoice, whether it was read or just written.
 *
 *  A mutation returns its row through `UPDATE ... RETURNING`, where SQLite
 *  allows no subquery, so the derived figures cannot ride along with it. They
 *  are fetched by one extra bound SELECT — the same expressions
 *  INVOICE_READ_COLUMNS uses — and the row then goes through
 *  `withComputedStatus` exactly as a read does. Anything less and a screen
 *  that re-renders from a mutation response gets a row with no
 *  `computed_status`, no `overdue` and no `not_yet_requested_cents`, which
 *  silently changes the next time it refetches. */
async function withBalance(db, row) {
  if (!row) return row;
  const derived = await db.prepare(
    `SELECT ${paidCentsSql()} AS paid_cents, ${requestedCentsSql()} AS requested_cents,
            ${dueCentsSql()} AS due_cents, total_cents - ${paidCentsSql()} AS balance_cents,
            ${notYetRequestedCentsSql()} AS not_yet_requested_cents,
            (SELECT group_concat(DISTINCT COALESCE(p.bank_account, p.method)) FROM payments p WHERE p.invoice_id = invoices.id) AS paid_into
     FROM invoices WHERE id = ?`,
  ).bind(row.id).first();

  const paidCents = Number(derived?.paid_cents ?? 0);
  const requestedCents = Number(derived?.requested_cents ?? row.request_cents ?? row.total_cents);
  return withComputedStatus({
    ...row,
    paid_cents: paidCents,
    requested_cents: requestedCents,
    due_cents: Number(derived?.due_cents ?? (requestedCents - paidCents)),
    balance_cents: Number(derived?.balance_cents ?? (row.total_cents - paidCents)),
    not_yet_requested_cents: Number(derived?.not_yet_requested_cents ?? 0),
    paid_into: derived?.paid_into ?? null,
  }, todayDate());
}

/** 'invoice' (asks for the whole total) or 'prepayment' (asks for part of a
 *  project now — `request_cents`). Matches the CHECK in 0006. */
function assertKind(value) {
  if (!INVOICE_KINDS.includes(value)) {
    throw new ValidationError(`kind must be one of ${INVOICE_KINDS.join(', ')}`, 'kind');
  }
  return value;
}

/** The amount asked for now. NULL means the whole total, which is what an
 *  ordinary invoice always asks for — so a number here only makes sense on a
 *  prepayment, and the pair is checked together rather than each alone. */
function assertRequestCents(value, kind) {
  if (value === null || value === undefined) return null;
  assertCents(value, 'request_cents');
  if (value <= 0) throw new ValidationError('request_cents must be more than zero', 'request_cents');
  if (kind !== 'prepayment') {
    throw new ValidationError("request_cents is only for kind 'prepayment'", 'request_cents');
  }
  return value;
}

/** `series` is deliberately absent from the INSERT: the column's DEFAULT in
 *  0007 is the live series, so a new draft joins it without this module
 *  naming it, and the closed `agency` series can only ever be set by the
 *  one-off data statement that set it on 5.R.A.L.01. */
export async function createInvoice(db, input = {}) {
  const clientId = requireInt(input.client_id, 'client_id');
  const vatTreatment = assertVatTreatment(input.vat_treatment ?? 'reverse_charge');
  const kind = assertKind(input.kind ?? 'invoice');
  const requestCents = assertRequestCents(input.request_cents, kind);
  const at = nowIso();

  // A draft belongs to its client's project unless it is told otherwise. An
  // explicit null still means "no project" — only an omitted slug inherits.
  let slug = requireTextOrNull(input.slug, 'slug');
  if (input.slug === undefined) {
    const client = await db.prepare('SELECT slug FROM clients WHERE id = ?').bind(clientId).first();
    slug = client?.slug ?? null;
  }

  return db.prepare(
    `INSERT INTO invoices (
       number, seq, year, client_id, slug, subject, po_number, status,
       issued_on, due_on, sent_on, paid_on, currency, vat_treatment,
       subtotal_cents, vat_cents, total_cents, kind, request_cents, notes, created_at, updated_at
     )
     VALUES (NULL, NULL, NULL, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
     RETURNING ${INVOICE_COLUMNS}`,
  ).bind(
    clientId,
    slug,
    typeof input.subject === 'string' ? input.subject : '',
    requireTextOrNull(input.po_number, 'po_number'),
    typeof input.currency === 'string' && input.currency ? input.currency : 'EUR',
    vatTreatment,
    kind,
    requestCents,
    typeof input.notes === 'string' ? input.notes : '',
    at,
    at,
  ).first();
}

/** Drafts only — a number means it was issued, and an issued invoice's terms
 *  do not change retroactively.
 *
 *  Changing `vat_treatment` changes the money: the stored vat_cents and
 *  total_cents were derived by setInvoiceLines from the *previous* treatment.
 *  Left alone they go stale, and a draft flipped from reverse_charge to
 *  standard would be issued printing "VAT 21%" against €0,00 and a total
 *  short by the whole VAT. So whenever the treatment is in the patch the
 *  totals are recomputed here, from the lines already stored, by the same
 *  helper setInvoiceLines uses. */
/** The header half of a draft edit: which columns the patch touches and what
 *  to bind for them, validated. Shared by `updateInvoice` (header alone) and
 *  `saveInvoice` (header and lines in one batch), so the two can never drift
 *  on what a field means or which refusal it earns. */
function invoiceHeaderSets(patch, current) {
  const sets = [];
  const args = [];
  const kind = patch.kind === undefined ? current.kind : assertKind(patch.kind);

  for (const field of INVOICE_WRITABLE) {
    if (patch[field] === undefined) continue;
    if (field === 'client_id') { sets.push('client_id = ?'); args.push(requireInt(patch.client_id, 'client_id')); continue; }
    if (field === 'vat_treatment') { sets.push('vat_treatment = ?'); args.push(assertVatTreatment(patch.vat_treatment)); continue; }
    if (field === 'kind') { sets.push('kind = ?'); args.push(kind); continue; }
    if (field === 'request_cents') { sets.push('request_cents = ?'); args.push(assertRequestCents(patch.request_cents, kind)); continue; }
    if (field === 'bank_account') { sets.push('bank_account = ?'); args.push(assertBankAccountId(patch.bank_account)); continue; }
    // NOT NULL in 0003/0005: an explicit null is refused by name here rather
    // than reaching SQLite as a constraint failure.
    if (field === 'subject' || field === 'currency' || field === 'notes') {
      sets.push(`${field} = ?`);
      args.push(requireText(patch[field], field));
      continue;
    }
    sets.push(`${field} = ?`);
    args.push(requireTextOrNull(patch[field], field));
  }

  // Going back to an ordinary invoice drops the amount only a prepayment can
  // carry, so the pair can never be left contradicting itself.
  if (kind === 'invoice' && patch.request_cents === undefined && current.request_cents !== null) {
    sets.push('request_cents = NULL');
  }

  return { sets, args, kind };
}

export async function updateInvoice(db, id, patch = {}) {
  assertId(id);

  const current = await db.prepare('SELECT id, number, kind, request_cents, vat_treatment, issuer_profile, issuer_snapshot FROM invoices WHERE id = ?').bind(id).first();
  if (!current) return null;
  if (current.number !== null) throw new ValidationError('only a draft invoice can be edited', 'status');
  await assertBankAccountKnown(db, patch.bank_account);
  const issuerPart = await issuerProfileSets(db, patch, current);

  const { sets, args } = invoiceHeaderSets(patch, current);
  sets.push(...issuerPart.sets);
  args.push(...issuerPart.args);

  if (!sets.length) throw new ValidationError('nothing to update', 'patch');

  if (patch.vat_treatment !== undefined) {
    const { results: storedLines } = await db.prepare(
      'SELECT amount_cents FROM invoice_lines WHERE invoice_id = ?',
    ).bind(id).all();
    const totals = invoiceTotals((storedLines ?? []).map((l) => l.amount_cents), patch.vat_treatment);
    sets.push('subtotal_cents = ?', 'vat_cents = ?', 'total_cents = ?');
    args.push(totals.subtotal_cents, totals.vat_cents, totals.total_cents);
  }

  sets.push('updated_at = ?');
  args.push(nowIso());
  args.push(id);

  return withBalance(db, await db.prepare(
    `UPDATE invoices SET ${sets.join(', ')} WHERE id = ? RETURNING ${INVOICE_COLUMNS}`,
  ).bind(...args).first());
}

/** Ties an issued invoice to its project. Only the slug, and only while it
 *  has none: the project is HQ's own bookkeeping and is never printed, so it
 *  may be filled in after issuing (Accept quote does), but an invoice is never
 *  moved from one project to another. True when it was linked. */
export async function linkInvoiceProject(db, id, slug) {
  assertId(id);
  const row = await db.prepare(
    'UPDATE invoices SET slug = ?, updated_at = ? WHERE id = ? AND slug IS NULL RETURNING id',
  ).bind(requireString(slug, 'slug'), nowIso(), id).first();
  return Boolean(row);
}

/** Exact half-up division of non-negative integers, in BigInt.
 *  floor((2n + d) / 2d) is half-up for n >= 0: a remainder of exactly half
 *  goes up. BigInt because qty-scaled x unit_cents can exceed 2^53 before the
 *  divide brings it back inside it, and money may not be approximate. */
function divideHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** How many decimal places `qty` actually has. Refuses more than
 *  QTY_MAX_DECIMALS (and any exponential form, which is always finer than
 *  that) rather than silently rounding a quantity the caller meant. */
function quantityDecimals(qty, index) {
  const text = String(qty);
  if (/e/i.test(text)) {
    throw new ValidationError(
      `lines[${index}].quantity must have at most ${QTY_MAX_DECIMALS} decimal places`,
      `lines[${index}].quantity`,
    );
  }
  const dot = text.indexOf('.');
  const decimals = dot === -1 ? 0 : text.length - dot - 1;
  if (decimals > QTY_MAX_DECIMALS) {
    throw new ValidationError(
      `lines[${index}].quantity must have at most ${QTY_MAX_DECIMALS} decimal places`,
      `lines[${index}].quantity`,
    );
  }
  return decimals;
}

/** ROUNDING POLICY: half-up on the *exact decimal value* of qty x unit_cents.
 *
 *  `Math.round(qty * unitCents)` rounds the binary float, not the number the
 *  client agreed to: 0.29 x 50 is 14.499999999999998 in IEEE-754, so it gives
 *  14 where the exact decimal 14.5 rounds up to 15. A cent is a cent on a
 *  legal document, so the arithmetic is done in integers instead: qty is
 *  scaled to a whole number by its own decimal places (at most four), the
 *  multiplication happens in BigInt, and the quotient is rounded half up —
 *  ties always away from zero, which for these always-non-negative amounts
 *  means up. Half-up (not banker's rounding) because it is what the printed
 *  invoices and the accountant already assume.
 *
 *  qty is the only non-integer ever legitimately bound in this module — the
 *  schema declares `quantity REAL`. Every cents figure is always an integer. */
function lineAmountCents(qty, unitCents, index) {
  const decimals = quantityDecimals(qty, index);
  const scale = 10 ** decimals;
  // Exact: qty has `decimals` places, so qty * scale is a whole number and the
  // float is within half an ULP of it well below 2^53.
  const scaledQty = Math.round(qty * scale);
  const sign = unitCents < 0 ? -1 : 1;
  const amount = Number(divideHalfUp(BigInt(scaledQty) * BigInt(Math.abs(unitCents)), BigInt(scale)));
  return sign * assertCents(amount, `lines[${index}].amount_cents`);
}

/** The one place subtotal / VAT / total are derived from a set of line
 *  amounts. setInvoiceLines calls it with the lines it is about to write;
 *  updateInvoice calls it with the lines already stored. Anything that can
 *  change the treatment goes through here, so vat_cents can never be left
 *  behind by the treatment it was computed from. */
function invoiceTotals(amountsCents, vatTreatment) {
  const subtotalCents = amountsCents.reduce((sum, cents) => sum + cents, 0);
  if (subtotalCents < 0) throw new ValidationError('The deductions are larger than the invoice: the total cannot go below zero', 'lines');
  assertCents(subtotalCents, 'subtotal_cents');
  const rate = VAT_TREATMENTS[vatTreatment]?.rate ?? 0;
  // Same half-up-on-the-exact-value policy as a line amount.
  const vatCents = Number(divideHalfUp(BigInt(subtotalCents) * BigInt(rate), 100n));
  const totalCents = subtotalCents + vatCents;
  assertCents(vatCents, 'vat_cents');
  assertCents(totalCents, 'total_cents');
  return { subtotal_cents: subtotalCents, vat_cents: vatCents, total_cents: totalCents };
}

/** ONE name for the quantity: `quantity`, as the column and every read call
 *  it, and as every refusal names it (`lines[0].quantity`). A form that keys
 *  its highlighting off `error.field` needs one string per control, not two.
 *  `qty` is still accepted as an input alias so a caller written against the
 *  older shape keeps working, but nothing answers in it. */
function assertInvoiceLine(line, index) {
  const description = requireString(line?.description, `lines[${index}].description`);
  const field = `lines[${index}].quantity`;
  const quantity = line.quantity === undefined ? line.qty : line.quantity;

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new ValidationError(`${field} must be a positive number`, field);
  }
  if (quantity > QTY_MAX) {
    throw new ValidationError(`${field} must be at most ${QTY_MAX}`, field);
  }
  // A negative price is a deduction line (« prepayment already paid: -€1,600 »).
  // The invoice as a whole still never goes below zero: invoiceTotals refuses it.
  const unitField = `lines[${index}].unit_cents`;
  assertCents(Number.isInteger(line.unit_cents) ? Math.abs(line.unit_cents) : line.unit_cents, unitField);
  // Checked even for a no-charge line: the quantity is still stored and still
  // printed, so an unrepresentable one is refused rather than quietly kept.
  quantityDecimals(quantity, index);

  const noCharge = line.no_charge ? 1 : 0;
  // A no-charge line prints "NO CHARGE" rather than €0,00 — it still costs
  // the client nothing, so it never contributes to the subtotal.
  const amountCents = noCharge ? 0 : lineAmountCents(quantity, line.unit_cents, index);

  return { description, quantity, unit_cents: line.unit_cents, amount_cents: amountCents, no_charge: noCharge };
}

/** Drafts only. Replaces every line and recomputes subtotal/vat/total in
 *  cents from the invoice's current vat_treatment. */
export async function setInvoiceLines(db, id, lines = []) {
  assertId(id);
  if (!Array.isArray(lines) || !lines.length) throw new ValidationError('at least one line is required', 'lines');

  const current = await db.prepare('SELECT id, number, vat_treatment FROM invoices WHERE id = ?').bind(id).first();
  if (!current) return null;
  if (current.number !== null) throw new ValidationError('only a draft invoice can have its lines set', 'status');

  const clean = lines.map((line, index) => assertInvoiceLine(line, index));
  // Before anything is deleted: deductions that take the total below zero are refused
  // with the invoice's old lines still in place.
  const totals = invoiceTotals(clean.map((l) => l.amount_cents), current.vat_treatment);

  await db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').bind(id).run();

  for (let i = 0; i < clean.length; i += 1) {
    const line = clean[i];
    // eslint-disable-next-line no-await-in-loop -- lines are few and order (position) matters
    await db.prepare(
      `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_cents, amount_cents, no_charge, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, line.description, line.quantity, line.unit_cents, line.amount_cents, line.no_charge, i).run();
  }

  const at = nowIso();

  const updated = await db.prepare(
    `UPDATE invoices SET subtotal_cents = ?, vat_cents = ?, total_cents = ?, updated_at = ?
     WHERE id = ? RETURNING ${INVOICE_COLUMNS}`,
  ).bind(totals.subtotal_cents, totals.vat_cents, totals.total_cents, at, id).first();

  // The lines echoed here are the ones just written, in the shape every read
  // gives them — `quantity`, not `qty` — so a caller never has to know which
  // call produced the row it is holding.
  return {
    ...await withBalance(db, updated),
    lines: clean.map((l, i) => ({ ...l, invoice_id: id, position: i })),
  };
}

/**
 * A whole draft — header and lines — written in ONE D1 batch.
 *
 * Review finding H2: the screen used to PATCH the header and then PUT the
 * lines as two separate requests. When the second was refused (a 400 on
 * `lines[0].quantity`, a dropped connection) the first had already landed and
 * the totals had already been recomputed against the new treatment, so the
 * invoice was half-saved while the screen said nothing had been. `db.batch`
 * runs its statements inside one transaction, so either both halves land or
 * neither does.
 *
 * Everything is validated before a single statement is built: an invalid line
 * throws with the field it names and nothing has been written.
 */
export async function saveInvoice(db, id, patch = {}, lines) {
  assertId(id);
  if (!Array.isArray(lines) || !lines.length) throw new ValidationError('at least one line is required', 'lines');

  const current = await db.prepare(
    'SELECT id, number, kind, request_cents, vat_treatment, issuer_profile, issuer_snapshot FROM invoices WHERE id = ?',
  ).bind(id).first();
  if (!current) return null;
  if (current.number !== null) throw new ValidationError('only a draft invoice can be edited', 'status');
  await assertBankAccountKnown(db, patch.bank_account);
  const issuerPart = await issuerProfileSets(db, patch, current);

  const { sets, args } = invoiceHeaderSets(patch, current);
  sets.push(...issuerPart.sets);
  args.push(...issuerPart.args);
  const clean = lines.map((line, index) => assertInvoiceLine(line, index));

  // The lines about to be written, against the treatment about to be stored —
  // not the one on the row now, which is exactly the staleness H2 describes.
  const treatment = patch.vat_treatment === undefined ? current.vat_treatment : patch.vat_treatment;
  const totals = invoiceTotals(clean.map((l) => l.amount_cents), treatment);
  sets.push('subtotal_cents = ?', 'vat_cents = ?', 'total_cents = ?', 'updated_at = ?');
  args.push(totals.subtotal_cents, totals.vat_cents, totals.total_cents, nowIso());
  args.push(id);

  const statements = [
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').bind(id),
    ...clean.map((line, i) => db.prepare(
      `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_cents, amount_cents, no_charge, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, line.description, line.quantity, line.unit_cents, line.amount_cents, line.no_charge, i)),
    db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).bind(...args),
  ];

  await db.batch(statements);
  return getInvoice(db, id);
}

/** Allocates `<n>.R.A.<CLIENT LETTERS>.<NN>` and flips a draft to issued, all
 *  inside one UPDATE.
 *
 *  The format, as the owner states it finally (addendum 4, 2026-09-21):
 *  `n` is the invoice's number within its year and series; `R` is Realis;
 *  `A` is Andy and is FIXED — it is not the client's letter; the client's
 *  letters follow (Aubin `L`, Lumen `SC`); `NN` is that client's
 *  running index, all time, across every series.
 *
 *  `seq` therefore counts within (series, year): COALESCE(MAX(seq), 0) + 1
 *  over the rows of this invoice's own series and year, which is what the
 *  unique index in 0007 is on. The series exists because the numbering starts
 *  over: 5.R.A.L.01 was issued as Realis *Agency* and stays in the `agency`
 *  series; every invoice from now is `studio` and the first of them is 1.
 *  So Aubin's next in 2026 is 1.R.A.L.02, and a new client Lumen issued
 *  after it is 2.R.A.SC.01.
 *
 *  `NN` is that client's invoice count + 1, zero-padded to two digits by
 *  SQLite's printf, from a subquery over this client's numbered invoices —
 *  void ones included, because a number is never reused.
 *
 *  Both counters are subqueries inside the same statement, never a prior read
 *  in JS, and the statement is guarded by `WHERE number IS NULL`: two
 *  concurrent issues cannot collide, and a second attempt affects no row
 *  instead of reissuing under a new number. */
export async function issueInvoice(db, id, on) {
  assertId(id);
  if (on !== undefined && on !== null) requireDate(on, 'on');

  const current = await db.prepare(
    `SELECT i.id, i.client_id, i.vat_treatment, c.initials, c.vat_number,
            (SELECT p.number FROM invoices p WHERE p.id = i.parent_id AND p.number IS NOT NULL) AS parent_number
     FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE i.id = ?`,
  ).bind(id).first();
  if (!current) return null;

  if (current.vat_treatment === 'reverse_charge' && !current.vat_number) {
    throw new ValidationError("reverse_charge requires the client's VAT number", 'vat_number');
  }

  const initials = requireInitialsOrNull(current.initials);
  if (!initials) throw new ValidationError('the client needs initials before an invoice can be issued', 'initials');

  const issuedOn = on ?? todayDate();
  const year = Number(issuedOn.slice(0, 4));
  const dueOn = addDays(issuedOn, 30);
  const at = nowIso();

  // Written twice: once for the `seq` column, once inside the `number` it is
  // stitched into. Both read the same snapshot within this one statement.
  // Per (series, year) — this invoice's own series, read from its own row, so
  // the statement stays self-contained and no series ever travels in from a
  // request.
  const nextSeq = "(SELECT COALESCE(MAX(v.seq), 0) + 1 FROM invoices v WHERE v.series = invoices.series AND v.year = ?)";
  // Archive invoices keep their printed numbers and are not part of the
  // client's running index: importing 2023–2025 must not move it.
  const nextForClient = "(SELECT COUNT(*) + 1 FROM invoices WHERE client_id = ? AND number IS NOT NULL AND series != 'archive')";

  // A part invoice continues its prepayment's number rather than starting a
  // new one: part 2 of 5.R.A.L.01 is 5.R.A.L.02 — same `n`, the client's next
  // index. It takes no `seq`, so the series counter is not consumed, and the
  // client index alone keeps the number unique.
  if (current.parent_number) {
    const n = String(current.parent_number).split('.')[0];
    const part = await db.prepare(
      `UPDATE invoices
       SET seq = NULL,
           year = ?,
           number = ? || '.R.A.' || ? || '.' || printf('%02d', ${nextForClient}),
           status = 'issued',
           issued_on = ?,
           due_on = ?,
           updated_at = ?
       WHERE id = ? AND number IS NULL
       RETURNING ${INVOICE_COLUMNS}`,
    ).bind(year, n, initials, current.client_id, issuedOn, dueOn, at, id).first();
    if (!part) throw new ValidationError('invoice is already issued', 'status');
    return withBalance(db, part);
  }

  const updated = await db.prepare(
    `UPDATE invoices
     SET seq = ${nextSeq},
         year = ?,
         number = ${nextSeq} || '.R.A.' || ? || '.' || printf('%02d', ${nextForClient}),
         status = 'issued',
         issued_on = ?,
         due_on = ?,
         updated_at = ?
     WHERE id = ? AND number IS NULL
     RETURNING ${INVOICE_COLUMNS}`,
  ).bind(
    year, year, year, initials, current.client_id, issuedOn, dueOn, at, id,
  ).first();

  if (!updated) throw new ValidationError('invoice is already issued', 'status');
  return withBalance(db, updated);
}

/** Reads the row the three transitions below all guard on. `null` means no
 *  such invoice — the only case any of them is allowed to answer with null,
 *  so a refusal is never mistaken for a missing invoice. */
async function invoiceGuardRow(db, id) {
  return db.prepare('SELECT id, number, status, series FROM invoices WHERE id = ?').bind(id).first();
}

/** The same guard row plus what is still owed, for everything that touches
 *  money. The balance is derived from the payments in the same statement, so
 *  it cannot be read from a stale column. */
async function invoiceBalanceRow(db, id) {
  const row = await db.prepare(
    `SELECT id, number, status, kind, total_cents, request_cents,
            ${paidCentsSql()} AS paid_cents, ${requestedCentsSql()} AS requested_cents,
            ${dueCentsSql()} AS due_cents
     FROM invoices WHERE id = ?`,
  ).bind(id).first();
  if (!row) return null;
  const paidCents = Number(row.paid_cents ?? 0);
  const requestedCents = Number(row.requested_cents ?? row.total_cents);
  return {
    ...row,
    paid_cents: paidCents,
    requested_cents: requestedCents,
    due_cents: Number(row.due_cents ?? (requestedCents - paidCents)),
    balance_cents: row.total_cents - paidCents,
  };
}

/** A draft has no number to send, and a void invoice is not owed — both were
 *  silent no-ops returning null, indistinguishable from "no such invoice".
 *  They are refusals, and say so. */
export async function markSent(db, id, on) {
  assertId(id);
  if (on !== undefined && on !== null) requireDate(on, 'on');

  const current = await invoiceGuardRow(db, id);
  if (!current) return null;
  if (current.number === null) throw new ValidationError('only an issued invoice can be marked sent', 'status');
  if (current.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'status');
  if (current.status === 'void') throw new ValidationError('a void invoice cannot be marked sent', 'status');

  const at = nowIso();
  const sentOn = on ?? todayDate();

  return withBalance(db, await db.prepare(
    `UPDATE invoices SET sent_on = ?, updated_at = ?
     WHERE id = ? AND number IS NOT NULL AND status != 'void'
     RETURNING ${INVOICE_COLUMNS}`,
  ).bind(sentOn, at, id).first());
}

/* --- Payments ------------------------------------------------------------ *
 * Invoice 5.R.A.L.01 is why this exists: €3000.00 total, €1700.00 already
 * paid, €1300.00 still owed. `paid_on` alone could only say "paid" or "not
 * paid", which of that invoice is simply false. A payment is a row; what is
 * paid and what is owed are derived from those rows everywhere.
 * ------------------------------------------------------------------------- */

/** Records one payment against an issued invoice. Integer cents, more than
 *  zero, never more than what is still owed — an overpayment is a real event
 *  but not one this module invents a shape for, so it is refused by name
 *  rather than quietly stored. The date is validated like every other date
 *  here; omitted, it is today.
 *
 *  `invoices.paid_on` is then recomputed from the payments in one statement:
 *  the date the invoice became settled, or NULL while it is not. It is a
 *  cache of the payments, never an independent fact. */
/** Puts an overdue invoice out of Home's « Chase » list for `days` days
 *  (audit B7); 0 brings it back now. Only an issued, unvoided invoice. */
export async function snoozeInvoiceChase(db, id, days, today = hqToday()) {
  assertId(id);
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0 || n > 30) throw new ValidationError('days must be a whole number from 0 to 30', 'days');
  const row = await db.prepare('SELECT id, number, status FROM invoices WHERE id = ?').bind(id).first();
  if (!row) return null;
  if (row.number === null) throw new ValidationError('only an issued invoice can be chased', 'status');
  if (row.status === 'void') throw new ValidationError('a void invoice is not chased', 'status');
  const until = n === 0 ? null : addCalendarDays(today, n);
  await db.prepare('UPDATE invoices SET chase_snoozed_until = ?, updated_at = ? WHERE id = ?').bind(until, nowIso(), id).run();
  return getInvoice(db, id);
}

export async function recordPayment(db, invoiceId, input = {}) {
  assertId(invoiceId);

  const amountCents = input?.amount_cents;
  assertCents(amountCents, 'amount_cents');
  if (amountCents <= 0) throw new ValidationError('amount_cents must be more than zero', 'amount_cents');

  const paidOn = input.paid_on === undefined || input.paid_on === null
    ? todayDate()
    : requireDate(input.paid_on, 'paid_on');
  const label = input.label === undefined || input.label === null ? '' : requireText(input.label, 'label');
  const method = requireTextOrNull(input.method, 'method');

  const current = await invoiceBalanceRow(db, invoiceId);
  if (!current) return null;
  if (current.number === null) throw new ValidationError('only an issued invoice can take a payment', 'status');
  if (current.status === 'void') throw new ValidationError('a void invoice cannot take a payment', 'status');
  // Against what this invoice ASKED for, not its project total: the rest of a
  // prepayment's project is a later invoice, and paying it here would make
  // that invoice look already settled.
  if (current.due_cents <= 0) throw new ValidationError('this invoice is already settled', 'amount_cents');
  if (amountCents > current.due_cents) {
    throw new ValidationError(
      `amount_cents must be at most the ${current.due_cents} cents still due on this invoice`,
      'amount_cents',
    );
  }

  const at = nowIso();

  // The check above is for the message; THIS is the guard. Read-then-insert
  // is three statements with nothing holding the balance still between them:
  // a double-clicked "record payment" has both reads see the same balance,
  // both pass, and the invoice ends up overpaid with a negative due_cents.
  // So the condition is part of the insert, the same way issueInvoice puts
  // `WHERE number IS NULL` inside its one allocating UPDATE. No row inserted
  // means someone else got there first.
  const payment = await db.prepare(
    `INSERT INTO payments (invoice_id, amount_cents, paid_on, label, method, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.invoice_id = ?) + ?
           <= (SELECT COALESCE(request_cents, total_cents) FROM invoices WHERE id = ?)
     RETURNING ${PAYMENT_COLUMNS}`,
  ).bind(invoiceId, amountCents, paidOn, label, method, at, invoiceId, amountCents, invoiceId).first();

  if (!payment) {
    throw new ValidationError(
      'this payment would take the invoice past what it asked for — reload and try again',
      'amount_cents',
    );
  }

  await db.prepare(
    `UPDATE invoices
     SET paid_on = (
           SELECT CASE WHEN COALESCE(SUM(p.amount_cents), 0) >= COALESCE(invoices.request_cents, invoices.total_cents)
                       THEN MAX(p.paid_on) END
           FROM payments p WHERE p.invoice_id = invoices.id
         ),
         updated_at = ?
     WHERE id = ?`,
  ).bind(at, invoiceId).run();

  return payment;
}

/** Takes back a payment recorded by mistake (audit B8, F8): a wrong amount
 *  used to be fixable only by voiding the whole invoice. The payment row goes;
 *  the invoice's notes keep a line saying what was removed and when, and its
 *  paid date is worked out again from the payments left. */
export async function removePayment(db, invoiceId, paymentId) {
  assertId(invoiceId);
  assertId(paymentId);
  const invoice = await db.prepare('SELECT id, number, series FROM invoices WHERE id = ?').bind(invoiceId).first();
  if (!invoice) return null;
  if (invoice.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'status');
  const payment = await db.prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ? AND invoice_id = ?`,
  ).bind(paymentId, invoiceId).first();
  if (!payment) return null;
  const at = nowIso();
  const note = `Payment removed ${at.slice(0, 10)}: ${euros(payment.amount_cents)} of ${payment.paid_on}${payment.label ? ` (${payment.label})` : ''}`;
  await db.batch([
    db.prepare('DELETE FROM payments WHERE id = ? AND invoice_id = ?').bind(paymentId, invoiceId),
    db.prepare(
      `UPDATE invoices
       SET paid_on = (
             SELECT CASE WHEN COALESCE(SUM(p.amount_cents), 0) >= COALESCE(invoices.request_cents, invoices.total_cents)
                              AND COALESCE(SUM(p.amount_cents), 0) > 0
                         THEN MAX(p.paid_on) END
             FROM payments p WHERE p.invoice_id = invoices.id
           ),
           notes = TRIM(COALESCE(notes, '') || CHAR(10) || ?),
           updated_at = ?
       WHERE id = ?`,
    ).bind(note, at, invoiceId),
  ]);
  return { removed: payment, invoice: await getInvoice(db, invoiceId) };
}

/** Every payment against one invoice, oldest first. `null` — not `[]` — when
 *  there is no such invoice, so "nothing paid yet" and "no such invoice" stay
 *  different answers. */
export async function listPayments(db, invoiceId) {
  assertId(invoiceId);

  const invoice = await db.prepare('SELECT id FROM invoices WHERE id = ?').bind(invoiceId).first();
  if (!invoice) return null;

  const { results } = await db.prepare(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE invoice_id = ? ORDER BY paid_on ASC, id ASC`,
  ).bind(invoiceId).all();
  return results ?? [];
}

/** "Paid in full" is now one payment for whatever is left, not a flag: a
 *  thin wrapper over recordPayment so there is exactly one path that money
 *  can arrive by. Returns the invoice, with its payments. */
export async function markPaid(db, id, on) {
  assertId(id);
  if (on !== undefined && on !== null) requireDate(on, 'on');

  const current = await invoiceBalanceRow(db, id);
  if (!current) return null;
  if (current.number === null) throw new ValidationError('only an issued invoice can be marked paid', 'status');
  if (current.status === 'void') throw new ValidationError('a void invoice cannot be marked paid', 'status');
  if (current.due_cents <= 0) throw new ValidationError('this invoice is already settled', 'status');

  await recordPayment(db, id, {
    amount_cents: current.due_cents,
    paid_on: on ?? todayDate(),
    label: 'Paid in full',
  });

  return getInvoice(db, id);
}

/** Never deletes, never clears `number` — a cancelled invoice is voided,
 *  the number stays (a legal requirement, not tidiness). Only an issued
 *  (non-draft) invoice can be voided; a draft is deleted instead, and asking
 *  to void one is refused rather than silently doing nothing. */
export async function voidInvoice(db, id, reason) {
  assertId(id);
  const reasonText = typeof reason === 'string' ? reason.trim() : '';
  if (!reasonText) throw new ValidationError('a reason is required to void an invoice', 'reason');

  const current = await invoiceGuardRow(db, id);
  if (!current) return null;
  if (current.number === null) {
    throw new ValidationError('only an issued invoice can be voided; delete a draft instead', 'status');
  }
  if (current.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'status');
  // Voiding twice passed the guard above and appended a second "Voided: ..."
  // line to the notes of an invoice that was already void.
  if (current.status === 'void') throw new ValidationError('this invoice is already void', 'status');

  const at = nowIso();

  // A voided invoice gives its order entries back (audit B8, F8): the months
  // or days it billed can be put on a correct invoice. Before, they stayed
  // tied to the void one and could never be billed again. One batch, so a
  // void never happens without its release.
  const [voided] = await db.batch([
    db.prepare(
      `UPDATE invoices
       SET status = 'void', notes = TRIM(notes || CHAR(10) || 'Voided: ' || ?), updated_at = ?
       WHERE id = ? AND number IS NOT NULL AND status != 'void'
       RETURNING ${INVOICE_COLUMNS}`,
    ).bind(reasonText, at, id),
    db.prepare(
      `UPDATE order_entries SET invoice_id = NULL
       WHERE invoice_id = ? AND EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'void')`,
    ).bind(id, id),
  ]);
  return withBalance(db, voided?.results?.[0] ?? null);
}

/** "Visual creation package - Prepayment" -> "Visual creation package".
 *  Strips a trailing role (prepayment, deposit, part N) so a follow-up
 *  invoice can name the project without inheriting the parent's role. */
export function projectSubject(subject) {
  let out = String(subject ?? '').trim();
  const role = /\s*[-–—:]\s*(?:prepayment|pre-payment|deposit|advance|acompte|voorschot|part\s*\d+(?:\s*\([^)]*\))?)\s*$/i;
  while (role.test(out)) out = out.replace(role, '').trim();
  return out;
}

/** €1,700.00 — for text that is printed on an invoice line. */
function euros(cents) {
  const value = (Number(cents) || 0) / 100;
  return `€${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Part 2: the rest of a prepayment's project, as its own draft invoice
 *  pointing back at the invoice that asked for part 1.
 *
 *  It is a new document, not an edit — the prepayment is issued and issued
 *  invoices do not change — and it is what makes the parent's "not yet
 *  invoiced" figure go to zero once it is issued. The amount is the project
 *  total minus what has already been asked for, on this invoice and on any
 *  earlier issued child. */
export async function createPartInvoice(db, parentId) {
  assertId(parentId);

  const parent = await db.prepare(
    `SELECT ${INVOICE_COLUMNS}, ${requestedCentsSql()} AS requested_cents,
            ${issuedChildrenCentsSql()} AS children_cents,
            ${childrenInFlightCentsSql()} AS in_flight_cents,
            ${notYetRequestedCentsSql()} AS not_yet_requested_cents
     FROM invoices WHERE id = ?`,
  ).bind(parentId).first();
  if (!parent) return null;

  if (parent.number === null) throw new ValidationError('only an issued invoice can be continued', 'status');
  if (parent.status === 'void') throw new ValidationError('a void invoice cannot be continued', 'status');
  if (parent.kind !== 'prepayment') {
    throw new ValidationError('only a prepayment invoice has a part left to invoice', 'kind');
  }

  // Every child that exists, oldest first — drafts included. The reported
  // figure ignores drafts (nobody has been sent one); what may be DRAFTED may
  // not, or the same balance is handed out twice.
  const { results: rows } = await db.prepare(
    "SELECT id, number, status FROM invoices WHERE parent_id = ? AND status != 'void' ORDER BY id ASC",
  ).bind(parentId).all();
  const siblings = rows ?? [];
  const part = siblings.length + 2;

  const open = siblings.find((child) => child.number === null);
  if (open) {
    throw new ValidationError(
      `part ${siblings.indexOf(open) + 2} already exists (draft #${open.id})`,
      'parent_id',
    );
  }

  const remaining = Math.max(
    Number(parent.total_cents) - Number(parent.requested_cents) - Number(parent.in_flight_cents ?? 0),
    0,
  );
  if (remaining <= 0) throw new ValidationError('nothing is left to invoice on this project', 'request_cents');

  // The parent's subject carries its own role ("… - Prepayment"); part 2 is
  // not a prepayment, so it gets the project's name and its own role.
  const subject = projectSubject(parent.subject) || 'Project';
  const at = nowIso();

  const draft = await db.prepare(
    `INSERT INTO invoices (
       number, seq, year, client_id, slug, subject, po_number, status,
       issued_on, due_on, sent_on, paid_on, currency, vat_treatment,
       subtotal_cents, vat_cents, total_cents, kind, request_cents, parent_id,
       notes, issuer_profile, issuer_snapshot, bank_account, created_at, updated_at
     )
     VALUES (NULL, NULL, NULL, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, ?, ?, 0, 0, 0, 'invoice', NULL, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${INVOICE_COLUMNS}`,
  ).bind(
    parent.client_id,
    parent.slug,
    `${subject} - Part ${part} (final invoice)`,
    parent.po_number,
    parent.currency,
    parent.vat_treatment,
    parentId,
    `Part ${part} of ${subject}. Part 1 (${parent.number}) asked for ${parent.requested_cents} cents of a ${parent.total_cents} cent project.`,
    // The balance is made out from the same issuer as part 1, and paid into the same account.
    parent.issuer_profile ?? null,
    parent.issuer_profile ? parent.issuer_snapshot ?? null : null,
    parent.issuer_profile ? PAY_ACCOUNT : null,
    at,
    at,
  ).first();

  await setInvoiceLines(db, draft.id, [
    // The final invoice names the whole and what was already asked for, so
    // the two documents reconcile on their own (deposit, then balance).
    {
      description: `Balance of ${subject} — project total ${euros(parent.total_cents)}, `
        + `prepayment ${euros(Number(parent.requested_cents) + Number(parent.in_flight_cents ?? 0))} invoiced on ${parent.number}`,
      quantity: 1,
      // `remaining` includes VAT; the line is net, and the invoice adds its VAT.
      unit_cents: netForGross(remaining, parent.vat_treatment),
    },
  ]);

  return getInvoice(db, draft.id);
}

/** Undo an issue: an invoice that was numbered but never left the building
 *  goes back to being a draft, and its number is freed.
 *
 *  Belgian numbering may not have gaps, so this is only allowed where it
 *  cannot leave one: the invoice must be the newest in its series and year,
 *  hold its client's newest index, never have been sent, carry no payments,
 *  and have no live part invoice hanging off it. Anything that was sent is
 *  corrected the legal way instead (void it, or a credit note). Each refusal
 *  says what stands in the way, so the screen can tell the owner what to undo
 *  first. */
export async function unissueInvoice(db, id) {
  assertId(id);
  const current = await db.prepare(
    `SELECT i.id, i.number, i.status, i.sent_on, i.series, i.year, i.seq, i.client_id,
            (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id) AS payment_count,
            (SELECT COUNT(*) FROM invoices c WHERE c.parent_id = i.id AND c.status != 'void') AS live_children,
            (SELECT v.number FROM invoices v WHERE v.series = i.series AND v.year = i.year AND v.seq > i.seq
              ORDER BY v.seq DESC LIMIT 1) AS newer_number,
            (SELECT COUNT(*) FROM invoices w WHERE w.client_id = i.client_id AND w.number IS NOT NULL AND w.series != 'archive') AS client_numbered
     FROM invoices i WHERE i.id = ?`,
  ).bind(id).first();
  if (!current) return null;

  if (current.number === null) throw new ValidationError('this invoice is still a draft', 'status');
  if (current.series === ARCHIVE_SERIES) throw new ValidationError(ARCHIVE_READ_ONLY, 'status');
  // A void that never left the building is a mistake like any other; it can
  // go back too. One that was sent is caught just below.
  if (current.sent_on) {
    throw new ValidationError('this invoice was sent to the client — void it or issue a credit note instead', 'status');
  }
  if (Number(current.payment_count) > 0) throw new ValidationError('this invoice has payments recorded against it', 'status');
  if (Number(current.live_children) > 0) {
    throw new ValidationError('a part invoice is linked to this one — undo or delete that part first', 'parent_id');
  }
  if (current.newer_number) {
    throw new ValidationError(`${current.newer_number} was issued after this one — undo that invoice first`, 'number');
  }
  const clientIndex = Number(String(current.number).split('.').pop());
  if (clientIndex !== Number(current.client_numbered)) {
    throw new ValidationError("this is not the client's newest invoice — undo the newer one first", 'number');
  }

  const at = nowIso();
  return withBalance(db, await db.prepare(
    `UPDATE invoices
     SET number = NULL, seq = NULL, year = NULL, status = 'draft', issued_on = NULL, due_on = NULL,
         notes = TRIM(notes || CHAR(10) || 'Issue undone on ' || ? || ' (was ' || number || ', never sent).'),
         updated_at = ?
     WHERE id = ? AND number IS NOT NULL AND sent_on IS NULL AND status IN ('issued', 'void')
     RETURNING ${INVOICE_COLUMNS}`,
  ).bind(at.slice(0, 10), at, id).first());
}

/** Drafts only — an issued invoice's number must never disappear. */
export async function deleteDraft(db, id) {
  assertId(id);

  const current = await db.prepare('SELECT id, number FROM invoices WHERE id = ?').bind(id).first();
  if (!current) return false;
  if (current.number !== null) throw new ValidationError('only a draft invoice can be deleted', 'status');

  const result = await db.prepare('DELETE FROM invoices WHERE id = ?').bind(id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/** `{ outstanding_cents, overdue_cents, not_yet_requested_cents,
 *  paid_this_year_cents, by_month[], by_client[] }`.
 *
 *  Every figure is derived, from the payments and from `due_on` against
 *  `today` — there is no stored outstanding, overdue or paid column to go
 *  stale.
 *
 *  Outstanding and overdue count what has been ASKED FOR and not paid. The
 *  rest of a prepayment's project is not a debt the client has run up; it is
 *  work not yet invoiced, and it is reported separately as
 *  `not_yet_requested_cents` so it is visible without being owed. */
export async function financeOverview(db, today) {
  if (today !== undefined && today !== null) requireDate(today, 'today');
  const day = today ?? todayDate();
  const year = day.slice(0, 4);

  // Six independent reads, one round trip's wait (3 Nov: from Lima each one is ~0.5 s).
  const [outstanding, overdue, notYetRequested, paidThisYear, { results: byMonth }, { results: byClient }] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(SUM(${dueCentsSql()}), 0) AS cents FROM invoices
       WHERE number IS NOT NULL AND status != 'void' AND series != 'archive' AND ${dueCentsSql()} > 0`,
    ).bind().first(),
    db.prepare(
      `SELECT COALESCE(SUM(${dueCentsSql()}), 0) AS cents FROM invoices
       WHERE number IS NOT NULL AND status != 'void' AND series != 'archive' AND ${dueCentsSql()} > 0
         AND due_on IS NOT NULL AND due_on < ?`,
    ).bind(day).first(),
    db.prepare(
      `SELECT COALESCE(SUM(${notYetRequestedCentsSql()}), 0) AS cents FROM invoices
       WHERE number IS NOT NULL AND status != 'void' AND kind = 'prepayment'`,
    ).bind().first(),
    db.prepare(
      `SELECT COALESCE(SUM(p.amount_cents), 0) AS cents
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.status != 'void' AND substr(p.paid_on, 1, 4) = ?`,
    ).bind(year).first(),
    db.prepare(
      `SELECT substr(issued_on, 1, 7) AS month, COALESCE(SUM(total_cents), 0) AS cents
       FROM invoices
       WHERE issued_on IS NOT NULL AND status != 'void' AND substr(issued_on, 1, 4) = ?
       GROUP BY month ORDER BY month ASC`,
    ).bind(year).all(),
    db.prepare(
      `SELECT c.id AS client_id, c.name AS name, COALESCE(SUM(${dueCentsSql('i')}), 0) AS outstanding_cents
       FROM clients c JOIN invoices i ON i.client_id = c.id
       WHERE i.number IS NOT NULL AND i.status != 'void' AND i.series != 'archive' AND ${dueCentsSql('i')} > 0
       GROUP BY c.id, c.name ORDER BY outstanding_cents DESC`,
    ).bind().all(),
  ]);

  return {
    outstanding_cents: outstanding?.cents ?? 0,
    overdue_cents: overdue?.cents ?? 0,
    not_yet_requested_cents: notYetRequested?.cents ?? 0,
    paid_this_year_cents: paidThisYear?.cents ?? 0,
    by_month: byMonth ?? [],
    by_client: byClient ?? [],
  };
}

/** The money picture of ONE project: its client, its invoices (each with
 *  what was asked, paid and owed) and the totals across them.
 *
 *  `invoiced_cents` counts only invoices with no parent. A part-2 invoice
 *  bills a slice of its parent's project total, so adding both would invoice
 *  the same work twice — the parent already carries the whole figure.
 *
 *  The slug is the registry's, and the caller checks it against the registry
 *  before asking; here it is only ever a bound value. */
export async function financeProject(db, slug) {
  const projectSlug = requireString(slug, 'slug');
  const day = todayDate();

  // Three independent reads, one round trip's wait (3 Nov).
  const [client, { results }, totals] = await Promise.all([
    db.prepare(
      `SELECT ${CLIENT_COLUMNS} FROM clients WHERE slug = ? ORDER BY id ASC LIMIT 1`,
    ).bind(projectSlug).first(),
    db.prepare(
      `SELECT ${INVOICE_READ_COLUMNS} FROM invoices WHERE slug = ? ORDER BY id DESC`,
    ).bind(projectSlug).all(),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN parent_id IS NULL THEN total_cents ELSE 0 END), 0) AS invoiced_cents,
         COALESCE(SUM(${paidCentsSql()}), 0) AS paid_cents,
         COALESCE(SUM(CASE WHEN number IS NOT NULL AND series != 'archive' AND ${dueCentsSql()} > 0 THEN ${dueCentsSql()} ELSE 0 END), 0) AS owed_now_cents,
         COALESCE(SUM(CASE WHEN number IS NOT NULL AND kind = 'prepayment' THEN ${notYetRequestedCentsSql()} ELSE 0 END), 0) AS not_yet_requested_cents
       FROM invoices
       WHERE slug = ? AND status != 'void'`,
    ).bind(projectSlug).first(),
  ]);
  const invoices = (results ?? []).map((row) => withComputedStatus(row, day));

  return {
    slug: projectSlug,
    client: client ?? null,
    invoices,
    totals: {
      invoiced_cents: totals?.invoiced_cents ?? 0,
      paid_cents: totals?.paid_cents ?? 0,
      owed_now_cents: totals?.owed_now_cents ?? 0,
      not_yet_requested_cents: totals?.not_yet_requested_cents ?? 0,
    },
  };
}

/** Business purchases (migrations/0019), newest first; one year if asked. */
export async function listExpenses(db, filter = {}) {
  const where = [];
  const args = [];
  if (filter.year !== undefined) { where.push('year = ?'); args.push(requireInt(filter.year, 'year')); }
  const { results } = await db.prepare(
    `SELECT id, ref, spent_on, year, vendor, description, order_ref, amount_cents, currency,
            original_amount_cents, original_currency, paid_with, flag, notes, source, created_at
     FROM expenses${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY spent_on DESC, id DESC`,
  ).bind(...args).all();
  return results ?? [];
}

export async function getProjectMeta(db, slug) {
  return await db.prepare('SELECT * FROM project_meta WHERE slug = ?').bind(slug).first()
    ?? { slug, notes: '', pinned: 0, updated_at: null };
}
export async function saveProjectMeta(db, slug, input) {
  if (!input || typeof input.notes !== 'string') throw new ValidationError('Notes must be text', 'notes');
  return db.prepare(`INSERT INTO project_meta (slug, notes, pinned, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET notes = excluded.notes, pinned = excluded.pinned, updated_at = excluded.updated_at
    RETURNING *`).bind(slug, input.notes, input.pinned ? 1 : 0, nowIso()).first();
}
export async function getOverview(db) {
  const today = hqToday();
  const [summary, due, dueCount, events] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN s.stage = 'won' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN s.stage IN ('replied', 'talks') THEN 1 ELSE 0 END) AS conversations
      FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid`).bind().first(),
    db.prepare(`SELECT l.uid, l.name, s.follow_up FROM lead_state s JOIN leads l ON l.uid = s.uid
      WHERE s.follow_up <= ? AND s.stage NOT IN ('won', 'passed') ORDER BY s.follow_up LIMIT 20`).bind(today).all(),
    // The list above stops at 20; Home's to-do list says how many there are.
    db.prepare(`SELECT COUNT(*) AS n FROM lead_state s JOIN leads l ON l.uid = s.uid
      WHERE s.follow_up <= ? AND s.stage NOT IN ('won', 'passed')`).bind(today).first(),
    db.prepare(`SELECT title, kind, at FROM (
      SELECT l.name AS title, e.kind || CASE WHEN e.detail != '' THEN ': ' || e.detail ELSE '' END AS kind, e.at AS at
      FROM lead_events e JOIN leads l ON l.uid = e.uid
      UNION ALL SELECT title, 'mission: ' || status AS kind, updated_at AS at FROM missions
    ) ORDER BY at DESC LIMIT 10`).bind().all(),
  ]);
  return {
    leads: summary,
    followups: due.results ?? [],
    followups_due: dueCount?.n ?? 0,
    activity: events.results ?? [],
  };
}

/** Each list's meta, in the shape getLeadsWorkspace gives it, without its rows. */
export async function getLeadDatasets(db) {
  const { results } = await db.prepare('SELECT * FROM datasets ORDER BY key').bind().all();
  return { datasets: (results ?? []).map((dataset) => ({ meta: { ...dataset, tiers: { hot: dataset.tier_hot, warm: dataset.tier_warm } } })) };
}

export async function getLeadsWorkspace(db) {
  const [leads, datasets, contexts, drafts, profile] = await Promise.all([
    listLeads(db), db.prepare('SELECT * FROM datasets ORDER BY key').bind().all(),
    db.prepare('SELECT uid, value FROM lead_context').bind().all(),
    db.prepare('SELECT * FROM lead_drafts').bind().all(), getSetting(db, 'profile'),
  ]);
  const context = Object.fromEntries(contexts.results.map(r => [r.uid, JSON.parse(r.value)]));
  const progress = { version: 2, migrated: { web: true, ugc: true }, leads: {} };
  for (const lead of leads) {
    progress.leads[lead.uid] = { ...context[lead.uid], status: lead.stage, star: !!lead.starred, notes: lead.notes || '', followUp: lead.follow_up || '', updatedAt: lead.updated_at || '', lookedAt: lead.looked_at, sentAt: lead.sent_at, repliedAt: lead.replied_at, wonAt: lead.won_at, passedAt: lead.passed_at };
  }
  const draftMap = {};
  for (const draft of drafts.results) {
    draftMap[draft.uid] ??= {};
    if (draft.lang === '__name') draftMap[draft.uid].__name = draft.to_name;
    else draftMap[draft.uid][draft.lang] = { subject: draft.subject, body: draft.body };
  }
  return { progress, profile: profile || {}, drafts: draftMap, datasets: datasets.results.map(dataset => ({
    meta: { ...dataset, tiers: { hot: dataset.tier_hot, warm: dataset.tier_warm } },
    rows: leads.filter(l => l.dataset === dataset.key).map(l => ({ ...JSON.parse(l.payload), uid: l.uid, id: l.id, tier: l.tier, contactType: l.contact_type, languages: JSON.parse(l.languages) })),
  })) };
}
export async function mergeLeadProgress(db, input) {
  if (!input?.leads || typeof input.leads !== 'object' || Array.isArray(input.leads)) throw new ValidationError('Invalid leads backup');
  const current = new Map((await listLeads(db)).map(l => [l.uid, l]));
  const pending = [];
  for (const [uid, state] of Object.entries(input.leads)) {
    const lead = current.get(uid);
    if (!lead) continue;
    if (!state || !STATE_STAGES.includes(state.status) || typeof state.notes !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) throw new ValidationError(`Invalid state for ${uid}`);
    if (state.updatedAt <= (lead.updated_at || '')) continue;
    pending.push([uid, state]);
  }
  for (const [uid, state] of pending) {
    await patchLeadState(db, uid, { stage: state.status, starred: !!state.star, notes: state.notes, follow_up: state.followUp || null }, state.updatedAt);
    await db.prepare(`INSERT INTO lead_context(uid,value,updated_at) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(uid, JSON.stringify(state), state.updatedAt).run();
  }
  return { saved: pending.length };
}
