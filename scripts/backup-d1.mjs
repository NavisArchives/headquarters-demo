// A full SQL export of HQ's database, filed in the Google Drive app folder
// (audit item 3, 13 Nov). Run weekly, and before every remote migration:
//
//   npm run backup -- --reason weekly          (the live database, read-only)
//   npm run backup -- --reason pre-migration   (the same, named for the release)
//   npm run backup -- --demo                   (the demo database: tests this script)
//   npm run backup:check -- <file.sql.gz>      (proves a backup restores, offline)
//
// What it does: `wrangler d1 export` to a temporary file → checks it has the
// core tables → gzips it → writes it and a manifest (sha256, size, rows per
// table, git head) into the Drive folder → re-reads the copy in Drive and
// compares the hash. It never deletes a backup. The restore steps are in
// docs/RUNBOOK-D1.md.
//
// The export reads the live database (Cloudflare blocks writes to it for the
// few seconds the export runs). It writes nothing to it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The tables a backup must hold for it to count as one. */
export const CORE_TABLES = ['leads', 'lead_state', 'clients', 'invoices', 'invoice_lines', 'missions', 'datasets', 'd1_migrations'];

/** The Drive app folder: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive/*OFFICE.
 *  HQ_BACKUP_DIR overrides it (tests, or another disk). */
export function backupDir(env = process.env) {
  if (env.HQ_BACKUP_DIR) return env.HQ_BACKUP_DIR;
  const cloud = join(homedir(), 'Library', 'CloudStorage');
  const drives = existsSync(cloud) ? readdirSync(cloud).filter((name) => name.startsWith('GoogleDrive-')) : [];
  for (const drive of drives) {
    const office = join(cloud, drive, 'My Drive', '*OFFICE');
    if (existsSync(office)) return join(office, 'HEADQUARTERS', 'BACKUPS', 'd1');
  }
  return null;
}

/** Rows per table, read from the INSERT lines of a d1 export. */
export function countRows(sql) {
  const tables = {};
  for (const match of sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z0-9_]+)["`]?/gm)) tables[match[1]] = 0;
  for (const match of sql.matchAll(/^INSERT INTO ["`]?([A-Za-z0-9_]+)["`]?/gm)) tables[match[1]] = (tables[match[1]] ?? 0) + 1;
  for (const name of Object.keys(tables)) if (name.startsWith('sqlite_')) delete tables[name]; // SQLite's own bookkeeping
  return tables;
}

/** What is wrong with an export, or null when it looks whole. */
export function problemWith(sql, { core = CORE_TABLES } = {}) {
  if (!sql || sql.length < 200) return 'the export is empty';
  const tables = countRows(sql);
  const missing = core.filter((table) => !(table in tables));
  if (missing.length) return `the export lacks ${missing.join(', ')}`;
  return null;
}

export function stamp(date = new Date()) {
  // Brussels time in the name, as every other file in the agency.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}`;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function gitHead() {
  const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

function exportArgs({ demo }, output) {
  return demo
    ? ['wrangler', 'd1', 'export', 'hq-demo', '--local', '--config', 'wrangler.demo.jsonc', '--output', output]
    : ['wrangler', 'd1', 'export', 'hq', '--remote', '--output', output];
}

/** Loads a backup into an in-memory SQLite and counts its rows: proof that it restores. */
export async function restoreCheck(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = readFileSync(file);
  const sql = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(sql);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const rows = Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
  const integrity = db.prepare('PRAGMA integrity_check').get();
  db.close();
  return { tables: names.length, rows, integrity: Object.values(integrity)[0] };
}

function argValue(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
}

async function main(args) {
  if (args[0] === 'check') {
    const file = args[1];
    if (!file || !existsSync(file)) { console.error('backup:check needs a backup file'); return 2; }
    const manifestFile = file.replace(/\.sql(\.gz)?$/, '.json');
    const result = await restoreCheck(file);
    console.log(`restores: ${result.tables} tables, integrity ${result.integrity}`);
    let ok = result.integrity === 'ok';
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const differ = Object.entries(manifest.rows).filter(([table, n]) => (result.rows[table] ?? 0) !== n);
      if (differ.length) { ok = false; console.error(`row counts differ from the manifest: ${differ.map(([t]) => t).join(', ')}`); }
      else console.log(`row counts match the manifest (${Object.keys(manifest.rows).length} tables)`);
      if (sha256(readFileSync(file)) !== manifest.sha256) { ok = false; console.error('the file hash differs from the manifest'); }
      else console.log('hash matches the manifest');
    }
    return ok ? 0 : 1;
  }

  const demo = args.includes('--demo');
  const reason = argValue(args, '--reason') ?? (demo ? 'demo' : 'manual');
  if (!/^[a-z0-9-]{1,40}$/.test(reason)) { console.error('--reason is one short word: weekly, pre-migration, manual'); return 2; }
  const dir = demo && !process.env.HQ_BACKUP_DIR ? join(root, '.wrangler', 'demo-backups') : backupDir();
  if (!dir) {
    console.error('No Google Drive folder found (~/Library/CloudStorage/GoogleDrive-*/My Drive/*OFFICE). Is Google Drive running? Nothing was exported.');
    return 2;
  }
  mkdirSync(dir, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), 'hq-backup-'));
  try {
    const raw = join(work, 'export.sql');
    const run = spawnSync('npx', exportArgs({ demo }, raw), { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (run.status !== 0 || !existsSync(raw)) {
      console.error(`wrangler d1 export failed (exit ${run.status}):\n${(run.stderr || run.stdout || '').trim().split('\n').slice(-8).join('\n')}`);
      return 1;
    }
    const sql = readFileSync(raw, 'utf8');
    const problem = problemWith(sql, demo ? { core: ['leads', 'lead_state', 'd1_migrations'] } : undefined);
    if (problem) { console.error(`Not filed: ${problem}.`); return 1; }

    const name = `hq-${demo ? 'demo-' : ''}${stamp()}-${reason}`;
    const gz = gzipSync(sql, { level: 9 });
    const hash = sha256(gz);
    const target = join(dir, `${name}.sql.gz`);
    if (existsSync(target)) { console.error(`${basename(target)} already exists; nothing overwritten.`); return 1; }
    writeFileSync(target, gz);
    const rows = countRows(sql);
    const manifest = {
      file: basename(target), database: demo ? 'hq-demo (local)' : 'hq (remote)', reason,
      at: new Date().toISOString(), git: gitHead(), bytes: gz.length, sqlBytes: Buffer.byteLength(sql), sha256: hash, rows,
    };
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

    // Drive can rewrite a file it is syncing: read the filed copy back.
    if (sha256(readFileSync(target)) !== hash) { console.error(`The copy in ${dir} does not match what was written.`); return 1; }
    const total = Object.values(rows).reduce((a, b) => a + b, 0);
    console.log(`Backed up ${Object.keys(rows).length} tables, ${total} rows, ${(gz.length / 1024).toFixed(0)} KB → ${target}`);
    console.log(`sha256 ${hash}`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error?.message || error); process.exit(1); });
}

