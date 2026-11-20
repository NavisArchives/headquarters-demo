import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileStore, merge, CounterError } from '../assistant/usage-store.mjs';
import { createHelper, WORST_CALL_USD, MONTHLY_CEILING_USD } from '../assistant/helper.mjs';

// NIRMATA's review of the $20 ceiling (20 Nov, H1–H4): the counter fails closed, never loses
// a write, and holds under two callers at once. Every test runs in its own temp folders.
const ORIGIN = 'http://localhost:8787';
const TOKEN = 't'.repeat(64);
let dir; let files; let lock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hq-counter-'));
  mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
  files = [join(dir, 'a', 'usage.json'), join(dir, 'b', 'usage.json')];
  lock = join(dir, 'a', 'usage.lock');
});
afterEach(() => {
  for (const d of ['a', 'b']) { try { chmodSync(join(dir, d), 0o700); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});
const store = (extra = {}) => fileStore({ files, lock, waitMs: 300, ...extra });
const month = () => '2026-11';
const today = () => '2026-11-20';
function helper(callModel, s = store()) {
  const calls = [];
  const h = createHelper({ key: 'sk-ant-fake-' + 'x'.repeat(40), token: TOKEN, store: s, today, month,
    callModel: async (r) => { calls.push(r); return callModel(r); } });
  return { h, calls };
}
const ask = (h, body = { messages: [{ role: 'user', content: 'hi' }] }) =>
  h({ method: 'POST', path: '/assistant', headers: { origin: ORIGIN, 'x-hq-assistant-token': TOKEN }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const answer = (usage) => async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage });
const seed = (u) => { for (const f of files) writeFileSync(f, JSON.stringify(u)); };
const month_cost = () => store().read().month_cost;

describe('H1: the body cap is in bytes', () => {
  it('40,000 « é » (80,000 bytes, 40,000 characters) is refused as too long, with no call', async () => {
    const { h, calls } = helper(answer({}));
    const res = await ask(h, { messages: [{ role: 'user', content: 'é'.repeat(40_000) }] });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe('H2: reserve before the call, settle after', () => {
  it('a normal answer settles to the real cost', async () => {
    const { h } = helper(answer({ input_tokens: 1000, output_tokens: 100 }));
    expect((await ask(h)).status).toBe(200);
    expect(month_cost()).toBeCloseTo((1000 * 0.10 + 100 * 0.50) / 1e6, 12);
  });
  it('an answer without readable usage keeps the whole reservation (never counted as free)', async () => {
    for (const usage of [undefined, {}, { input_tokens: '10', output_tokens: 5 }, { input_tokens: 10 }]) {
      rmSync(files[0], { force: true }); rmSync(files[1], { force: true });
      const { h } = helper(answer(usage));
      expect((await ask(h)).status).toBe(200);
      expect(month_cost()).toBeCloseTo(WORST_CALL_USD, 12);
    }
  });
  it('a timeout keeps the reservation (it may have been billed)', async () => {
    const { h } = helper(async () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); });
    expect((await ask(h)).status).toBe(502);
    expect(month_cost()).toBeCloseTo(WORST_CALL_USD, 12);
  });
  it('a dropped connection keeps the reservation', async () => {
    const { h } = helper(async () => { throw Object.assign(new Error('Connection error.'), { cause: { code: 'ECONNRESET' } }); });
    expect((await ask(h)).status).toBe(502);
    expect(month_cost()).toBeCloseTo(WORST_CALL_USD, 12);
  });
  it('an HTTP 500 answer gives it back', async () => {
    const { h } = helper(async () => { throw Object.assign(new Error('500'), { status: 500 }); });
    expect((await ask(h)).status).toBe(502);
    expect(month_cost()).toBe(0);
  });
  it('a request that provably never left (connection refused) gives it back', async () => {
    const { h } = helper(async () => { throw Object.assign(new Error('Connection error.'), { cause: { code: 'ECONNREFUSED' } }); });
    expect((await ask(h)).status).toBe(502);
    expect(month_cost()).toBe(0);
  });
  it('the reservation is what is checked: $20 minus less than one worst call is refused', async () => {
    seed({ day: '2026-11-20', count: 0, month: '2026-11', month_cost: MONTHLY_CEILING_USD - WORST_CALL_USD + 0.000001 });
    const { h, calls } = helper(answer({}));
    expect((await ask(h)).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe('H3: the counter fails closed and never loses a write', () => {
  it('a corrupt counter refuses, with no call', async () => {
    writeFileSync(files[0], '{"month":"2026-11","month_cost":');
    const { h, calls } = helper(answer({}));
    const res = await ask(h);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/spending counter cannot be read or saved/);
    expect(calls).toHaveLength(0);
  });
  it('a counter with a bad number refuses, with no call', async () => {
    seed({ month: '2026-11', month_cost: -5 });
    const { h, calls } = helper(answer({}));
    expect((await ask(h)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it('a counter that cannot be written refuses, with no call', async () => {
    seed({ day: '2026-11-20', count: 0, month: '2026-11', month_cost: 1 });
    chmodSync(join(dir, 'b'), 0o500); // the second copy's folder is read-only: the rename fails
    const { h, calls } = helper(answer({}));
    expect((await ask(h)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it('one copy deleted while the other holds $19.99: refused', async () => {
    writeFileSync(files[1], JSON.stringify({ day: '2026-11-20', count: 3, month: '2026-11', month_cost: 19.99 }));
    expect(existsSync(files[0])).toBe(false);
    const { h, calls } = helper(answer({}));
    expect((await ask(h)).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
  it('the higher month total wins when the copies differ', () => {
    expect(merge([{ month: '2026-11', month_cost: 3 }, { month: '2026-11', month_cost: 7 }]).month_cost).toBe(7);
    expect(merge([{ month: '2026-12', month_cost: 0.5 }, { month: '2026-11', month_cost: 19 }])).toMatchObject({ month: '2026-12', month_cost: 0.5 });
  });
  it('writes by temp file and rename: both copies written, mode 600, no temp file left', async () => {
    const { h } = helper(answer({ input_tokens: 10, output_tokens: 10 }));
    await ask(h);
    for (const f of files) {
      expect(JSON.parse(readFileSync(f, 'utf8')).count).toBe(1);
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(dir, 'a')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('H4: one exclusive lock', () => {
  it('a lock held by another caller makes this one wait, then refuse with no call', async () => {
    writeFileSync(lock, '99999');
    const { h, calls } = helper(answer({}));
    expect((await ask(h)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
  it('a lock left by a dead process is taken over after it goes stale', () => {
    writeFileSync(lock, '99999');
    const s = store({ staleMs: 0, waitMs: 1000 });
    expect(s.transact((u) => { u.count = 1; return 'ok'; })).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });
  it('two processes reserving at the same moment both land', async () => {
    const script = `import { fileStore } from ${JSON.stringify(new URL('../assistant/usage-store.mjs', import.meta.url).href)};
      const s = fileStore({ files: ${JSON.stringify(files)}, lock: ${JSON.stringify(lock)}, waitMs: 10000 });
      for (let i = 0; i < 100; i += 1) s.transact((u) => { u.month = '2026-11'; u.count = (u.count || 0) + 1; u.month_cost = (u.month_cost || 0) + 0.01; });`;
    const run = () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    await Promise.all([run(), run()]);
    const u = store().read();
    expect(u.count).toBe(200);
    expect(u.month_cost).toBeCloseTo(2.0, 9);
  }, 30_000);
  it('a failed transaction throws CounterError and releases the lock', () => {
    writeFileSync(files[0], 'not json');
    expect(() => store().transact(() => 'x')).toThrow(CounterError);
    expect(existsSync(lock)).toBe(false);
  });
});
