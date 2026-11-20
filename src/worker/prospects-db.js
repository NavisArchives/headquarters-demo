// Potential clients (migrations/0016): the pipeline and the onboarding
// questionnaire. Kept apart from db.js the way db-replies.js and orders-db.js
// are: one subject per module.

import { ValidationError, nowIso, cleanDay, getLeadStage, patchLeadState, STATE_STAGES } from './db.js';
import {
  cleanConfig, configFor, resolveSections, fieldShown, clientWritable, clientValueProblem, BUILTIN_TEMPLATES,
} from '../public/assets/onboarding-form.js';

/** The pipeline, in order. Won and lost are where a deal ends. */
export const PROSPECT_STAGES = Object.freeze(['lead', 'meeting', 'onboarding', 'proposal', 'contract', 'won', 'lost']);
export const PROSPECT_BRANDS = Object.freeze(['realis', 'archive']);
/** The questionnaires (onboarding-form.js TEMPLATES): the full one, and "Site web (léger)". */
export const PROSPECT_TEMPLATES = Object.freeze(['full', 'light']);
/** How long a live mirror link works. */
export const LIVE_DAYS = 7;

const TEXT_MAX = 200;
const NOTES_MAX = 20000;
const ENTITIES_MAX = 12;
const ANSWER_KEYS_PER_CALL = 200;
const ANSWER_TEXT_MAX = 4000;
const ANSWER_LIST_MAX = 40;
const ANSWERS_BYTES_MAX = 65536;
const ANSWER_KEY = /^[a-z0-9_.-]{1,80}$/;
const ENTITY_ID = /^[a-z0-9-]{1,40}$/;

const LIST_COLUMNS = `p.id, p.name, p.organisation, p.email, p.phone, p.address, p.brand, p.stage, p.next_step, p.next_at, p.next_tz, p.value_cents,
  p.lead_uid, p.gmail_thread, p.entities, p.notes, p.template, p.form_config, p.live_token, p.live_expires_at, p.client_id, p.onboarding_updated_at, p.lost_reason, p.position, p.created_at, p.updated_at,
  (SELECT COUNT(*) FROM json_each(p.onboarding) WHERE key NOT LIKE '%.note' AND key NOT LIKE '%.other') AS onboarding_answers,
  (SELECT COUNT(*) FROM json_each(p.onboarding) WHERE value = 'approved') AS onboarding_approved,
  l.name AS lead_name,
  (SELECT c.name FROM clients c WHERE c.id = p.client_id) AS client_name,
  (SELECT c.slug FROM clients c WHERE c.id = p.client_id) AS client_slug`;

function assertId(id) {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('id must be a positive integer', 'id');
  return id;
}

