// Zero-defect visual sweep — every route and every open state of HQ, at
// desktop, tablet and phone width, screenshotted and audited.
//
//   npm run check:visual            # the whole sweep
//   HQ_ONLY=leads-popup,finance …   # a subset, same files
//
// Exits non-zero on any finding, so it can gate a deploy. Dev-time only;
// never imported by the Worker.
//
// What it asserts on every shot:
//   · no two visible boxes in the same layer intersect (unless one contains
//     the other) — cards, panels, tables, dialogs, popups, dropdown menus,
//     pills, buttons, links and form controls
//   · no horizontal page scroll
//   · no text under 12px (--micro, the palette's floor)
//   · no tap target under 40px at 390
//   · nothing clipped by the viewport or by an overflow:hidden ancestor
//   · no text squeezed into a column too narrow to read
//   · no empty card (a card holding nothing but its eyebrow)
//   · stacked cards separated by the gap token, always the same one
//   · focus visible on whatever holds focus
//   · no JS errors
// And, per state: Escape closes it and leaves no backdrop and no scroll-lock.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { DEMO_BASE, assertDemoConfigIsLocal, assertDemoServer, offlineFonts } from './gate-target.mjs';

// The demo HQ only (see gate-target.mjs): `npm run demo` first.
const BASE = process.env.HQ_BASE || DEMO_BASE;
const OUT = process.argv[2]
  || resolve(root, '.superpowers/sdd/2026-09-20-hq-dashboard/screens/sweep');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------ sign in --- */

function password() {
  const line = readFileSync(resolve(root, process.env.HQ_BASE ? '.dev.vars' : 'demo.vars'), 'utf8')
    .split('\n').find((l) => l.startsWith('HQ_PASSWORD='));
  if (!line) throw new Error('.dev.vars has no HQ_PASSWORD');
  return line.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
}

// One login for the whole run. The Worker locks an IP out after a handful of
// failures, so a sweep that logged in per shot would lock itself out.
async function sessionCookie() {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: password() }),
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const value = /hq_session=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1];
  if (!value) throw new Error(`login failed (${res.status}) — is the dev server up with the current .dev.vars?`);
  return { name: 'hq_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' };
}

/* ------------------------------------------------------ what to shoot --- */

// The demo's own projects: the live registry's pages do not exist there.
const SLUGS = JSON.parse(readFileSync(resolve(root, 'demo/registry.json'), 'utf8')).map((p) => p.slug);

const ROUTES = [
  { file: 'home', path: '/', label: '/' },
  { file: 'projects', path: '/projects', label: '/projects' },
  ...SLUGS.map((slug) => ({ file: `p-${slug}`, path: `/p/${slug}`, label: `/p/${slug}` })),
  { file: 'missions', path: '/missions', label: '/missions' },
  { file: 'leads', path: '/leads', label: '/leads' },
  { file: 'pipeline', path: '/pipeline', label: '/pipeline' },
  { file: 'pipeline-1', path: '/pipeline/1', label: '/pipeline/1' },
  { file: 'onboarding-1', path: '/onboarding/1', label: '/onboarding/1' },
  { file: 'finance', path: '/finance', label: '/finance' },
  { file: 'finance-1', path: '/finance/1', label: '/finance/1' },
  { file: 'admin', path: '/admin', label: '/admin' },
  { file: 'login', path: '/login', label: '/login (signed out)', anon: true },
];

const openLeadPopup = async (page) => {
  await page.locator('.leads tbody tr').first().click();
  await page.waitForSelector('.scrim .modal', { state: 'visible' });
  await page.waitForTimeout(250);
};

/** Click a button inside the open popup by its exact text, if it is there. */
const clickText = async (page, scope, text) => {
  const target = page.locator(`${scope} button`, { hasText: new RegExp(`^${text}$`) }).first();
  if (await target.count()) { await target.click(); await page.waitForTimeout(200); }
};

