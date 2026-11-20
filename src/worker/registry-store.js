/**
 * The registry's second layer, in D1.
 *
 * `projects.json` is still the committed defaults layer and is still the only
 * place a local service or a probe's method can be spelled. This module holds
 * the rows the owner makes in HQ, and hands the merged result to everything
 * that used to read the file directly.
 *
 * Two rules shape every function here:
 *
 *   1. A read never throws. If D1 is unreachable the merged registry is the
 *      committed file and the result is marked `degraded`. The dashboard
 *      opens; it just cannot be changed until the database answers again.
 *   2. A write is one batch. A half-written save — the row updated but no
 *      version recorded — is not a state this table can be left in.
 */
import { mergeRegistry, validateEntry, slugFrom, RESERVED_SLUGS, UNWRITABLE_KEYS, UNWRITABLE_STATUS_FIELDS, safeProbeTarget } from '../shared/registry.js';
import { ValidationError, nowIso } from './db.js';

const ROW_COLUMNS = 'slug, origin, entry, brand, position, archived_at, version, created_at, updated_at';

const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_PROJECTS = 200;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;

/** Every row, or `null` when the database could not be read. The difference
 *  between `null` and `[]` is what tells `effectiveRegistry` to degrade. */
export async function readRows(db) {
  if (!db) return null;
  try {
    const { results } = await db.prepare(`SELECT ${ROW_COLUMNS} FROM projects`).all();
    return results ?? [];
  } catch {
    return null;
  }
}

/**
 * What the rest of the Worker should treat as the registry.
 * Tolerates a missing DB binding on purpose: the Worker tests bind ASSETS and
 * STATUS but no DB, and a dashboard that 500s because its database is absent
 * fails in a way that reads like a routing bug.
 */
export async function effectiveRegistry(env, file) {
  const rows = await readRows(env?.DB);
  if (rows === null) {
    return { registry: (file ?? []).map((p) => ({ ...p, origin: 'file' })), skipped: [], degraded: true };
  }
  const { registry, skipped } = mergeRegistry(file, rows);
  return { registry, skipped, degraded: false };
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

function assertSlug(slug) {
  const text = String(slug ?? '').trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(text)) {
    throw new ValidationError('a slug is lowercase words joined by hyphens', 'slug');
  }
  if (RESERVED_SLUGS.includes(text)) {
    throw new ValidationError(`"${text}" is a word HQ uses for its own pages — pick another`, 'slug');
  }
  if (text.length > 48) throw new ValidationError('that slug is too long', 'slug');
  return text;
}

/** Strip what is not the owner's to set, and say so rather than silently
 *  dropping it: a field that vanishes without explanation is worse than a
 *  refusal. */
function checkWritable(entry) {
  for (const key of UNWRITABLE_KEYS) {
    if (entry[key] !== undefined) {
      throw new ValidationError(`${key} is not yours to set here — it runs commands on the Mac, so it stays in the repository`, key);
    }
  }
  const status = entry.status;
  if (status && typeof status === 'object') {
    for (const field of UNWRITABLE_STATUS_FIELDS) {
      if (status[field] !== undefined) {
        throw new ValidationError(`status.${field} is not yours to set — a check is always a plain read of one address`, `status.${field}`);
      }
    }
    if (status.probe !== undefined && !['http', 'none'].includes(status.probe)) {
      throw new ValidationError('a check is either an address to open or nothing at all', 'status.probe');
    }
  }
  return entry;
}

/** Trim, cap, and drop the empties a form always sends. */
function tidy(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) continue;
      out[key] = text;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = tidy(value);
      if (Object.keys(inner).length) out[key] = inner;
    } else {
      out[key] = value;
    }
  }
  if (typeof out.name === 'string') out.name = out.name.slice(0, MAX_NAME);
  if (typeof out.description === 'string') out.description = out.description.slice(0, MAX_DESCRIPTION);
  return out;
}

/** Every address this entry would have the Worker open, checked before it
 *  can ever be fetched. */
