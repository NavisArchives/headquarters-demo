import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

for (const width of [1440, 1280, 390]) it(`keeps Planner, Review and After sending inside the ${width}px frame`, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const batch = { id: 'demo-layout', day: '2026-11-18', sender: 'demo@example.com', status: 'draft',
      content_hash: 'a'.repeat(64), skipped_json: '[]', verification_json: JSON.stringify({ summary: {
        counts: { delivered: 2, soft_bounce: 0, hard_bounce: 0, spam: 0, blocked: 0 },
        total: 3, bounce_rate: 0, pending: 1, api_failed: 0, not_in_log: 0, unmatched_events: 0, ignored_events: 0, failed: false,
      } }), items: Array.from({ length: 3 }, (_, i) => ({ uid: `demo/${i}`, recipient: `a-long-fictional-recipient-${i}@example.com`,
        step: 1, lang: 'EN', subject: 'An approved fictional subject', body: 'Demo message, kept in full.\n\n'.repeat(12) })) };
    let shell = await readFile(new URL('../src/public/index.html', import.meta.url), 'utf8');
    shell = shell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replaceAll('hq.example.com', 'hq.demo.example');
    shell = shell.replace('</body>', `<script type="module">
      import { renderOutreach } from '/assets/screens/outreach.js';
      document.querySelector('#nav').innerHTML = ['Projects','Missions','Outreach','Onboarding','Finance'].map((label) => '<button aria-label="'+label+'"><span class="l">'+label+'</span><span class="s">'+label+'</span></button>').join('');
      document.querySelector('#main').append(await renderOutreach({ navigate: () => {} }));
    </script></body>`);
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== 'https://hq.test') return route.abort();
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        let json = {};
        if (path === '/api/outreach/senders') json = { senders: [{ email: batch.sender, daily_limit: 20, paused: false }] };
        else if (path === '/api/outreach/cockpit') json = { day: batch.day };
        else if (path === '/api/outreach/batches') json = { batches: [{ ...batch, emails: 3 }] };
        else if (path.endsWith('/approve')) { batch.status = 'approved'; json = { batch }; }
        else if (path.endsWith('/export')) json = { files: [{ kind: 'first-touch', filename: 'demo.json', content: '{}', count: 3, sha256: 'b'.repeat(64) }], held: [], row_hashes: { 'demo/0': 'c'.repeat(64) } };
        else json = { batch };
        return route.fulfill({ json });
      }
      if (path.startsWith('/assets/')) {
        try { return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: await readFile(new URL(`../src/public${path}`, import.meta.url)) }); }
        catch { return route.fulfill({ status: 404, body: '' }); }
      }
      return route.fulfill({ contentType: 'text/html', body: shell });
    });
    const capture = async (name) => {
      if (!process.env.HQ_LAYOUT_SHOTS) return;
      await mkdir(process.env.HQ_LAYOUT_SHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.HQ_LAYOUT_SHOTS}/isolated-${name}-${width}.png` });
    };
    const check = async (modal = false) => {
      const metrics = await page.evaluate((inModal) => {
        const root = inModal ? [...document.querySelectorAll('.modal')].at(-1) : document.querySelector('.ow-screen');
        const scrollers = [root, ...root.querySelectorAll('*')].filter((node) => !node.matches('input,textarea,select') && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 2);
        const visibleButtons = [...root.querySelectorAll('button')].filter((node) => node.textContent === 'Close' || node.textContent === 'Approve');
        const clip = (node) => {
          const box = node.getBoundingClientRect();
          const rect = { left: Math.max(0, box.left), top: Math.max(0, box.top), right: Math.min(innerWidth, box.right), bottom: Math.min(innerHeight, box.bottom) };
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflow)) {
              const p = parent.getBoundingClientRect();
              rect.left = Math.max(rect.left, p.left); rect.right = Math.min(rect.right, p.right);
              rect.top = Math.max(rect.top, p.top); rect.bottom = Math.min(rect.bottom, p.bottom);
            }
          }
          return rect;
        };
        const nodes = [...root.querySelectorAll('section.card,button,input,textarea,select')]
          .filter((node) => node.getClientRects().length).map((node) => ({ node, box: clip(node) }))
          .filter(({ box }) => box.right - box.left > 2 && box.bottom - box.top > 2);
        const overlaps = [];
        for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i], b = nodes[j];
          if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
          if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 2
            && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 2) {
            overlaps.push([a.node.tagName, b.node.tagName]);
          }
        }
        const cards = [...root.querySelectorAll('section.card')];
        const unequalRows = cards.some((a) => cards.some((b) => a !== b && a.parentElement === b.parentElement
          && Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2
          && Math.abs(a.getBoundingClientRect().height - b.getBoundingClientRect().height) > 2));

        const toast = document.querySelector('.toast.show');
        const toastHitsActions = toast && visibleButtons.some((button) => {
          const a = toast.getBoundingClientRect(), b = button.getBoundingClientRect();
          return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
        });
        return { toastHitsActions: Boolean(toastHitsActions), overlaps, unequalRows, pageX: document.documentElement.scrollWidth - innerWidth,
          pageY: document.documentElement.scrollHeight - innerHeight,
          scrolling: scrollers.length, scrollNames: scrollers.map((node) => node.className),
          actions: visibleButtons.map((node) => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }),
          barGap: getComputedStyle(document.documentElement).getPropertyValue('--bar-gap').trim() };
      }, modal);
      expect(metrics.pageX).toBeLessThanOrEqual(1);
      expect(metrics.pageY).toBeLessThanOrEqual(1);
      expect(metrics.scrolling, JSON.stringify(metrics.scrollNames)).toBeLessThanOrEqual(1);
      expect(metrics.actions.every(Boolean)).toBe(true);
      expect(metrics.overlaps).toEqual([]);
      expect(metrics.unequalRows).toBe(false);
      expect(metrics.toastHitsActions).toBe(false);
      if (width === 390) expect(metrics.barGap).toBe('18px');
    };
    await page.goto('https://hq.test/outreach?view=planner');
    await page.getByRole('button', { name: 'Review and approve', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await check();
    await capture('planner');
    await page.getByRole('button', { name: 'Review and approve', exact: true }).click();
    await page.getByRole('dialog', { name: 'Review exact emails', exact: true }).waitFor();
    await check(true);
    await capture('review');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'After sending', exact: true }).waitFor();
    await check(true);
    await page.getByRole('button', { name: 'After sending', exact: true }).click();
    await page.getByLabel('Send log JSON', { exact: true }).waitFor();
    await check(true);
    await capture('after-sending');
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30000);
