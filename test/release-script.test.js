// npm run release (Andy, 14 Nov: one command per release). Every step is played
// against a fake shell: nothing here touches git, wrangler or the network.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, pendingMigrations, versionId, release, isMainModule, outputTail } from '../scripts/release.mjs';

const SHA = 'c84501b0c84501b0c84501b0c84501b0c84501b0';
const MAIN = mkdtempSync(join(tmpdir(), 'hq-release-test-'));

/** A fake shell: answers by command, records every call. */
function fakeShell(over = {}) {
  const calls = [];
  const answers = {
    'git worktree list --porcelain': `worktree ${MAIN}\nHEAD abc\n`,
    'git rev-parse --abbrev-ref HEAD': 'hq-dashboard\n',
    'git status --porcelain --untracked-files=no': '',
    'git fetch --quiet origin': '',
    [`git rev-parse --verify c84501b^{commit}`]: `${SHA}\n`,
    [`git branch -r --contains ${SHA}`]: '  origin/fix/money-path-a\n',
    'git merge-base --is-ancestor hq-dashboard': '',
    'git merge-base --is-ancestor origin/hq-dashboard': '',
    'git rev-parse --short hq-dashboard': 'aacde0d\n',
    'git log --format=%h %s': 'c84501b feat(outreach): clinics\n',
    'git worktree add --detach': '',
    'git rev-parse HEAD': `${SHA}\n`,
    'npx wrangler deployments status': 'Version(s): (100%) 11111111-1111-4111-8111-111111111111\n',
    'npx wrangler d1 migrations list hq --remote': '✅ No migrations to apply!\n',
    'git merge --ff-only': '',
    'git push origin hq-dashboard': '',
    'node scripts/sw-manifest.mjs': 'sw-manifest: 72 files, version 612ce473efab0b76\n',
    'npx wrangler deploy': 'Uploaded hq\nCurrent Version ID: 22222222-2222-4222-8222-222222222222\n',
    ...over,
  };
  const sh = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    // Real git makes the folder; the fake does too, so the script can link into it.
    if (line.startsWith('git worktree add --detach') && !(answers['git worktree add --detach'] && typeof answers['git worktree add --detach'] === 'object')) {
      mkdirSync(args[3], { recursive: true });
    }
    const key = Object.keys(answers).sort((a, b) => b.length - a.length).find((k) => line.startsWith(k));
    const answer = key === undefined ? '' : answers[key];
    const a = typeof answer === 'function' ? answer() : answer;
    if (a && typeof a === 'object') return { status: a.status, stdout: a.stdout ?? '', stderr: a.stderr ?? '', shown: false };
    return { status: 0, stdout: a, stderr: '' };
  };
  return { sh, calls };
}
const ok200 = async () => ({ status: 200 });
const quiet = () => {};

describe('the arguments', () => {
  it('takes one commit, --sql files and --dry-run', () => {
    expect(parseArgs(['c84501b', '--sql', 'a.sql', '--sql', 'b.sql', '--dry-run'])).toEqual({ commit: 'c84501b', sql: ['a.sql', 'b.sql'], dryRun: true });
    expect(() => parseArgs([])).toThrow(/which approved commit/);
    expect(() => parseArgs(['main'])).toThrow(/not a commit hash/);
    expect(() => parseArgs(['c84501b', 'aacde0d'])).toThrow(/one commit only/);
    expect(() => parseArgs(['c84501b', '--sql'])).toThrow(/needs a file/);
    expect(() => parseArgs(['c84501b', '--force'])).toThrow(/unknown option/);
  });

  it('reads wrangler: pending migrations and the Version ID', () => {
    expect(pendingMigrations('✅ No migrations to apply!')).toEqual([]);
    expect(pendingMigrations('│ 0028_brevo.sql │\n│ 0029_x.sql │')).toEqual(['0028_brevo.sql', '0029_x.sql']);
    expect(versionId('Current Version ID: 22222222-2222-4222-8222-222222222222')).toBe('22222222-2222-4222-8222-222222222222');
    expect(versionId('nothing')).toBeNull();
  });
});

