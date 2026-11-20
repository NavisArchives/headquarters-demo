// Push the morning briefing to HQ (the scheduled morning session runs this).
//   node scripts/briefing-push.mjs <file.json> --check   validate only, write nothing
//   node scripts/briefing-push.mjs <file.json>           validate, then push
//   --base http://localhost:8787 (default: the local HQ on the Mac, same database as online)
// Checking and writing are two separate steps: nothing is sent unless the file passes.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanBriefing } from '../src/worker/briefing.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const check = args.includes('--check');
const baseAt = args.indexOf('--base');
const base = baseAt >= 0 ? args[baseAt + 1] : 'http://localhost:8787';
if (!file) { console.error('usage: node scripts/briefing-push.mjs <file.json> [--check] [--base URL]'); process.exit(2); }

let clean;
try {
  clean = cleanBriefing(JSON.parse(readFileSync(resolve(file), 'utf8')));
} catch (error) {
  console.error(`NOT VALID: ${error.message}`);
  process.exit(1);
}
console.log(`valid: ${clean.date}, ${clean.findings.length} findings (${clean.findings.map((f) => f.type).join(', ')})`);
if (check) process.exit(0);

// The password is the one HQ itself reads (.dev.vars); it is never printed.
const line = readFileSync(resolve(root, '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
const password = line?.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
if (!password) { console.error('no HQ_PASSWORD in .dev.vars'); process.exit(1); }
let login;
try {
  login = await fetch(`${base}/login`, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
} catch {
  // The local HQ only runs while its Dock app (Start HQ.command) is open.
  console.error(`HQ is not answering at ${base}. Start it first (open "Start HQ.command" in the HQ folder, or npm run dev), then push again.`);
  process.exit(3);
}
const session = /hq_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
if (!session) { console.error(`could not sign in to ${base} (${login.status})`); process.exit(1); }
const res = await fetch(`${base}/api/briefing`, {
  method: 'POST', body: JSON.stringify(clean),
  headers: { 'Content-Type': 'application/json', Cookie: `hq_session=${session}`, Origin: base },
});
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`push refused (${res.status}): ${out.error ?? ''}`); process.exit(1); }
console.log(`pushed to ${base}: ${out.findings} findings for ${out.date}`);
