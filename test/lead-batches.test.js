// Lead batches import themselves once NIRMATA approves them (Andy, 13 Nov).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { receiveBatch, approveBatch, importApproved, listBatches, sha256Hex } from '../src/worker/lead-batches.js';
import { handleIntake } from '../src/worker/intake.js';

const KEY = 'web-wave-test-be';
const row = (n, extra = {}) => ({
  id: `firm-${n}`, name: `Firm ${n}`, website: `https://firm${n}.example`, category: 'Local business',
  subcategory: 'Driving school', country: 'BE', score: 60 + n, email: `hello@firm${n}.example`, ...extra,
});
const file = (rows, meta = {}) => JSON.stringify({
  meta: { key: KEY, business: 'Web design', title: 'Web wave test', collected: '2026-11-13', tiers: { hot: 70, warm: 50 }, ...meta },
  rows,
});

async function withDb(fn) {
  const { database, dispose } = await freshDatabase();
  try { await fn(database); } finally { await dispose(); }
}
const count = async (d, sql, ...args) => (await d.prepare(sql).bind(...args).first()).n;

describe('lead batches', () => {
  it('waits for an approval, then imports every row in one go', async () => {
    await withDb(async (d) => {
      const raw = file([row(1), row(2), row(3)]);
      const filed = await receiveBatch(d, 'leads', KEY, raw);
      expect(filed).toMatchObject({ rows: 3, imported: [] });
      expect(filed.sha256).toBe(await sha256Hex(raw));
      expect(await count(d, 'SELECT COUNT(*) AS n FROM leads')).toBe(0);

      const approved = await approveBatch(d, 'nirmata', { key: KEY, sha256: filed.sha256, rows: 3 });
      expect(approved.imported).toEqual([expect.objectContaining({ key: KEY, rows: 3, result: 'imported' })]);
      expect(await count(d, 'SELECT COUNT(*) AS n FROM leads WHERE uid LIKE ?', `${KEY}/%`)).toBe(3);
      expect(await count(d, 'SELECT row_count AS n FROM datasets WHERE key = ?', KEY)).toBe(3);
      const [log] = await listBatches(d);
      expect(log).toMatchObject({ key: KEY, rows: 3, result: 'imported' });
      expect(log.approved_at).toBeTruthy();
    });
  }, 30000);

  it('imports when the approval came first, too', async () => {
    await withDb(async (d) => {
      const raw = file([row(1)]);
      await approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(raw), rows: 1 });
      const filed = await receiveBatch(d, 'leads', KEY, raw);
      expect(filed.imported[0]).toMatchObject({ result: 'imported' });
    });
  }, 30000);

  it('never imports a file that changed after the check', async () => {
    await withDb(async (d) => {
      const checked = file([row(1), row(2)]);
      await approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(checked), rows: 2 });
      const changed = file([row(1), row(2, { email: 'other@firm2.example' })]);
      expect((await receiveBatch(d, 'leads', KEY, changed)).imported).toEqual([]);
      expect(await count(d, 'SELECT COUNT(*) AS n FROM leads')).toBe(0);
    });
  }, 30000);

  it('refuses a count that differs from the approval, and writes nothing', async () => {
    await withDb(async (d) => {
      const raw = file([row(1), row(2)]);
      await receiveBatch(d, 'leads', KEY, raw);
      const { imported } = await approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(raw), rows: 3 });
      expect(imported[0]).toMatchObject({ result: 'failed' });
      expect(imported[0].error).toMatch(/2 rows in the file, 3 approved/);
      expect(await count(d, 'SELECT COUNT(*) AS n FROM leads')).toBe(0);
      expect(await count(d, 'SELECT COUNT(*) AS n FROM datasets')).toBe(0);
    });
  }, 30000);

  it('refuses a bad row before storing anything', async () => {
    await withDb(async (d) => {
      await expect(receiveBatch(d, 'leads', KEY, file([row(1), { ...row(2), website: '' }]))).rejects.toThrow(/website/);
      await expect(receiveBatch(d, 'leads', 'other-key', file([row(1)]))).rejects.toThrow(/meta.key/);
      expect(await count(d, 'SELECT COUNT(*) AS n FROM lead_batches')).toBe(0);
    });
  }, 30000);

  it('upserts without touching what Andy owns, and running twice changes nothing', async () => {
    await withDb(async (d) => {
      const first = file([row(1)]);
      await receiveBatch(d, 'leads', KEY, first);
      await approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(first), rows: 1 });
      await db.patchLeadState(d, `${KEY}/firm-1`, { stage: 'looked', notes: 'mine' });
      const update = file([row(1, { name: 'Firm 1 renamed' }), row(2)]);
      await receiveBatch(d, 'leads', KEY, update);
      await approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(update), rows: 2 });
      expect(await importApproved(d)).toEqual([]);
      expect((await d.prepare('SELECT name FROM leads WHERE uid = ?').bind(`${KEY}/firm-1`).first()).name).toBe('Firm 1 renamed');
      const state = await d.prepare('SELECT stage, notes FROM lead_state WHERE uid = ?').bind(`${KEY}/firm-1`).first();
      expect(state).toEqual({ stage: 'looked', notes: 'mine' });
      expect(await count(d, 'SELECT COUNT(*) AS n FROM leads')).toBe(2);
    });
  }, 30000);
});

