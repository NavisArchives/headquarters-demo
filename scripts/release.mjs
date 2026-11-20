#!/usr/bin/env node
// One command per release (Andy, 14 Nov: « one command, not 6–8 »).
//
//   npm run release -- <approved commit> [--sql <file>]... [--dry-run]
//
// In order, stopping at the first failure:
//   1. checks   the main checkout is on hq-dashboard and clean; the commit
//               exists on origin and is a fast-forward of hq-dashboard; every
//               --sql file exists
//   2. worktree a fresh, clean worktree at exactly that commit (never an edited
//               one: 13 Nov, a deploy picked up uncommitted files)
//   3. migrate  if D1 has migrations pending for that commit: a pre-migration
//               backup (npm run backup), then apply them
//   4. ff+push  hq-dashboard fast-forwards to the commit, and is pushed
//   5. deploy   wrangler deploy from the clean worktree; the Version ID is kept
//   6. smoke    /login and the public font stylesheet answer 200 on the live
//               address (everything else under /assets needs a session)
//   7. sql      each --sql file runs against live D1, after a pre-write backup
//
// --dry-run runs only the read-only checks and prints the plan. Nothing here
// sends mail, and nothing is deleted. The previous Version ID is printed as
// the rollback (`npx wrangler rollback <id>`).
import { spawnSync } from 'node:child_process';
import { existsSync, symlinkSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE = 'https://hq.example.com';
const BRANCH = 'hq-dashboard';

/** argv -> { commit, sql: [], dryRun } or throws with what is wrong. */
export function parseArgs(argv) {
  const out = { commit: null, sql: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--sql') {
      const file = argv[i + 1];
      if (!file || file.startsWith('--')) throw new Error('--sql needs a file');
      out.sql.push(file); i += 1;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!out.commit) out.commit = a;
    else throw new Error(`one commit only (got ${out.commit} and ${a})`);
  }
  if (!out.commit) throw new Error('which approved commit? npm run release -- <commit> [--sql <file>] [--dry-run]');
  if (!/^[0-9a-f]{7,40}$/i.test(out.commit)) throw new Error(`« ${out.commit} » is not a commit hash`);
  return out;
}

/** Pending migrations from `wrangler d1 migrations list`: [] when none. */
export function pendingMigrations(output) {
  if (/No migrations to apply/i.test(output)) return [];
  return [...new Set(String(output).match(/\b\d{4}_[\w-]+\.sql\b/g) ?? [])];
}

/** The Version ID wrangler prints after a deploy, or after `deployments status`. */
export function versionId(output) {
  const named = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(output);
  if (named) return named[1];
  return /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(output)?.[1] ?? null;
}

/** The main checkout: the one whose worktree list entry is first. */
function mainCheckout(sh) {
  // A release handed over to a commit's own script (below) runs from a copy: it is told where main is.
  if (process.env.HQ_RELEASE_MAIN) return process.env.HQ_RELEASE_MAIN;
  const list = sh('git', ['worktree', 'list', '--porcelain'], { cwd: HERE, quiet: true }).stdout;
  return /^worktree (.+)$/m.exec(list)?.[1] ?? HERE;
}