function cleanText(value, field, { required = false, max = TEXT_MAX } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new ValidationError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  const text = value.trim();
  if (required && !text) throw new ValidationError(`${field} is required`, field);
  if (text.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer`, field);
  return text;
}

function cleanEmail(value) {
  const email = cleanText(value, 'email');
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('email does not look like an address', 'email');
  return email;
}

function cleanStage(value) {
  if (!PROSPECT_STAGES.includes(value)) throw new ValidationError(`stage must be one of ${PROSPECT_STAGES.join(', ')}`, 'stage');
  return value;
}

function cleanBrand(value) {
  if (!PROSPECT_BRANDS.includes(value)) throw new ValidationError('brand must be realis or archive', 'brand');
  return value;
}

/** A day (2026-10-16), or a day and a time (2026-10-16T18:30). */
/** Whose clock a meeting time is on (0030): an IANA zone, or null. */
export function cleanZone(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw new ValidationError('next_tz must be a time zone', 'next_tz');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new ValidationError('next_tz is not a known time zone', 'next_tz'); }
  return value;
}

export function cleanWhen(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('next_at must be a date', 'next_at');
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!match) throw new ValidationError('next_at must be a date like 2026-10-16 or 2026-10-16T18:30', 'next_at');
  cleanDay(match[1], 'next_at');
  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59)) {
    throw new ValidationError('next_at has a time that does not exist', 'next_at');
  }
  return value.trim();
}

const slug = (text) => String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'entity';

/**
 * The businesses one prospect brings. Each keeps its id once it has one: the
 * questionnaire's answers about it are filed under that id.
 */
export function cleanEntities(value) {
  if (!Array.isArray(value)) throw new ValidationError('entities must be a list', 'entities');
  if (value.length > ENTITIES_MAX) throw new ValidationError(`at most ${ENTITIES_MAX} entities`, 'entities');
  const seen = new Set();
  return value.map((item, index) => {
    const raw = typeof item === 'string' ? { name: item } : item;
    if (!raw || typeof raw !== 'object') throw new ValidationError('each entity needs a name', 'entities');
    const name = cleanText(raw.name, 'entities', { required: true, max: 120 });
    const kind = cleanText(raw.kind ?? '', 'entities', { max: 80 }) ?? '';
    let id = typeof raw.id === 'string' && ENTITY_ID.test(raw.id) ? raw.id : slug(name);
    if (seen.has(id)) id = `${id.slice(0, 36)}-${index + 1}`;
    seen.add(id);
    // Its own web addresses: the site, then Instagram, Facebook… (http/https only).
    const links = Array.isArray(raw.links) ? raw.links : (raw.url ? [raw.url] : []);
    if (links.length > 6) throw new ValidationError('at most 6 links per business', 'entities');
    const clean = links.map((u) => {
      const text = cleanText(u, 'entities', { required: true, max: 300 });
      if (!/^https?:\/\/[^\s]+$/i.test(text)) throw new ValidationError('a business link must start with http:// or https://', 'entities');
      return text;
    });
    return clean.length ? { id, name, kind, links: clean } : { id, name, kind };
  });
}

async function cleanLead(db, value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('lead_uid must be a lead', 'lead_uid');
  if (!await db.prepare('SELECT uid FROM leads WHERE uid = ?').bind(value).first()) {
    throw new ValidationError('no such lead', 'lead_uid');
  }
  return value;
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function shape(row) {
  if (!row) return row;
  const { onboarding, form_config: formConfig, onboarding_meta: meta, ...rest } = row;
  const own = formConfig ? parseJson(formConfig, null) : null;
  return {
    ...rest,
    form_config: own,
    config: configFor({ form_config: own, template: row.template }),
    entities: parseJson(row.entities, []),
    ...(onboarding !== undefined ? { onboarding: parseJson(onboarding, {}) } : {}),
    ...(meta !== undefined ? { onboarding_meta: parseJson(meta, {}) } : {}),
  };
}

/**
 * Every prospect, in the order the board shows them. `client` false: only the
 * deals (the Prospects pipeline). `slug`: the client onboardings of the
 * clients on that project.
 */
export async function listProspects(db, { client = null, slug = null } = {}) {
  const where = slug ? 'WHERE p.client_id IN (SELECT id FROM clients WHERE slug = ?)'
    : client === false ? 'WHERE p.client_id IS NULL' : '';
  const stmt = db.prepare(
    `SELECT ${LIST_COLUMNS} FROM prospects p LEFT JOIN leads l ON l.uid = p.lead_uid
     ${where} ORDER BY p.next_at IS NULL, p.next_at, p.position, p.id`,
  );
  const { results } = await (slug ? stmt.bind(slug) : stmt).all();
  return (results ?? []).map(shape);
}

/** One prospect, whole: the answers, and the missions of the lead it came from. */
export async function getProspect(db, id) {
  assertId(id);
  const row = await db.prepare(
    `SELECT ${LIST_COLUMNS}, p.onboarding, p.onboarding_meta FROM prospects p LEFT JOIN leads l ON l.uid = p.lead_uid WHERE p.id = ?`,
  ).bind(id).first();
  if (!row) return null;
  const prospect = shape(row);
  const { results } = prospect.lead_uid
    ? await db.prepare('SELECT id, title, status, due, done_at FROM missions WHERE lead_uid = ? ORDER BY id DESC').bind(prospect.lead_uid).all()
    : { results: [] };
  prospect.missions = results ?? [];
  return prospect;
}

const WRITABLE = ['name', 'organisation', 'email', 'phone', 'address', 'brand', 'stage', 'next_step', 'next_at', 'next_tz', 'value_cents',
  'lead_uid', 'gmail_thread', 'entities', 'notes', 'template', 'form_config', 'client_id', 'lost_reason', 'position'];

async function cleanField(db, field, value) {
  switch (field) {
    case 'name': return cleanText(value, 'name', { required: true });
    case 'organisation': return cleanText(value ?? '', 'organisation') ?? '';
    case 'email': return cleanEmail(value);
    case 'phone': return cleanText(value, 'phone', { max: 60 });
    case 'address': return cleanText(value, 'address', { max: 300 });
    case 'brand': return cleanBrand(value);
    case 'stage': return cleanStage(value);
    case 'next_step': return cleanText(value ?? '', 'next_step') ?? '';
    case 'next_at': return cleanWhen(value);
    case 'next_tz': return cleanZone(value);
    case 'value_cents': {
      // What the deal is worth, in cents (0031); null when not known yet.
      if (value === null || value === '') return null;
      if (!Number.isInteger(value) || value < 0 || value > 100_000_000) throw new ValidationError('value_cents must be a whole number of cents', 'value_cents');
      return value;
    }
    case 'lead_uid': return cleanLead(db, value);
    case 'gmail_thread': {
      const thread = cleanText(value, 'gmail_thread', { max: 40 });
      if (thread && !/^[0-9a-f]{8,40}$/i.test(thread)) throw new ValidationError('gmail_thread must be a Gmail thread id', 'gmail_thread');
      return thread || null;
    }
    case 'entities': return JSON.stringify(cleanEntities(value));
    case 'notes': return cleanText(value ?? '', 'notes', { max: NOTES_MAX }) ?? '';
    case 'client_id': {
      // The client this onboarding is for (0021); null takes it back to the pipeline.
      if (value === null || value === '') return null;
      if (!Number.isInteger(value) || value < 1) throw new ValidationError('client_id must be a client', 'client_id');
      if (!await db.prepare('SELECT id FROM clients WHERE id = ?').bind(value).first()) throw new ValidationError('no such client', 'client_id');
      return value;
    }
    case 'form_config':
      if (value === null) return null;
      try { return JSON.stringify(cleanConfig(value)); } catch (error) { throw new ValidationError(error.message, 'form_config'); }
    case 'template':
      if (!PROSPECT_TEMPLATES.includes(value)) throw new ValidationError('template must be full or light', 'template');
      return value;
    case 'lost_reason': return cleanText(value, 'lost_reason', { max: 500 });
    case 'position':
      if (!Number.isInteger(value)) throw new ValidationError('position must be a whole number', 'position');
      return value;
    default: throw new ValidationError(`unknown field ${field}`, field);
  }
}

/**
 * A deal moves its lead, one way (A3, NIRMATA's review of 29 Oct): a meeting
 * or anything after it puts the lead in « talks »; a won deal wins the lead; a
 * lost deal passes it. Only ever forward, and a won lead is never passed.
 * Winning or passing the lead is also what closes its warm-lead mission (the
 * 0012 triggers), so the « follow up » count stops counting it.
 */
const LEAD_STAGE_FOR = Object.freeze({
  meeting: 'talks', onboarding: 'talks', proposal: 'talks', contract: 'talks', won: 'won', lost: 'passed',
});

export async function syncLeadFromProspect(db, prospect) {
  const target = LEAD_STAGE_FOR[prospect?.stage];
  if (!target || !prospect.lead_uid) return false;
  const current = await getLeadStage(db, prospect.lead_uid);
  if (current === null || current === target || current === 'won') return false;
  // A signed deal always wins its lead, even one passed earlier; « passed »
  // ends anything not won; « talks » only ever moves a lead forward.
  if (target === 'talks' && STATE_STAGES.indexOf(current) >= STATE_STAGES.indexOf('talks')) return false;
  await patchLeadState(db, prospect.lead_uid, { stage: target });
  return true;
}

export async function createProspect(db, input = {}) {
  // A new prospect starts on the base questionnaire (F31); 'full' is Dr Renard's.
  const fields = { name: input.name, stage: input.stage ?? 'lead', brand: input.brand ?? 'realis', template: input.template ?? 'light' };
  for (const field of WRITABLE) if (input[field] !== undefined && !(field in fields)) fields[field] = input[field];
  const columns = [];
  const values = [];
  for (const [field, value] of Object.entries(fields)) {
    columns.push(field);
    values.push(await cleanField(db, field, value));
  }
  const at = nowIso();
  columns.push('created_at', 'updated_at');
  values.push(at, at);
  const row = await db.prepare(
    `INSERT INTO prospects (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING id`,
  ).bind(...values).first();
  const made = await getProspect(db, row.id);
  await syncLeadFromProspect(db, made);
  return made;
}

export async function updateProspect(db, id, patch = {}) {
  assertId(id);
  const sets = [];
  const args = [];
  for (const field of WRITABLE) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = ?`);
    args.push(await cleanField(db, field, patch[field]));
  }
  if (!sets.length) throw new ValidationError('nothing to update', 'patch');
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  const row = await db.prepare(`UPDATE prospects SET ${sets.join(', ')} WHERE id = ? RETURNING id`).bind(...args).first();
  if (!row) return null;
  const saved = await getProspect(db, row.id);
  if (patch.stage !== undefined || patch.lead_uid !== undefined) await syncLeadFromProspect(db, saved);
  return saved;
}

