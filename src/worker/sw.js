// GET /sw.js — HQ's service worker, built per request from this release's
// asset manifest (scripts/sw-manifest.mjs, written by the release) and the two
// files in /assets: sw-route.js (the routing table) and sw-core.js (the rest).
// Public on purpose: the kill switch must reach a phone that is signed out,
// and the script holds code and file names only.
//
//   no manifest (dev, the demo, tests)  → 404: nothing registers
//   SW_OFF = "1"                        → a worker that empties every HQ cache
//                                          and unregisters itself (the kill switch)
const HEADERS = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' };

// It never reloads the page: the page would register /sw.js again, get this
// script again, and reload again. A page it controlled just uses the network.
export const KILL_SCRIPT = `/* HQ's service worker is switched off (SW_OFF): empty every HQ cache, then go. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('hq-')) await caches.delete(key);
  await self.registration.unregister();
})()));
`;

/** The script: constants, the routing table without its exports, the core. */
export function buildServiceWorker(manifest, routeSource, coreSource) {
  const files = manifest.files.map((f) => ({ path: f.path }));
  return `/* HQ service worker · release ${manifest.version} */
const VERSION = ${JSON.stringify(manifest.version)};
const FILES = ${JSON.stringify(files)};
${routeSource.replace(/^export /gm, '')}
${coreSource}`;
}

async function asset(env, url, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url)));
  return res.ok ? res : null;
}

export async function handleServiceWorker(request, env, url) {
  if (url.pathname !== '/sw.js') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  if (env.SW_OFF === '1') return new Response(KILL_SCRIPT, { headers: HEADERS });
  const manifestRes = await asset(env, url, '/asset-manifest.json');
  if (!manifestRes) return new Response('no service worker in this build', { status: 404, headers: { 'Cache-Control': 'no-cache' } });
  const [manifest, route, core] = await Promise.all([
    manifestRes.json(), asset(env, url, '/assets/sw-route.js'), asset(env, url, '/assets/sw-core.js'),
  ]);
  if (!route || !core) return new Response('service worker files missing', { status: 500 });
  const body = buildServiceWorker(manifest, await route.text(), await core.text());
  return new Response(body, { headers: { ...HEADERS, 'X-HQ-Release': manifest.version } });
}
