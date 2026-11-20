// Visual pass harness — screenshots + layout audit for every HQ screen.
// Dev-time only; never imported by the Worker. Usage:
//   node scripts/shoot.mjs [outDir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_BASE } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_BASE.
const BASE = process.env.HQ_BASE || DEMO_BASE;
const OUT = process.argv[2] || resolve(root, '.superpowers/sdd/2026-09-20-hq-dashboard/screens');
mkdirSync(OUT, { recursive: true });

function password() {
  const line = readFileSync(resolve(root, '.dev.vars'), 'utf8')
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

// `/` goes last: another agent is adding a section to the home screen, so
// its shot should be the freshest one in the run.
const SHOTS = [
  { file: 'projects', path: '/projects' },
  { file: 'p-andyssarchives', path: '/p/andyssarchives' },
  { file: 'missions', path: '/missions' },
  { file: 'leads', path: '/leads' },
  { file: 'leads-popup', path: '/leads', popup: true },
  { file: 'finance', path: '/finance' },
  // The invoice editor needs an invoice to edit. A draft is created through
  // the API before the shot and deleted after it, so the run leaves the
  // database exactly as it found it.
  // A tall viewport for this one: the editor is a dialog, and the point of
  // the shot is the whole form — fields, lines, the live totals preview and
  // the actions — not the first screenful of it.
  { file: 'finance-editor', path: '/finance', draft: true, click: '.invoice-row .btn', tall: 1750 },
  { file: 'finance-invoice', path: '/finance/1' },
  { file: 'finance-project', path: '/p/marc-aubin' },
  { file: 'admin', path: '/admin' },
  { file: 'login', path: '/login', anon: true },
  { file: 'home', path: '/' },
];

/** Create the draft the editor shot opens; returns its id. */
const makeDraft = (page) => page.evaluate(async () => {
  const post = (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const clients = await fetch('/api/finance/clients').then((r) => r.json());
  const { invoice } = await post('/api/finance/invoices', {
    client_id: clients.clients[0].id,
    kind: 'prepayment',
    subject: 'Visual creation package - Prepayment',
  });
  await fetch(`/api/finance/invoices/${invoice.id}/lines`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lines: [
        { description: 'Website — Design, creation', qty: 1, unit_cents: 200000 },
        { description: 'Website marketing — SEO + Google', qty: 1, unit_cents: 60000 },
        { description: 'Digital marketing — Design + Post (3x a week) + website maintenance · monthly cost', qty: 1, unit_cents: 40000 },
      ],
    }),
  });
  await fetch(`/api/finance/invoices/${invoice.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_cents: 170000, kind: 'prepayment' }),
  });
  return invoice.id;
});

const dropDraft = (page, id) => page.evaluate(
  (draftId) => fetch(`/api/finance/invoices/${draftId}`, { method: 'DELETE' }).then((r) => r.status),
  id,
);

const WIDTHS = [{ w: 1280, h: 900 }, { w: 390, h: 844 }];

// Everything the owner asked to be true on every screen, checked in the page.
const AUDIT = `(() => {
  const out = { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, issues: [] };
  const add = (kind, node, detail) => out.issues.push({
    kind, detail,
    sel: node ? (node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\\s+/).join('.') : '')) : '',
  });

  if (out.scrollWidth > out.innerWidth + 1) add('page-h-scroll', null, out.scrollWidth + ' > ' + out.innerWidth);

  const docW = document.documentElement.clientWidth;
  for (const node of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) continue;

    // text smaller than 12px
    const size = parseFloat(cs.fontSize);
    const hasText = [...node.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText && size < 12) add('tiny-text', node, size + 'px: ' + node.textContent.trim().slice(0, 40));

    // anything sticking out of the viewport sideways
    if (r.right > docW + 1 || r.left < -1) {
      const scroller = node.closest('[data-scrolls], .tablewrap, .table-wrap, nav.pills, .dd-menu');
      if (!scroller) add('overflows-x', node, 'left=' + Math.round(r.left) + ' right=' + Math.round(r.right) + ' doc=' + docW);
    }

    // Tap targets on phone. A control smaller than 40px is still fine if it
    // carries its hit area around it (an ::after overlay), so ask the page
    // what a finger 20px above and below the centre would actually hit.
    if (window.innerWidth <= 480 && /^(button|a|select|summary)$/.test(node.tagName.toLowerCase()) && r.height < 40) {
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hits = (y) => { const t = document.elementFromPoint(cx, y); return !!t && (t === node || node.contains(t) || t.contains(node)); };
      if (cy - 19 < 0 || !hits(cy - 19) || !hits(cy + 19)) {
        add('small-tap-target', node, Math.round(r.height) + 'px tall: ' + (node.textContent || '').trim().slice(0, 30));
      }
    }
  }

  // overlapping siblings inside the main column
  const main = document.getElementById('main');
  if (main) {
    const kids = [...main.children].filter((n) => getComputedStyle(n).position === 'static');
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect(); const b = kids[i + 1].getBoundingClientRect();
      if (a.height && b.height && b.top < a.bottom - 1) add('overlap', kids[i + 1], 'top ' + Math.round(b.top) + ' < previous bottom ' + Math.round(a.bottom));
    }
  }
  return out;
})()`;

// `HQ_ONLY=finance,finance-invoice node scripts/shoot.mjs` reshoots part of
// the set without touching the other screens' files.
const ONLY = (process.env.HQ_ONLY || '').split(',').map((n) => n.trim()).filter(Boolean);
const SELECTED = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.file)) : SHOTS;

const browser = await chromium.launch();
const cookie = await sessionCookie();
const report = [];

for (const shot of SELECTED) {
  for (const { w, h } of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: w, height: shot.tall ?? h },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      isMobile: w <= 480,
      hasTouch: w <= 480,
    });
    if (!shot.anon) await context.addCookies([cookie]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + shot.path, { waitUntil: 'networkidle' });
    let draftId = null;
    if (shot.draft) {
      draftId = await makeDraft(page);
      await page.goto(BASE + shot.path, { waitUntil: 'networkidle' });
    }
    if (shot.popup) {
      await page.locator('.leads tbody tr').first().click();
      await page.waitForSelector('.scrim', { state: 'visible' });
    }
    if (shot.click) {
      await page.locator(shot.click).first().click();
      await page.waitForSelector('dialog.editor', { state: 'visible' });
    }
    await page.waitForTimeout(450);

    const audit = await page.evaluate(AUDIT);
    const file = `${OUT}/${shot.file}-${w}.png`;
    await page.screenshot({ path: file, fullPage: !shot.popup && !shot.click });
    report.push({ screen: shot.file, width: w, file, ...audit, errors });
    if (draftId) await dropDraft(page, draftId);
    await context.close();
  }
}

await browser.close();

for (const r of report) {
  const flags = [];
  if (r.errors.length) flags.push(`JS:${r.errors.length}`);
  const byKind = {};
  for (const i of r.issues) (byKind[i.kind] ||= []).push(i);
  console.log(`\n== ${r.screen} @${r.width}  scrollWidth=${r.scrollWidth}/${r.innerWidth} ${flags.join(' ')}`);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`   ${kind} (${list.length})`);
    for (const i of list.slice(0, 8)) console.log(`     - ${i.sel} :: ${i.detail}`);
    if (list.length > 8) console.log(`     … ${list.length - 8} more`);
  }
  for (const e of r.errors.slice(0, 3)) console.log(`   ! ${e.slice(0, 160)}`);
}
console.log(`\nwrote ${report.length} screenshots to ${OUT}`);
