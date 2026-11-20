import { describe, it, expect } from 'vitest';
import { handlePixel } from '../src/worker/px.js';

/** A Map-backed fake KV: get/put/delete, same shape as the OPENS binding. */
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function call(path, env, headers, method = 'GET') {
  const url = new URL(`https://hq.example.com${path}`);
  const request = new Request(url, { method, headers });
  return handlePixel(request, env, url);
}

describe('routing', () => {
  it('ignores paths that are not the pixel', async () => {
    expect(await call('/api/leads', {})).toBeNull();
  });

  it('ignores a path that only looks close (no .gif, or not under /px/)', async () => {
    expect(await call('/px/abc123', {})).toBeNull();
    expect(await call('/pixel/abc123.gif', {})).toBeNull();
  });
});

describe('GET /px/<token>.gif', () => {
  it('records an open for a known token and returns the gif', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
    });
    const res = await call('/px/abc123.gif', { OPENS: kv });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/gif');
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x47); // 'G' of GIF89a
    expect(bytes[bytes.length - 1]).toBe(0x3b); // GIF trailer

    const opens = JSON.parse(kv.store.get('opens:ugc-brands-agencies/babbel'));
    expect(opens).toHaveLength(1);
    expect(() => new Date(opens[0]).toISOString()).not.toThrow();
  });

  it('appends to existing opens rather than overwriting them', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
      'opens:ugc-brands-agencies/babbel': JSON.stringify(['2026-09-20T01:00:00.000Z']),
    });
    await call('/px/abc123.gif', { OPENS: kv });
    const opens = JSON.parse(kv.store.get('opens:ugc-brands-agencies/babbel'));
    expect(opens).toHaveLength(2);
    expect(opens[0]).toBe('2026-09-20T01:00:00.000Z');
  });

  it('returns the byte-identical gif and headers for an unknown token, and records nothing', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
    });

    const known = await call('/px/abc123.gif', { OPENS: kv });
    const knownBytes = Array.from(new Uint8Array(await known.arrayBuffer()));
    const knownHeaders = [...known.headers].sort();

    const sizeAfterKnownHit = kv.store.size;
    const unknown = await call('/px/does-not-exist.gif', { OPENS: kv });
    const unknownBytes = Array.from(new Uint8Array(await unknown.arrayBuffer()));
    const unknownHeaders = [...unknown.headers].sort();

    expect(unknown.status).toBe(known.status);
    expect(unknownHeaders).toEqual(knownHeaders);
    expect(unknownBytes).toEqual(knownBytes);
    expect(kv.store.size).toBe(sizeAfterKnownHit); // no new key written for the unknown token
  });

  it('still returns the gif, byte for byte, when OPENS is not bound', async () => {
    const withKv = await call('/px/whatever.gif', { OPENS: fakeKv() });
    const withoutKv = await call('/px/whatever.gif', {});

    expect(withoutKv.status).toBe(200);
    expect(withoutKv.headers.get('Content-Type')).toBe('image/gif');
    expect(withoutKv.headers.get('Cache-Control')).toBe('no-store, private');
    expect(Array.from(new Uint8Array(await withoutKv.arrayBuffer())))
      .toEqual(Array.from(new Uint8Array(await withKv.arrayBuffer())));
  });

  it('works with no auth cookie and no Access header at all', async () => {
    const url = new URL('https://hq.example.com/px/whatever.gif');
    const request = new Request(url, { method: 'GET' });
    expect(request.headers.get('Cookie')).toBeNull();
    expect(request.headers.get('Cf-Access-Jwt-Assertion')).toBeNull();

    const res = await handlePixel(request, {}, url);
    expect(res.status).toBe(200);
  });

  it('returns null for POST and records nothing', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
    });
    const sizeBeforePost = kv.store.size;
    const res = await call('/px/abc123.gif', { OPENS: kv }, {}, 'POST');
    expect(res).toBeNull();
    expect(kv.store.size).toBe(sizeBeforePost);
  });

  it('keeps only the 200 most recent hits', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
      // Pre-populate with 249 hits at least 5 seconds apart
      'opens:ugc-brands-agencies/babbel': JSON.stringify(
        Array.from({ length: 249 }, (_, i) => new Date(2026, 8, 20, 0, 0, i * 5).toISOString()),
      ),
    });

    await call('/px/abc123.gif', { OPENS: kv });
    const hits = JSON.parse(kv.store.get('opens:ugc-brands-agencies/babbel'));
    expect(hits).toHaveLength(200);
    // The oldest should be gone
    expect(hits[0]).not.toBe(new Date(2026, 8, 20, 0, 0, 0).toISOString());
  });

  it('drops a hit that lands within 5 seconds of the previous one', async () => {
    const kv = fakeKv({
      'token:abc123': JSON.stringify({ uid: 'ugc-brands-agencies/babbel', sentAt: '2026-09-20T00:00:00.000Z' }),
      'opens:ugc-brands-agencies/babbel': JSON.stringify(['2026-09-20T00:00:00.000Z']),
    });

    // Simulate two hits: one at t=0, one at t=2 seconds (within 5 second window)
    const mockDate = new Date('2026-09-20T00:00:02.000Z');
    const originalDateNow = Date.now;
    global.Date.now = () => mockDate.getTime();
    global.Date = class extends Date {
      constructor(...args) {
        if (args.length === 0) return mockDate;
        return super(...args);
      }

      static now() {
        return mockDate.getTime();
      }
    };

    await call('/px/abc123.gif', { OPENS: kv });
    const hits = JSON.parse(kv.store.get('opens:ugc-brands-agencies/babbel'));
    expect(hits).toHaveLength(1); // The second hit should not be recorded

    // Restore Date
    global.Date.now = originalDateNow;
    global.Date = Date;
  });
});