/** Open the issued invoice dialog on /finance and scroll a sub-form in. */
const openIssued = (label) => async (page) => {
  const row = page.locator('.invoice-row').first();
  await row.locator('.btn').first().click();
  await page.waitForSelector('.scrim .modal, dialog[open]', { state: 'visible' });
  await page.waitForTimeout(350);
  if (label) {
    const box = page.locator('.sub-form', { hasText: label }).first();
    if (await box.count()) await box.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
};

const STATES = [
  {
    file: 'leads-popup',
    label: 'leads · popup (first row)',
    path: '/leads',
    setup: openLeadPopup,
  },
  {
    file: 'leads-popup-nl-dm',
    label: 'leads · popup NL / DM',
    path: '/leads',
    async setup(page) {
      await openLeadPopup(page);
      await clickText(page, '.langs', 'NL');
      await clickText(page, '.modes', 'DM');
    },
  },
  {
    file: 'leads-popup-en-followup',
    label: 'leads · popup EN / Follow-up',
    path: '/leads',
    async setup(page) {
      await openLeadPopup(page);
      await clickText(page, '.langs', 'EN');
      await clickText(page, '.modes', 'Follow-up');
    },
  },
  {
    file: 'leads-popup-fr-dm',
    label: 'leads · popup FR / DM',
    path: '/leads',
    async setup(page) {
      await openLeadPopup(page);
      await clickText(page, '.langs', 'FR');
      await clickText(page, '.modes', 'DM');
    },
  },
  {
    file: 'leads-dropdown',
    label: 'leads · a filter dropdown open',
    path: '/leads',
    async setup(page) {
      // On a phone the pickers are in the Filters sheet (P6 block 3), every list open.
      const sheetBtn = page.locator('.filters-btn');
      if (await sheetBtn.isVisible()) {
        await sheetBtn.click();
        await page.waitForSelector('.filter-sheet .dd[open] .dd-menu', { state: 'visible' });
      } else {
        await page.locator('.dd > summary').first().click();
        await page.waitForSelector('.dd[open] .dd-menu', { state: 'visible' });
      }
      await page.waitForTimeout(200);
    },
  },
  {
    file: 'leads-your-details',
    label: 'leads · "Your details" panel',
    path: '/leads',
    async setup(page) {
      // On a phone the actions are in the Summary pane (P6 block 3).
      const summary = page.locator('.leads-seg [data-seg=summary]');
      if (await summary.isVisible()) await summary.click();
      await page.locator('button.chip-btn', { hasText: 'Your details' }).first().click();
      await page.waitForSelector('.scrim .modal', { state: 'visible' });
      await page.waitForTimeout(250);
    },
  },
  {
    file: 'missions-new',
    label: 'missions · a new mission, the card in edit mode',
    path: '/missions',
    async setup(page) {
      await page.getByRole('button', { name: 'New mission', exact: true }).first().click();
      await page.waitForSelector('.ms-card.is-editing .ms-edit', { state: 'visible' });
      await page.waitForTimeout(300);
    },
  },
  {
    file: 'missions-edit',
    label: 'missions · an existing card in edit mode',
    path: '/missions',
    // "Change" unfolds the editor inside the card it belongs to. Nothing is
    // seeded: the screen always has at least the card this opens, or the
    // state simply has no card to open and says so in the report.
    async setup(page) {
      await page.locator('.ms-card .ms-titlebtn').first().click();
      await page.waitForSelector('.ms-card.is-editing .ms-edit', { state: 'visible' });
      await page.waitForTimeout(300);
    },
  },
  {
    file: 'missions-proposed',
    label: 'missions · the proposals column, one reply expanded',
    path: '/missions',
    // A proposal seeded through the API so the column has something to show,
    // then taken away again: the sweep leaves the database as it found it.
    async setup(page) {
      const id = await page.evaluate(async () => {
        const made = await fetch('/api/missions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Answer Lumen — which brands you have worked with',
            detail: 'They ask which brands you have worked with.',
            status: 'proposed',
          }),
        }).then((r) => r.json());
        return (made.mission ?? made).id;
      });
      await page.reload({ waitUntil: 'networkidle' });
      const summary = page.locator('.ms-col-proposed details > summary').first();
      if (await summary.count()) await summary.click();
      await page.waitForTimeout(350);
      return async () => {
        await page.evaluate((mid) => fetch(`/api/missions/${mid}`, { method: 'DELETE' }), id);
      };
    },
  },
  {
    file: 'missions-blocked',
    label: 'missions · a blocked mission with its reason',
    path: '/missions',
    // Seeded through the API so the shot has something to show, then taken
    // away again: the sweep leaves the database as it found it.
    async setup(page) {
      const id = await page.evaluate(async () => {
        const post = (url, body) => fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then((r) => r.json());
        const made = await post('/api/missions', { title: 'Wait for the Gmail bridge token' });
        const mission = made.mission ?? made;
        await fetch(`/api/missions/${mission.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'blocked', blocked_on: 'The bridge needs an OAuth token that only Andy can grant.' }),
        });
        return mission.id;
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(350);
      return async () => {
        await page.evaluate((mid) => fetch(`/api/missions/${mid}`, { method: 'DELETE' }), id);
      };
    },
  },
  {
    file: 'finance-new-invoice',
    label: 'finance · "New invoice" editor',
    path: '/finance',
    tall: 1750,
    async setup(page) {
      const id = await page.evaluate(async () => {
        const post = (url, body) => fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then((r) => r.json());
        const { clients } = await fetch('/api/finance/clients').then((r) => r.json());
        const { invoice } = await post('/api/finance/invoices', {
          client_id: clients[0].id, kind: 'prepayment', subject: 'Visual creation package - Prepayment',
        });
        await fetch(`/api/finance/invoices/${invoice.id}/lines`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: [
            { description: 'Website — Design, creation', qty: 1, unit_cents: 200000 },
            { description: 'Website marketing — SEO + Google', qty: 1, unit_cents: 60000 },
            { description: 'Digital marketing — Design + Post (3x a week) + website maintenance · monthly cost', qty: 1, unit_cents: 40000 },
          ] }),
        });
        return invoice.id;
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('.invoice-row .btn').first().click();
      await page.waitForSelector('dialog.editor, .scrim .modal', { state: 'visible' });
      await page.waitForTimeout(400);
      return async () => {
        await page.evaluate((iid) => fetch(`/api/finance/invoices/${iid}`, { method: 'DELETE' }), id);
      };
    },
  },
  {
    file: 'finance-clients',
    label: 'finance · Clients panel',
    path: '/finance',
    async setup(page) {
      await page.locator('button', { hasText: /^Clients$/ }).first().click();
      await page.waitForSelector('.scrim .modal, dialog[open]', { state: 'visible' });
      await page.waitForTimeout(300);
    },
  },
  { file: 'finance-record-payment', label: 'finance · Record payment', path: '/finance', tall: 1600, setup: openIssued('Record a payment') },
  { file: 'finance-part-2', label: 'finance · Create part 2', path: '/finance', tall: 1600, setup: openIssued('Part 2') },
  { file: 'finance-void', label: 'finance · Void', path: '/finance', tall: 1600, setup: openIssued('Void') },
  {
    file: 'project-notes-focus',
    label: 'project page · notes textarea focused',
    path: `/p/${SLUGS[0]}`,
    async setup(page) {
      const box = page.locator('textarea').last();
      await box.scrollIntoViewIfNeeded();
      await box.focus();
      await page.waitForTimeout(200);
    },
  },
  { file: 'admin-screen', label: '/admin', path: '/admin', setup: async (page) => page.waitForTimeout(150) },
];

/* ----------------------------------------------------- the page audit --- */

const AUDIT = `(() => {
  const GAP = 16;            // --gap
  const GAP_LG = 30;         // --gap-lg
  const MICRO = 12;          // --micro, the type floor
  const TAP = 40;
  const issues = [];
  const sel = (n) => n.tagName.toLowerCase()
    + (n.id ? '#' + n.id : '')
    + (typeof n.className === 'string' && n.className.trim()
        ? '.' + n.className.trim().split(/\\s+/).join('.') : '');
  const add = (kind, node, detail) => issues.push({ kind, sel: node ? sel(node) : '', detail });

  const docW = document.documentElement.clientWidth;
  const docH = document.documentElement.clientHeight;
  const scrollW = document.documentElement.scrollWidth;
  if (scrollW > window.innerWidth + 1) {
    add('page-h-scroll', null, scrollW + 'px wide in a ' + window.innerWidth + 'px viewport');
  }

  const visible = (n) => {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // What the eye actually sees: the element's box intersected with every
  // ancestor that clips, and with the viewport. Without this a pill scrolled
  // out of the nav strip still "overlaps" whatever sits beside the strip —
  // its rect says so, the screen does not.
  const shownRect = (n) => {
    let r = n.getBoundingClientRect();
    let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    for (let cur = n.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      const clipsX = cs.overflowX !== 'visible';
      const clipsY = cs.overflowY !== 'visible';
      if (!clipsX && !clipsY) continue;
      const cr = cur.getBoundingClientRect();
      if (clipsX) { box.left = Math.max(box.left, cr.left); box.right = Math.min(box.right, cr.right); }
      if (clipsY) { box.top = Math.max(box.top, cr.top); box.bottom = Math.min(box.bottom, cr.bottom); }
    }
    box.left = Math.max(box.left, 0);
    box.top = Math.max(box.top, 0);
    box.right = Math.min(box.right, docW);
    box.width = box.right - box.left;
    box.height = box.bottom - box.top;
    box.x = box.left; box.y = box.top;
    return box;
  };

  const all = [...document.querySelectorAll('body *')].filter(visible);

  /* ---- layers: a popover legitimately covers the page beneath it, so
     boxes are only ever compared against boxes in the same layer. ---- */
  const layerOf = (n) => {
    for (let cur = n; cur && cur !== document.body; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky') return cur;
      if (cur.tagName === 'DIALOG') return cur;
    }
    return null;
  };

  /* ---- 1. overlap ---- */
  const OVERLAP_SEL = '.card, .panel, .section, .modal, .scrim, dialog, [aria-modal], '
    + '.dd-menu, .dd-opt, .menu, .toast, table, thead, tbody, tr, '
    + '.tag, .pill, .rx-pill, .chip-btn, .btn, .tab, button, a, '
    + 'input, select, textarea, .eyebrow, h1, h2, h3';
  const boxes = all
    .filter((n) => n.matches(OVERLAP_SEL))
    .map((n) => ({ n, s: sel(n), r: shownRect(n), layer: layerOf(n) }))
    .filter((b) => b.r.width > 1 && b.r.height > 1);

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.layer !== b.layer) continue;
      if (a.n.contains(b.n) || b.n.contains(a.n)) continue;
      // A label and the control it wraps, a row and its cells: same-parent
      // inline siblings on one text line are not a layout collision.
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 1 && iy > 1) {
        add('overlap', a.n,
          sel(a.n) + ' [' + Math.round(a.r.x) + ',' + Math.round(a.r.y) + ',' + Math.round(a.r.width) + 'x' + Math.round(a.r.height) + ']'
          + '  ∩  ' + sel(b.n) + ' [' + Math.round(b.r.x) + ',' + Math.round(b.r.y) + ',' + Math.round(b.r.width) + 'x' + Math.round(b.r.height) + ']'
          + '  by ' + Math.round(ix) + 'x' + Math.round(iy) + 'px');
      }
    }
  }

  for (const node of all) {
    const cs = getComputedStyle(node);
    const r = node.getBoundingClientRect();

    /* ---- 2. type floor ---- */
    const size = parseFloat(cs.fontSize);
    const ownText = [...node.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText && size < MICRO - 0.01) {
      add('tiny-text', node, size + 'px — "' + node.textContent.trim().slice(0, 40) + '"');
    }

    /* ---- 2b. text squeezed into a column too narrow to read ----
       A grid column that cannot shrink pushes its neighbour to nearly
       nothing, and the text inside it wraps one character to a line. It
       overlaps nothing and is clipped by nothing, so only its own width
       gives it away. */
    if (ownText && node.textContent.trim().length > 3) {
      const line = parseFloat(cs.lineHeight) || size * 1.4;
      const tall = r.height > line * 3.5;
      if (r.width < 44 && tall) {
        add('squeezed-text', node, Math.round(r.width) + 'px wide, ' + Math.round(r.height)
          + 'px tall — "' + node.textContent.trim().slice(0, 40) + '" is wrapping a character to a line');
      }
    }

    /* ---- 3. tap targets on the phone ---- */
    if (window.innerWidth <= 480
        && /^(button|a|select|summary)$/.test(node.tagName.toLowerCase())
        && r.height < TAP && r.top >= 0 && r.bottom <= docH) {
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hits = (y) => {
        const t = document.elementFromPoint(cx, y);
        return !!t && (t === node || node.contains(t) || t.contains(node));
      };
      if (cy - 19 < 0 || !hits(cy - 19) || !hits(cy + 19)) {
        add('small-tap-target', node, Math.round(r.height) + 'px tall — "' + (node.textContent || '').trim().slice(0, 30) + '"');
      }
    }

    /* ---- 4. clipped by the viewport, or by an overflow:hidden ancestor ---- */
    if (r.width > 0 && r.height > 0) {
      if (r.right > docW + 1 || r.left < -1) {
        // A strip that scrolls inside itself is allowed to have content out
        // of view — that is what the scroller is for.
        let scroller = null;
        for (let cur = node.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
          const o = getComputedStyle(cur);
          if (/(auto|scroll)/.test(o.overflowX) && cur.scrollWidth > cur.clientWidth + 1) { scroller = cur; break; }
        }
        const decorative = !node.matches('input, select, textarea, button, a, img, svg, canvas, video')
          && (cs.pointerEvents === 'none' || (!node.textContent.trim() && !node.children.length));
        if (!scroller && !decorative) add('clipped-by-viewport', node, 'left=' + Math.round(r.left) + ' right=' + Math.round(r.right) + ' viewport=' + docW);
      }

      // Only content can be "cut off". A decorative shape (no text, nothing
      // to click, pointer-events: none) is drawn inside an overflow:hidden
      // box on purpose — that is how a background flourish is bled to the
      // edge — so it is not a clipping bug.
      const CONTENT = 'input, select, textarea, button, a, img, svg, canvas, video';
      // Nothing to cut off: no text, no children, not a replaced or
      // interactive element — an empty box with a background is decoration.
      const carriesContent = node.matches(CONTENT)
        || ((!!node.textContent.trim() || node.children.length > 0)
            && cs.pointerEvents !== 'none');
      for (let cur = carriesContent ? node.parentElement : null; cur && cur !== document.body; cur = cur.parentElement) {
        const o = getComputedStyle(cur);
        // Inside a scroll container the content below the fold is reached by
        // scrolling, not cut off (the phone frame's .scroll-region, P6).
        if (/(auto|scroll)/.test(o.overflowY) || /(auto|scroll)/.test(o.overflowX)) break;
        const hiddenX = o.overflowX === 'hidden' || o.overflowX === 'clip';
        const hiddenY = o.overflowY === 'hidden' || o.overflowY === 'clip';
        if (!hiddenX && !hiddenY) continue;
        const cr = cur.getBoundingClientRect();
        if (!cr.width || !cr.height) continue;
        const outX = hiddenX && (r.right > cr.right + 1 || r.left < cr.left - 1);
        const outY = hiddenY && (r.bottom > cr.bottom + 1 || r.top < cr.top - 1);
        if (outX || outY) {
          add('clipped-by-ancestor', node,
            'clipped by ' + sel(cur) + ' — element [' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.right) + ',' + Math.round(r.bottom)
            + '] vs box [' + Math.round(cr.left) + ',' + Math.round(cr.top) + ',' + Math.round(cr.right) + ',' + Math.round(cr.bottom) + ']');
        }
        break;
      }
    }

    /* ---- 5. an empty card ---- */
    if (node.matches('.card, .panel')) {
      const meaningful = [...node.children].filter((c) => !c.matches('.eyebrow') && visible(c));
      const loose = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!meaningful.length && !loose) {
        add('empty-card', node, 'nothing in it but the eyebrow');
      }
    }
  }

  /* ---- 6. stacked cards, one gap ---- */
  const stacks = [document.getElementById('main'), ...document.querySelectorAll('.grid, .modal, dialog')].filter(Boolean);
  for (const stack of stacks) {
    const kids = [...stack.children].filter((n) => visible(n) && getComputedStyle(n).position === 'static');
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i]; const b = kids[i + 1];
      if (!(a.matches('.card, .panel') && b.matches('.card, .panel'))) continue;
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
      // side by side, not stacked
      if (rb.top < ra.bottom - 1 && Math.abs(ra.left - rb.left) > 2) continue;
      const gap = Math.round(rb.top - ra.bottom);
      if (gap !== GAP && gap !== GAP_LG) {
        add('gap-off-token', b, gap + 'px between two stacked cards in ' + sel(stack) + ' — expected ' + GAP + ' or ' + GAP_LG);
      }
    }
  }

  /* ---- 8. header holds one row: Sign out sits beside the wordmark, never
     under it, at any width. Compared by vertical centre, not top edge — the
     wordmark and the Sign out chip are different heights, so a one-row
     header centred with align-items: center naturally has their top edges a
     few px apart even though neither has wrapped. */
  const brandMark = document.querySelector('.brand');
  const signout = document.getElementById('signout');
  if (brandMark && signout) {
    const br = brandMark.getBoundingClientRect();
    const sr = signout.getBoundingClientRect();
    const bc = br.top + br.height / 2;
    const sc = sr.top + sr.height / 2;
    if (Math.abs(bc - sc) > 4) {
      add('header-wrapped', signout,
        'Sign out centre ' + Math.round(sc) + 'px vs wordmark centre ' + Math.round(bc) + 'px — more than 4px apart (wrapped to its own row)');
    }
  }

  /* ---- 9. phone nav: nothing hidden — every pill's box is fully inside
     the viewport (the strip wraps to a second row instead of scrolling
     past its own first pills). ---- */
  if (window.innerWidth <= 390) {
    for (const btn of document.querySelectorAll('nav.pills button')) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.left < -1 || r.right > docW + 1)) {
        add('pill-out-of-view', btn,
          '[' + Math.round(r.left) + ',' + Math.round(r.right) + '] viewport=' + docW);
      }
    }
  }

  /* ---- 7. focus is visible ---- */
  const focused = document.activeElement;
  if (focused && focused !== document.body && focused.matches('input, textarea, select, button, a, summary')) {
    const cs = getComputedStyle(focused);
    // Only a control the browser has decided deserves a ring — focus moved
    // there by the keyboard, or a text field — is expected to draw one. A
    // button that merely received focus from a click is not.
    const due = focused.matches(':focus-visible');
    const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
      || cs.boxShadow !== 'none'
      || cs.borderColor !== getComputedStyle(document.body).borderColor;
    if (due && !ring) add('focus-not-visible', focused, 'the focused control draws no ring');
  }

  return { issues, scrollWidth: scrollW, innerWidth: window.innerWidth };
})()`;

// After Escape: nothing dimmed may be left behind, and the page must scroll.
const AFTER_ESCAPE = `(() => {
  const leftovers = [...document.querySelectorAll('.backdrop, .modal, .scrim, [aria-modal], dialog[open]')]
    .filter((n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    })
    .map((n) => n.tagName.toLowerCase() + '.' + (typeof n.className === 'string' ? n.className : ''));
  const body = getComputedStyle(document.body);
  const html = getComputedStyle(document.documentElement);
  // A phone-frame screen holds the page still on purpose (P6): that is not a modal's lock left on.
  const framed = !!document.querySelector('#main > .phone-frame') && innerWidth <= 760;
  const locked = (!framed && (body.overflow === 'hidden' || html.overflow === 'hidden'))
    || body.position === 'fixed'
    || /(no-scroll|scroll-lock|modal-open|locked)/.test(document.body.className)
    || /(no-scroll|scroll-lock|modal-open|locked)/.test(document.documentElement.className);
  return { leftovers, locked, bodyClass: document.body.className };
})()`;

// Navigating inside the app must take every popup with it — a scrim that
// outlives the screen it belonged to dims the next page and eats its clicks.
const AFTER_NAV = `(() => {
  const dimmed = [...document.querySelectorAll('.scrim, .backdrop, [aria-modal]')]
    .filter((n) => getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0);
  return { count: dimmed.length, path: location.pathname };
})()`;

/* -------------------------------------------------------------- run it --- */

const ROUTE_WIDTHS = [1280, 768, 390];
const STATE_WIDTHS = [1280, 390];
const HEIGHT = { 1280: 900, 768: 1024, 390: 844 };

const ONLY = (process.env.HQ_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const pick = (list) => (ONLY.length ? list.filter((s) => ONLY.includes(s.file)) : list);

const browser = await chromium.launch();
assertDemoConfigIsLocal(root);
const cookie = await sessionCookie();
await assertDemoServer(BASE, cookie.value);
const findings = [];
const shots = [];

async function shoot(spec, width, { state = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: spec.tall ?? HEIGHT[width] },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    isMobile: width <= 480,
    hasTouch: width <= 480,
  });
  if (!spec.anon) await context.addCookies([cookie]);
  await offlineFonts(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A failed request is the API's business, not the layout's — and the leads
  // API belongs to another agent. Only errors the page's own script threw.
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR_|favicon/.test(text)) return;
    errors.push(text);
  });

  const name = `${spec.file}-${width}`;
  let cleanup = null;
  try {
    await page.goto(BASE + spec.path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    if (spec.setup) cleanup = await spec.setup(page);
    await page.waitForTimeout(350);

    const file = `${OUT}/${name}.png`;
    await page.screenshot({ path: file, fullPage: !state });
    shots.push({ name, file, width, label: spec.label || spec.file });

    const audit = await page.evaluate(AUDIT);
    for (const issue of audit.issues) findings.push({ shot: name, ...issue });
    for (const e of errors) findings.push({ shot: name, kind: 'js-error', sel: '', detail: e.slice(0, 200) });

    if (state) {
      // The first Escape in a field blurs it rather than closing the popup
      // (deliberate — you can leave a half-typed draft without losing it), so
      // press until the layer is gone or three presses are up.
      let after = null;
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        after = await page.evaluate(AFTER_ESCAPE);
        if (!after.leftovers.length && !after.locked) break;
      }
      for (const l of after.leftovers) {
        findings.push({ shot: name, kind: 'leftover-backdrop', sel: l, detail: 'still on screen after Escape' });
      }
      if (after.locked) {
        findings.push({ shot: name, kind: 'scroll-lock-left-on', sel: 'body', detail: `body class "${after.bodyClass}"` });
      }
    }
  } catch (error) {
    findings.push({ shot: name, kind: 'setup-failed', sel: '', detail: String(error).slice(0, 220) });
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    await context.close();
  }
}

for (const route of pick(ROUTES)) {
  for (const width of ROUTE_WIDTHS) await shoot(route, width);
}
for (const state of pick(STATES)) {
  for (const width of STATE_WIDTHS) await shoot(state, width, { state: true });
}

/* A popup must not outlive the screen it belongs to. */
if (!ONLY.length) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await context.addCookies([cookie]);
  await offlineFonts(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle' });
  await openLeadPopup(page);
  await page.evaluate(() => {
    // by path, not by text: the phone bar spells the sections differently
    for (const b of document.querySelectorAll('#nav button')) if (b.dataset.path === '/projects') b.click();
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(AFTER_NAV);
  if (after.count) {
    findings.push({
      shot: 'nav-away-from-popup', kind: 'leftover-backdrop', sel: '.scrim',
      detail: `${after.count} dim layer(s) still over ${after.path} after navigating away from the leads popup`,
    });
  }
  await context.close();
}

/* --------------------------------------------------------- contact sheets --- */

function sheetHtml(width, columns, thumb, cap) {
  const cards = shots.filter((s) => s.width === width).map((s) => `
    <figure>
      <div class="shot"><img src="./${s.name}.png" alt=""></div>
      <figcaption><span class="t">${s.label}</span><span class="w">${width}</span></figcaption>
    </figure>`).join('');
  return `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; --ink:#E6EEE8; --muted:#8A9C90; --line:#27332B; --card:#18211C; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:#101613; color:var(--ink);
    font:14px/1.45 'Instrument Sans', ui-sans-serif, system-ui, sans-serif; }
  h1 { margin:0 0 4px; font-size:20px; font-weight:600; letter-spacing:-.02em; }
  p.sub { margin:0 0 22px; font-size:13px; color:var(--muted); }
  .sheet { display:grid; grid-template-columns:repeat(${columns}, ${thumb}px); gap:22px; }
  figure { margin:0; }
  .shot { max-height:${cap}px; overflow:hidden; border:1px solid var(--line);
    border-radius:10px; background:var(--card); }
  .shot img { display:block; width:100%; height:auto; }
  figcaption { display:flex; justify-content:space-between; gap:8px; align-items:baseline;
    margin-top:7px; font-family:'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size:12px; }
  figcaption .w { color:var(--muted); }
</style>
<body>
  <h1>HQ — every page and state at ${width}px</h1>
  <p class="sub">${shots.filter((s) => s.width === width).length} shots · dark is the only theme · tall pages cropped to their first ${cap}px.</p>
  <div class="sheet">${cards}</div>
</body>`;
}

const sheetPage = await (await offlineFonts(await browser.newContext({ deviceScaleFactor: 1, colorScheme: 'dark' }))).newPage();
for (const [width, columns, thumb, cap] of [[1280, 4, 320, 560], [768, 5, 250, 560], [390, 7, 165, 560]]) {
  if (!shots.some((s) => s.width === width)) continue;
  const tmp = `${OUT}/.sheet-${width}.html`;
  writeFileSync(tmp, sheetHtml(width, columns, thumb, cap));
  await sheetPage.goto(`file://${tmp}`, { waitUntil: 'networkidle' });
  await sheetPage.waitForTimeout(400);
  await sheetPage.screenshot({ path: `${OUT}/contact-${width}.png`, fullPage: true });
  rmSync(tmp, { force: true });
}

await browser.close();

/* ------------------------------------------------------------- report --- */

console.log(`\n${shots.length} screenshots → ${OUT}`);
if (!findings.length) {
  console.log('visual-sweep: clean — no overlaps, no clipping, no tiny type, no leftovers.');
  process.exit(0);
}

const byShot = {};
for (const f of findings) (byShot[f.shot] ||= []).push(f);
for (const [shot, list] of Object.entries(byShot)) {
  console.log(`\n== ${shot}  (${list.length})`);
  const byKind = {};
  for (const f of list) (byKind[f.kind] ||= []).push(f);
  for (const [kind, group] of Object.entries(byKind)) {
    console.log(`   ${kind} (${group.length})`);
    for (const f of group.slice(0, 6)) console.log(`     - ${f.sel} :: ${f.detail}`);
    if (group.length > 6) console.log(`     … ${group.length - 6} more`);
  }
}
console.log(`\nvisual-sweep: FAILED — ${findings.length} finding(s) across ${Object.keys(byShot).length} shot(s)`);
process.exit(1);
