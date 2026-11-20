import { describe, it, expect, beforeEach } from 'vitest';

/** The mailbox sync, on its own: at most every ten minutes, only with Gmail connected, never loud. */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.window ??= { dispatchEvent() {}, location: { pathname: '/' } };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const { autoSyncMailbox, forgetGmailStatus, AUTO_SYNC_EVERY_MS } = await import('../src/public/assets/leads-gmail.js');

let connected = true;
let syncs = 0;
let failSync = false;
beforeEach(() => {
  store.clear();
  forgetGmailStatus();
  connected = true;
  syncs = 0;
  failSync = false;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/api/gmail/status')) return { ok: true, status: 200, text: async () => JSON.stringify({ connected, email: 'me@gmail.com' }) };
    if (path.includes('/api/gmail/activity')) {
      syncs += 1;
      if (failSync) return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'bridge down' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ applied: 0, updated: 2, skipped: 1 }) };
    }
    throw new Error(`no stub for ${path}`);
  };
});

describe('reading the mailbox without a button', () => {
  it('runs once, then not again for ten minutes', async () => {
    const t = 1_800_000_000_000;
    expect(await autoSyncMailbox(t)).toMatchObject({ updated: 2 });
    expect(await autoSyncMailbox(t + 60_000)).toBeNull();
    expect(syncs).toBe(1);
    expect(await autoSyncMailbox(t + AUTO_SYNC_EVERY_MS + 1)).toMatchObject({ updated: 2 });
    expect(syncs).toBe(2);
  });

  it('does nothing when Gmail is not connected (the online HQ, or the Mac asleep)', async () => {
    connected = false;
    expect(await autoSyncMailbox(1_800_000_000_000)).toBeNull();
    expect(syncs).toBe(0);
  });

  it('a bridge that fails is quiet: null, never a throw', async () => {
    failSync = true;
    await expect(autoSyncMailbox(1_800_000_000_000)).resolves.toBeNull();
  });
});