export async function deleteProspect(db, id) {
  assertId(id);
  const result = await db.prepare('DELETE FROM prospects WHERE id = ?').bind(id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/* ---- the onboarding questionnaire ---- */

/**
 * What the client-facing questionnaire may read, and nothing else: no email,
 * no notes, no stage, no lead. This is all the safe view ever fetches.
 */
export async function getOnboarding(db, id) {
  assertId(id);
  const row = await db.prepare(
    `SELECT ${SAFE_COLUMNS} FROM prospects WHERE id = ?`,
  ).bind(id).first();
  return row ? safeForm(row) : null;
}

const SAFE_COLUMNS = 'id, name, organisation, brand, template, form_config, entities, onboarding, onboarding_updated_at';

function safeForm(row) {
  return {
    id: row.id,
    name: row.name,
    organisation: row.organisation,
    brand: row.brand,
    template: row.template ?? 'full',
    config: configFor({ form_config: row.form_config ? parseJson(row.form_config, null) : null, template: row.template }),
    entities: parseJson(row.entities, []),
    answers: parseJson(row.onboarding, {}),
    updated_at: row.onboarding_updated_at,
  };
}

/* ---- the live mirror (/live/<token>) ---- */

// The first links were 64 hex characters; since F31 a link reads
// /live/<name>-<6 characters> (30 bits, with expiry and a cap on wrong tries).
// Both keep working until they expire.
export const LIVE_TOKEN = /^(?:[0-9a-f]{64}|[a-z0-9]{1,24}-[a-z2-7]{6})$/;
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** "Dr Luc Fontaine" → "fontaine": the family name, readable in a link. */
export function linkName(name) {
  const words = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !['dr', 'docteur', 'prof', 'pr'].includes(w));
  return (words.at(-1) ?? 'client').slice(0, 24) || 'client';
}

function newToken(name) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = [...bytes].map((b) => CODE_ALPHABET[b & 31]).join('');
  return `${linkName(name)}-${code}`;
}