function checkProbeTargets(entry) {
  const urls = [
    ['status.url', entry?.status?.url],
    ['links.live.url', entry?.links?.live?.url],
  ];
  const probes = entry?.status?.probe === 'http';
  for (const [field, url] of urls) {
    if (!url) continue;
    // A link HQ only renders may be any https address; one that gets opened
    // by the Worker on a timer is held to the destination rules.
    const checked = probes || field === 'status.url';
    const why = safeProbeTarget(url);
    if (why && checked) throw new ValidationError(`${field}: ${why}`, field);
    if (why && !/private|machine|api\//.test(why)) throw new ValidationError(`${field}: ${why}`, field);
  }
}

/**
 * Build and check the entry a create or an edit would store.
 * `existing` is the merged registry it would join, so the one validator sees
 * exactly the array it would have to accept.
 */
export function prepareEntry(input, existing, { slug: known = null } = {}) {
  const raw = tidy(input ?? {});
  checkWritable(raw);

  const slug = assertSlug(known ?? raw.slug ?? slugFrom(raw.name));
  const candidate = { ...raw, slug };
  if (candidate.status === undefined) candidate.status = { probe: 'none' };
  if (candidate.stage === undefined) candidate.stage = 'not_started';

  checkProbeTargets(candidate);

  const errors = validateEntry(candidate, existing ?? []);
  if (errors.length) {
    const error = new ValidationError('That project would not validate', 'entry');
    error.errors = errors;
    throw error;
  }

  const json = JSON.stringify(candidate);
  if (json.length > MAX_ENTRY_BYTES) throw new ValidationError('that project holds too much text', 'entry');
  return { slug, entry: candidate, json };
}

/** One batch: the row, its version, and the line in the log. */
async function write(db, { slug, origin, json, brand, archivedAt, version, position, createdAt, actor, action, note, before }) {
  const at = nowIso();
  await db.batch([
    db.prepare(
      `INSERT INTO projects (slug, origin, entry, brand, position, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         origin = excluded.origin, entry = excluded.entry, brand = excluded.brand,
         archived_at = excluded.archived_at, version = excluded.version, updated_at = excluded.updated_at`,
    ).bind(slug, origin, json, brand ?? null, position ?? 0, archivedAt ?? null, version, createdAt ?? at, at),
    db.prepare(
      `INSERT INTO project_versions (slug, version, origin, entry, brand, archived_at, at, actor, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, version, origin, json, brand ?? null, archivedAt ?? null, at, actor ?? '', note ?? ''),
    db.prepare(
      'INSERT INTO project_events (at, actor, slug, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(at, actor ?? '', slug, action, before ?? null, json),
  ]);
  return at;
}

export async function getRow(db, slug) {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM projects WHERE slug = ?`).bind(slug).first();
}

/** A project the owner made. The whole entry is stored. */
export async function createProject(db, input, existing, { actor = '' } = {}) {
  const { slug, entry, json } = prepareEntry(input, existing);
  if ((existing ?? []).some((p) => p.slug === slug)) {
    throw new ValidationError(`there is already a project called "${slug}"`, 'slug');
  }
  if ((existing ?? []).length >= MAX_PROJECTS) {
    throw new ValidationError('that is more projects than HQ will hold', 'slug');
  }
  const next = await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM projects').first();
  await write(db, {
    slug, origin: 'db', json, brand: entry.brand ?? null, archivedAt: null,
    version: 1, position: Number(next?.n ?? 0), createdAt: nowIso(),
    actor, action: 'create', note: 'created', before: null,
  });
  return { ...entry, origin: 'db' };
}

/**
 * An edit. A committed project stores only what changed, so every field the
 * owner did not touch keeps tracking the repository and a later deploy still
 * reaches him. A project he made stores the whole entry.
 */
export async function updateProject(db, slug, patch, { file, existing, actor = '', expectUpdatedAt = null } = {}) {
  const known = assertSlug(slug);
  if (patch && patch.slug !== undefined && patch.slug !== known) {
    throw new ValidationError('the slug cannot change — invoices, orders and missions point at it', 'slug');
  }
  const row = await getRow(db, known);
  if (expectUpdatedAt && row && row.updated_at !== expectUpdatedAt) {
    throw new ValidationError('this project changed somewhere else — reload and try again', 'updated_at');
  }

  const inFile = (file ?? []).some((p) => p.slug === known);
  const current = (existing ?? []).find((p) => p.slug === known);
  if (!current) throw new ValidationError('no such project', 'slug');

  const origin = inFile ? 'override' : 'db';
  // An override is stored as sent; a db-born project keeps its whole entry.
  const merged = inFile
    ? { ...(row?.entry ? JSON.parse(row.entry) : {}), ...tidy(patch) }
    : { ...current, ...tidy(patch) };
  delete merged.origin;
  delete merged.archived;

  const wouldBe = inFile
    ? { ...(file ?? []).find((p) => p.slug === known), ...merged, slug: known }
    : { ...merged, slug: known };
  checkWritable(tidy(patch));
  checkProbeTargets(wouldBe);
  const errors = validateEntry(wouldBe, (existing ?? []).filter((p) => p.slug !== known));
  if (errors.length) {
    const error = new ValidationError('That change would not validate', 'entry');
    error.errors = errors;
    throw error;
  }

  const json = JSON.stringify(inFile ? merged : wouldBe);
  if (json.length > MAX_ENTRY_BYTES) throw new ValidationError('that project holds too much text', 'entry');
  await write(db, {
    slug: known, origin, json, brand: wouldBe.brand ?? null,
    archivedAt: row?.archived_at ?? null,
    version: Number(row?.version ?? 0) + 1,
    position: row?.position ?? 0,
    createdAt: row?.created_at ?? nowIso(),
    actor, action: 'edit', note: 'edited', before: row?.entry ?? null,
  });
  return wouldBe;
}

/** Off the boards, out of the probe list, money untouched. */
export async function setArchived(db, slug, archived, { existing, actor = '' } = {}) {
  const known = assertSlug(slug);
  const row = await getRow(db, known);
  const current = (existing ?? []).find((p) => p.slug === known);
  if (!current) throw new ValidationError('no such project', 'slug');
  const at = nowIso();
  if (!row) {
    // A committed project archived for the first time needs a row to hold it.
    const json = JSON.stringify({});
    await write(db, {
      slug: known, origin: 'override', json, brand: current.brand ?? null,
      archivedAt: archived ? at : null, version: 1, position: 0, createdAt: at,
      actor, action: archived ? 'archive' : 'unarchive', note: archived ? 'archived' : 'unarchived', before: null,
    });
  } else {
    await write(db, {
      slug: known, origin: row.origin, json: row.entry, brand: row.brand,
      archivedAt: archived ? at : null, version: Number(row.version ?? 0) + 1,
      position: row.position ?? 0, createdAt: row.created_at,
      actor, action: archived ? 'archive' : 'unarchive', note: archived ? 'archived' : 'unarchived', before: row.entry,
    });
  }
  return { slug: known, archived };
}

/** How many records point at this slug, so a discard can refuse with numbers
 *  rather than a shrug. */
export async function countReferences(db, slug) {
  const counts = {};
  for (const [name, sql] of [
    ['invoices', 'SELECT COUNT(*) AS n FROM invoices WHERE slug = ?'],
    ['orders', 'SELECT COUNT(*) AS n FROM orders WHERE slug = ?'],
    ['clients', 'SELECT COUNT(*) AS n FROM clients WHERE slug = ?'],
    ['missions', 'SELECT COUNT(*) AS n FROM missions WHERE slug = ?'],
    ['notes', 'SELECT COUNT(*) AS n FROM project_meta WHERE slug = ?'],
  ]) {
    try {
      const row = await db.prepare(sql).bind(slug).first();
      counts[name] = Number(row?.n ?? 0);
    } catch { counts[name] = 0; }
  }
  return counts;
}

/**
 * Throw a project away. Only one the owner made, and only while nothing
 * refers to it. This exists for exactly one case: a slug typed wrongly and
 * noticed straight away, before it is written into anything.
 */
export async function discardProject(db, slug, { file, actor = '' } = {}) {
  const known = assertSlug(slug);
  if ((file ?? []).some((p) => p.slug === known)) {
    throw new ValidationError('this project is in the repository — archive it instead', 'slug');
  }
  const row = await getRow(db, known);
  if (!row) throw new ValidationError('no such project', 'slug');
  if (row.origin !== 'db') throw new ValidationError('this project is in the repository — archive it instead', 'slug');

  const counts = await countReferences(db, known);
  const used = Object.entries(counts).filter(([, n]) => n > 0);
  if (used.length) {
    const error = new ValidationError('this project is referred to elsewhere — archive it instead', 'slug');
    error.counts = counts;
    throw error;
  }
  await db.batch([
    db.prepare('DELETE FROM projects WHERE slug = ?').bind(known),
    db.prepare('INSERT INTO project_events (at, actor, slug, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(nowIso(), actor, known, 'discard', row.entry),
  ]);
  return true;
}

/** Back to what the repository says: the override row simply goes. */
export async function revertProject(db, slug, { file, actor = '' } = {}) {
  const known = assertSlug(slug);
  if (!(file ?? []).some((p) => p.slug === known)) {
    throw new ValidationError('this project is not in the repository, so there is nothing to go back to', 'slug');
  }
  const row = await getRow(db, known);
  if (!row) return false;
  await db.batch([
    db.prepare('DELETE FROM projects WHERE slug = ?').bind(known),
    db.prepare('INSERT INTO project_events (at, actor, slug, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(nowIso(), actor, known, 'revert', row.entry),
  ]);
  return true;
}

export async function listVersions(db, slug) {
  const { results } = await db.prepare(
    'SELECT version, origin, at, actor, note FROM project_versions WHERE slug = ? ORDER BY version DESC',
  ).bind(assertSlug(slug)).all();
  return results ?? [];
}

export async function listEvents(db, slug, limit = 40) {
  const { results } = await db.prepare(
    'SELECT at, actor, action FROM project_events WHERE slug = ? ORDER BY at DESC, id DESC LIMIT ?',
  ).bind(assertSlug(slug), limit).all();
  return results ?? [];
}

/** Undo is a write: restoring v3 records a new version whose entry is v3's. */
export async function restoreVersion(db, slug, version, { actor = '' } = {}) {
  const known = assertSlug(slug);
  const want = Number(version);
  if (!Number.isInteger(want) || want <= 0) throw new ValidationError('which version?', 'version');
  const old = await db.prepare(
    'SELECT origin, entry, brand, archived_at FROM project_versions WHERE slug = ? AND version = ?',
  ).bind(known, want).first();
  if (!old) throw new ValidationError('there is no such version', 'version');
  const row = await getRow(db, known);
  await write(db, {
    slug: known, origin: old.origin, json: old.entry, brand: old.brand,
    archivedAt: old.archived_at, version: Number(row?.version ?? 0) + 1,
    position: row?.position ?? 0, createdAt: row?.created_at ?? nowIso(),
    actor, action: 'restore', note: `restored from v${want}`, before: row?.entry ?? null,
  });
  return JSON.parse(old.entry);
}