function defaultSh(cmd, args, { cwd, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  if (!quiet) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  // `shown`: the output already reached the terminal, so a Stop need not repeat it.
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', shown: !quiet };
}

/** The last lines a failed command printed, for a Stop that would otherwise say only « exit 1 »
 *  (15 Nov: « migrations list failed (exit 1) » twice, and wrangler's reason was swallowed). */
export function outputTail(r, lines = 20) {
  if (!r || r.shown) return '';
  const text = [r.stderr, r.stdout].map((t) => String(t ?? '').trim()).filter(Boolean).join('\n');
  return text ? text.split('\n').slice(-lines).join('\n') : '';
}

class Stop extends Error {}

/**
 * The release. `sh` runs a command and returns { status, stdout, stderr };
 * `fetchImpl` is fetch. Both are parameters so the tests can play every step.
 */
/** Runs a commit's own release script, given as text, with the same arguments.
 *  This file imports Node's own modules only, so a copy runs from anywhere. */
function defaultHandoff({ source, argv, main, short }) {
  const file = join(tmpdir(), `hq-release-${short}-${process.pid}.mjs`);
  const started = `${file}.started`;
  writeFileSync(file, source);
  const r = spawnSync('node', [file, ...argv], {
    stdio: 'inherit', env: { ...process.env, HQ_RELEASE_HANDOFF: '1', HQ_RELEASE_MAIN: main, HQ_RELEASE_STARTED: started },
  });
  if (r.status !== 0) throw new Stop(`${short}'s own release script stopped (exit ${r.status ?? 'none'}): see above`);
  // 14 Nov, c27fc6a: the copy exited 0 without running at all, and this said nothing.
  if (!existsSync(started)) throw new Stop(`${short}'s own release script exited without running: nothing was changed`);
  return { handedOff: true };
}

/** True when `argv1` is this module. Both sides through realpath: on macOS the temp folder
 *  is /var/folders/…, a symlink to /private/var/folders/…, and import.meta.url gives the
 *  second (14 Nov: the handed-off copy compared the two, thought it was imported, and exited 0). */
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(resolve(argv1)) === real(fileURLToPath(metaUrl));
}