/**
 * The live link of a prospect's questionnaire: the one that works now, or a
 * new one valid LIVE_DAYS days. Copying twice gives the same link, so the one
 * already sent keeps working. Null when there is no such prospect.
 */
export async function ensureLiveLink(db, id, now = Date.now()) {
  assertId(id);
  const row = await db.prepare('SELECT name, live_token, live_expires_at FROM prospects WHERE id = ?').bind(id).first();
  if (!row) return null;
  const at = new Date(now).toISOString();
  if (row.live_token && row.live_expires_at && row.live_expires_at > at) {
    return { token: row.live_token, expires_at: row.live_expires_at };
  }
  const expires = new Date(now + LIVE_DAYS * 86400000).toISOString();
  // A clash with another prospect's link is a one-in-a-billion: try again.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = newToken(row.name);
    try {
      // eslint-disable-next-line no-await-in-loop -- one write, retried only on a clash
      await db.prepare('UPDATE prospects SET live_token = ?, live_expires_at = ?, updated_at = ? WHERE id = ?')
        .bind(token, expires, at, id).run();
      return { token, expires_at: expires };
    } catch (error) {
      if (!/UNIQUE/i.test(String(error?.message))) throw error;
    }
  }
  throw new Error('could not make a live link');
}

/** Stop the live link at once. False when there is no such prospect. */
export async function revokeLiveLink(db, id) {
  assertId(id);
  const result = await db.prepare('UPDATE prospects SET live_token = NULL, live_expires_at = NULL, updated_at = ? WHERE id = ?')
    .bind(nowIso(), id).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * What the live mirror shows for a token: the safe fields only, and only
 * while the link has not expired or been revoked. Null otherwise.
 */
export async function getLiveView(db, token, now = Date.now()) {
  if (typeof token !== 'string' || !LIVE_TOKEN.test(token)) return null;
  const row = await db.prepare(
    `SELECT ${SAFE_COLUMNS}, live_token, live_expires_at FROM prospects WHERE live_token = ?`,
  ).bind(token).first();
  if (!row || row.live_token !== token) return null;
  if (!row.live_expires_at || row.live_expires_at <= new Date(now).toISOString()) return null;
  return { ...safeForm(row), expires_at: row.live_expires_at };
}

/** One answer: a choice, a list of choices, a number, yes/no, or text. Null clears it. */
export function cleanAnswers(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new ValidationError('answers must be an object', 'answers');
  }
  const keys = Object.keys(changes);
  if (!keys.length) throw new ValidationError('nothing to save', 'answers');
  if (keys.length > ANSWER_KEYS_PER_CALL) throw new ValidationError('too many answers at once', 'answers');
  const clean = {};
  for (const key of keys) {
    if (!ANSWER_KEY.test(key)) throw new ValidationError(`not a question: ${key.slice(0, 40)}`, 'answers');
    const value = changes[key];
    if (value === null || typeof value === 'boolean') clean[key] = value;
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ValidationError(`${key} must be a number`, key);
      clean[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > ANSWER_TEXT_MAX) throw new ValidationError(`${key} is too long`, key);
      clean[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > ANSWER_LIST_MAX) throw new ValidationError(`${key} has too many choices`, key);
      if (!value.every((v) => typeof v === 'string' && v.length <= TEXT_MAX)) throw new ValidationError(`${key} must be a list of choices`, key);
      clean[key] = [...new Set(value)];
    } else {
      throw new ValidationError(`${key} cannot be saved`, key);
    }
  }
  return clean;
}

