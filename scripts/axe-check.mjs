// Accessibility, checked by axe-core (NIRMATA, 14 Nov: « axe 0 »). Every
// screen in the phone frame, at an iPhone 13, in every segment it offers, in
// both palettes, with the Liquid Glass tab bar over it: WCAG 2.0–2.2 A and AA
// rules. Any violation fails the gates. Dev-time only; runs inside
// `npm run gates`, against the demo.
//   node scripts/axe-check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE, FRAMED, assertDemoConfigIsLocal, assertDemoServer, offlineFonts } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HQ_BASE || DEMO_BASE;
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PALETTES = [null, 'marine'];

function password() {
  const line = readFileSync(resolve(root, process.env.HQ_BASE ? '.dev.vars' : 'demo.vars'), 'utf8').split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
  return line.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
}
async function sessionCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST', body: new URLSearchParams({ password: password() }), redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const value = /hq_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!value) throw new Error(`login failed (${res.status})`);
  return { name: 'hq_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' };
}

const browser = await chromium.launch();
assertDemoConfigIsLocal(root);
const cookie = await sessionCookie();
await assertDemoServer(BASE, cookie.value);
let failed = false;
let checked = 0;

for (const route of FRAMED) {
  for (const palette of PALETTES) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await context.addCookies([cookie]);
    await offlineFonts(context);
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    if (palette) await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, palette);
    await page.waitForTimeout(350);
    const segTabs = page.locator('#main [role=tablist]').first().locator('[role=tab]');
    const segments = [...Array(await segTabs.count()).keys()];
    for (const i of segments.length ? segments : [null]) {
      if (i !== null) { await segTabs.nth(i).click(); await page.waitForTimeout(250); }
      await page.addScriptTag({ path: AXE });
      const result = await page.evaluate(async (tags) => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) , count: v.nodes.length }));
      }, TAGS);
      checked += 1;
      if (result.length) {
        failed = true;
        console.log(`\n== ${route} @390 ${palette || 'forest'}${i === null ? '' : ` segment ${i + 1}`}`);
        for (const v of result) {
          console.log(`   ${v.id} (${v.impact}, ${v.count}): ${v.help}`);
          for (const n of v.nodes) console.log(`     - ${n}`);
        }
      }
    }
    await context.close();
  }
}

await browser.close();
if (failed) {
  console.log('\naxe: FAILED');
  process.exit(1);
}
console.log(`axe: clean (${FRAMED.join(', ')}; ${checked} screen/segment/palette checks, WCAG 2.0–2.2 A and AA)`);
