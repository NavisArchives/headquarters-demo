// The platforms store (migration 0040). Name, link, status, next step, pay, note.
// Nothing here may hold a secret: the fields are short free text, and the API
// accepts only these keys (anything else, e.g. « email » or « password », is refused).
import { ValidationError, nowIso } from './db.js';
import { PLATFORM_STATUS_LABEL, sortPlatforms } from '../public/assets/platform-statuses.js';

const FIELDS = ['name', 'url', 'status', 'next_step', 'pay', 'note'];
const MAX = { name: 80, url: 300, next_step: 200, pay: 60, note: 500 };
const SELECT = 'SELECT id, name, url, status, next_step, pay, note, created_at, updated_at FROM platforms';

function text(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  const v = value.trim();
  if (v.length > MAX[field]) throw new ValidationError(`${field} must be ${MAX[field]} characters or fewer`, field);
  return v;
}

/** A link is optional; when given it is an http(s) address. « micro1.ai » becomes https://micro1.ai. */
export function cleanUrl(value) {
  const raw = text(value, 'url');
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try { parsed = new URL(withScheme); } catch { throw new ValidationError('url must be a web address', 'url'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) {
    throw new ValidationError('url must be a web address', 'url');
  }
  return parsed.href;
}

function cleanStatus(value) {
  if (value === undefined) return 'to_sign_up';
  if (!Object.hasOwn(PLATFORM_STATUS_LABEL, value)) throw new ValidationError('status must be one of the six', 'status');
  return value;
}

function onlyKnown(input) {
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key)) throw new ValidationError(`unknown field: ${key}`, key);
  }
}

function assertId(id) {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('no such platform', 'id');
}

export async function listPlatforms(db) {
  const { results } = await db.prepare(SELECT).all();
  return sortPlatforms(results ?? []);
}

export function getPlatform(db, id) {
  assertId(id);
  return db.prepare(`${SELECT} WHERE id = ?`).bind(id).first();
}

export async function createPlatform(db, input = {}) {
  onlyKnown(input);
  const name = text(input.name, 'name');
  if (!name) throw new ValidationError('name is required', 'name');
  const at = nowIso();
  const row = await db.prepare(
    `INSERT INTO platforms (name, url, status, next_step, pay, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(name, cleanUrl(input.url), cleanStatus(input.status), text(input.next_step, 'next_step'),
    text(input.pay, 'pay'), text(input.note, 'note'), at, at).first();
  return getPlatform(db, row.id);
}

export async function updatePlatform(db, id, patch = {}) {
  assertId(id);
  onlyKnown(patch);
  const sets = []; const args = [];
  for (const field of FIELDS) {
    if (patch[field] === undefined) continue;
    let value;
    if (field === 'url') value = cleanUrl(patch.url);
    else if (field === 'status') value = cleanStatus(patch.status);
    else value = text(patch[field], field);
    if (field === 'name' && !value) throw new ValidationError('name is required', 'name');
    sets.push(`${field} = ?`); args.push(value);
  }
  if (!sets.length) return getPlatform(db, id);
  sets.push('updated_at = ?'); args.push(nowIso());
  const { meta } = await db.prepare(`UPDATE platforms SET ${sets.join(', ')} WHERE id = ?`).bind(...args, id).run();
  return meta.changes ? getPlatform(db, id) : null;
}

export async function deletePlatform(db, id) {
  assertId(id);
  const { meta } = await db.prepare('DELETE FROM platforms WHERE id = ?').bind(id).run();
  return meta.changes > 0;
}