/**
 * Merge answers into the stored ones (RFC 7396, in SQL: a list replaces the
 * old list, null removes the answer). Fields typed on two screens at once
 * never overwrite each other.
 */
export async function saveOnboarding(db, id, changes, { by = 'andy' } = {}) {
  assertId(id);
  const clean = cleanAnswers(changes);
  const at = nowIso();
  // When each answer came in and from whom (0020); a cleared answer clears it.
  const meta = Object.fromEntries(Object.entries(clean).map(([key, value]) => [key, value === null ? null : { at, by }]));
  const row = await db.prepare(
    `UPDATE prospects SET onboarding = json_patch(onboarding, ?), onboarding_meta = json_patch(onboarding_meta, ?),
       onboarding_updated_at = ?, updated_at = ?
     WHERE id = ? AND length(json_patch(onboarding, ?)) <= ? RETURNING onboarding, onboarding_updated_at`,
  ).bind(JSON.stringify(clean), JSON.stringify(meta), at, at, id, JSON.stringify(clean), ANSWERS_BYTES_MAX).first();
  if (!row) {
    if (await db.prepare('SELECT id FROM prospects WHERE id = ?').bind(id).first()) {
      throw new ValidationError('the questionnaire is full: shorten a long answer', 'answers');
    }
    return null;
  }
  return { answers: parseJson(row.onboarding, {}), updated_at: row.onboarding_updated_at };
}

/* ---- the client typing on his live page (F31) ---- */

// A client tapping through a phone questionnaire saves on every tap.
export const CLIENT_WRITES_PER_MINUTE = 60;
const CLIENT_TEXT_MAX = { text: 300, long: 4000 };

export class TooManyWrites extends Error {}

/**
 * The client writes one open text answer through his live link: only a text
 * question his questionnaire shows right now, only text, short. Checked first,
 * counted (at most 30 a minute), then saved like Andy's own answers.
 */