describe('the release', () => {
  it('--dry-run checks and prints the plan, and changes nothing', async () => {
    const { sh, calls } = fakeShell();
    const lines = [];
    const out = await release(['c84501b', '--dry-run'], { sh, fetchImpl: ok200, log: (s) => lines.push(s) });
    expect(out).toMatchObject({ dryRun: true, sha: SHA });
    expect(lines.join('\n')).toMatch(/aacde0d → c84501b is a fast-forward/);
    for (const c of calls) expect(c).not.toMatch(/merge --ff-only|push|wrangler deploy$|worktree add|execute|apply/);
  });

  it('runs every step in order and returns the Version ID', async () => {
    const { sh, calls } = fakeShell();
    const out = await release(['c84501b'], { sh, fetchImpl: ok200, log: quiet });
    expect(out).toMatchObject({ version: '22222222-2222-4222-8222-222222222222', before: '11111111-1111-4111-8111-111111111111', pending: [] });
    const at = (p) => calls.findIndex((c) => c === p || c.startsWith(`${p} `));
    expect(at('git worktree add --detach')).toBeLessThan(at('npx wrangler d1 migrations list'));
    expect(at('npx wrangler d1 migrations list')).toBeLessThan(at('git merge --ff-only'));
    expect(at('git merge --ff-only')).toBeLessThan(at('git push origin hq-dashboard'));
    expect(at('git push origin hq-dashboard')).toBeLessThan(at('npx wrangler deploy'));
    expect(calls.some((c) => c.includes('migrations apply'))).toBe(false);
  });

  it('backs up before pending migrations, and applies them before the deploy', async () => {
    const { sh, calls } = fakeShell({ 'npx wrangler d1 migrations list hq --remote': '│ 0028_brevo.sql │\n' });
    const out = await release(['c84501b'], { sh, fetchImpl: ok200, log: quiet });
    expect(out.pending).toEqual(['0028_brevo.sql']);
    const at = (p) => calls.findIndex((c) => c === p || c.startsWith(`${p} `));
    expect(at('npm run -s backup -- --reason pre-migration')).toBeGreaterThan(-1);
    expect(at('npm run -s backup -- --reason pre-migration')).toBeLessThan(at('npx wrangler d1 migrations apply'));
    expect(at('npx wrangler d1 migrations apply')).toBeLessThan(at('npx wrangler deploy'));
  });

  it('runs --sql files last, after their own backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-release-sql-'));
    const file = join(dir, 'write.sql');
    writeFileSync(file, 'SELECT 1;');
    const { sh, calls } = fakeShell();
    await release(['c84501b', '--sql', file], { sh, fetchImpl: ok200, log: quiet });
    const at = (p) => calls.findIndex((c) => c === p || c.startsWith(`${p} `));
    expect(at('npm run -s backup -- --reason pre-sql')).toBeGreaterThan(at('npx wrangler deploy'));
    expect(at(`npx wrangler d1 execute hq --remote --file ${file}`)).toBeGreaterThan(at('npm run -s backup -- --reason pre-sql'));
  });

  const refuses = async (over, args, message, forbidden = /merge --ff-only|wrangler deploy$|migrations apply/) => {
    const { sh, calls } = fakeShell(over);
    await expect(release(args, { sh, fetchImpl: ok200, log: quiet })).rejects.toThrow(message);
    expect(calls.some((c) => forbidden.test(c))).toBe(false);
  };

  it('refuses a main checkout on another branch, or with uncommitted changes', async () => {
    await refuses({ 'git rev-parse --abbrev-ref HEAD': 'fix/x\n' }, ['c84501b'], /not hq-dashboard/);
    await refuses({ 'git status --porcelain --untracked-files=no': ' M src/shared/outreach.js\n' }, ['c84501b'], /uncommitted changes/);
  });

  it('refuses a commit that is not on origin, or not a fast-forward', async () => {
    await refuses({ [`git branch -r --contains ${SHA}`]: '' }, ['c84501b'], /not on origin/);
    await refuses({ 'git merge-base --is-ancestor hq-dashboard': { status: 1 } }, ['c84501b'], /not a fast-forward/);
    await refuses({ 'git rev-parse --verify c84501b^{commit}': { status: 128 } }, ['c84501b'], /not known/);
  });

  it('refuses a missing --sql file before anything changes', async () => {
    await refuses({}, ['c84501b', '--sql', '/nope/missing.sql'], /no such SQL file/);
  });

  it('stops at the first failure: a failed migration means no deploy', async () => {
    await refuses({
      'npx wrangler d1 migrations list hq --remote': '│ 0028_x.sql │\n',
      'npx wrangler d1 migrations apply': { status: 1 },
    }, ['c84501b'], /migrations apply failed/, /merge --ff-only|push|wrangler deploy$/);
  });

  it('a failing smoke test stops before the SQL, with the rollback command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-release-sql-'));
    const file = join(dir, 'w.sql'); writeFileSync(file, 'SELECT 1;');
    const { sh, calls } = fakeShell();
    await expect(release(['c84501b', '--sql', file], { sh, fetchImpl: async () => ({ status: 500 }), log: quiet }))
      .rejects.toThrow(/rollback 11111111/);
    expect(calls.some((c) => c.includes('d1 execute'))).toBe(false);
  });

  it('refuses a release worktree that exists but was edited', async () => {
    mkdirSync(join(MAIN, '.claude', 'worktrees', 'release-c84501b'), { recursive: true });
    await refuses({ 'git status --porcelain --untracked-files=no': '' , 'git rev-parse HEAD': 'deadbeef\n' }, ['c84501b'], /not a clean checkout/);
  });

  it('smokes only addresses that answer without a session', async () => {
    const asked = [];
    const { sh } = fakeShell();
    await release(['c84501b'], { sh, fetchImpl: async (url) => { asked.push(url); return { status: 200 }; }, log: quiet });
    // /sw.js is public by design (the kill switch must reach a signed-out phone).
    expect(asked).toEqual(['https://hq.example.com/login', 'https://hq.example.com/assets/fonts/fonts.css', 'https://hq.example.com/sw.js']);
  });
});

