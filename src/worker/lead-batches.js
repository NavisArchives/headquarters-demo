// Lead batches that import themselves (Andy, 13 Nov: « this is bit of a repeat
// pattern of always having to run the imports … lets do 1 then! »).
//
//   LEADS    files a dataset (the data.json it built) through the intake door.
//   NIRMATA  files an approval naming that file's sha256 and its row count.
//   HQ       imports the batch the moment both exist and match, in one
//            transaction, through its own D1 binding: no wrangler, no terminal.
//
// The gate is the fingerprint: a batch whose bytes changed after the check has
// another sha256, matches no approval, and is never imported. Leads are
// upserted with the importer's own rules (import-leads.js); nothing is
// deleted, and lead_state, lead_events and lead_drafts are never touched.
import { ValidationError, nowIso, upsertDatasetStatement, upsertLeadStatement } from './db.js';
import { prepareImport, ImportError } from './import-leads.js';
import { isPersonalDataset } from '../public/assets/personal-lists.js';

/** A batch is one dataset file; D1 holds a row of up to about 2 MB. */
export const BATCH_MAX_BYTES = 1_500_000;
const KEY = /^[a-z0-9][a-z0-9-]{1,79}$/;
const SHA = /^[0-9a-f]{64}$/;

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseBatch(key, raw) {
  if (!KEY.test(key ?? '')) throw new ValidationError('key must be the dataset folder name, like web-wave-r4-fr-be', 'key');
  // The Travel list list is Andy's own: kept by hand, never through the batch door.
  if (isPersonalDataset(key)) throw new ValidationError(`${key} is a personal list and is not imported as a batch`, 'key');
  let data;
  try { data = JSON.parse(raw); } catch { throw new ValidationError('the batch must be the dataset JSON (data.json)', 'body'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.rows)) throw new ValidationError('the batch needs meta and rows', 'body');
  // Every check the importer makes, before anything is stored (required fields,
  // score range, duplicate ids, meta.key = key, tiers).
  try {
    const [dataset] = prepareImport([{ key, meta: data.meta, rows: data.rows }]);
    return dataset;
  } catch (error) {
    if (error instanceof ImportError) throw new ValidationError(error.message, 'rows');
    throw error;
  }
}

const LOG_COLUMNS = 'id, key, sha256, rows, source, received_at, imported_at, result, error';

/** LEADS (or NIRMATA) files a batch. Filing the same bytes again changes nothing. */
export async function receiveBatch(db, source, key, raw) {
  if (raw.length > BATCH_MAX_BYTES) throw new ValidationError(`a batch must be at most ${BATCH_MAX_BYTES} bytes; split the dataset`, 'body');
  const dataset = parseBatch(key, raw);
  const sha256 = await sha256Hex(raw);
  await db.prepare(
    `INSERT INTO lead_batches (key, sha256, rows, body, source, received_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key, sha256) DO NOTHING`,
  ).bind(key, sha256, dataset.count, raw, source, nowIso()).run();
  const imported = await importApproved(db);
  return { key, sha256, rows: dataset.count, imported };
}

/** NIRMATA approves the file it checked, by its sha256 and row count. */
export async function approveBatch(db, source, input = {}) {
  const key = String(input.key ?? '');
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  const rows = input.rows;
  if (!KEY.test(key)) throw new ValidationError('key must be the dataset folder name', 'key');
  if (!SHA.test(sha256)) throw new ValidationError('sha256 must be the file\'s 64-character SHA-256', 'sha256');
  if (!Number.isInteger(rows) || rows < 1) throw new ValidationError('rows must be the number of leads checked', 'rows');
  await db.prepare(
    `INSERT INTO lead_batch_approvals (key, sha256, rows, approved_at, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key, sha256) DO NOTHING`,
  ).bind(key, sha256, rows, nowIso(), source).run();
  const imported = await importApproved(db);
  return { key, sha256, rows, imported };
}

/** One batch, all or nothing: the checks, then every upsert in one D1 batch
 *  (a transaction). The outcome is written to the batch's log row either way. */
async function importOne(db, batch, approval) {
  const at = nowIso();
  try {
    const dataset = parseBatch(batch.key, batch.body);
    if (dataset.count !== approval.rows || dataset.count !== batch.rows) {
      throw new ValidationError(`${batch.key}: ${dataset.count} rows in the file, ${approval.rows} approved`, 'rows');
    }
    const statements = [upsertDatasetStatement(db, {
      key: dataset.key, ...dataset.meta, count: dataset.count,
    })];
    for (const row of dataset.rows) {
      // upsertLead derives the uid as `<dataset>/<id>`; an id holding a slash
      // could still reach into another dataset's uid space, so it is refused.
      if (String(row.id).includes('/') || row.dataset !== batch.key) {
        throw new ValidationError(`${batch.key}: row ${row.id} does not belong to this dataset`, 'rows');
      }
      statements.push(upsertLeadStatement(db, row));
    }
    statements.push(db.prepare(
      "UPDATE lead_batches SET imported_at = ?, result = 'imported', error = NULL, body = '' WHERE id = ?",
    ).bind(at, batch.id));
    await db.batch(statements);
    return { key: batch.key, sha256: batch.sha256, rows: dataset.count, result: 'imported', at };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 500);
    await db.prepare("UPDATE lead_batches SET imported_at = ?, result = 'failed', error = ? WHERE id = ?")
      .bind(at, message, batch.id).run();
    return { key: batch.key, sha256: batch.sha256, rows: batch.rows, result: 'failed', error: message, at };
  }
}

/** Imports every filed batch that has a matching approval and was not tried yet. */
export async function importApproved(db) {
  const { results } = await db.prepare(
    `SELECT b.id, b.key, b.sha256, b.rows, b.body, a.rows AS approved_rows
     FROM lead_batches b JOIN lead_batch_approvals a ON a.key = b.key AND a.sha256 = b.sha256
     WHERE b.result IS NULL ORDER BY b.id`,
  ).all();
  const done = [];
  for (const row of results ?? []) {
    // eslint-disable-next-line no-await-in-loop -- one transaction per batch, in the order they came
    done.push(await importOne(db, row, { rows: row.approved_rows }));
  }
  return done;
}

/** The log, newest first: what NIRMATA and the leads screen read. */
export async function listBatches(db, { limit = 50 } = {}) {
  const { results } = await db.prepare(
    `SELECT ${LOG_COLUMNS.split(', ').map((c) => `b.${c}`).join(', ')},
            (SELECT a.approved_at FROM lead_batch_approvals a WHERE a.key = b.key AND a.sha256 = b.sha256) AS approved_at
     FROM lead_batches b ORDER BY b.id DESC LIMIT ?`,
  ).bind(Math.min(Math.max(Number(limit) || 50, 1), 200)).all();
  return results ?? [];
}