export async function clientWrite(db, token, key, value, now = Date.now()) {
  const form = await getLiveView(db, token, now);
  if (!form) return null;
  const sections = resolveSections(form.config);
  // Two answers that hang off a question: the note on « Modifier » (<key>.note, an
  // approval) and the text of « Autre » (<key>.other, a choice that offers it).
  const note = key.endsWith('.note') ? key.slice(0, -5) : null;
  const other = key.endsWith('.other') ? key.slice(0, -6) : null;
  const belongs = (f) => (note && f.key === note && f.type === 'approve') || (other && f.key === other && f.other);
  const section = sections.find((s) => s.fields.some((f) => f.key === key || belongs(f)));
  const found = section?.fields.find((f) => f.key === key);
  const field = found ?? (section ? (note ? { key, type: 'long' } : other ? { key, type: 'text' } : undefined) : undefined);
  if (!field || !clientWritable(field, form.config) || !fieldShown(field, form.answers) || !fieldShown(section, form.answers)) {
    throw new ValidationError('this answer is not yours to write', 'key');
  }
  const problem = clientValueProblem(field, value);
  if (problem) throw new ValidationError(problem, 'value');
  let clean = value;
  if (typeof value === 'string') {
    clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const max = CLIENT_TEXT_MAX[field.type];
    if (max && clean.length > max) throw new ValidationError(`at most ${max} characters`, 'value');
    if (clean === '') clean = null;
  }
  if (Array.isArray(value) && !value.length) clean = null;

  const minute = new Date(now).toISOString().slice(0, 16);
  const counted = await db.prepare(
    `UPDATE prospects SET live_write_count = CASE WHEN live_write_minute = ? THEN live_write_count + 1 ELSE 1 END,
       live_write_minute = ? WHERE live_token = ? RETURNING live_write_count`,
  ).bind(minute, minute, token).first();
  if (!counted) return null;
  if (counted.live_write_count > CLIENT_WRITES_PER_MINUTE) throw new TooManyWrites('too many changes: wait a minute');
  return saveOnboarding(db, form.id, { [key]: clean }, { by: 'client' });
}

/* ---- wrong live links: a cap per address and minute ---- */

export const LIVE_MISSES_PER_MINUTE = 20;

/** Whether this address has tried too many wrong links in the last minute or two. */
export async function liveBlocked(db, address, now = Date.now()) {
  // This minute and the one before together: a burst across a minute's turn still counts as one.
  const minute = new Date(now).toISOString().slice(0, 16);
  const before = new Date(now - 60000).toISOString().slice(0, 16);
  const row = await db.prepare('SELECT SUM(count) AS count FROM live_misses WHERE address = ? AND minute IN (?, ?)').bind(address, minute, before).first();
  return (row?.count ?? 0) >= LIVE_MISSES_PER_MINUTE;
}

/** Count one wrong link, and forget counts older than an hour. */
export async function recordLiveMiss(db, address, now = Date.now()) {
  const minute = new Date(now).toISOString().slice(0, 16);
  const hourAgo = new Date(now - 3600000).toISOString().slice(0, 16);
  await db.batch([
    db.prepare(`INSERT INTO live_misses (address, minute, count) VALUES (?, ?, 1)
                ON CONFLICT (address, minute) DO UPDATE SET count = count + 1`).bind(address, minute),
    db.prepare('DELETE FROM live_misses WHERE minute < ?').bind(hourAgo),
  ]);
}

/* ---- saved questionnaire templates (F31) ---- */

/** The built-in templates, then the ones Andy saved. */
export async function listTemplates(db) {
  const { results } = await db.prepare('SELECT id, name, config, updated_at FROM onboarding_templates ORDER BY name').all();
  return [
    ...BUILTIN_TEMPLATES.map((tpl) => ({ id: tpl.id, name: tpl.name, builtin: true, config: tpl.config })),
    ...(results ?? []).map((r) => ({ id: `saved-${r.id}`, name: r.name, builtin: false, config: parseJson(r.config, null), updated_at: r.updated_at })),
  ];
}

/** Save a setup under a name; the same name again replaces it. */
export async function saveTemplate(db, input = {}) {
  const name = cleanText(input.name, 'name', { required: true, max: 80 });
  if (BUILTIN_TEMPLATES.some((tpl) => tpl.name.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError('that name is a built-in template: choose another', 'name');
  }
  let config;
  try { config = cleanConfig(input.config); } catch (error) { throw new ValidationError(error.message, 'config'); }
  const at = nowIso();
  await db.prepare(
    `INSERT INTO onboarding_templates (name, config, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  ).bind(name, JSON.stringify(config), at, at).run();
  return (await listTemplates(db)).find((tpl) => tpl.name === name);
}
