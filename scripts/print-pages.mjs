// Does a long invoice print whole?
//
// The A4 sheet was laid out for the three-line invoice the owner actually
// has, and the template round measured roughly nine pixels of slack left on
// it. One more line and the sheet overflowed a box that was `height:297mm`
// with `overflow:hidden` — so the surplus was not pushed onto a second page,
// it was cut off, silently, on a legal document.
//
// This probe is the check that cannot be written without a browser: it builds
// a twelve-line draft through the API, opens /finance/<id>, switches the page
// to print media, and asserts the paper runs to exactly two A4 pages with
// nothing clipped and no row straddling the break. It then deletes the draft.
//
// A DRAFT is used deliberately: a draft has no number, so nothing is taken
// from the running invoice sequence, and `DELETE /api/finance/invoices/<id>`
// removes it with its lines. The local database is asserted to be back to one
// client and invoice 5.R.A.L.01 before the probe exits.
//
// Run it against the local dev server:  node scripts/print-pages.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DEMO_BASE } from './gate-target.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_BASE.
const BASE = process.env.HQ_BASE || DEMO_BASE;

/** A4 at 96dpi, the unit the browser lays print media out in. */
const A4_PX = (297 / 25.4) * 96; // 1122.52

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

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: `hq_session=${session}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

const { clients } = await api('/api/finance/clients');
assert.ok(clients.length, 'the local database needs a client');
const client = clients[0];

/** What the owner's local database holds before the probe touches it. The
 *  probe adds one draft and takes it away again; anything else it found —
 *  the owner's real, issued invoices — it leaves exactly as it was. */
const BEFORE = {
  invoices: (await api('/api/finance/invoices')).invoices.map((i) => `${i.id}:${i.number ?? 'draft'}`).sort(),
  clients: clients.map((c) => c.id).sort(),
};
assert.ok(BEFORE.invoices.some((row) => row.endsWith(':5.R.A.L.01')), 'invoice 5.R.A.L.01 is in the local database');

/** Twelve lines, each with a description long enough to wrap — a real long
 *  invoice, not twelve one-word rows. */
const LINES = Array.from({ length: 12 }, (_, i) => ({
  description: `Line ${i + 1} — Website module ${i + 1}\nDesign, build, revisions and handover for module ${i + 1} of the project, including copy review and a round of client feedback.`,
  quantity: 1,
  unit_cents: 25000 + i * 1000,
}));

let draftId = null;
const browser = await chromium.launch({ headless: true });
try {
  const { invoice: draft } = await api('/api/finance/invoices', 'POST', {
    client_id: client.id,
    kind: 'invoice',
    subject: 'Twelve-line print probe',
  });
  draftId = draft.id;

  // One request — the atomic save (review finding H2).
  const { invoice: saved } = await api(`/api/finance/invoices/${draftId}`, 'PUT', {
    client_id: client.id,
    kind: 'invoice',
    subject: 'Twelve-line print probe',
    vat_treatment: 'standard',
    lines: LINES,
  });
  assert.equal(saved.lines.length, 12, 'twelve lines were stored');

  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.context().addCookies([{
    name: 'hq_session', value: session, url: BASE, httpOnly: true, sameSite: 'Lax',
  }]);

  await page.goto(`${BASE}/finance/${draftId}`);
  await page.locator('.paper').waitFor();
  await page.emulateMedia({ media: 'print' });

  const measure = () => page.evaluate(() => {
    const paper = document.querySelector('.paper');
    const rect = paper.getBoundingClientRect();
    const style = getComputedStyle(paper);
    // Anything inside the sheet whose content is taller than its own box is
    // content the reader will never see. The hero is the one deliberate clip
    // on the sheet: its two decorative circles are absolutely positioned well
    // outside it and are meant to be cut off by it, so it is excluded by name
    // rather than by loosening the rule for everything.
    const clipped = [];
    for (const node of paper.querySelectorAll('*')) {
      if (node.closest('.hero')) continue;
      const cs = getComputedStyle(node);
      if (cs.overflow === 'hidden' && node.scrollHeight > node.clientHeight + 1) {
        clipped.push(`${node.className || node.tagName} ${node.scrollHeight}>${node.clientHeight}`);
      }
    }
    // Nothing a reader would have to join across the page break. This is not
    // geometry — layout boxes do not move for pagination; the browser splits
    // them when it paints the pages — so what is checked is that the rule is
    // actually in force in print media on each of the three blocks that must
    // stay whole. The page count below is what proves the split itself.
    const splittable = [];
    for (const row of paper.querySelectorAll('.items .row, .items .head, .totals, .pay, .foot')) {
      const cs = getComputedStyle(row);
      if (cs.breakInside !== 'avoid' && cs.pageBreakInside !== 'avoid') {
        splittable.push(`${row.className}: ${cs.breakInside}`);
      }
    }
    const last = paper.querySelector('.items .row:last-of-type');
    return {
      height: rect.height,
      paperOverflow: style.overflow,
      scrollHeight: paper.scrollHeight,
      clientHeight: paper.clientHeight,
      rows: paper.querySelectorAll('.items .row').length,
      lastRowBottom: last ? last.getBoundingClientRect().bottom - rect.top : 0,
      footBottom: paper.querySelector('.foot').getBoundingClientRect().bottom - rect.top,
      clipped,
      splittable,
    };
  });

  const measured = await measure();
  const pages = Math.ceil(measured.height / A4_PX);

  assert.equal(measured.rows, 12, 'twelve item rows are on the sheet');
  assert.notEqual(measured.paperOverflow, 'hidden', '.paper must not clip its own content');
  assert.ok(
    measured.scrollHeight <= measured.clientHeight + 1,
    `the sheet is shorter than its content (${measured.scrollHeight} > ${measured.clientHeight})`,
  );
  assert.deepEqual(measured.clipped, [], 'nothing inside the sheet is clipped');
  assert.deepEqual(measured.splittable, [], 'every row, the totals box and the payment block are unsplittable in print');
  assert.ok(
    measured.lastRowBottom < measured.height && measured.footBottom <= measured.height + 1,
    'the last line and the footer are both inside the sheet',
  );
  assert.equal(pages, 2, `a twelve-line invoice prints as 2 pages (measured ${pages}, ${Math.round(measured.height)}px)`);

  // And the same thing through the actual print pipeline, not only the layout.
  const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  const pdfPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  assert.equal(pdfPages, 2, `the printed PDF has 2 pages (got ${pdfPages})`);

  // The short invoice the owner actually has must still be one sheet: the
  // paper grows for a long invoice, it does not grow for every invoice.
  const short = (await api('/api/finance/invoices')).invoices.find((i) => i.number === '5.R.A.L.01');
  await page.goto(`${BASE}/finance/${short.id}`);
  await page.locator('.paper').waitFor();
  await page.emulateMedia({ media: 'print' });
  const shortMeasured = await measure();
  const shortPages = Math.ceil(shortMeasured.height / A4_PX);
  assert.deepEqual(shortMeasured.clipped, [], 'nothing on the short invoice is clipped either');
  assert.equal(shortPages, 1, `5.R.A.L.01 still prints as 1 page (measured ${shortPages})`);

  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log(`PASS: a 12-line invoice prints as ${pages} A4 pages and 5.R.A.L.01 as ${shortPages}; nothing clipped, no splittable rows.`);
} finally {
  await browser.close();
  // The probe leaves nothing behind: the local database is the owner's, and
  // it holds exactly one client and invoice 5.R.A.L.01.
  if (draftId) await api(`/api/finance/invoices/${draftId}`, 'DELETE').catch((e) => { console.error(e); });
  const { invoices } = await api('/api/finance/invoices');
  const { clients: after } = await api('/api/finance/clients');
  assert.deepEqual(
    invoices.map((i) => `${i.id}:${i.number ?? 'draft'}`).sort(),
    BEFORE.invoices,
    'the probe left the invoices exactly as it found them, 5.R.A.L.01 included',
  );
  assert.deepEqual(after.map((c) => c.id).sort(), BEFORE.clients, 'the probe left the clients exactly as it found them');
}