describe('the service worker (14 Nov)', () => {
  it('writes the manifest in the release worktree right before the deploy, and says its release', async () => {
    const { sh, calls } = fakeShell();
    const lines = [];
    await release(['c84501b'], { sh, fetchImpl: ok200, log: (s) => lines.push(s) });
    const manifest = calls.findIndex((c) => c === 'node scripts/sw-manifest.mjs');
    const deploy = calls.findIndex((c) => c === 'npx wrangler deploy');
    expect(manifest).toBeGreaterThan(-1);
    expect(manifest).toBe(deploy - 1);
    expect(lines.join('\n')).toMatch(/service-worker manifest: release 612ce473efab0b76/);
  });
  it('never deploys when the manifest cannot be written', async () => {
    const { sh, calls } = fakeShell({ 'node scripts/sw-manifest.mjs': { status: 1, stdout: '' } });
    await expect(release(['c84501b'], { sh, fetchImpl: ok200, log: quiet })).rejects.toThrow(/service-worker manifest/);
    expect(calls.some((c) => c === 'npx wrangler deploy')).toBe(false);
  });
  it('shows the manifest step in the dry run', async () => {
    const { sh } = fakeShell();
    const lines = [];
    await release(['c84501b', '--dry-run'], { sh, fetchImpl: ok200, log: (s) => lines.push(s) });
    expect(lines.join('\n')).toMatch(/service-worker manifest \(node scripts\/sw-manifest\.mjs\)/);
  });
});

describe('the commit runs its own release script (14 Nov: 5424dbd shipped its service worker without a manifest)', () => {
  it('hands the whole release to the commit\'s script when it differs, before anything changes', async () => {
    const { sh, calls } = fakeShell({ 'git show': 'export const NEWER = true; // the commit\'s release.mjs\n' });
    const handed = [];
    const out = await release(['c84501b', '--sql', 'x.sql'].slice(0, 1), {
      sh, fetchImpl: ok200, log: quiet, selfSource: () => 'the running, older release.mjs', handoff: (h) => { handed.push(h); return { handedOff: true }; },
    });
    expect(out).toEqual({ handedOff: true });
    expect(handed).toHaveLength(1);
    expect(handed[0].source).toContain('NEWER');
    expect(handed[0].argv).toEqual(['c84501b']);
    expect(handed[0].short).toBe('c84501b');
    // nothing was done by the older script: no worktree, no migration, no merge, no deploy
    for (const step of ['git worktree add', 'npx wrangler d1 migrations', 'git merge --ff-only', 'git push', 'npx wrangler deploy', 'node scripts/sw-manifest.mjs']) {
      expect(calls.some((c) => c.startsWith(step))).toBe(false);
    }
  });

  it('runs itself when the commit carries the same script', async () => {
    const SAME = 'the same release.mjs';
    const { sh, calls } = fakeShell({ 'git show': SAME });
    let handed = false;
    await release(['c84501b'], { sh, fetchImpl: ok200, log: quiet, selfSource: () => SAME, handoff: () => { handed = true; } });
    expect(handed).toBe(false);
    expect(calls).toContain('npx wrangler deploy');
  });

  it('never hands over twice (the handed-over run is marked)', async () => {
    const { sh, calls } = fakeShell({ 'git show': 'something else' });
    process.env.HQ_RELEASE_HANDOFF = '1';
    try {
      let handed = false;
      await release(['c84501b'], { sh, fetchImpl: ok200, log: quiet, selfSource: () => 'mine', handoff: () => { handed = true; } });
      expect(handed).toBe(false);
      expect(calls).toContain('npx wrangler deploy');
    } finally { delete process.env.HQ_RELEASE_HANDOFF; }
  });
});

