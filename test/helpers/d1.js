import { afterAll, beforeAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlStatements } from '../../scripts/sql-statements.mjs';

/**
 * A fresh D1 database with every migration applied, on the engine production
 * uses: workerd's SQLite through Miniflare. Every database is empty and thrown
 * away. No production data.
 *
 * Why a template: Miniflare's D1 is a SQLite file on disk even when nothing is
 * persisted, so each statement waits on the disk. Replaying the 130-odd
 * migration statements for every test cost ~2.5 s on an idle Mac, half of
 * vitest's 5 s budget, and on a busy one (other sessions building, syncing)
 * whichever tests happened to hit the slow disk timed out (23 Oct 2026).
 * Now the migrations run once per test file into a template folder, and each
 * test boots Miniflare on its own copy of that folder (~0.35 s). The template
 * is built in a beforeAll, so no test's own time budget pays for it.
 */
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const ROOT = mkdtempSync(join(tmpdir(), 'hq-d1-test-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function miniflare(persistTo) {
  return new Miniflare({
    resourcePersistencePath: persistTo,
    workers: [{
      config: {
        name: 'hq-test',
        type: 'worker',
        compatibilityDate: '2025-07-18',
        manifest: {
          mainModule: 'index.mjs',
          modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } },
        },
        env: { DB: { type: 'd1', id: 'DB' } },
      },
    }],
  });
}

let template = null;
/** Applies every migration, in order, once per test file. */
function migratedTemplate() {
  template ??= (async () => {
    const path = join(ROOT, 'template');
    const mf = miniflare(path);
    try {
      const database = await mf.getD1Database('DB');
      const statements = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
        .flatMap((file) => sqlStatements(readFileSync(new URL(file, MIGRATIONS), 'utf8')));
      // eslint-disable-next-line no-await-in-loop -- migrations are ordered
      for (const statement of statements) await database.prepare(statement).run();
    } finally {
      await mf.dispose();
    }
    return path;
  })();
  return template;
}
// Once per file; a slow disk may need more than the 10 s hook default.
beforeAll(migratedTemplate, 60000);

let copies = 0;
/** A database of its own, and a dispose() that removes it from disk. */
export async function freshDatabase() {
  const from = await migratedTemplate();
  copies += 1;
  const path = join(ROOT, `db-${copies}`);
  cpSync(from, path, { recursive: true });
  const mf = miniflare(path);
  try {
    const database = await mf.getD1Database('DB');
    return {
      database,
      dispose: async () => {
        await mf.dispose();
        rmSync(path, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await mf.dispose();
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
