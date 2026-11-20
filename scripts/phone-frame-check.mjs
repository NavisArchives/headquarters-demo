// The phone frame (audit P6; Andy's rule: no page scroll, only the list
// scrolls). For every screen that has opted in (.phone-frame), at an iPhone 13
// and an iPhone SE, and in every segment it offers:
//   - the page does not scroll, and nothing goes sideways;
//   - only a .scroll-region scrolls;
//   - every button is at least 44 px tall, every field at least 16 px;
//   - a segment's count equals what its list shows (no second count source).
// Dev-time only; runs inside `npm run gates`, against the demo.
//   node scripts/phone-frame-check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE, FRAMED, assertDemoConfigIsLocal, assertDemoServer, offlineFonts } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HQ_BASE || DEMO_BASE;

const SIZES = [{ width: 390, height: 844 }, { width: 375, height: 667 }];

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

// Runs in the page: everything the rule asks, for the segment on screen.
const AUDIT = `(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  const problems = [];
  const doc = document.scrollingElement;
  if (doc.scrollHeight > innerHeight + 1) problems.push('the page scrolls: ' + doc.scrollHeight + ' > ' + innerHeight);
  if (doc.scrollWidth > innerWidth + 1) problems.push('sideways: ' + doc.scrollWidth + ' > ' + innerWidth);
  if (!document.querySelector('#main > .phone-frame')) problems.push('no .phone-frame');
  // Nothing may stick out past the screen's sides, even where #main clips it
  // (a clipped card still loses its right edge), unless it sits inside a box
  // that scrolls sideways on purpose.
  for (const e of [...document.querySelectorAll('#main *')].filter(visible)) {
    const r = e.getBoundingClientRect();
    if (r.right <= innerWidth + 1 && r.left >= -1) continue;
    let p = e.parentElement; let scrolls = false;
    while (p && p.id !== 'main') { if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= innerWidth + 1) { scrolls = true; break; } p = p.parentElement; }
    if (!scrolls) { problems.push('sticks out sideways: ' + name(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); break; }
  }
  const scrollers = [...document.querySelectorAll('#main *')].filter((e) => visible(e)
    && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1);
  for (const e of scrollers) if (!e.classList.contains('scroll-region')) problems.push('scrolls but is not the region: ' + name(e));
  if (scrollers.length > 1) problems.push(scrollers.length + ' regions scroll at once');
  const regions = [...document.querySelectorAll('#main .scroll-region')].filter(visible);
  if (regions.length !== 1) problems.push(regions.length + ' visible scroll regions (want 1)');
  for (const b of [...document.querySelectorAll('#main button, #main .btn')].filter(visible)) {
    const h = b.getBoundingClientRect().height;
    if (h < 43.5) problems.push('button under 44 px: ' + name(b) + ' "' + (b.textContent || '').trim().slice(0, 20) + '" ' + Math.round(h));
  }
  for (const f of [...document.querySelectorAll('#main input:not([type=checkbox]):not([type=radio]):not([type=hidden]), #main select, #main textarea')].filter(visible)) {
    if (parseFloat(getComputedStyle(f).fontSize) < 16) problems.push('field under 16 px: ' + name(f));
  }
  // The floating tab bar (≤ 480 px): nothing to tap may sit under it, a list
  // that runs on beneath it can scroll its last row clear, and its own tabs are 44 px.
  const nav = document.querySelector('#nav');
  const bar = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
  if (bar) {
    for (const b of [...document.querySelectorAll('#main button, #main a, #main input, #main select')].filter(visible)) {
      if (b.closest('.scroll-region')) continue;
      const r = b.getBoundingClientRect();
      if (r.bottom > bar.top + 1 && r.top < bar.bottom && r.right > bar.left && r.left < bar.right) problems.push('under the tab bar: ' + name(b));
    }
    for (const reg of regions) {
      const r = reg.getBoundingClientRect();
      const under = r.bottom - bar.top;
      if (under > 1 && parseFloat(getComputedStyle(reg).paddingBottom) < under) problems.push('the last row of ' + name(reg) + ' cannot scroll clear of the tab bar');
    }
    for (const t of [...nav.querySelectorAll('button')].filter(visible)) {
      const r = t.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) problems.push('tab under 44 px: ' + (t.getAttribute('aria-label') || '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  }
  return problems;
})()`;

