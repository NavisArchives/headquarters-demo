#!/usr/bin/env node
// One command, no values to type (NIRMATA, 13 Nov): makes the intake tokens for
// NIRMATA and LEADS (now MARKETING: lead batches and its send logs), keeps each
// where only its own session reads it, and gives
// HQ only their SHA-256.
//
//   node scripts/setup-intake-tokens.mjs            local HQ (localhost:8787)
//   node scripts/setup-intake-tokens.mjs --online   also the deployed Worker (wrangler secret put)
//   add --rotate to replace tokens that already exist
//
// Raw tokens (mode 600, never in git, never printed):
//   OFFICE/NIRMATA/.secrets/intake-token
//   OFFICE/HEADQUARTERS/.secrets/leads-intake-token
// HEADQUARTERS/.dev.vars gets INTAKE_TOKEN_NIRMATA_SHA256 and INTAKE_TOKEN_LEADS_SHA256.
//
// It also makes BREVO_HOOK_TOKEN, the secret in the path of Brevo's « opened »
// webhook (src/worker/brevo-hook.js). Only the deployed Worker uses it (Brevo
// can't reach localhost), so it goes online with --online, and the full webhook
// address Andy pastes into Brevo is written to HEADQUARTERS/.secrets/brevo-webhook-url.
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HQ = process.env.HQ_HOME || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = [
  { name: 'INTAKE_TOKEN_NIRMATA', file: process.env.NIRMATA_TOKEN_FILE || `${HQ}/.secrets/nirmata-intake-token` },
  { name: 'INTAKE_TOKEN_LEADS', file: `${HQ}/.secrets/leads-intake-token` },
];
const args = new Set(process.argv.slice(2));
const rotate = args.has('--rotate');
const online = args.has('--online');
const sha = (t) => createHash('sha256').update(t).digest('hex');
const BREVO_FILE = `${HQ}/.secrets/brevo-hook-token`;
const BREVO_URL_FILE = `${HQ}/.secrets/brevo-webhook-url`;
const ONLINE_HOST = 'https://hq.example.com';

const made = [];
for (const t of TOKENS) {
  if (existsSync(t.file) && !rotate) {
    made.push({ ...t, hash: sha(readFileSync(t.file, 'utf8').trim()), kept: true });
    continue;
  }
  mkdirSync(dirname(t.file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(t.file, `${token}\n`, { mode: 0o600 });
  chmodSync(t.file, 0o600);
  made.push({ ...t, hash: sha(token), kept: false });
}

// .dev.vars: drop any old raw or hashed line for these two, then add the hashes.
const vars = `${HQ}/.dev.vars`;
const names = TOKENS.flatMap((t) => [t.name, `${t.name}_SHA256`]);
const old = existsSync(vars) ? readFileSync(vars, 'utf8').split('\n') : [];
const kept = old.filter((line) => !names.some((n) => line.startsWith(`${n}=`)));
while (kept.length && kept.at(-1) === '') kept.pop();
writeFileSync(vars, `${[...kept, ...made.map((t) => `${t.name}_SHA256=${t.hash}`)].join('\n')}\n`, { mode: 0o600 });

for (const t of made) console.log(`${t.kept ? 'kept' : 'made'}  ${t.name} → ${t.file.replace(`${HQ}/`, '')} (hash in .dev.vars)`);

// Brevo's webhook secret: kept like the others, never printed.
let brevo;
const brevoKept = existsSync(BREVO_FILE) && !rotate;
if (brevoKept) {
  brevo = readFileSync(BREVO_FILE, 'utf8').trim();
} else {
  mkdirSync(dirname(BREVO_FILE), { recursive: true, mode: 0o700 });
  brevo = randomBytes(24).toString('hex');
  writeFileSync(BREVO_FILE, `${brevo}\n`, { mode: 0o600 });
  chmodSync(BREVO_FILE, 0o600);
}
writeFileSync(BREVO_URL_FILE, `${ONLINE_HOST}/hooks/brevo/${brevo}\n`, { mode: 0o600 });
chmodSync(BREVO_URL_FILE, 0o600);
console.log(`${brevoKept ? 'kept' : 'made'}  BREVO_HOOK_TOKEN → the webhook address is in ${BREVO_URL_FILE.replace(`${HQ}/`, '')}`);

if (online) {
  for (const t of made) {
    const run = spawnSync('npx', ['wrangler', 'secret', 'put', `${t.name}_SHA256`], {
      cwd: repo, input: `${t.hash}\n`, encoding: 'utf8',
    });
    console.log(run.status === 0 ? `online ${t.name}_SHA256 set` : `online ${t.name}_SHA256 FAILED:\n${run.stderr}`);
  }
  const hook = spawnSync('npx', ['wrangler', 'secret', 'put', 'BREVO_HOOK_TOKEN'], { cwd: repo, input: `${brevo}\n`, encoding: 'utf8' });
  console.log(hook.status === 0 ? 'online BREVO_HOOK_TOKEN set' : `online BREVO_HOOK_TOKEN FAILED:\n${hook.stderr}`);
}
console.log('Restart HQ (quit and reopen it from the Dock) so it reads the new hashes.');
