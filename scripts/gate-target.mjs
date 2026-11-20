// The deploy gates (overlap check, visual sweep) click through every screen,
// open editors and seed rows. Run against the live database, that once marked
// a real mission done (14 Oct 2026). So they run against the demo HQ only —
// `npm run demo`, port 8790, fictional data in a local throwaway database —
// and they refuse anything else. Dev-time only; never imported by the Worker.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEMO_BASE = 'http://localhost:8790';

/** The demo's own config must keep its database local: no `"remote": true`. */
export function assertDemoConfigIsLocal(root) {
  const raw = readFileSync(resolve(root, 'wrangler.demo.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  if (/"remote"\s*:\s*true/.test(raw)) {
    throw new Error('wrangler.demo.jsonc binds a remote database; the gates refuse to run against it');
  }
}

/** Asks the server which HQ it is, with the gate's own session, and refuses
 *  unless it answers that it is the demo. */
export async function assertDemoServer(base, cookieValue) {
  let body = null;
  try {
    const res = await fetch(`${base}/api/environment`, { headers: { Cookie: `hq_session=${cookieValue}` } });
    body = res.ok ? await res.json() : null;
  } catch { /* unreachable is the same answer as "not the demo" */ }
  if (body?.demo !== true) {
    throw new Error(`${base} is not the demo HQ — the gates only run against \`npm run demo\` (port 8790), never live data`);
  }
}

/** External fonts are fetched over Andy's connection (Travel) on every page load,
 *  which kept the gates' « networkidle » from ever arriving (13 Nov). The demo
 *  falls back to system fonts; nothing the gates measure depends on the webfont. */
export async function offlineFonts(context) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  return context;
}

/** The screens converted to the phone frame (P6); each block adds its own.
 *  Shared by the phone-frame check and the accessibility check. */
export const FRAMED = ['/missions', '/', '/leads', '/finance', '/reports', '/pipeline', '/projects', '/admin', '/p/arbor'];
