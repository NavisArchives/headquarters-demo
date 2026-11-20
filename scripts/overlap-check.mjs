// Overlap audit — the owner's rule is "none of the pages can have overlapping
// designs." This walks every route at desktop and phone widths and reports
// any pair of visible elements (cards/panels/sections/rx-* blocks/tables,
// plus every button/link) that geometrically intersect without one being an
// ancestor of the other. Dev-time only; never imported by the Worker.
//   node scripts/overlap-check.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { DEMO_BASE, assertDemoConfigIsLocal, assertDemoServer, offlineFonts } from './gate-target.mjs';

// The demo HQ only (see gate-target.mjs): `npm run demo` first.
const BASE = process.env.HQ_BASE || DEMO_BASE;

function password() {
  const line = readFileSync(resolve(root, process.env.HQ_BASE ? '.dev.vars' : 'demo.vars'), 'utf8')
    .split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
  return line.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
}

async function sessionCookie() {
  const body = new URLSearchParams({ password: password() });
  const res = await fetch(`${BASE}/login`, {
    method: 'POST', body, redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const raw = res.headers.get('set-cookie') || '';
  const value = /hq_session=([^;]+)/.exec(raw)?.[1];
  if (!value) throw new Error(`login failed (${res.status})`);
  return { name: 'hq_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' };
}

// The demo's own projects: the live registry's pages do not exist there.
const DEMO_SLUGS = JSON.parse(readFileSync(resolve(root, 'demo/registry.json'), 'utf8')).map((p) => p.slug);
const ROUTES = [
  '/', '/projects', ...DEMO_SLUGS.slice(0, 2).map((slug) => `/p/${slug}`),
  '/missions', '/leads', '/pipeline', '/pipeline/1', '/pipeline/8', '/pipeline/9', '/p/arbor', '/onboarding/1', '/onboarding/8', '/onboarding/9', '/finance', '/finance/1', '/admin',
];
// 1024 and 768 as well: the top bar changes layout at 900 px, and nothing
// between the desktop and the phone width was being looked at.
const WIDTHS = [1280, 1024, 768, 390];

// Runs in the page. Collects boxes for the target selector set, then reports
// every intersecting pair where neither box's element is an ancestor of the
// other's (a card containing a button is expected to "contain" it, not
// overlap it — only siblings/cousins actually overlapping are a bug).
const AUDIT = `(() => {
  const sel = (n) => n.tagName.toLowerCase()
    + (n.id ? '#' + n.id : '')
    + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '');

  const matches = (n) => {
    if (n.matches('.card, .panel, .section, table, button, a')) return true;
    if (typeof n.className === 'string' && /(^|\\s)rx-[\\w-]+/.test(n.className)) return true;
    return false;
  };

  // A popover/dropdown/dialog (position: absolute|fixed, or an ancestor that
  // is) is meant to float over whatever sits beneath it — that is what makes
  // it a popover. Flagging that as a layout bug would just make every open
  // filter menu or modal "overlap" the page behind it, which is not the
  // owner's complaint (two things in normal flow landing on top of each
  // other). Skip any node inside such a floating container.
  const floats = (n) => {
    for (let cur = n; cur && cur !== document.body; cur = cur.parentElement) {
      const p = getComputedStyle(cur).position;
      if (p === 'absolute' || p === 'fixed') return true;
    }
    return false;
  };

  // What of an element can actually be seen: its box cut down by every
  // ancestor that clips (overflow other than visible — a scroll list, a
  // cropped frame). A row scrolled out of view inside a scroll box is not on
  // top of the card below it; measuring its unclipped box called the Home
  // "needs attention" list (20 rows in a 193 px scroller) an overlap.
  const visibleRect = (n) => {
    const r = n.getBoundingClientRect();
    let left = r.left; let top = r.top; let right = r.right; let bottom = r.bottom;
    for (let cur = n.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const c = cur.getBoundingClientRect();
      // The padding box: inside the borders, where the content is clipped.
      const cl = c.left + cur.clientLeft; const ct = c.top + cur.clientTop;
      if (cs.overflowX !== 'visible') { left = Math.max(left, cl); right = Math.min(right, cl + cur.clientWidth); }
      if (cs.overflowY !== 'visible') { top = Math.max(top, ct); bottom = Math.min(bottom, ct + cur.clientHeight); }
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const nodes = [...document.querySelectorAll('body *')].filter((n) => {
    if (!matches(n)) return false;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (floats(n)) return false;
    const r = visibleRect(n);
    return r.width > 0 && r.height > 0;
  });

  const boxes = nodes.map((n) => ({ n, sel: sel(n), r: visibleRect(n) }));
  const findings = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.n.contains(b.n) || b.n.contains(a.n)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 1 && iy > 1) {
        findings.push({
          a: a.sel, b: b.sel,
          aBox: { x: Math.round(a.r.left), y: Math.round(a.r.top), w: Math.round(a.r.width), h: Math.round(a.r.height) },
          bBox: { x: Math.round(b.r.left), y: Math.round(b.r.top), w: Math.round(b.r.width), h: Math.round(b.r.height) },
        });
      }
    }
  }

  // Floating buttons (position: fixed, e.g. the assistant ✦) are skipped above,
  // as popovers are. But a floating button that sits on a button or link of the
  // page hides it (NIRMATA S2, 20 Nov: the ✦ over « Open missions » at 390).
  // Check each one against every visible in-flow button and link.
  const floaters = [...document.querySelectorAll('button, a')].filter((n) => {
    const cs = getComputedStyle(n);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (n.closest('#nav, nav, [role="dialog"], .navsheet, .toast, .scrim')) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  for (const f of floaters) {
    const fr = f.getBoundingClientRect();
    for (const b of boxes) {
      if (!b.n.matches('button, a') || f.contains(b.n) || b.n.contains(f)) continue;
      const ix = Math.min(fr.right, b.r.right) - Math.max(fr.left, b.r.left);
      const iy = Math.min(fr.bottom, b.r.bottom) - Math.max(fr.top, b.r.top);
      if (ix > 1 && iy > 1) findings.push({ a: sel(f) + ' (floating)', b: b.sel,
        aBox: { x: Math.round(fr.left), y: Math.round(fr.top), w: Math.round(fr.width), h: Math.round(fr.height) },
        bBox: { x: Math.round(b.r.left), y: Math.round(b.r.top), w: Math.round(b.r.width), h: Math.round(b.r.height) } });
    }
  }

  return {
    floaters: floaters.length,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    findings,
  };
})()`;

const browser = await chromium.launch();
assertDemoConfigIsLocal(root);
const cookie = await sessionCookie();
await assertDemoServer(BASE, cookie.value);
let failed = false;

for (const route of ROUTES) {
  for (const w of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      isMobile: w <= 480,
      hasTouch: w <= 480,
    });
    await context.addCookies([cookie]);
    await offlineFonts(context);
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);

    const result = await page.evaluate(AUDIT);

    if (result.scrollWidth > result.innerWidth + 1) {
      failed = true;
      console.log(`\n== ${route} @${w}  horizontal overflow: scrollWidth=${result.scrollWidth} > innerWidth=${result.innerWidth}`);
    }

    if (result.findings.length) {
      failed = true;
      console.log(`\n== ${route} @${w}  ${result.findings.length} overlap(s)`);
      for (const f of result.findings) {
        console.log(`   ${f.a}  <->  ${f.b}`);
        console.log(`     a: ${JSON.stringify(f.aBox)}`);
        console.log(`     b: ${JSON.stringify(f.bBox)}`);
      }
    }

    await context.close();
  }
}

await browser.close();

if (failed) {
  console.log('\noverlap-check: FAILED');
  process.exit(1);
} else {
  console.log('\noverlap-check: clean across every route/width');
}
