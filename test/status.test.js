import { describe, it, expect } from 'vitest';
import { probeHttp, fetchDeployTimes, fetchLeadsSummary } from '../src/worker/status.js';

const respondWith = (status) => async () => new Response(null, { status });

describe('probeHttp', () => {
  it('reports a 200 as up', async () => {
    const result = await probeHttp('https://example.com', { fetchImpl: respondWith(200) });
    expect(result.kind).toBe('up');
    expect(result.code).toBe(200);
  });

  it('treats a 401 as up, because the worker answered', async () => {
    const result = await probeHttp('https://example.com', { fetchImpl: respondWith(401) });
    expect(result.kind).toBe('up');
  });

  it('reports a 500 as down', async () => {
    const result = await probeHttp('https://example.com', { fetchImpl: respondWith(500) });
    expect(result.kind).toBe('down');
  });

  it('reports a timeout as unknown, not down', async () => {
    const hang = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    const result = await probeHttp('https://example.com', { fetchImpl: hang, timeoutMs: 10 });
    expect(result.kind).toBe('unknown');
    expect(result.detail).toBe('no answer in 10 ms');
  });

  it('reports a network error as unknown', async () => {
    const boom = async () => { throw new Error('dns failure'); };
    const result = await probeHttp('https://example.com', { fetchImpl: boom });
    expect(result).toMatchObject({ kind: 'unknown', detail: 'dns failure' });
  });
});

describe('fetchDeployTimes', () => {
  const env = { CF_API_TOKEN: 'token', CF_ACCOUNT_ID: 'acct' };

  it('maps worker names to modified_on', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      result: [
        { id: 'realis-studio', modified_on: '2026-09-18T10:00:00Z' },
        { id: 'andyssarchives', modified_on: '2026-09-20T08:30:00Z' },
      ],
    }));
    expect(await fetchDeployTimes(env, fetchImpl)).toEqual({
      'realis-studio': '2026-09-18T10:00:00Z',
      'andyssarchives': '2026-09-20T08:30:00Z',
    });
  });

  it('returns an empty map when the token is missing', async () => {
    let called = false;
    await fetchDeployTimes({}, async () => { called = true; return new Response('{}'); });
    expect(called).toBe(false);
  });

  it('returns an empty map when the API rejects the token', async () => {
    const fetchImpl = async () => new Response('forbidden', { status: 403 });
    expect(await fetchDeployTimes(env, fetchImpl)).toEqual({});
  });

  it('returns an empty map when the API call throws', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    expect(await fetchDeployTimes(env, fetchImpl)).toEqual({});
  });
});

describe('fetchLeadsSummary', () => {
  const env = { LEADS_SUMMARY_URL: 'https://leads.example/api/summary', LEADS_SUMMARY_SECRET: 's3cret' };

  it('sends the shared secret and returns the body', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = init.headers['X-HQ-Secret'];
      return new Response(JSON.stringify({ total: 183 }));
    };
    expect(await fetchLeadsSummary(env, fetchImpl)).toEqual({ total: 183 });
    expect(seen).toBe('s3cret');
  });

  it('returns null when the endpoint rejects the secret', async () => {
    const fetchImpl = async () => new Response('no', { status: 401 });
    expect(await fetchLeadsSummary(env, fetchImpl)).toBeNull();
  });

  it('returns null when the endpoint is unreachable', async () => {
    const fetchImpl = async () => { throw new Error('offline'); };
    expect(await fetchLeadsSummary(env, fetchImpl)).toBeNull();
  });
});