describe('the handed-off copy really runs (14 Nov: c27fc6a\'s copy exited 0 silently from /var/folders)', () => {
  it('knows it is the main module through a symlinked folder', () => {
    const real = mkdtempSync(join(tmpdir(), 'hq-release-real-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    writeFileSync(join(real, 'r.mjs'), '');
    expect(isMainModule(join(link, 'r.mjs'), pathToFileURL(join(real, 'r.mjs')).href)).toBe(true);
    expect(isMainModule(join(link, 'other.mjs'), pathToFileURL(join(real, 'r.mjs')).href)).toBe(false);
    expect(isMainModule(undefined, pathToFileURL(join(real, 'r.mjs')).href)).toBe(false);
  });

  it('a copy in the temp folder runs, prints its Stop and marks that it started', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-release-copy-'));
    const file = join(dir, 'release.mjs');
    writeFileSync(file, readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8'));
    const started = `${file}.started`;
    const r = spawnSync('node', [file, '--no-such-option'], { encoding: 'utf8', env: { ...process.env, HQ_RELEASE_STARTED: started } });
    expect(r.stderr).toMatch(/STOPPED: unknown option --no-such-option/);
    expect(r.status).not.toBe(0);
    expect(existsSync(started)).toBe(true);
  });
});

describe('a failed quiet command says why (15 Nov: « migrations list failed (exit 1) » and nothing else)', () => {
  const noWait = async () => {};

  it('the Stop carries the last lines the command printed', async () => {
    const { sh } = fakeShell({
      'npx wrangler d1 migrations list hq --remote': { status: 1, stderr: 'X [ERROR] A request to the Cloudflare API failed.\nfetch failed' },
    });
    const lines = [];
    await expect(release(['c84501b'], { sh, fetchImpl: ok200, log: (l) => lines.push(l), selfSource: () => 'same', pause: noWait }))
      .rejects.toThrow(/migrations list failed \(exit 1\):\n[\s\S]*fetch failed/);
  });

  it('migrations list is tried once more, and a second success carries on', async () => {
    let n = 0;
    const { sh, calls } = fakeShell({
      'git show': 'same',
      'npx wrangler d1 migrations list hq --remote': () => (n++ === 0 ? { status: 1, stderr: 'fetch failed' } : { status: 0, stdout: '✅ No migrations to apply!\n' }),
    });
    const waits = [];
    const lines = [];
    await release(['c84501b'], { sh, fetchImpl: ok200, log: (l) => lines.push(l), selfSource: () => 'same', pause: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([10000]);
    expect(calls.filter((c) => c.startsWith('npx wrangler d1 migrations list'))).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/trying once more in 10 s\nfetch failed/);
    expect(calls).toContain('npx wrangler deploy');
  });

  it('output already shown on the terminal is not repeated, and the tail keeps the last 20 lines', () => {
    expect(outputTail({ status: 1, stderr: 'x', shown: true })).toBe('');
    const many = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const tail = outputTail({ status: 1, stderr: many, stdout: '' });
    expect(tail.split('\n')).toHaveLength(20);
    expect(tail.startsWith('line 11')).toBe(true);
  });
});

describe('the /sw.js smoke after the deploy', () => {
  const answer = (sw) => async (url) => (url.endsWith('/sw.js') ? sw : { status: 200 });
  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
  it('stops the release when /sw.js is 404 (no manifest in the deploy)', async () => {
    const { sh } = fakeShell();
    await expect(release(['c84501b'], { sh, fetchImpl: answer({ status: 404, headers: headers({}) }), log: quiet }))
      .rejects.toThrow(/\/sw\.js answered 404.*roll back/);
  });
  it('stops when /sw.js serves another release', async () => {
    const { sh } = fakeShell();
    await expect(release(['c84501b'], { sh, fetchImpl: answer({ status: 200, headers: headers({ 'x-hq-release': '0000000000000000' }) }), log: quiet }))
      .rejects.toThrow(/release 0000000000000000, not release 612ce473efab0b76/);
  });
  it('passes on this release, and on the kill switch (200, no release)', async () => {
    for (const sw of [{ status: 200, headers: headers({ 'x-hq-release': '612ce473efab0b76' }) }, { status: 200, headers: headers({}) }]) {
      const { sh } = fakeShell();
      await expect(release(['c84501b'], { sh, fetchImpl: answer(sw), log: quiet })).resolves.toMatchObject({ version: expect.any(String) });
    }
  });
});
