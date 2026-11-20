// Screenshots for the demo's site card: three fictional landing pages,
// rendered rather than captured, because the projects they belong to do not
// exist. Written to src/public/assets/shots/<slug>.jpg, the same place the
// real ones live (npm run shots).
//   node scripts/demo-shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src/public/assets/shots');
mkdirSync(out, { recursive: true });

const page = (title, body) => `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400&display=swap">
<style>
  *{box-sizing:border-box;margin:0}
  body{font:16px/1.5 'Instrument Sans',system-ui,sans-serif;background:#fff;color:#12140f}
  .bar{display:flex;align-items:center;justify-content:space-between;padding:22px 48px;border-bottom:1px solid #eceae4}
  .bar b{font-size:17px;letter-spacing:-.02em}
  .bar nav{display:flex;gap:26px;font-size:14px;color:#6b6b62}
  .bar nav span:first-child{color:#12140f}
  .wrap{padding:74px 48px 0;max-width:1280px}
  h1{font-size:60px;line-height:1.04;letter-spacing:-.035em;font-weight:400;max-width:15ch}
  h1 em{font-style:italic}
  p.lede{margin-top:22px;font-size:17px;color:#55554d;max-width:52ch}
  .cta{margin-top:30px;display:flex;gap:14px;align-items:center}
  .btn{background:#12140f;color:#fff;border-radius:999px;padding:13px 26px;font-size:14px}
  .link{font-size:14px;color:#55554d;text-decoration:underline;text-underline-offset:4px}
  .strip{margin-top:60px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .tile{height:210px;border-radius:14px}
  .mono{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8b8b81}
</style>${body}`;

const SITES = [
  {
    slug: 'kestrel-studio',
    html: page('Kestrel', `<div class="bar"><b>Kestrel Studio.</b><nav><span>Home</span><span>About</span><span>Work</span><span>Contact</span></nav></div>
      <div class="wrap"><p class="mono">Brussels · since 2021</p>
      <h1 style="margin-top:14px">Websites that <em>earn</em> the second visit.</h1>
      <p class="lede">A small studio designing and building multilingual websites and web apps for practices and studios across the Benelux — design, development, content and launch.</p>
      <div class="cta"><span class="btn">Start a project</span><span class="link">See the work</span></div>
      <div class="strip"><div class="tile" style="background:linear-gradient(150deg,#1d2a24,#33473c)"></div><div class="tile" style="background:linear-gradient(150deg,#e8e3d8,#cfc7b6)"></div><div class="tile" style="background:linear-gradient(150deg,#2a3340,#48586b)"></div></div></div>`),
  },
  {
    slug: 'fieldnote',
    html: page('Fieldnote', `<div class="bar"><b>Fieldnote</b><nav><span>Work</span><span>Reel</span><span>Rates</span><span>Contact</span></nav></div>
      <div class="wrap"><p class="mono">Creator · NL / FR / EN</p>
      <h1 style="margin-top:14px">Short video that <em>looks</em> like the brand.</h1>
      <p class="lede">Talking head, product demo, unboxing and tutorial — written, shot, lit and edited in house, delivered in three languages from a single shoot day.</p>
      <div class="cta"><span class="btn">Book a shoot</span><span class="link">Watch the reel</span></div>
      <div class="strip"><div class="tile" style="background:linear-gradient(150deg,#3a2a2a,#6d4b3f)"></div><div class="tile" style="background:linear-gradient(150deg,#1f1f22,#3d3d45)"></div><div class="tile" style="background:linear-gradient(150deg,#d9cfc2,#b6a794)"></div></div></div>`),
  },
  {
    slug: 'arbor',
    html: page('Arbor', `<div class="bar"><b>Arbor</b><nav><span>Product</span><span>Pricing</span><span>Docs</span><span>Sign in</span></nav></div>
      <div class="wrap"><p class="mono">A reading list your team actually reads</p>
      <h1 style="margin-top:14px">Everything worth reading, in <em>one</em> shelf.</h1>
      <p class="lede">Arbor collects what your team is reading, keeps the good parts, and sends one digest a week. No feed, no notifications, no unread count.</p>
      <div class="cta"><span class="btn">Try it free</span><span class="link">See a sample digest</span></div>
      <div class="strip"><div class="tile" style="background:linear-gradient(150deg,#16302a,#2c5a4a)"></div><div class="tile" style="background:linear-gradient(150deg,#eee9df,#d6cfc0)"></div><div class="tile" style="background:linear-gradient(150deg,#242a33,#3f4a59)"></div></div></div>`),
  },
];

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
for (const site of SITES) {
  await tab.setContent(site.html, { waitUntil: 'networkidle' });
  await tab.waitForTimeout(700);
  await tab.screenshot({ path: resolve(out, `${site.slug}.jpg`), type: 'jpeg', quality: 78 });
  console.log('shot', site.slug);
}
await browser.close();
