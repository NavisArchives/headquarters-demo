/* ---------------------------------------------------------------------- *
 * Leads importer (phase 4, task 3).
 *
 * Reads the lead datasets (see leads/SCHEMA.md) and upserts them into
 * `datasets` and `leads` via db.js's own upsertDataset/upsertLead — nothing
 * here writes SQL directly. Facts only: this module never imports anything
 * that touches `lead_state`, `lead_events` or `lead_drafts`, and it must
 * stay that way — those tables are owned by the person, not the importer.
 *
 * Two-phase by design: `prepareImport` validates and derives every row for
 * every dataset *before* `runImport` issues a single db.prepare() call. A
 * bad row anywhere aborts the whole run with nothing written, rather than
 * leaving some datasets imported and others not.
 * ---------------------------------------------------------------------- */

import { upsertDataset, upsertLead, nowIso } from './db.js';

/** Mirrors tools/build.py's REQUIRED list and leads/SCHEMA.md's required
 *  row table, exactly. */
export const REQUIRED_ROW_FIELDS = Object.freeze([
  'id', 'name', 'website', 'category', 'subcategory', 'country', 'score',
]);

const CONTACT_TYPES = Object.freeze(['email', 'form', 'linkedin', 'portal', 'phone', 'other']);

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function rowLabel(datasetKey, row, index) {
  const id = row && !isBlank(row.id) ? row.id : `#${index}`;
  return `${datasetKey}/${id}`;
}

/** Validates dataset meta the way tools/build.py's validate_meta does, and
 *  returns the subset upsertDataset needs (mapped, not the raw JSON shape). */
function checkMeta(meta, datasetKey) {
  const m = meta || {};
  for (const field of ['business', 'title', 'collected']) {
    if (isBlank(m[field])) throw new ImportError(`${datasetKey}: meta.${field} is required`);
  }
  if (!isBlank(m.key) && m.key !== datasetKey) {
    throw new ImportError(`${datasetKey}: meta.key '${m.key}' must equal the dataset folder name`);
  }
  const tiers = m.tiers || {};
  if (!Number.isInteger(tiers.hot) || !Number.isInteger(tiers.warm) || tiers.hot < tiers.warm) {
    throw new ImportError(`${datasetKey}: meta.tiers must be { hot, warm } integers with hot >= warm`);
  }
  return {
    business: m.business,
    title: m.title,
    subtitle: m.subtitle ?? null,
    collected: m.collected,
    method: m.method ?? null,
    scoring: m.scoring ?? null,
    tiers,
  };
}

/** Validates one row the way tools/build.py's normalise_row does (required
 *  fields, score range, duplicate id). Throws naming the dataset and the
 *  row's id (or its index, if `id` itself is what's missing). */
function checkRow(row, index, datasetKey, seenIds) {
  for (const field of REQUIRED_ROW_FIELDS) {
    if (isBlank(row?.[field])) {
      throw new ImportError(`${rowLabel(datasetKey, row, index)}: missing required field '${field}'`);
    }
  }
  if (!Number.isInteger(row.score) || row.score < 0 || row.score > 100) {
    throw new ImportError(`${rowLabel(datasetKey, row, index)}: score must be an integer 0-100`);
  }
  if (seenIds.has(row.id)) {
    throw new ImportError(`${rowLabel(datasetKey, row, index)}: duplicate id in dataset '${datasetKey}'`);
  }
  seenIds.add(row.id);
}

/** score >= tiers.hot -> Hot, >= tiers.warm -> Warm, else Cool. */
export function deriveTier(score, tiers) {
  if (score >= tiers.hot) return 'Hot';
  if (score >= tiers.warm) return 'Warm';
  return 'Cool';
}

/** The row's own contactType wins if present. Otherwise: email -> 'email',
 *  else phone -> 'phone', else 'form' — mirrors tools/build.py's
 *  `r.setdefault("contactType", "email" if r["email"] else ("phone" if
 *  r["phone"] else "form"))`, and leads/SCHEMA.md's "derived from
 *  email/phone if omitted". */
