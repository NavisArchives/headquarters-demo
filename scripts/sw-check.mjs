// The service worker, in a real browser, against the demo (design approved by
// NIRMATA, 14 Nov). Three phases on one browser profile, because a worker has
// to outlive the demo restarting with and without SW_OFF:
//
//   node scripts/sw-check.mjs main   demo as usual, manifest written:
//        installs (all of this release's files), reloads offline with the age
//        said, never mixes two releases across an update, /?sw=off works, and a
//        signed-out device never shows the cached data
//   node scripts/sw-check.mjs off    demo started with --var SW_OFF:1:
//        the kill switch empties every HQ cache and unregisters
//   node scripts/sw-check.mjs on     demo as usual again: the worker comes back
//
// SW_PROFILE (a folder) keeps the browser profile between phases.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE, assertDemoConfigIsLocal } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = DEMO_BASE;
const phase = process.argv[2];
const PROFILE = process.env.SW_PROFILE;
if (!['main', 'off', 'on'].includes(phase) || !PROFILE) throw new Error('usage: SW_PROFILE=<dir> node scripts/sw-check.mjs main|off|on');
assertDemoConfigIsLocal(root);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

function password() {
  const line = readFileSync(join(root, 'demo.vars'), 'utf8').split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
  return line.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
}
async function signIn(context) {
  const res = await fetch(`${BASE}/login`, { method: 'POST', body: new URLSearchParams({ password: password() }), redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const value = /hq_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!value) throw new Error('login failed');
  await context.addCookies([{ name: 'hq_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}
const manifest = () => JSON.parse(readFileSync(join(root, 'src', 'public', 'asset-manifest.json'), 'utf8'));
const writeManifest = () => { const r = spawnSync('node', ['scripts/sw-manifest.mjs'], { cwd: root }); if (r.status !== 0) throw new Error('sw-manifest failed'); };
const state = (page) => page.evaluate(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  const keys = await caches.keys();
  const shell = keys.filter((k) => k.startsWith('hq-shell-'));
  const count = shell.length ? (await (await caches.open(shell[0])).keys()).length : 0;
  return { regs: regs.length, active: regs[0]?.active?.state ?? null, waiting: !!regs[0]?.waiting, controlled: !!navigator.serviceWorker.controller, keys, shell, count };
});
const until = async (page, test, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const s = await state(page); if (test(s) || Date.now() > end) return s; await page.waitForTimeout(250); }
};
const toastText = (page) => page.evaluate(() => document.querySelector('.toast')?.textContent || '');

const context = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = context.pages()[0] || await context.newPage();
try {
  await signIn(context);

  if (phase === 'main') {
    const m = manifest();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.setItem('hq.sw.dev', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    let s = await until(page, (x) => x.active === 'activated' && x.count === m.files.length);
    await page.reload({ waitUntil: 'networkidle' });
    s = await until(page, (x) => x.controlled);
    check('installs this release, all of it', s.shell.length === 1 && s.shell[0] === `hq-shell-${m.version}` && s.count === m.files.length && s.controlled,
      `${s.shell.join(',')} · ${s.count}/${m.files.length} files · controlled ${s.controlled}`);

    // Home's reads are kept; an offline reload shows them, with their age said.
    await page.waitForTimeout(800);
    s = await state(page);
    check('keeps a copy of Home\'s reads', s.keys.includes('hq-data'), s.keys.join(','));
    const rowsOnline = await page.locator('.td-row').count();
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    const rowsOffline = await page.locator('.td-row').count();
    const said = await toastText(page);
    check('reloads offline, from this release, with Home\'s data', rowsOffline > 0 && rowsOffline === rowsOnline, `${rowsOffline} to-dos offline, ${rowsOnline} online`);
    check('says how old the offline data is', /Offline · showing what HQ had at/.test(said), said);
    await context.setOffline(false);

    // A new release: it installs beside this one and waits; nothing mixes until Reload.
    const cssPath = join(root, 'src', 'public', 'assets', 'phone.css');
    const css = readFileSync(cssPath, 'utf8');
    const MARK = '/* sw-check: release B */';
    try {
      writeFileSync(cssPath, `${css}\n${MARK}\n`);
      writeManifest();
      const b = manifest().version;
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      s = await until(page, (x) => x.waiting);
      await page.waitForTimeout(500);
      const offer = await toastText(page);
      const servedBefore = await page.evaluate(async () => (await fetch('/assets/phone.css')).text());
      check('a new release waits, and says so', s.waiting && /HQ was updated/.test(offer), `waiting ${s.waiting} · toast « ${offer} »`);
      check('no mixing: until Reload, the page gets the release it started with', !servedBefore.includes(MARK), servedBefore.includes(MARK) ? 'served release B early' : 'release A served');
      await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.locator('.toast__action').click()]);
      await page.waitForTimeout(800);
      s = await until(page, (x) => x.shell.length === 1 && x.shell[0] === `hq-shell-${b}`);
      const servedAfter = await page.evaluate(async () => (await fetch('/assets/phone.css')).text());
      check('Reload switches whole: only release B is kept, and it is served', s.shell.length === 1 && s.shell[0] === `hq-shell-${b}` && servedAfter.includes(MARK), `${s.shell.join(',')} · marker ${servedAfter.includes(MARK)}`);
    } finally {
      writeFileSync(cssPath, css);
      writeManifest();
    }

    // The kill switch on one device.
    await page.goto(`${BASE}/?sw=off`, { waitUntil: 'networkidle' });
    await page.waitForURL((u) => !u.search.includes('sw=off'), { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    s = await until(page, (x) => x.regs === 0 && !x.keys.some((k) => k.startsWith('hq-')));
    check('/?sw=off unregisters and empties every HQ cache on this device', s.regs === 0 && !s.keys.some((k) => k.startsWith('hq-')), `${s.regs} registrations · caches ${s.keys.join(',') || 'none'}`);
    await page.evaluate(() => localStorage.setItem('hq.sw.dev', '1'));
    await page.reload({ waitUntil: 'networkidle' });
    s = await until(page, (x) => x.active === 'activated');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Signed out: the copy is gone, and nothing cached is shown, online or off.
    await page.locator('#avatar').click();
    await Promise.all([page.waitForURL(/\/login/, { timeout: 15000 }), page.locator('.umenu__item', { hasText: 'Sign out' }).click()]);
    s = await state(page);
    check('sign-out empties the offline copy', !s.keys.includes('hq-data'), s.keys.join(','));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    check('signed out and online: the sign-in page wins', /\/login/.test(page.url()), page.url());
    await context.setOffline(true);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1500);
    // Home's own « could not be loaded » alerts are fine; a row of data is not.
    const leaked = await page.locator('.td-row:not(.is-alert)').count();
    const after = await state(page);
    check('signed out and offline: no cached data shown, no copy kept', leaked === 0 && !after.keys.includes('hq-data'), `${leaked} data rows · caches ${after.keys.join(',')}`);
    await context.setOffline(false);
  }

  if (phase === 'off') {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r?.update(); });
    const s = await until(page, (x) => x.regs === 0 && !x.keys.some((k) => k.startsWith('hq-')), 20000);
    check('SW_OFF: the kill switch empties every HQ cache and unregisters', s.regs === 0 && !s.keys.some((k) => k.startsWith('hq-')), `${s.regs} registrations · caches ${s.keys.join(',') || 'none'}`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const again = await state(page);
    check('SW_OFF: a reload does not loop and keeps nothing', again.regs === 0 && !again.keys.some((k) => k.startsWith('hq-')), `${again.regs} registrations`);
  }

  if (phase === 'on') {
    const m = manifest();
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const s = await until(page, (x) => x.active === 'activated' && x.count === m.files.length, 20000);
    check('SW_OFF lifted: the worker comes back with this release', s.regs === 1 && s.shell[0] === `hq-shell-${m.version}` && s.count === m.files.length, `${s.shell.join(',')} · ${s.count}/${m.files.length}`);
  }
} finally {
  await context.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nsw-check ${phase}: FAILED (${failed.length})` : `\nsw-check ${phase}: clean (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