export async function release(argv, {
  sh = defaultSh, fetchImpl = fetch, log = console.log, pause = (ms) => new Promise((done) => { setTimeout(done, ms); }),
  selfSource = () => readFileSync(fileURLToPath(import.meta.url), 'utf8'), handoff = defaultHandoff,
} = {}) {
  const args = parseArgs(argv);
  const say = (s) => log(s);
  const must = (r, what) => {
    if (r.status === 0) return r;
    const tail = outputTail(r);
    throw new Stop(`${what} failed (exit ${r.status})${tail ? `:\n${tail}` : ''}`);
  };
  const git = (a, cwd, opts = {}) => sh('git', a, { cwd, quiet: true, ...opts });

  // 1. checks (read-only)
  const main = mainCheckout(sh);
  say(`HQ release · main checkout ${main}`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], main).stdout.trim();
  if (branch !== BRANCH) throw new Stop(`the main checkout is on « ${branch} », not ${BRANCH}`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], main).stdout.trim();
  if (dirty) throw new Stop(`the main checkout has uncommitted changes:\n${dirty}`);
  must(git(['fetch', '--quiet', 'origin'], main), 'git fetch');
  const full = git(['rev-parse', '--verify', `${args.commit}^{commit}`], main);
  if (full.status !== 0) throw new Stop(`commit ${args.commit} is not known here`);
  const sha = full.stdout.trim();
  const short = sha.slice(0, 7);
  const onOrigin = git(['branch', '-r', '--contains', sha], main).stdout.trim();
  if (!onOrigin) throw new Stop(`${short} is not on origin: push its branch first`);
  if (git(['merge-base', '--is-ancestor', BRANCH, sha], main).status !== 0) {
    throw new Stop(`${short} is not a fast-forward of ${BRANCH}: it does not contain ${BRANCH}'s head`);
  }
  if (git(['merge-base', '--is-ancestor', `origin/${BRANCH}`, sha], main).status !== 0) {
    throw new Stop(`${short} does not contain origin/${BRANCH}: someone pushed since; ask before going on`);
  }
  const sqlFiles = args.sql.map((f) => (isAbsolute(f) ? f : resolve(process.cwd(), f)));
  for (const f of sqlFiles) if (!existsSync(f)) throw new Stop(`no such SQL file: ${f}`);

  // 1b. The commit's own release script runs its release (14 Nov: 5424dbd was released by the
  //     previous script, which had no manifest step, so its service worker shipped without one).
  //     If the commit changes this file, the whole run is handed to its version, before anything changes.
  if (process.env.HQ_RELEASE_HANDOFF !== '1') {
    const theirs = git(['show', `${sha}:scripts/release.mjs`], main);
    if (theirs.status === 0 && theirs.stdout.trim() && theirs.stdout !== selfSource()) {
      say(`1b. ${short} changes the release script: handing the release to its own version`);
      return handoff({ source: theirs.stdout, argv, main, short });
    }
  }
  const head = git(['rev-parse', '--short', BRANCH], main).stdout.trim();
  const subjects = git(['log', '--format=%h %s', `${BRANCH}..${sha}`], main).stdout.trim();

  const plan = [
    `1. checks passed: ${BRANCH} ${head} → ${short} is a fast-forward on origin`,
    `   ${subjects ? subjects.split('\n').join('\n   ') : '(no new commits)'}`,
    `2. a clean worktree at ${short}`,
    '3. migrations: list what is pending on live D1; if any, back up first, then apply',
    `4. git merge --ff-only ${short} on ${BRANCH}, then git push origin ${BRANCH}`,
    `5. the service-worker manifest (node scripts/sw-manifest.mjs) written in that worktree, then npx wrangler deploy from it, keeping the Version ID`,
    `6. smoke: ${LIVE}/login, ${LIVE}/assets/fonts/fonts.css, and ${LIVE}/sw.js carrying this release's manifest version`,
    ...(sqlFiles.length ? [`7. back up, then run on live D1: ${sqlFiles.join(', ')}`] : []),
  ];
  say(plan.join('\n'));
  if (args.dryRun) { say('\n--dry-run: nothing was changed.'); return { dryRun: true, sha }; }

  // 2. a clean worktree at exactly that commit
  const tree = join(main, '.claude', 'worktrees', `release-${short}`);
  if (existsSync(tree)) {
    const at = git(['rev-parse', 'HEAD'], tree).stdout.trim();
    const changed = git(['status', '--porcelain', '--untracked-files=no'], tree).stdout.trim();
    if (at !== sha || changed) throw new Stop(`${tree} exists but is not a clean checkout of ${short}`);
  } else {
    mkdirSync(dirname(tree), { recursive: true });
    must(git(['worktree', 'add', '--detach', tree, sha], main), 'git worktree add');
    if (!existsSync(tree)) throw new Stop(`git worktree add reported success but ${tree} is missing`);
    symlinkSync(join(main, 'node_modules'), join(tree, 'node_modules'));
    if (existsSync(join(main, '.dev.vars'))) symlinkSync(join(main, '.dev.vars'), join(tree, '.dev.vars'));
  }
  say(`\n2. worktree ${tree} at ${short}`);

  const before = versionId(sh('npx', ['wrangler', 'deployments', 'status'], { cwd: tree, quiet: true }).stdout);
  say(`   live now: ${before ?? 'unknown'}`);

  // 3. migrations
  // Read-only, so one retry is safe: a hotspot or a busy D1 can fail it once (15 Nov).
  const listMigrations = () => sh('npx', ['wrangler', 'd1', 'migrations', 'list', 'hq', '--remote'], { cwd: tree, quiet: true });
  let listing = listMigrations();
  if (listing.status !== 0) {
    say(`3. migrations list failed (exit ${listing.status}); trying once more in 10 s`);
    const tail = outputTail(listing);
    if (tail) say(tail);
    await pause(10_000);
    listing = listMigrations();
  }
  const listed = must(listing, 'migrations list');
  const pending = pendingMigrations(listed.stdout + listed.stderr);
  if (pending.length) {
    say(`3. pending: ${pending.join(', ')} — backup first`);
    must(sh('npm', ['run', '-s', 'backup', '--', '--reason', 'pre-migration'], { cwd: tree }), 'pre-migration backup');
    must(sh('npx', ['wrangler', 'd1', 'migrations', 'apply', 'hq', '--remote'], { cwd: tree }), 'migrations apply');
  } else {
    say('3. no migrations pending');
  }

  // 4. fast-forward and push
  must(git(['merge', '--ff-only', sha], main, { quiet: false }), 'git merge --ff-only');
  must(git(['push', 'origin', BRANCH], main, { quiet: false }), 'git push');
  say(`4. ${BRANCH} = ${short}, pushed`);

  // 5. the service worker's manifest (one release, one cache), then deploy.
  // Written in the release worktree only: never committed, always this commit's files.
  const manifestRun = must(sh('node', ['scripts/sw-manifest.mjs'], { cwd: tree }), 'service-worker manifest');
  const swVersion = /version ([0-9a-f]{16})/.exec(manifestRun.stdout)?.[1];
  if (!swVersion) throw new Stop('the service-worker manifest did not say its version: nothing was deployed');
  say(`5. service-worker manifest: release ${swVersion}`);
  const deployed = must(sh('npx', ['wrangler', 'deploy'], { cwd: tree }), 'wrangler deploy');
  const version = versionId(deployed.stdout + deployed.stderr);
  if (!version) throw new Stop('deployed, but no Version ID in the output: check wrangler');
  say(`5. deployed: Version ID ${version}`);

  // 6. smoke
  // Both answer without a session: /assets/app.js does not (401), by design.
  for (const path of ['/login', '/assets/fonts/fonts.css']) {
    let status = 0;
    try { status = (await fetchImpl(`${LIVE}${path}`, { redirect: 'manual' })).status; } catch { status = 0; }
    if (status !== 200) throw new Stop(`smoke ${path} answered ${status}; roll back with: npx wrangler rollback ${before ?? '<previous id>'}`);
  }
  // The service worker answers, and it is this release's (or the kill switch, when SW_OFF is set).
  // The service worker answers with this release, or (SW_OFF) the kill switch with no release.
  // Anything else, a 404 above all, stops the release here (14 Nov: a 404 went by as a note).
  let swStatus = 0;
  let swRelease = null;
  try {
    const res = await fetchImpl(`${LIVE}/sw.js`, { redirect: 'manual' });
    swStatus = res.status;
    swRelease = res.headers?.get?.('x-hq-release') ?? null;
  } catch { swStatus = 0; }
  if (swStatus === 200 && swRelease === swVersion) say(`   /sw.js: release ${swRelease}`);
  else if (swStatus === 200 && !swRelease) say('   /sw.js: the kill switch (SW_OFF) is serving');
  else throw new Stop(`/sw.js answered ${swStatus}${swRelease ? ` with release ${swRelease}` : ''}, not release ${swVersion}; roll back with: npx wrangler rollback ${before ?? '<previous id>'}`);
  say('6. smoke: /login 200, /assets/fonts/fonts.css 200');

  // 7. D1 write files, after their own backup
  // Read cost (14 Nov: the account hit D1's free daily row-read limit, 5 M rows). Every backup
  // exports every table, and a check file that joins lead_events on « detail LIKE '%message …' »
  // reads the whole table once per id, three times per release (check, write, check). Keep check
  // files to counts on indexed columns (uid, kind, sent_to) where a LIKE scan is avoidable.
  if (sqlFiles.length) {
    must(sh('npm', ['run', '-s', 'backup', '--', '--reason', 'pre-sql'], { cwd: tree }), 'pre-SQL backup');
    for (const f of sqlFiles) {
      must(sh('npx', ['wrangler', 'd1', 'execute', 'hq', '--remote', '--file', f], { cwd: tree }), `SQL ${f}`);
      say(`7. ran ${f}`);
    }
  }

  say(`\nReleased ${short}. Version ID ${version}. Rollback: npx wrangler rollback ${before ?? '<previous id>'}`);
  return { sha, version, before, pending };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  if (process.env.HQ_RELEASE_STARTED) writeFileSync(process.env.HQ_RELEASE_STARTED, `${process.pid}\n`);
  release(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    console.error(`\nSTOPPED: ${error.message}`);
    process.exit(error instanceof Stop ? 1 : 2);
  });
}
