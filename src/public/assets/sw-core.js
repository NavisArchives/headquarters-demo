/* HQ's service worker (design approved by NIRMATA, 14 Nov). Not loaded as a
   page script: /sw.js serves it with VERSION, FILES and routeFor() put in
   front of it (src/worker/sw.js).

   One release, one cache: install fetches every file of this release into
   hq-shell-<VERSION>, all or nothing, and activate deletes every other release's
   cache. Pages are answered from the network first (a sign-out redirect always
   wins), but a plain 200 is answered with this release's own index.html, so a
   page and its modules always come from one release. A new release installs
   beside it and waits: the page says « HQ was updated · Reload », and only
   that Reload switches.

   Home's reads are kept for offline, with the time they were fetched, for 7
   days at most; a 401 or a sign-out empties them. Nothing is written offline. */
/* global VERSION, FILES, routeFor */
const SHELL = `hq-shell-${VERSION}`;
const DATA = 'hq-data';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    try {
      await Promise.all(FILES.map(async (file) => {
        // The shell page is served at / (the Worker redirects /index.html), and kept as /index.html.
        const from = file.path === '/index.html' ? '/' : file.path;
        const response = await fetch(from, { cache: 'reload', credentials: 'same-origin' });
        if (!response.ok || response.redirected) throw new Error(`${file.path}: ${response.status}`);
        await cache.put(file.path, response);
      }));
    } catch (error) {
      // Half a release is never used: drop it, and the previous worker stays.
      await caches.delete(SHELL);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('hq-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Switched off on this device (/?sw=off): store nothing more, keep nothing.
let stopped = false;

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'signout') event.waitUntil(caches.delete(DATA));
  if (event.data === 'stop') {
    stopped = true;
    event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith('hq-')) await caches.delete(key); })());
  }
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// Reads never open a cache: caches.open() creates one, and a cache emptied by
// sign-out or switched off must stay gone.
function fromShell(path) {
  return caches.match(path, { cacheName: SHELL });
}

async function page(request) {
  try {
    const response = await withTimeout(fetch(request), NAV_TIMEOUT_MS);
    // A redirect (to /login), a 404, a 401: the network's answer stands.
    if (response.status !== 200 || response.redirected) return response;
    return (await fromShell('/index.html')) || response;
  } catch {
    const cached = await fromShell('/index.html');
    return cached || Response.error();
  }
}

async function asset(request) {
  const path = new URL(request.url).pathname;
  return (await fromShell(path)) || fetch(request);
}

async function data(request) {
  try {
    const response = await fetch(request);
    if (response.status === 401) { await caches.delete(DATA); return response; }
    if (response.ok && !stopped) {
      const headers = new Headers(response.headers);
      headers.set('X-HQ-Fetched-At', new Date().toISOString());
      const cache = await caches.open(DATA);
      await cache.put(request, new Response(await response.clone().blob(), { status: 200, headers }));
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: DATA });
    const at = cached?.headers.get('X-HQ-Fetched-At');
    if (!cached || !at || Date.now() - Date.parse(at) > MAX_AGE_MS) return Response.error();
    const headers = new Headers(cached.headers);
    headers.set('X-HQ-Offline-Since', at);
    return new Response(await cached.blob(), { status: 200, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request, self.location.origin);
  if (route === 'shell') event.respondWith(page(event.request));
  else if (route === 'asset') event.respondWith(asset(event.request));
  else if (route === 'data') event.respondWith(data(event.request));
});

// Local notifications use safe HQ paths; no email text becomes a URL.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href=event.notification.data?.href;
  const path=typeof href==='string' && /^\/(?!\/)/.test(href) ? href : '/outreach?view=today';
  event.waitUntil(self.clients.openWindow(path));
});
