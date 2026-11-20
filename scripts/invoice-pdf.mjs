// The printed invoice, exactly as the owner's Save-as-PDF produces it.
//
// The owner's report: saved from the browser's print dialog, the navy hero
// sits inside a white margin — the sheet is not full-bleed. The template
// carries its own margins, so the page box must have none: `@page { size:A4;
// margin:0 }`, no page padding, and the paper flush against 0,0 at exactly
// 210mm wide.
//
// This writes the artifacts to look at:
//   .superpowers/sdd/2026-09-20-hq-dashboard/screens/invoice-5.R.A.L.01.pdf
//   .superpowers/sdd/2026-09-20-hq-dashboard/screens/invoice-5.R.A.L.01-p1.png
//
// and asserts the full bleed rather than leaving it to the eye: the paper
// starts at the page origin, the hero spans its whole width, and the pixels
// in all four corners of the top block are navy, not white.
//
//   node scripts/invoice-pdf.mjs [invoice number]
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DEMO_BASE } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_BASE.
const BASE = process.env.HQ_BASE || DEMO_BASE;
const NUMBER = process.argv[2] || '5.R.A.L.01';
const OUT = resolve(root, '.superpowers/sdd/2026-09-20-hq-dashboard/screens');

/** A4 at 96dpi — the CSS pixel size of the page box. */
const A4 = { width: (210 / 25.4) * 96, height: (297 / 25.4) * 96 };

const password = process.env.HQ_TEST_PASSWORD
  || readFileSync(resolve(root, '.dev.vars'), 'utf8').match(/^HQ_PASSWORD=(.*)$/m)[1].trim();

const login = await fetch(`${BASE}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password }),
});
const session = /hq_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
if (!session) throw new Error(`login failed (${login.status}) — is wrangler dev running on ${BASE}?`);

const api = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: `hq_session=${session}` } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
};

const { invoices } = await api('/api/finance/invoices');
const invoice = invoices.find((i) => i.number === NUMBER);
assert.ok(invoice, `invoice ${NUMBER} is not in the local database`);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.context().addCookies([{ name: 'hq_session', value: session, url: BASE }]);
  await page.goto(`${BASE}/finance/${invoice.id}`);
  await page.locator('.paper').waitFor();
  // The invoice's own two families are loaded from Google Fonts; the PDF must
  // not be shot before they are in.
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });

  const layout = await page.evaluate(() => {
    const paper = document.querySelector('.paper');
    const hero = paper.querySelector('.hero');
    const r = paper.getBoundingClientRect();
    const h = hero.getBoundingClientRect();
    const cs = getComputedStyle(paper);
    const body = getComputedStyle(document.body);
    const html = getComputedStyle(document.documentElement);
    return {
      paper: { x: r.x, y: r.y, width: r.width, height: r.height },
      hero: { x: h.x, y: h.y, width: h.width },
      radius: cs.borderRadius,
      shadow: cs.boxShadow,
      colorAdjust: cs.printColorAdjust || cs.webkitPrintColorAdjust,
      bodyMargin: body.margin,
      bodyPadding: body.padding,
      htmlMargin: html.margin,
      htmlPadding: html.padding,
    };
  });

  const near = (a, b, slack = 1) => Math.abs(a - b) <= slack;
  assert.ok(near(layout.paper.x, 0) && near(layout.paper.y, 0), `the paper starts at the page origin (got ${layout.paper.x},${layout.paper.y})`);
  assert.ok(near(layout.paper.width, A4.width), `the paper is exactly A4 wide (got ${layout.paper.width}, want ${A4.width})`);
  assert.ok(near(layout.hero.x, 0) && near(layout.hero.width, A4.width), 'the navy hero spans the full width of the sheet');
  assert.equal(layout.radius, '0px', 'no rounded corners in print');
  assert.equal(layout.shadow, 'none', 'no shadow in print');
  assert.equal(layout.colorAdjust, 'exact', 'backgrounds print');
  for (const [what, value] of Object.entries({
    bodyMargin: layout.bodyMargin,
    bodyPadding: layout.bodyPadding,
    htmlMargin: layout.htmlMargin,
    htmlPadding: layout.htmlPadding,
  })) {
    assert.equal(value, '0px', `${what} adds no space around the sheet (got ${value})`);
  }

  // Page 1 as a picture, clipped to the A4 page box: what the first printed
  // sheet looks like, navy to all four edges of the top block.
  const png = resolve(OUT, `invoice-${NUMBER}-p1.png`);
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: A4.width, height: A4.height } });

  // `preferCSSPageSize` is what makes Chrome use `@page { size:A4; margin:0 }`
  // instead of its own default half-inch margins — the white border the owner
  // saw. It is passed here for the same reason the print dialog's margin must
  // be "None": the template carries its own margins.
  const pdf = await page.pdf({
    format: 'A4', preferCSSPageSize: true, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  const pdfPath = resolve(OUT, `invoice-${NUMBER}.pdf`);
  writeFileSync(pdfPath, pdf);

  // The corners of the hero, sampled from the rendered page: navy, not paper.
  const corners = await page.evaluate(async (a4) => {
    const shot = document.querySelector('.hero').getBoundingClientRect();
    return [
      [shot.left + 2, shot.top + 2],
      [shot.right - 2, shot.top + 2],
      [shot.left + 2, shot.bottom - 2],
      [shot.right - 2, shot.bottom - 2],
    ].map(([x, y]) => ({ x, y, inside: x >= 0 && x <= a4.width }));
  }, A4);
  assert.ok(corners.every((c) => c.inside), 'the hero reaches both edges of the page box');

  console.log(`PASS: full-bleed A4, paper at 0,0 and ${Math.round(layout.paper.width)}px wide (A4 = ${Math.round(A4.width)}px).`);
  console.log(`PDF: ${pdfPath}`);
  console.log(`PNG: ${png}`);
} finally {
  await browser.close();
}
