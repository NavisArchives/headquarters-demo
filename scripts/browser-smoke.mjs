import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DEMO_BASE } from './gate-target.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const vars = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
// The demo (8790, fictional data) by default: 8787 is the live database, and these
// scripts click and write (audit, 13 Nov). Another target only on purpose, via HQ_TEST_URL.
const origin = process.env.HQ_TEST_URL || DEMO_BASE;
try {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Password').fill(process.env.HQ_TEST_PASSWORD || vars.match(/^HQ_PASSWORD=(.*)$/m)[1]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByText('214 leads', { exact: true }).waitFor();
  await page.getByLabel('Business', { exact: true }).selectOption('UGC');
  await page.getByText('150 leads', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open lead', exact: true }).first().click();
  await page.getByRole('button', { name: 'Compose draft', exact: true }).click();
  await page.getByLabel('Message body').waitFor();
  assert.ok((await page.getByLabel('Message body').inputValue()).length > 20);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Finance', exact: true }).click();
  await page.getByRole('button', { name: 'New invoice', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Invoice details', exact: true }).click();
  await page.getByRole('heading', { name: 'Your invoice details' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: /^Open / }).first().click();
  await page.getByRole('button', { name: 'Save notes', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Headquarters', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  mkdirSync(new URL('../.wrangler/screenshots/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../.wrangler/screenshots/hq-desktop.png', import.meta.url).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByText('214 leads', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile fits viewport');
  await page.screenshot({ path: new URL('../.wrangler/screenshots/hq-mobile.png', import.meta.url).pathname, fullPage: false });
  assert.deepEqual(errors, []);
  console.log('PASS: desktop and mobile login, overview, leads, business filter, outreach, finance, projects; no browser exceptions.');
} finally { await browser.close(); }
