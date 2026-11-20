// Load a questionnaire setup (form_config) onto one prospect in HQ.
//   node scripts/setup-push.mjs <prospect-id> <setup.json> --check   validate only, write nothing
//   node scripts/setup-push.mjs <prospect-id> <setup.json>           validate, then write
//   --base http://localhost:8787 (default: the local HQ on the Mac, same database as online)
// The file is checked with HQ's own rules first; nothing is sent unless it passes,
// and the prospect must exist (it is read before anything is written).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanConfig } from '../src/public/assets/onboarding-form.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const base = baseAt >= 0 ? args[baseAt + 1] : 'http://localhost:8787';
const [id, file] = args.filter((a, i) => !a.startsWith('--') && !(baseAt >= 0 && i === baseAt + 1));
const check = args.includes('--check');
if (!/^\d+$/.test(id ?? '') || !file) { console.error('usage: node scripts/setup-push.mjs <prospect-id> <setup.json> [--check] [--base URL]'); process.exit(2); }

let setup;
try { setup = cleanConfig(JSON.parse(readFileSync(resolve(file), 'utf8'))); } catch (error) { console.error(`NOT VALID: ${error.message}`); process.exit(1); }
console.log(`valid: ${setup.custom.length} questions (${setup.custom.filter((q) => q.optional).length} optional), client answers: ${Boolean(setup.clientAnswers)}, tu: ${Boolean(setup.tu)}`);
if (check) process.exit(0);

const line = readFileSync(resolve(root, '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
const password = line?.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
let login;
try {
  login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
} catch {
  console.error(`HQ is not answering at ${base}. Start it first (open "Start HQ.command"), then run again.`);
  process.exit(3);
}
const session = /hq_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
if (!session) { console.error(`could not sign in to ${base} (${login.status})`); process.exit(1); }
const headers = { 'Content-Type': 'application/json', Cookie: `hq_session=${session}`, Origin: base };
const before = await fetch(`${base}/api/prospects/${id}`, { headers });
if (!before.ok) { console.error(`no prospect ${id} (${before.status}): nothing written`); process.exit(1); }
const { prospect } = await before.json();
console.log(`prospect ${id}: ${prospect.name}`);
const res = await fetch(`${base}/api/prospects/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ form_config: setup }) });
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`refused (${res.status}): ${out.error ?? ''}`); process.exit(1); }
console.log(`written: ${prospect.name} now has ${out.prospect.config.custom.length} questions; « The client answers on his phone » is ${out.prospect.config.clientAnswers ? 'on' : 'off'}`);
