// The page's side of HQ's service worker (design approved 14 Nov).
//   - registers /sw.js on the live HQ only (or locally when a test opts in);
//   - a new release waits until « HQ was updated · Reload »: that Reload is the
//     only thing that switches, so a page never mixes two releases;
//   - /?sw=off on a device unregisters and empties every HQ cache there;
//   - sign-out and an ended session empty the offline copy of Home's data;
//   - data the worker served from that copy says how old it is, once.
const LIVE_HOST = 'hq.example.com';
const DEV_FLAG = 'hq.sw.dev'; // localStorage: lets the local test run register

function allowed() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (location.hostname === LIVE_HOST) return true;
  try { return localStorage.getItem(DEV_FLAG) === '1'; } catch { return false; }
}

/** Empty the offline copy of Home's data (sign-out, an ended session). */
export async function forgetOfflineData() {
  try { if (typeof caches !== 'undefined') await caches.delete('hq-data'); } catch { /* nothing kept */ }
  try { navigator.serviceWorker?.controller?.postMessage('signout'); } catch { /* no worker */ }
}

/** The kill switch on one device: /?sw=off. */
async function switchOff() {
  // First tell the running worker to store nothing more, so no late answer refills a cache.
  try { navigator.serviceWorker.controller?.postMessage('stop'); } catch { /* none running */ }
  for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  if (typeof caches !== 'undefined') for (const key of await caches.keys()) if (key.startsWith('hq-')) await caches.delete(key);
  try { localStorage.removeItem(DEV_FLAG); } catch { /* fine */ }
}

let offlineSaid = false;
/** Called by api.js for each response: data from the offline copy says its age, once. */
export function noteOfflineCopy(response) {
  const since = response?.headers?.get?.('X-HQ-Offline-Since');
  if (!since || offlineSaid || typeof window === 'undefined') return;
  offlineSaid = true;
  window.dispatchEvent(new CustomEvent('hq:offline-copy', { detail: { since } }));
}

/** « Offline · showing what HQ had at 14 Nov, 09:12 » */
export function offlineCopyMessage(since) {
  const when = new Date(since).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Offline · showing what HQ had at ${when}`;
}

export async function registerServiceWorker({ toast } = {}) {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  window.addEventListener('hq:offline-copy', (event) => toast?.(offlineCopyMessage(event.detail.since)));
  if (await switchingOff) return null;
  try {
    if (sessionStorage.getItem('hq.sw.said') === 'off') { sessionStorage.removeItem('hq.sw.said'); toast?.('Offline mode is off on this device'); }
  } catch { /* fine */ }
  if (!allowed()) return null;
  let reg;
  try { reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }

  let asked = false;
  const offer = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) return; // the first install needs no reload
    toast?.('HQ was updated', { action: { label: 'Reload', onClick: () => { asked = true; worker.postMessage('skipWaiting'); } } });
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) location.reload(); });
  if (reg.waiting) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    next?.addEventListener('statechange', () => { if (next.state === 'installed') offer(next); });
  });
  window.addEventListener('hq:session-ended', () => { forgetOfflineData(); });
  return reg;
}

/** /?sw=off runs as soon as this module loads, before any screen starts its reads;
 *  then the page reloads without the flag, since an unregistered worker still
 *  holds the page it is on until that page goes. */
export const switchingOff = (async () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (new URLSearchParams(location.search).get('sw') !== 'off') return false;
  await switchOff();
  try { sessionStorage.setItem('hq.sw.said', 'off'); } catch { /* the toast is a nicety */ }
  location.replace(location.pathname);
  return true;
})();
