// A revisit answers at once; a write forgets everything (Andy in Lima, 3 Nov).
import { describe, it, expect, beforeEach } from 'vitest';
import { apiFetch, enableApiCache, clearApiCache } from '../src/public/assets/api.js';

globalThis.window ??= { dispatchEvent() {} };
globalThis.CustomEvent ??= class {};
let answer; let calls;
const tick = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => {
  enableApiCache(); clearApiCache(); calls = 0; answer = 1;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ n: answer }), { status: 200 }); };
});

describe('the read cache', () => {
  it('returns the last answer at once and refreshes behind it', async () => {
    expect(await apiFetch('/api/missions')).toEqual({ n: 1 });
    answer = 2;
    expect(await apiFetch('/api/missions')).toEqual({ n: 1 }); // instantly, the last one
    await tick(); await tick();
    expect(calls).toBe(2);
    expect(await apiFetch('/api/missions')).toEqual({ n: 2 }); // the next visit has the fresh one
  });

  it('gives each caller its own copy', async () => {
    (await apiFetch('/api/missions')).n = 99;
    expect((await apiFetch('/api/missions')).n).toBe(1);
  });

  it('forgets everything after a write', async () => {
    await apiFetch('/api/missions');
    answer = 3;
    await apiFetch('/api/missions/1', { method: 'PATCH', body: '{}' });
    expect(await apiFetch('/api/missions')).toEqual({ n: 3 });
  });

  it('a read still running when a write lands does not fill the cache with old data', async () => {
    const old = apiFetch('/api/missions');
    await apiFetch('/api/missions/1', { method: 'PATCH', body: '{}' });
    await old;
    answer = 4;
    expect(await apiFetch('/api/missions')).toEqual({ n: 4 });
  });

  it.each(['/api/status', '/api/finance/invoices/159', '/api/projects/x/meta', '/api/prospects/1/onboarding', '/api/leads/a/compose?lang=FR', '/api/finance/orders/3'])('always reads %s fresh', async (url) => {
    await apiFetch(url); answer = 5;
    expect(await apiFetch(url)).toEqual({ n: 5 });
  });

  it.each(['/api/missions?slug=x', '/api/finance/invoices?status=overdue', '/api/finance/projects/alexis', '/api/leads'])('keeps the list %s', async (url) => {
    await apiFetch(url); answer = 5;
    expect(await apiFetch(url)).toEqual({ n: 1 });
  });

  it('a lead-state write patches that row in the cached Leads list and forgets the rest', async () => {
    const list = { leads: [{ uid: 'd/a', stage: 'new', payload: '{"evidence":"x"}' }, { uid: 'd/b', stage: 'new', payload: '{}' }] };
    globalThis.fetch = async (url) => {
      calls += 1;
      if (url === '/api/leads') return new Response(JSON.stringify(list), { status: 200 });
      if (url.endsWith('/state')) return new Response(JSON.stringify({ lead: { uid: 'd/a', stage: 'looked', payload: '{"pitch":"long"}' } }), { status: 200 });
      return new Response(JSON.stringify({ n: answer }), { status: 200 });
    };
    await apiFetch('/api/leads');
    await apiFetch('/api/missions');
    await apiFetch('/api/leads/d/a/state', { method: 'PATCH', body: '{}' });
    const before = calls;
    const cached = await apiFetch('/api/leads');
    expect(cached.leads[0]).toEqual({ uid: 'd/a', stage: 'looked', payload: '{"evidence":"x"}' }); // its trimmed payload stays
    expect(cached.leads[1].stage).toBe('new');
    await tick(); await tick();
    answer = 7;
    expect(await apiFetch('/api/missions')).toEqual({ n: 7 }); // the other reads were forgotten
    expect(calls).toBeGreaterThan(before);
  });

  it('a read-only POST forgets nothing', async () => {
    await apiFetch('/api/missions');
    answer = 8;
    await apiFetch('/api/leads/opens', { method: 'POST', readOnly: true, body: '{}' });
    expect(await apiFetch('/api/missions')).toEqual({ n: 1 });
  });
});


describe('policy errors', () => {
  it('preserves suppression errors without ending the session', async () => {
    let ended = 0;
    const previous = window.dispatchEvent;
    window.dispatchEvent = () => { ended += 1; };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'This address is suppressed' }), { status: 403 });
    try {
      await expect(apiFetch('/api/gmail/drafts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403, message: 'This address is suppressed' });
      expect(ended).toBe(0);
    } finally { window.dispatchEvent = previous; }
  });
});
