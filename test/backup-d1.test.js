// The weekly D1 backup (audit item 3): what counts as a whole export, and where it goes.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { countRows, problemWith, stamp, backupDir, restoreCheck, CORE_TABLES } from '../scripts/backup-d1.mjs';

const exportOf = (tables, rows = {}, { bookkeeping = true } = {}) => [
  'PRAGMA defer_foreign_keys=TRUE;',
  ...tables.map((t) => `CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v TEXT);`),
  ...(bookkeeping ? ['CREATE TABLE sqlite_sequence(name,seq);'] : []),
  ...Object.entries(rows).flatMap(([t, n]) => Array.from({ length: n }, (_, i) => `INSERT INTO "${t}" VALUES(${i + 1},'x');`)),
  ...(bookkeeping ? ['INSERT INTO "sqlite_sequence" VALUES(\'leads\',3);'] : []),
].join('\n');

describe('the D1 backup', () => {
  it('counts rows per table and leaves SQLite\'s own tables out', () => {
    expect(countRows(exportOf(['leads', 'clients'], { leads: 3 }))).toEqual({ leads: 3, clients: 0 });
  });

  it('refuses an empty export or one without the core tables', () => {
    expect(problemWith('')).toMatch(/empty/);
    const partial = exportOf(['leads', 'clients'], { leads: 50 });
    expect(problemWith(partial)).toMatch(/lacks .*invoices/);
    expect(problemWith(exportOf(CORE_TABLES, { leads: 50 }))).toBeNull();
  });

  it('names the file in Brussels time', () => {
    expect(stamp(new Date('2026-11-16T14:05:00Z'))).toBe('2026-11-16-1505');
    expect(stamp(new Date('2026-07-01T22:30:00Z'))).toBe('2026-07-02-0030');
  });

  it('goes where HQ_BACKUP_DIR says, when it is set', () => {
    expect(backupDir({ HQ_BACKUP_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('proves a backup restores, and notices a broken one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-backup-test-'));
    const good = join(dir, 'good.sql.gz');
    writeFileSync(good, gzipSync(exportOf(CORE_TABLES, { leads: 4, invoices: 2 }, { bookkeeping: false })));
    const result = await restoreCheck(good);
    expect(result.integrity).toBe('ok');
    expect(result.rows).toMatchObject({ leads: 4, invoices: 2, clients: 0 });
    const bad = join(dir, 'bad.sql.gz');
    writeFileSync(bad, gzipSync('CREATE TABLE leads (id INTEGER PRIMARY KEY);\nINSERT INTO leads VALUES(1);\nINSERT INTO leads VALUES(1);'));
    await expect(restoreCheck(bad)).rejects.toThrow(/UNIQUE/);
  });
});