// Missions: each tab's number is the cards its list shows (plus « Show older · n »).
const MISSIONS_COUNTS = `(() => [...document.querySelectorAll('.ms-seg [role=tab]')].map((tab) => {
  const said = Number((tab.textContent.match(/(\\d+)\\s*$/) || [])[1]);
  const list = document.querySelector('.ms-col-' + tab.dataset.seg + ' .ms-list');
  const cards = list ? list.querySelectorAll(':scope > .ms-card:not(.is-editing)').length : NaN;
  const older = list ? Number(((list.querySelector('.ms-older') || {}).textContent || '').match(/(\\d+)\\s*$/)?.[1] || 0) : 0;
  return { seg: tab.dataset.seg, said, shown: cards + older };
}))()`;

// Home: each tab's number is what its pane shows (to-do rows plus the reply cards above them).
const HOME_COUNTS = `(() => {
  const n = (key) => Number(document.querySelector('.home-seg [data-seg=' + key + '] .n')?.textContent);
  const out = [];
  const todo = document.querySelector('[data-pane=todo]');
  out.push({ seg: 'todo', said: n('todo'), shown: todo ? todo.querySelectorAll('.td-row, .home-reply').length : NaN });
  const ring = document.querySelector('[data-pane=missions]');
  const legend = ring ? [...ring.querySelectorAll('.ring__legend > div')].filter((d) => !d.querySelector('.l-proposed')) : [];
  out.push({ seg: 'missions', said: n('missions'), shown: legend.reduce((t, d) => t + Number(d.querySelector('b').textContent), 0) });
  const leads = document.querySelector('[data-pane=leads] .stat b');
  out.push({ seg: 'leads', said: n('leads'), shown: Number(leads?.textContent) });
  return out;
})()`;

// Leads: the List tab says what the table says it shows (« N shown »), and draws at most that many rows.
const LEADS_COUNTS = `(() => {
  const said = Number(document.querySelector('.leads-seg [data-seg=list] .n')?.textContent);
  const eyebrow = document.querySelector('.leads section[aria-label=Leads] > .eyebrow');
  const shown = Number(((eyebrow && eyebrow.textContent) || '').match(/^(\\d+) shown/)?.[1]);
  const rows = document.querySelectorAll('.leads .tablewrap tbody tr').length;
  const out = [{ seg: 'list', said, shown }];
  if (rows > said) out.push({ seg: 'list rows', said, shown: rows });
  return out;
})()`;

// Pipeline: the picked stage says the count its column shows.
const PIPELINE_COUNTS = `(() => {
  const opt = document.querySelector('.pl-stagepick')?.selectedOptions?.[0];
  const said = Number((opt?.textContent || '').match(/(\\d+)\\s*$/)?.[1]);
  const shown = document.querySelectorAll('.pl-col.is-on .pl-col__list > .pl-card').length;
  return [{ seg: 'stage ' + (opt?.value || '?'), said, shown }];
})()`;

const browser = await chromium.launch();
assertDemoConfigIsLocal(root);
const cookie = await sessionCookie();
await assertDemoServer(BASE, cookie.value);
let failed = false;
let checked = 0;

for (const route of FRAMED) {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: 'dark', isMobile: true, hasTouch: true });
    await context.addCookies([cookie]);
    await offlineFonts(context);
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);
    // The screen's segments: its first tablist (a card can carry tabs of its own).
    const segTabs = page.locator('#main [role=tablist]').first().locator('[role=tab]');
    const segments = [...Array(await segTabs.count()).keys()];
    for (const i of segments.length ? segments : [null]) {
      if (i !== null) {
        await segTabs.nth(i).click();
        await page.waitForTimeout(250);
      }
      const where = `${route} @${size.width}×${size.height}${i === null ? '' : ` segment ${i + 1}`}`;
      const problems = await page.evaluate(AUDIT);
      const COUNTS = { '/missions': MISSIONS_COUNTS, '/': HOME_COUNTS, '/leads': LEADS_COUNTS, '/pipeline': PIPELINE_COUNTS }[route];
      if (COUNTS) {
        for (const c of await page.evaluate(COUNTS)) {
          if (c.said !== c.shown) problems.push(`segment « ${c.seg} » says ${c.said}, its pane shows ${c.shown}`);
        }
      }
      checked += 1;
      if (problems.length) {
        failed = true;
        console.log(`\n== ${where}`);
        for (const p of [...new Set(problems)]) console.log(`   ${p}`);
      }
    }
    await context.close();
  }
}

await browser.close();
if (failed) {
  console.log('\nphone-frame: FAILED');
  process.exit(1);
}
console.log(`phone-frame: clean (${FRAMED.join(', ')}; ${checked} screen/segment/size checks)`);
