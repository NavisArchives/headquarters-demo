// Nothing typed is lost, and HQ says plainly when it is offline (audit D15, D16).
import { describe, it, expect, beforeEach } from 'vitest';
import { installDom } from './dom-shim.js';

installDom();
const mem = new Map();
globalThis.localStorage = {
  get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
};
const { keepDraft, readDraft, pendingDrafts } = await import('../src/public/assets/drafts.js');
const { offlineMessage, apiFetch, ApiError, REQUEST_TIMEOUT_MS } = await import('../src/public/assets/api.js');

const field = (value = '') => { const listeners = []; return { value, addEventListener: (t, fn) => listeners.push(fn), fire(v) { this.value = v; for (const fn of listeners) fn(); } }; };

beforeEach(() => mem.clear());

describe('drafts', () => {
  it('keeps what is typed, brings it back, and forgets it once saved', () => {
    const a = field('');
    keepDraft(a, 'project-notes:x', { serverValue: 'old' });
    a.fire('half-typed call note');
    expect(readDraft('project-notes:x')).toBe('half-typed call note');
    // Another screen, a reload: a new field for the same thing.
    const b = field('old');
    const kept = keepDraft(b, 'project-notes:x', { serverValue: 'old' });
    expect(kept.restored).toBe(true);
    expect(b.value).toBe('half-typed call note');
    kept.saved();
    expect(readDraft('project-notes:x')).toBeNull();
    expect(pendingDrafts()).toEqual([]);
  });

  it('drops a draft that matches what the server already holds', () => {
    const a = field('same');
    keepDraft(a, 'k', { serverValue: 'same' });
    a.fire('same');
    expect(readDraft('k')).toBeNull();
  });
});

describe('a request with no connection', () => {
  it('says what happened in plain words', () => {
    expect(offlineMessage(new TypeError('Failed to fetch'), false)).toMatch(/^No connection: nothing was saved/);
    expect(offlineMessage(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toMatch(/^No answer after 15 s/);
    expect(offlineMessage(new TypeError('Failed to fetch'), true)).toMatch(/^HQ could not be reached/);
    expect(REQUEST_TIMEOUT_MS).toBe(15000);
  });

  it('turns a network failure into that message', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await expect(apiFetch('/api/todos', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiError);
    await expect(apiFetch('/api/todos', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/nothing was saved/) });
  });

  it('gives up on a hung request instead of waiting forever', async () => {
    globalThis.fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const realSet = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => realSet(fn, 0); // the 15 s, now
    try {
      await expect(apiFetch('/api/todos', { method: 'POST', body: '{}' })).rejects.toMatchObject({ message: expect.stringMatching(/^No answer after 15 s/) });
    } finally { globalThis.setTimeout = realSet; }
  });
});
