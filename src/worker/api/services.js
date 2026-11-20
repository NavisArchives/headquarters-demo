import { localServices } from '../../shared/registry.js';
import { invalidateStatus } from '../status.js';

/* ------------------------------------------------------------------------
 * Local services, through the Mac.
 *
 * The dev servers on this computer are started and stopped by the bridge
 * (modules/leads/tools/serve.py), which reads projects.json itself and runs
 * only what that registry carries. HQ forwards; it never names a command.
 *
 * Two guards live here, before anything leaves the Worker:
 *   - the slug and service name are checked against the same registry the
 *     bridge reads, so an unknown pair is a 404 that never reaches the Mac;
 *   - `manual: true` services — launchd's, or a human's — are refused.
 *
 * Without a bridge (the deployed Worker cannot reach 127.0.0.1) every route
 * answers 503 `{ error: 'needs the Mac' }`, a state the screen can show.
 * --------------------------------------------------------------------- */

const PREFIX = '/api/services';
const BRIDGE_TIMEOUT_MS = 30_000; // a start waits up to 20 s for the port
const LOGS_MAX = 400;

/**
 * Where the Mac bridge lives. It is the same local server Gmail already goes
 * through, so it keeps its variable name; every reader goes through here, so
 * renaming GMAIL_BRIDGE to MAC_BRIDGE later is this one line.
 */
export function macBridge(env) {
  // The demo shares .dev.vars with the local HQ: it must never reach the real
  // Mac (fictional data only), and must not wait 30 s on it (the gates' timeouts, 13 Nov).
  if (env?.DEMO === 'on') return null;
  const raw = typeof env?.GMAIL_BRIDGE === 'string' ? env.GMAIL_BRIDGE.trim() : '';
  if (!raw) return null;
  let base;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  return base.protocol === 'http:' || base.protocol === 'https:' ? base : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const needsTheMac = () => json({ error: 'needs the Mac', running: false }, 503);
const bridgeDown = () => json({ error: 'the Mac bridge is not running', running: false }, 503);
const unreadable = () => json({ error: 'the Mac bridge sent something unreadable', running: false }, 502);

/**
 * One call to the bridge. Sends JSON and nothing else: no HQ session cookie,
 * no Access header, no client header of any kind. The Origin is derived from
 * the configured bridge URL — serve.py insists on a local one.
 */
async function callBridge(base, path, { method, body = null, fetchImpl, timeoutMs }) {
  const target = new URL(path, base).toString();
  const headers = {};
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = base.origin;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      method, headers, body, redirect: 'manual', signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    return { status: response.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function relay(result) {
  if (!result) return bridgeDown();
  if (result.data === null) return unreadable();
  return json(result.data, result.status);
}

/** The registry entry these two names address, or null. */
function serviceFor(registry, slug, name) {
  return localServices(registry).find((s) => s.slug === slug && s.name === name) ?? null;
}

/**
 * Handle /api/services*. Returns null when the path belongs to someone else.
 * `fetchImpl` is injected the way status.js and gmail.js inject it, so a test
 * can watch exactly what would be sent to the Mac.
 */
export async function handleServices(request, env, url, registry, {
  fetchImpl = fetch, timeoutMs = BRIDGE_TIMEOUT_MS, ctx = null,
} = {}) {
  const { pathname } = url;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;

  const rest = pathname.slice(PREFIX.length).replace(/^\//, '');
  const parts = rest ? rest.split('/') : [];

  // GET /api/services — the whole list.
  if (parts.length === 0) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const base = macBridge(env);
    if (!base) return needsTheMac();
    return relay(await callBridge(base, '/api/services', { method: 'GET', fetchImpl, timeoutMs }));
  }

  // Everything else addresses one service: /api/services/<slug>/<name>/<verb>
  if (parts.length !== 3) return json({ error: 'not found' }, 404);
  const [slug, name, verb] = parts;
  if (!['start', 'stop', 'logs'].includes(verb)) return json({ error: 'not found' }, 404);

  // Checked against the registry BEFORE anything is proxied: an unknown pair
  // never reaches the Mac at all.
  const service = serviceFor(registry, slug, name);
  if (!service) return json({ error: 'no such service' }, 404);

  if (verb === 'logs') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const base = macBridge(env);
    if (!base) return needsTheMac();
    const asked = Number(url.searchParams.get('lines'));
    const lines = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), LOGS_MAX) : 80;
    const query = `?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}&lines=${lines}`;
    return relay(await callBridge(base, `/api/services/logs${query}`, { method: 'GET', fetchImpl, timeoutMs }));
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (service.manual) {
    return json({ error: 'this service is started by hand, not by HQ' }, 409);
  }
  const base = macBridge(env);
  if (!base) return needsTheMac();

  const result = await callBridge(base, `/api/services/${verb}`, {
    method: 'POST',
    // The body is built here from the registry's own names, not forwarded.
    body: JSON.stringify({ slug, name }),
    fetchImpl,
    timeoutMs,
  });

  // Whatever happened, the Local pill is now out of date: drop the cached
  // status so the next read probes again instead of serving a stale five
  // minutes of "stopped".
  if (result && result.status < 500) await invalidateStatus(env, ctx);

  return relay(result);
}