export function deriveContactType(row) {
  if (!isBlank(row.contactType)) return row.contactType;
  if (!isBlank(row.email)) return 'email';
  if (!isBlank(row.phone)) return 'phone';
  return 'form';
}

function assertContactType(contactType, datasetKey, row, index) {
  if (!CONTACT_TYPES.includes(contactType)) {
    throw new ImportError(
      `${rowLabel(datasetKey, row, index)}: contactType '${contactType}' not in ${CONTACT_TYPES.join(', ')}`,
    );
  }
  return contactType;
}

/** Builds the row shape upsertLead expects. `payload` is the row exactly as
 *  read from data.json (never mutated), so it round-trips verbatim. */
function buildLeadRow(datasetKey, datasetMeta, row, index) {
  const contactType = assertContactType(deriveContactType(row), datasetKey, row, index);
  return {
    dataset: datasetKey,
    id: row.id,
    business: datasetMeta.business,
    name: row.name,
    website: row.website,
    category: row.category,
    subcategory: row.subcategory ?? null,
    city: row.city ?? null,
    area: row.area ?? null,
    region: row.region ?? null,
    country: row.country,
    languages: Array.isArray(row.languages) ? row.languages : [],
    email: row.email ?? null,
    phone: row.phone ?? null,
    contact: row.contact ?? null,
    contact_type: contactType,
    score: row.score,
    tier: deriveTier(row.score, datasetMeta.tiers),
    verified: row.verified ?? null,
    payload: row,
  };
}

/**
 * Pure (no I/O, no db): validates every dataset and every row up front and
 * derives the row shape upsertLead needs. Throws ImportError, naming the
 * dataset and row, on the first problem found anywhere — so a caller that
 * runs this before touching the db never writes anything partial.
 *
 * `datasets` is an array of `{ key, meta, rows }`, where `key` is the
 * dataset folder name, `meta` is the parsed `data.json` `meta` object, and
 * `rows` is the parsed `data.json` `rows` array.
 */
export function prepareImport(datasets) {
  if (!Array.isArray(datasets)) throw new ImportError('datasets must be an array');

  const prepared = [];
  for (const dataset of datasets) {
    const key = dataset?.key;
    if (isBlank(key)) throw new ImportError('a dataset is missing its key');

    const datasetMeta = checkMeta(dataset.meta, key);
    const rows = Array.isArray(dataset.rows) ? dataset.rows : [];
    const seenIds = new Set();
    const leadRows = rows.map((row, index) => {
      checkRow(row, index, key, seenIds);
      return buildLeadRow(key, datasetMeta, row, index);
    });

    prepared.push({ key, meta: datasetMeta, rows: leadRows, count: leadRows.length });
  }
  return prepared;
}

/**
 * Validates and upserts every dataset via db.js's upsertDataset/upsertLead —
 * facts only, never `lead_state`/`lead_events`/`lead_drafts`. Idempotent:
 * running it twice with the same input issues the same upserts and leaves
 * no extra rows, because every write is `ON CONFLICT ... DO UPDATE` keyed
 * on `datasets.key` / `leads.uid`.
 *
 * `now`, if given, is only used for the returned summary's `importedAt` —
 * the actual row timestamps come from db.js's own `nowIso()`, one clock for
 * every writer.
 */
export async function runImport(db, datasets, { now } = {}) {
  const prepared = prepareImport(datasets);

  for (const dataset of prepared) {
    await upsertDataset(db, {
      key: dataset.key,
      business: dataset.meta.business,
      title: dataset.meta.title,
      subtitle: dataset.meta.subtitle,
      collected: dataset.meta.collected,
      method: dataset.meta.method,
      scoring: dataset.meta.scoring,
      tiers: dataset.meta.tiers,
      count: dataset.count,
    });
    for (const row of dataset.rows) {
      await upsertLead(db, row);
    }
  }

  const totalRows = prepared.reduce((sum, d) => sum + d.count, 0);
  return {
    importedAt: now ?? nowIso(),
    totalRows,
    datasets: prepared.map((d) => ({ key: d.key, business: d.meta.business, count: d.count })),
  };
}
