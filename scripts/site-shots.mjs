// Screenshots of every project's live site for the home screen's site card.
// Run by hand (npm run shots) — the Worker never imports this; the images
// are committed under src/public/assets/shots/ like any other asset.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(resolve(root, 'projects.json'), 'utf8'));
const out = resolve(root, 'src/public/assets/shots');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const project of registry) {
  const url = project.links?.live?.url;
  if (!url) continue;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: resolve(out, `${project.slug}.jpg`), type: 'jpeg', quality: 78 });
    console.log('shot', project.slug);
  } catch (error) {
    console.log('skip', project.slug, error.message.split('\n')[0]);
  }
}
await browser.close();
