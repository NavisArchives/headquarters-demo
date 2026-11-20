import { describe, it, expect } from 'vitest';
import { handleServices, macBridge } from '../src/worker/api/services.js';

/** A fetch that records what would have gone to the Mac. */
function fakeFetch(handler = () => jsonResponse({})) {
  const calls = [];
  const impl = async (target, init = {}) => {
    calls.push({
      url: String(target),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ?? null,
    });
    return handler(String(target), init);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const BRIDGE = 'http://127.0.0.1:8765';

/** A registry with one runnable service and one launchd-owned one. */
const REGISTRY = [
  {
    slug: 'marc-aubin',
    local: {
      path: '/tmp/axel',
      services: [
        { id: 'site', label: 'Site', run: ['npm', 'run', 'dev'], port: 4330 },
        { id: 'tunnel', label: 'Tunnel', run: ['./tools/admin.sh'], port: 4180, manual: true },
      ],
    },
    links: { local: { url: 'http://localhost:4330', service: 'site' } },
  },
];

/** A KV stub that records what was dropped. */
function fakeKv() {
  const deleted = [];
  return { deleted, async delete(key) { deleted.push(key); } };
}

function call(method, path, { env = {}, fetchImpl, headers = {}, ctx } = {}) {
  const target = `https://hq.example.com${path}`;
  const request = new Request(target, { method, headers: { Cookie: 'hq_session=secret', ...headers } });
  return handleServices(request, env, new URL(target), REGISTRY, { fetchImpl, ctx });
}

describe('macBridge', () => {
  it('reads the bridge URL out of the environment and nowhere else', () => {
    expect(macBridge({ GMAIL_BRIDGE: BRIDGE }).origin).toBe(BRIDGE);
    expect(macBridge({})).toBe(null);
    expect(macBridge({ GMAIL_BRIDGE: 'file:///etc/passwd' })).toBe(null);
  });
});

describe('/api/services', () => {
  it('leaves other paths alone', async () => {
    expect(await call('GET', '/api/status')).toBe(null);
    expect(await call('GET', '/api/servicesomething')).toBe(null);
  });

  it('answers 503 "needs the Mac" with no bridge configured', async () => {
    const fetchImpl = fakeFetch();
    const response = await call('GET', '/api/services', { fetchImpl });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'needs the Mac', running: false });
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('forwards the list and sends no cookie', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ services: [] }));
    const response = await call('GET', '/api/services', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(response.status).toBe(200);
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/services`);
    expect(JSON.stringify(fetchImpl.calls[0].headers)).not.toMatch(/cookie|hq_session/i);
  });

  it('never reaches the bridge for an unknown slug or service name', async () => {
    const fetchImpl = fakeFetch();
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    for (const path of [
      '/api/services/nope/site/start',
      '/api/services/marc-aubin/nope/start',
      '/api/services/marc-aubin/site/deploy',
      '/api/services/marc-aubin/site',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await call('POST', path, { env, fetchImpl });
      expect(response.status, path).toBe(404);
    }
    expect(fetchImpl.calls).toHaveLength(0);
    expect(env.STATUS.deleted).toHaveLength(0);
  });

  it('refuses a manual service without asking the Mac', async () => {
    const fetchImpl = fakeFetch();
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    const response = await call('POST', '/api/services/marc-aubin/tunnel/start', { env, fetchImpl });
    expect(response.status).toBe(409);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('sends only the registry names in the body, and drops the status cache', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ running: true, pid: 321 }));
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    const response = await call('POST', '/api/services/marc-aubin/site/start', { env, fetchImpl });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ running: true, pid: 321 });
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/services/start`);
    expect(fetchImpl.calls[0].method).toBe('POST');
    expect(JSON.parse(fetchImpl.calls[0].body)).toEqual({ slug: 'marc-aubin', name: 'site' });
    expect(fetchImpl.calls[0].headers.Origin).toBe(BRIDGE);
    expect(env.STATUS.deleted).toEqual(['status:v1']);
  });

  it('relays the bridge\'s own refusals verbatim', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: 'HQ did not start this' }, 409));
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    const response = await call('POST', '/api/services/marc-aubin/site/stop', { env, fetchImpl });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'HQ did not start this' });
  });

  it('answers 503 when the bridge is not running', async () => {
    const fetchImpl = fakeFetch(() => { throw new Error('connection refused'); });
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    const response = await call('POST', '/api/services/marc-aubin/site/stop', { env, fetchImpl });
    expect(response.status).toBe(503);
    // A call that never landed leaves the cache alone.
    expect(env.STATUS.deleted).toHaveLength(0);
  });

  it('caps the log tail and passes the names as query parameters', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ lines: [] }));
    const env = { GMAIL_BRIDGE: BRIDGE };
    await call('GET', '/api/services/marc-aubin/site/logs?lines=9999', { env, fetchImpl });
    expect(fetchImpl.calls[0].url)
      .toBe(`${BRIDGE}/api/services/logs?slug=marc-aubin&name=site&lines=400`);
  });

  it('allows only the verb each route is for', async () => {
    const env = { GMAIL_BRIDGE: BRIDGE, STATUS: fakeKv() };
    const fetchImpl = fakeFetch();
    expect((await call('GET', '/api/services/marc-aubin/site/start', { env, fetchImpl })).status).toBe(405);
    expect((await call('POST', '/api/services/marc-aubin/site/logs', { env, fetchImpl })).status).toBe(405);
    expect((await call('POST', '/api/services', { env, fetchImpl })).status).toBe(405);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
