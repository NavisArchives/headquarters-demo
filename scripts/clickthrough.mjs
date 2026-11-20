// Dev-time smoke: drive the real UI once at desktop and once on a phone —
// create a mission and mark it done, open a lead and switch language/mode,
// open a project page, open the finance editor. Gmail-writing controls
// ("Open in Gmail", "Draft only", "Sync mailbox") are never touched.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_BASE.
const BASE = process.env.HQ_BASE || DEMO_BASE;
const OUT = process.argv[2] || resolve(root, '.superpowers/sdd/2026-09-20-hq-dashboard/screens/states');
mkdirSync(OUT, { recursive: true });

const pw = readFileSync(resolve(root, '.dev.vars'), 'utf8')
  .split('\n').find((l) => l.startsWith('HQ_PASSWORD=')).slice('HQ_PASSWORD='.length).trim();
const login = await fetch(`${BASE}/login`, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: pw }),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});
const value = /hq_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
if (!value) throw new Error(`login failed (${login.status})`);
const cookie = { name: 'hq_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' };

const TAP = `(() => {
  const bad = [];
  for (const n of document.querySelectorAll('button,a,select,summary')) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height || r.height >= 40) continue;
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = (y) => { const t = document.elementFromPoint(cx, y); return !!t && (t === n || n.contains(t) || t.contains(n)); };
    if (cy - 19 >= 0 && hit(cy - 19) && hit(cy + 19)) continue;
    bad.push(n.tagName.toLowerCase() + '.' + String(n.className) + ' h=' + Math.round(r.height) + ' ' + n.textContent.trim().slice(0, 24));
  }
  return bad;
})()`;

const browser = await chromium.launch();
const problems = [];
const note = (m) => { console.log('  ' + m); };

for (const { w, h, tag } of [{ w: 1280, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'phone' }]) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, colorScheme: 'dark',
    isMobile: w <= 480, hasTouch: w <= 480, deviceScaleFactor: 1,
  });
  await ctx.addCookies([cookie]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${tag}: pageerror ${e}`));

  console.log(`\n### ${tag} (${w}px)`);

  /* ---- missions: create, screenshot, mark done ---- */
  await page.goto(`${BASE}/missions`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New mission' }).click();
  const title = `Visual pass check ${tag} ${Date.now()}`;
  await page.getByLabel('New mission title').fill(title);
  await page.getByLabel('New mission title').press('Enter');
  await page.getByText(title).waitFor();
  note(`created "${title}"`);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/missions-with-a-mission-${w}.png`, fullPage: true });
  if (w <= 480) {
    const bad = await page.evaluate(TAP);
    if (bad.length) problems.push(`${tag} missions-live: small tap targets ${JSON.stringify(bad)}`);
    else note('tap targets on a live mission row: all ≥40px');
  }

  const row = page.locator('.mission', { hasText: title });
  await row.locator('.tick').click();            // pending -> in progress
  await page.waitForTimeout(350);
  await page.locator('.mission', { hasText: title }).locator('.tick').click();  // -> done
  await page.waitForTimeout(400);
  const done = await page.locator('.mission.is-done', { hasText: title }).count();
  if (!done) problems.push(`${tag}: mission did not reach done`);
  else note('marked done');
  await page.screenshot({ path: `${OUT}/missions-done-${w}.png`, fullPage: true });

  // tidy up: delete the mission we made
  await page.locator('.mission', { hasText: title }).locator('.icon-btn').last().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await page.waitForTimeout(400);
  note(`cleaned up (${await page.locator('.mission', { hasText: title }).count()} left)`);

  /* ---- leads: open the popup, switch language and mode ---- */
  await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle' });
  await page.locator('.leads tbody tr').first().click();
  await page.waitForSelector('.scrim');
  const body = page.locator('.bodybox');
  const seen = {};
  for (const lang of ['NL', 'EN', 'FR']) {
    await page.locator('.langs button', { hasText: new RegExp(`^${lang}$`) }).click();
    await page.waitForTimeout(220);
    seen[lang] = (await body.inputValue()).slice(0, 34);
  }
  note(`languages: ${Object.entries(seen).map(([k, v]) => `${k}="${v}…"`).join('  ')}`);
  if (new Set(Object.values(seen)).size < 3) problems.push(`${tag}: NL/EN/FR did not all produce different drafts`);
  for (const mode of ['Email', 'DM', 'Follow-up']) {
    await page.locator('.modes button', { hasText: new RegExp(`^${mode}$`) }).click();
    await page.waitForTimeout(220);
    const pressed = await page.locator('.modes button', { hasText: new RegExp(`^${mode}$`) }).getAttribute('aria-pressed');
    if (pressed !== 'true') problems.push(`${tag}: mode ${mode} did not select`);
  }
  note('modes Email / DM / Follow-up all select');
  await page.screenshot({ path: `${OUT}/lead-followup-${w}.png` });
  if (w <= 480) {
    const closeBox = await page.locator('.navbtns .x').last().boundingBox();
    if (!closeBox || closeBox.x + closeBox.width > w || closeBox.y < 0) problems.push(`${tag}: close button out of reach ${JSON.stringify(closeBox)}`);
    else note(`close button at x=${Math.round(closeBox.x)}..${Math.round(closeBox.x + closeBox.width)} of ${w}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.locator('.scrim').count()) problems.push(`${tag}: Escape did not close the popup`);

  /* ---- a project page ---- */
  await page.goto(`${BASE}/p/andyssarchives`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const heading = await page.locator('h1').first().innerText();
  note(`project page heading: ${heading.trim()}`);

  /* ---- the finance editor dialog ---- */
  await page.goto(`${BASE}/finance`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Invoice details' }).click();
  await page.waitForSelector('dialog.editor[open]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/finance-editor-${w}.png` });
  const overflow = await page.evaluate(`(() => {
    const d = document.querySelector('dialog.editor[open]');
    const r = d.getBoundingClientRect();
    return { off: r.right > innerWidth + 1 || r.left < -1 || r.width > innerWidth,
             doc: document.documentElement.scrollWidth, win: innerWidth };
  })()`);
  if (overflow.off || overflow.doc > overflow.win + 1) problems.push(`${tag}: finance editor overflows ${JSON.stringify(overflow)}`);
  else note('finance editor fits the viewport');
  await page.getByRole('button', { name: 'Close' }).click();

  await ctx.close();
}

await browser.close();
console.log(problems.length ? `\nPROBLEMS:\n- ${problems.join('\n- ')}` : '\nclick-through: clean');
process.exit(problems.length ? 1 : 0);
