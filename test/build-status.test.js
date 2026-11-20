import { describe, it, expect } from 'vitest';
import { buildStatus, getStatus } from '../src/worker/status.js';

const registry = [
  { slug: 'realis-studio', status: { probe: 'http', worker: 'realis-studio' },
    links: { live: { url: 'https://realis.example' } } },
  { slug: 'marc-aubin', status: { probe: 'local' }, links: {} },
  { slug: 'victor-lemaire', status: { probe: 'none' }, links: {} },
];

const env = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' };

function fakeFetch(handlers) {
  return async (url, init) => {
    for (const [match, respond] of handlers) {
      if (String(url).includes(match)) return respond(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('buildStatus', () => {
  it('probes http projects and folds in the deploy time', async () => {
    const fetchImpl = fakeFetch([
      ['realis.example', async () => new Response(null, { status: 200 })],
      ['workers/scripts', async () => new Response(JSON.stringify({
        result: [{ id: 'realis-studio', modified_on: '2026-09-18T10:00:00Z' }],
      }))],
    ]);
    const status = await buildStatus(registry, env, { fetchImpl });
    expect(status.projects['realis-studio']).toMatchObject({
      kind: 'up', label: 'Live', deployed: '2026-09-18T10:00:00Z',
    });
  });

  it('marks local projects unknown until the agent exists', async () => {
    const fetchImpl = fakeFetch([
      ['realis.example', async () => new Response(null, { status: 200 })],
      ['workers/scripts', async () => new Response(JSON.stringify({ result: [] }))],
    ]);
    const status = await buildStatus(registry, env, { fetchImpl });
    expect(status.projects['marc-aubin']).toMatchObject({ kind: 'unknown', label: 'Local only' });
  });

  it('marks none-probe projects as not set up', async () => {
    const fetchImpl = fakeFetch([
      ['realis.example', async () => new Response(null, { status: 200 })],
      ['workers/scripts', async () => new Response(JSON.stringify({ result: [] }))],
    ]);
    const status = await buildStatus(registry, env, { fetchImpl });
    expect(status.projects['victor-lemaire']).toMatchObject({ kind: 'none', label: 'Not set up' });
  });

  it('still returns every project when every probe fails', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    const status = await buildStatus(registry, env, { fetchImpl });
    expect(Object.keys(status.projects)).toHaveLength(3);
    expect(status.projects['realis-studio'].kind).toBe('unknown');
  });
});

describe('getStatus', () => {
  function fakeKv() {
    const store = new Map();
    return {
      store,
      get: async (key, type) => (store.has(key) ? (type === 'json' ? JSON.parse(store.get(key)) : store.get(key)) : null),
      put: async (key, value) => { store.set(key, value); },
    };
  }
  const ctx = { waitUntil: () => {} };

  it('serves a cached payload without any outbound fetch', async () => {
    const STATUS = fakeKv();
    STATUS.store.set('status:v1', JSON.stringify({ checkedAt: '2026-09-20T00:00:00Z', projects: {}, leads: null }));
    let called = false;
    const fetchImpl = async () => { called = true; return new Response('{}'); };
    const status = await getStatus(registry, { ...env, STATUS }, ctx, { fetchImpl });
    expect(status.checkedAt).toBe('2026-09-20T00:00:00Z');
    expect(called).toBe(false);
  });

  it('writes the payload to KV on a miss', async () => {
    const STATUS = fakeKv();
    const fetchImpl = async () => new Response(JSON.stringify({ result: [] }), { status: 200 });
    await getStatus(registry, { ...env, STATUS }, ctx, { fetchImpl });
    expect(STATUS.store.has('status:v1')).toBe(true);
  });
});