describe('the intake routes', () => {
  const env = (database) => ({ DB: database, INTAKE_TOKEN_LEADS: 'l'.repeat(40), INTAKE_TOKEN_NIRMATA: 'n'.repeat(40) });
  const call = (e, path, token, init = {}) => handleIntake(
    new Request(`http://hq.test${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }),
    e, new URL(`http://hq.test${path}`),
  );

  it('LEADS files, only NIRMATA approves, and a stranger is turned away', async () => {
    await withDb(async (d) => {
      const e = env(d);
      const raw = file([row(1)]);
      const filed = await call(e, `/api/intake/lead-batch?key=${KEY}`, 'l'.repeat(40), { method: 'POST', body: raw });
      expect(filed.status).toBe(201);
      const { sha256 } = await filed.json();
      const approve = { method: 'POST', body: JSON.stringify({ key: KEY, sha256, rows: 1 }) };
      expect((await call(e, '/api/intake/lead-approval', 'l'.repeat(40), approve)).status).toBe(403);
      expect((await call(e, '/api/intake/lead-approval', 'x'.repeat(40), approve)).status).toBe(401);
      // NIRMATA cannot file a batch: one token never both files and approves.
      expect((await call(e, `/api/intake/lead-batch?key=${KEY}`, 'n'.repeat(40), { method: 'POST', body: raw })).status).toBe(403);
      const ok = await call(e, '/api/intake/lead-approval', 'n'.repeat(40), approve);
      expect((await ok.json()).imported[0].result).toBe('imported');
      const log = await call(e, '/api/intake/lead-batches', 'l'.repeat(40));
      expect((await log.json()).batches[0]).toMatchObject({ key: KEY, result: 'imported' });
    });
  }, 30000);
});

describe('the toast', () => {
  it('names one batch, sums several, and says what failed', async () => {
    const { importMessage } = await import('../src/public/assets/lead-batches-ui.js');
    expect(importMessage([{ key: 'web-wave-osm-age-be-lu-fr', rows: 53, result: 'imported' }])).toBe('Imported web-wave-osm-age-be-lu-fr: 53 leads');
    expect(importMessage([{ key: 'a', rows: 7, result: 'imported' }, { key: 'b', rows: 53, result: 'imported' }])).toBe('Imported 2 batches: 60 leads');
    expect(importMessage([{ key: 'c', rows: 3, result: 'failed', error: 'x' }])).toBe('Not imported: c (x)');
  });
});

describe('tokens kept as their SHA-256 only', () => {
  it('accepts the token whose hash is configured, and nothing else', async () => {
    await withDb(async (d) => {
      const raw = 'n'.repeat(40);
      const e = { DB: d, INTAKE_TOKEN_NIRMATA_SHA256: await sha256Hex(raw) };
      const ask = (token) => handleIntake(new Request('http://hq.test/api/intake/lead-batches', { headers: { Authorization: `Bearer ${token}` } }), e, new URL('http://hq.test/api/intake/lead-batches'));
      expect((await ask(raw)).status).toBe(200);
      expect((await ask('m'.repeat(40))).status).toBe(401);
      expect((await ask(await sha256Hex(raw))).status).toBe(401); // the hash itself is not a token
    });
  }, 30000);
});

describe('the Travel list list stays personal', () => {
  it('is never imported as a batch', async () => {
    await withDb(async (d) => {
      await expect(receiveBatch(d, 'leads', 'travel-volunteer-stays', file([row(1)], { key: 'travel-volunteer-stays' }))).rejects.toThrow(/personal list/);
    });
  }, 30000);
});
