// Compile the existing importer's bound statements to a reviewed SQL file.
// Re-importing facts is safe; an existing HQ pipeline state always wins.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadDatasets, DEFAULT_DATASETS_DIR } from './import-leads.mjs';
import { runImport } from '../src/worker/import-leads.js';
import { STATE_STAGES } from '../src/worker/db.js';
const quote = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const statements = [];
const recorder = { prepare(sql) { return { bind(...args) { let n = 0; return { async run() { statements.push(sql.replaceAll('?', () => quote(args[n++])) + ';'); } }; } }; } };
await runImport(recorder, loadDatasets(DEFAULT_DATASETS_DIR));
const progress = JSON.parse(readFileSync(new URL('../modules/leads/progress.json', import.meta.url), 'utf8'));
let states = 0;
for (const [uid, state] of Object.entries(progress.leads || {})) {
  if (!STATE_STAGES.includes(state.status)) throw new Error(`Invalid stage for ${uid}`);
  const values = [uid, state.status, state.star ? 1 : 0, state.notes || '', state.followUp || null, state.lookedAt || null, state.sentAt || null, state.repliedAt || null, state.wonAt || null, state.passedAt || null, state.updatedAt || new Date().toISOString()];
  statements.push(`INSERT INTO lead_state (uid,stage,starred,notes,follow_up,looked_at,sent_at,replied_at,won_at,passed_at,updated_at) VALUES (${values.map(quote).join(',')}) ON CONFLICT(uid) DO NOTHING;`);
  states++;
}
mkdirSync(new URL('../.wrangler/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.wrangler/seed.sql', import.meta.url), statements.join('\n'));
console.log(`Prepared dataset import and ${states} saved pipeline records in .wrangler/seed.sql. Existing HQ state is preserved.`);
