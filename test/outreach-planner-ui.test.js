import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freshDatabase } from './helpers/d1.js';
import { handleOutreach } from '../src/worker/api/outreach.js';
import { saveSender } from '../src/worker/outreach.js';
import { setHqTimeZone } from '../src/worker/db.js';

it('keeps a built draft after Save paused sender, editing, reload, approval and delivery logging', async () => {
  const { database: db, dispose } = await freshDatabase();
  let browser;
  try {
    setHqTimeZone('America/Lima');
    await db.prepare(`
      INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
      VALUES ('plastic-surgeons-demo', 'Plastic surgeons', 'Demo only', 70, 50, 'x')
    `).run();
    for (const id of ['a', 'b']) await db.prepare(`
      INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
        languages, email, score, tier, payload, imported_at)
      VALUES (?, 'plastic-surgeons-demo', ?, 'Plastic surgeons', 'Robin Example', '', 'No site',
        'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')
    `).bind(`plastic-surgeons-demo/${id}`, id, `${id}@example.com`).run();
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: true });
    const now = new Date('2026-11-18T15:00:00Z');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // No server or app port. Every request stays inside this fictional test harness.
    await page.route('**/*', async (route) => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      if (url.origin !== 'https://hq.test') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        const request = new Request(url, { method: incoming.method(), headers: { 'Content-Type': 'application/json' },
          ...(incoming.postData() ? { body: incoming.postData() } : {}) });
        const response = await handleOutreach(request, { DB: db }, url, {}, now);
        return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
      }
      if (url.pathname.startsWith('/assets/') && !url.pathname.includes('..')) {
        return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`../src/public${url.pathname}`, import.meta.url), 'utf8') });
      }
      return route.fulfill({ contentType: 'text/html', body: `<main></main><script type="module">
        import { renderDailyPlanner } from '/assets/screens/outreach-planner.js';
        import { reviewBatch } from '/assets/screens/outreach-review.js';
        async function refresh() { document.querySelector('main').replaceChildren(await renderDailyPlanner({ refresh, reviewBatch })); }
        await refresh();
      </script>` });
    });
    await page.goto('https://hq.test/');
    await page.getByRole('button', { name: 'Build the batch', exact: true }).click();
    await page.waitForSelector('[data-draft-count="2"]');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByLabel('Sender address', { exact: true }).fill('demo@example.com');
    await page.getByLabel('Emails a day (0–280)', { exact: true }).fill('5');
    await page.getByRole('button', { name: 'Save, paused', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Your drafts are kept'));
    expect(await page.locator('[data-draft-count="2"]').count()).toBe(1);
    await page.locator('.ow-draft .row').first().click();
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH');
    await page.getByLabel('Email', { exact: true }).fill('An explicit saved edit.\n');
    expect((await saved).status()).toBe(200);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await page.waitForSelector('[data-draft-count="2"]');
    await page.locator('.ow-draft .row').first().click();
    expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe('An explicit saved edit.\n');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Sender allowed'));
    await page.getByRole('button', { name: 'Review and approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Download first-touch · 2 emails', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Send', exact: true }).count()).toBe(0);
    expect(await page.getByText('Review sha256:', { exact: false }).count()).toBe(1);
    await page.getByRole('button', { name: 'After sending', exact: true }).click();
    const sendLog = ['a', 'b'].map((id) => ({ uids: [`plastic-surgeons-demo/${id}`], status: 201, messageId: `<demo-${id}@example.com>` }));
    await page.getByLabel('Send log JSON', { exact: true }).setInputFiles({ name: 'demo-log.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(sendLog)) });
    await page.getByLabel('Brevo events CSV or JSON', { exact: true }).setInputFiles({ name: 'demo-events.csv', mimeType: 'text/csv', buffer: Buffer.from('messageId,event,date\n<demo-a@example.com>,delivered,2026-11-19T14:00:00Z\n') });
    await page.getByRole('button', { name: 'Verify delivery', exact: true }).click();
    await page.getByRole('button', { name: 'Log delivered in HQ', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('1 logged'));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE kind = 'sent'").first()).n).toBe(1);
    await page.getByRole('button', { name: 'Log delivered in HQ', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('0 logged'));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE kind = 'sent'").first()).n).toBe(1);


  } finally {
    await browser?.close();
    await dispose();
  }
}, 60000);
