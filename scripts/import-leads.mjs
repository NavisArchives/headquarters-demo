#!/usr/bin/env node
/*
 * Loads the lead datasets (see leads/SCHEMA.md) from disk, validates every
 * dataset and row the way tools/build.py does (src/worker/import-leads.js's
 * `prepareImport`), and prints what it found.
 *
 * Usage:
 *   node scripts/import-leads.mjs [datasetsDir] [--dry-run]
 *
 * `datasetsDir` defaults to the sibling `leads/datasets/` folder under
 * HEADQUARTERS/ (today: ../modules/leads/datasets relative to this file, i.e.
 * a sibling of this repo). Once that `leads/` folder merges into this repo
 * as `data/leads/datasets/`, pass that path explicitly, e.g.:
 *
 *   node scripts/import-leads.mjs data/leads/datasets
 *
 * or update DEFAULT_DATASETS_DIR below once the merge lands.
 *
 * This script never touches D1 — it only reads local JSON and validates.
 * Writing happens through `runImport(db, datasets, { now })`
 * (src/worker/import-leads.js), which Task 6 wires to an authenticated
 * `POST /api/leads/import` worker route. `--dry-run` additionally reports
 * the exact statement count a real import would issue (one dataset upsert
 * plus one lead upsert per row), still touching nothing.
 *
 * Zero runtime dependencies: only Node built-ins and this repo's own code.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareImport, ImportError } from '../src/worker/import-leads.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The sibling `leads/datasets/` folder under HEADQUARTERS/, as it exists
 *  today (this repo, `hq/`, and `leads/` are sibling folders). See the
 *  header comment above for the path once `leads/` merges into this repo. */
export const DEFAULT_DATASETS_DIR = path.resolve(SCRIPT_DIR, '../modules/leads/datasets');

/** Reads every `<dir>/<key>/data.json` (skipping folders starting with `_`,
 *  such as `_archive`, and any subfolder without a data.json) and returns
 *  `[{ key, meta, rows }, ...]`, sorted by folder name for determinism. */
export function loadDatasets(dir) {
  if (!existsSync(dir)) {
    throw new Error(`datasets directory not found: ${dir}`);
  }

  const keys = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  const datasets = [];
  for (const key of keys) {
    const dataPath = path.join(dir, key, 'data.json');
    if (!existsSync(dataPath)) continue;

    let doc;
    try {
      doc = JSON.parse(readFileSync(dataPath, 'utf8'));
    } catch (err) {
      throw new Error(`${path.relative(dir, dataPath)} is not valid JSON: ${err.message}`);
    }
    datasets.push({ key, meta: doc.meta ?? {}, rows: doc.rows ?? [] });
  }
  return datasets;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  const datasetsDir = positional[0] ? path.resolve(positional[0]) : DEFAULT_DATASETS_DIR;
  return { datasetsDir, dryRun };
}

export function main(argv = process.argv) {
  const { datasetsDir, dryRun } = parseArgs(argv);
  console.log(`Reading datasets from ${datasetsDir}`);

  const datasets = loadDatasets(datasetsDir);
  if (!datasets.length) {
    console.log('No datasets found (no data.json under any subfolder). Nothing to do.');
    return;
  }

  const prepared = prepareImport(datasets);

  const byBusiness = new Map();
  for (const d of prepared) byBusiness.set(d.meta.business, (byBusiness.get(d.meta.business) ?? 0) + d.count);
  const totalRows = prepared.reduce((sum, d) => sum + d.count, 0);

  console.log('');
  for (const d of prepared) console.log(`  ${d.key} (${d.meta.business}): ${d.count} rows`);
  console.log('');
  for (const [business, count] of byBusiness) console.log(`  ${business}: ${count}`);
  console.log(`  TOTAL: ${totalRows} rows across ${prepared.length} dataset(s)`);
  console.log('');

  if (dryRun) {
    const statements = prepared.length + totalRows;
    console.log('[dry-run] validated only — touching nothing.');
    console.log(
      `[dry-run] a real import would issue ${prepared.length} dataset upsert(s) `
      + `+ ${totalRows} lead upsert(s) = ${statements} statement(s).`,
    );
  } else {
    console.log('Validation passed. This script never talks to D1 directly — the actual');
    console.log('write happens through runImport() (src/worker/import-leads.js), wired to');
    console.log('POST /api/leads/import.');
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    const label = err instanceof ImportError ? 'invalid dataset' : 'import-leads';
    console.error(`${label}: ${err.message}`);
    process.exitCode = 1;
  }
}
