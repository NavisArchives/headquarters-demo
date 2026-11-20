import { it, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

it('puts recorded conversations first and passes only an explicit refusal with one state PATCH', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const patches = [];
    let declined = [{ uid: 'demo/no', name: 'Demo refusal', stage: 'replied', summary: 'A clear no', can_pass: true, reply_at: '2026-11-18T15:00:00Z' }];
    await page.route('**/*', async (route) => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      if (url.origin !== 'https://hq.test') return route.abort();
      if (url.pathname === '/api/outreach/replies') return route.fulfill({ json: {
        warm: [{ uid: 'demo/warm', name: 'Demo warm', stage: 'talks', summary: 'A call, please', thread_href: 'https://mail.google.com/mail/u/0/#all/demo-thread', reply_at: '2026-11-18T16:00:00Z' },
          { uid: 'demo/unclear', name: 'Demo ambiguous', stage: 'replied', summary: 'An ambiguous reply', reply_at: '2026-11-17T16:00:00Z' }],
        declined, mail_sync: 'Mailbox sync is not live. Recorded replies only.',
      } });
      if (url.pathname === '/api/leads/demo/no/state' && incoming.method() === 'PATCH') {
        patches.push(incoming.postDataJSON()); declined = [];
        return route.fulfill({ json: { lead: { uid: 'demo/no', stage: 'passed' } } });
      }
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`../src/public${url.pathname}`, import.meta.url), 'utf8') });
      return route.fulfill({ contentType: 'text/html', body: `<main></main><script type="module">
        import { homeRepliesPanel } from '/assets/screens/home-replies.js';
        window.open = (url) => { window.openedThread = url; };
        document.querySelector('main').append(await homeRepliesPanel());
      </script>` });
    });
    await page.goto('https://hq.test/');
    await page.getByRole('button', { name: 'Pass', exact: true }).waitFor();
    expect(await page.locator('.home-reply b').allTextContents()).toEqual(['Demo warm', 'Demo ambiguous', 'Demo refusal']);
    expect(await page.getByRole('button', { name: 'Pass', exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Open thread', exact: true }).first().click();
    expect(await page.evaluate(() => window.openedThread)).toBe('https://mail.google.com/mail/u/0/#all/demo-thread');
    await page.getByRole('button', { name: 'Pass', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.home-replies')?.dataset.attentionCount === '2');
    expect(patches).toEqual([{ stage: 'passed', follow_up: null }]);
    expect(await page.getByText('Demo refusal', { exact: true }).count()).toBe(0);
    expect(await page.getByText('Demo ambiguous', { exact: true }).count()).toBe(1);
    // The sync note is a tooltip on the heading, not text on the screen (no engineer text, 19 Nov).
    expect(await page.locator('.home-replies h3').getAttribute('title')).toBe('Mailbox sync is not live. Recorded replies only.');
  } finally { await browser.close(); }
}, 30000);
