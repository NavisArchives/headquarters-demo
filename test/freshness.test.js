// Honest sync freshness (Codex handover 003, NIRMATA 20 Nov): a failed attempt
// never advances the last success, stale sources are visible, and an empty
// list is not shown as certain unless the mailbox was read recently.
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';
import { freshDatabase } from './helpers/d1.js';
import { recordMailboxRead, mailboxState, sourceFreshness, MAILBOX_KEY } from '../src/worker/freshness.js';
import { handleGmail } from '../src/worker/api/gmail.js';

installDom();
const { freshnessLine } = await import('../src/public/assets/screens/home-replies.js');

function fakeKv() {
  const store = new Map();
  return { store, get: async (k, type) => (store.has(k) ? (type === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null),
    put: async (k, v) => { store.set(k, v); } };
}
const at = (s) => new Date(`2026-11-20T${s}:00Z`);

describe('mailbox freshness record', () => {
  it('a failure never advances the last success; a success clears the error', async () => {
    const kv = fakeKv();
    expect(mailboxState(null, at('10:00')).state).toBe('unknown');
    await recordMailboxRead(kv, true, at('09:00'));
    await recordMailboxRead(kv, false, at('09:40'), 'the Mac did not answer');
    const failed = JSON.parse(kv.store.get(MAILBOX_KEY));
    expect(failed).toEqual({ ok_at: at('09:00').toISOString(), attempt_at: at('09:40').toISOString(), error: 'the Mac did not answer' });
    expect(mailboxState(failed, at('09:41'))).toMatchObject({ state: 'failed', last_success_at: at('09:00').toISOString() });
    await recordMailboxRead(kv, true, at('09:50'));
    expect(mailboxState(JSON.parse(kv.store.get(MAILBOX_KEY)), at('10:00')).state).toBe('fresh');
    expect(mailboxState(JSON.parse(kv.store.get(MAILBOX_KEY)), at('10:30')).state).toBe('stale');
  });

  it('records the outcome of the real route: bridge down, then a good read', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      const kv = fakeKv();
      const env = { DB: db, STATUS: kv, GMAIL_BRIDGE: 'http://127.0.0.1:9' };
      const post = () => new Request('https://hq.test/api/gmail/activity', { method: 'POST' });
      const down = await handleGmail(post(), env, new URL('https://hq.test/api/gmail/activity'), { fetchImpl: async () => { throw new Error('refused'); }, timeoutMs: 50 });
      expect(down.status).toBe(503);
      expect(JSON.parse(kv.store.get(MAILBOX_KEY))).toMatchObject({ ok_at: null, error: 'the Mac did not answer' });
      const ok = await handleGmail(post(), env, new URL('https://hq.test/api/gmail/activity'),
        { fetchImpl: async () => new Response(JSON.stringify({ sent: {}, replied: {} }), { status: 200, headers: { 'content-type': 'application/json' } }), timeoutMs: 50 });
      expect(ok.status).toBe(200);
      const record = JSON.parse(kv.store.get(MAILBOX_KEY));
      expect(record.ok_at).toBe(record.attempt_at);
      expect(record.error).toBe('');
      const fresh = await sourceFreshness(env, new Date(Date.parse(record.ok_at) + 60_000));
      expect(fresh.mailbox.state).toBe('fresh');
      expect(fresh.replies).toEqual({ source: 'replies', state: 'unknown', last_recorded_at: null });
      expect(fresh.alerts).toBe('while_open');
    } finally { await dispose(); }
  });
});

describe('the Home line says only what is recorded', () => {
  it('plain states only: checked N ago, not checked today, could not check, or nothing', () => {
    const now = at('10:02').getTime();
    expect(freshnessLine({ mailbox: { state: 'fresh', last_success_at: at('09:50').toISOString() } }, now).text).toBe('Replies checked 12 min ago');
    expect(freshnessLine({ mailbox: { state: 'stale', last_success_at: at('07:40').toISOString() } }, now).text).toBe('Replies checked 2 h ago');
    expect(freshnessLine({ mailbox: { state: 'stale', last_success_at: '2026-11-18T09:00:00Z' } }, now).text).toBe('Replies not checked today');
    expect(freshnessLine({ mailbox: { state: 'failed', last_attempt_at: at('09:40').toISOString(), error: 'the Mac did not answer' } }, now).text).toBe('Could not check replies');
    expect(freshnessLine({ mailbox: { state: 'unknown' } }, now)).toBeNull();
    expect(freshnessLine(undefined)).toBeNull();
  });
});
