// Compose the visual-pass screenshots into two contact sheets, by rendering
// a plain page of <img>s in the same headless Chromium and screenshotting
// it. No image library, no new dependency.
import { chromium } from 'playwright';
import { readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] || resolve(root, '.superpowers/sdd/2026-09-20-hq-dashboard/screens');

const LABEL = {
  home: '/', projects: '/projects', 'p-andyssarchives': '/p/andyssarchives',
  missions: '/missions', leads: '/leads', 'leads-popup': '/leads · popup',
  finance: '/finance', admin: '/admin', login: '/login',
};
const ORDER = ['home', 'projects', 'p-andyssarchives', 'missions', 'leads', 'leads-popup', 'finance', 'admin', 'login'];

function sheet(width, columns, thumbWidth, cap) {
  const cards = ORDER
    .filter((name) => existsSync(`${DIR}/${name}-${width}.png`))
    .map((name) => `
      <figure>
        <div class="shot"><img src="./${name}-${width}.png" alt=""></div>
        <figcaption>${LABEL[name]}<span>${width}px</span></figcaption>
      </figure>`).join('');
  return `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; --ink:#E6EEE8; --muted:#8A9C90; --line:#27332B; --card:#18211C; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px; background: #101613; color: var(--ink);
    font: 14px/1.45 'Instrument Sans', ui-sans-serif, system-ui, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: -.02em; }
  p.sub { margin: 0 0 22px; font-size: 13px; color: var(--muted); }
  .sheet { display: grid; grid-template-columns: repeat(${columns}, ${thumbWidth}px); gap: 22px; }
  figure { margin: 0; }
  .shot {
    max-height: ${cap}px; overflow: hidden; border: 1px solid var(--line);
    border-radius: 10px; background: var(--card);
  }
  .shot img { display: block; width: 100%; height: auto; }
  figcaption {
    display: flex; justify-content: space-between; gap: 8px; align-items: baseline;
    margin-top: 7px; font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 12px;
  }
  figcaption span { color: var(--muted); }
</style>
<body>
  <h1>HQ — every screen at ${width}px</h1>
  <p class="sub">Dark is the only theme. Tall pages are cropped to their first ${cap}px; the full PNG is beside this sheet.</p>
  <div class="sheet">${cards}</div>
</body>`;
}

const browser = await chromium.launch();
for (const [width, columns, thumb, cap, out] of [
  [1280, 3, 380, 620, 'contact-desktop.png'],
  [390, 6, 180, 620, 'contact-phone.png'],
]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  // Written next to the PNGs so the <img src> are plain relative paths: a
  // file:// page may not reach a file:// image by absolute URL.
  const tmp = `${DIR}/.contact-${width}.html`;
  writeFileSync(tmp, sheet(width, columns, thumb, cap));
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null))));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${out}`, fullPage: true });
  console.log(`${DIR}/${out}`);
  await page.close();
  rmSync(tmp);
}
await browser.close();
console.log(readdirSync(DIR).filter((f) => f.endsWith('.png')).length + ' PNGs in ' + DIR);
