import { describe, it, expect } from 'vitest';
import { handleBrevoHook, eventTime } from '../src/worker/brevo-hook.js';
import { freshDatabase } from './helpers/d1.js';
import * as hqdb from '../src/worker/db.js';

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
  };
}

/** A fake D1 that answers the one query the hook makes. */
function fakeDb(rows) {
  return {
    prepare(sql) {
      if(sql.startsWith('INSERT OR IGNORE INTO outreach_delivery_events'))return {bind(){return {async run(){return {meta:{changes:1}};}};}};
      expect(sql).toMatch(/FROM leads WHERE lower\(trim\(email\)\) = \?/);
      return {
        bind(email) {
          return { async all() { return { results: rows.filter((r) => r.email.trim().toLowerCase() === email).map((r) => ({ uid: r.uid })) }; } };
        },
      };
    },
  };
}

const TOKEN = 'secret-token-123';
const LEADS = [
  { uid: 'plastic-surgeons-netherlands/a', email: 'info@clinic.nl' },
  { uid: 'plastic-surgeons-netherlands/b', email: 'Info@Clinic.nl ' },
  { uid: 'belgium-web-redesign/kinea', email: 'info@kinea.example' },
];

function call(path, env, body, method = 'POST') {
  const url = new URL(`https://hq.example.com${path}`);
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return handleBrevoHook(new Request(url, init), env, url);
}

describe('routing and the secret', () => {
  it('ignores other paths', async () => {
    expect(await call('/api/leads', {}, {})).toBeNull();
    expect(await call('/hooks/brevo', {}, {})).toBeNull();
  });

  it('answers 404 when the token is wrong or not configured', async () => {
    expect((await call(`/hooks/brevo/${TOKEN}`, {}, {})).status).toBe(404);
    expect((await call('/hooks/brevo/nope', { BREVO_HOOK_TOKEN: TOKEN }, {})).status).toBe(404);
  });

  it('only accepts POST, and rejects bad JSON', async () => {
    const env = { BREVO_HOOK_TOKEN: TOKEN };
    expect((await call(`/hooks/brevo/${TOKEN}`, env, undefined, 'GET')).status).toBe(405);
    expect((await call(`/hooks/brevo/${TOKEN}`, env, '{not json')).status).toBe(400);
  });
});

describe('recording opens', () => {
  it('records an opened event on every lead sharing that address', async () => {
    const kv = fakeKv();
    const env = { BREVO_HOOK_TOKEN: TOKEN, OPENS: kv, DB: fakeDb(LEADS) };
    const res = await call(`/hooks/brevo/${TOKEN}`, env, { event: 'opened', email: 'INFO@clinic.nl', ts_event: 1791450000 });
    expect(res.status).toBe(200);
    expect((await res.json()).recorded).toBe(2);
    const iso = new Date(1791450000 * 1000).toISOString();
    expect(JSON.parse(kv.store.get('opens:plastic-surgeons-netherlands/a'))).toEqual([iso]);
    expect(JSON.parse(kv.store.get('opens:plastic-surgeons-netherlands/b'))).toEqual([iso]);
  });

  it('accepts a batch, skips proxy opens and other events, and never double-counts a retry', async () => {
    const kv = fakeKv({ 'opens:belgium-web-redesign/kinea': JSON.stringify(['2026-10-01T10:00:00.000Z']) });
    const env = { BREVO_HOOK_TOKEN: TOKEN, OPENS: kv, DB: fakeDb(LEADS) };
    const batch = [
      { event: 'unique_opened', email: 'info@kinea.example', ts_event: 1791450000 },
      { event: 'opened', email: 'info@kinea.example', ts_event: 1791450000 },
      { event: 'proxy_open', email: 'info@kinea.example', ts_event: 1791450100 },
      { event: 'delivered', email: 'info@kinea.example', ts_event: 1791450200 },
      { event: 'opened', email: 'stranger@nowhere.com', ts_event: 1791450300 },
    ];
    const res = await call(`/hooks/brevo/${TOKEN}`, env, batch);
    expect((await res.json()).recorded).toBe(1);
    expect(JSON.parse(kv.store.get('opens:belgium-web-redesign/kinea'))).toEqual([
      '2026-10-01T10:00:00.000Z',
      new Date(1791450000 * 1000).toISOString(),
    ]);
    expect(kv.store.has('opens:undefined')).toBe(false);
  });

  it('still answers 200 when OPENS is not bound', async () => {
    const res = await call(`/hooks/brevo/${TOKEN}`, { BREVO_HOOK_TOKEN: TOKEN }, { event: 'opened', email: 'info@kinea.example' });
    expect(res.status).toBe(200);
  });
});

describe('eventTime', () => {
  it('reads seconds, milliseconds, and a plain date string', () => {
    expect(eventTime({ ts_event: 1791450000 })).toBe(new Date(1791450000000).toISOString());
    expect(eventTime({ ts_epoch: 1791450000123 })).toBe(new Date(1791450000123).toISOString());
    expect(eventTime({ date: '2026-10-08 17:00:00' })).toBe('2026-10-08T17:00:00.000Z');
    expect(eventTime({}, 0)).toBe(new Date(0).toISOString());
  });
});

/* ---- A5: a bounce or an unsubscribe stops the lead, on a real D1 ---- */

describe('stop events: never email this lead again (A5)', () => {
  async function withLeads(fn) {
    const { database, dispose } = await freshDatabase();
    try {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('arch', 'Web design', 'Architects', 70, 50, 'x')").run();
      for (const [id, email] of [['a', 'office@studio-a.example'], ['b', 'hello@studio-b.example']]) {
        await database.prepare(
          `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
           VALUES (?, 'arch', ?, 'Web design', ?, '', 'Architects', 'BE', ?, 80, 'Hot', '{}', 'x')`,
        ).bind(`arch/${id}`, id, `Studio ${id.toUpperCase()}`, email).run();
      }
      await hqdb.patchLeadState(database, 'arch/a', { stage: 'sent', follow_up: '2026-11-05' });
      await hqdb.patchLeadState(database, 'arch/b', { stage: 'won' });
      await fn(database);
    } finally { await dispose(); }
  }
  const stage = async (database, uid) => hqdb.getLeadStage(database, uid);

  it('a hard bounce passes the lead, clears its follow-up and says why; a retry changes nothing', async () => {
    await withLeads(async (database) => {
      const env = { BREVO_HOOK_TOKEN: 'tok', DB: database };
      const event = { event: 'hard_bounce', email: 'Office@Studio-A.example', ts_event: 1761900000 };
      const res = await (await call('/hooks/brevo/tok', env, [event])).json();
      expect(res.stopped).toBe(1);
      expect(await stage(database, 'arch/a')).toBe('passed');
      expect((await database.prepare('SELECT follow_up FROM lead_state WHERE uid = ?').bind('arch/a').first()).follow_up).toBeNull();
      const ev = await database.prepare("SELECT detail FROM lead_events WHERE uid = 'arch/a' AND kind = 'stop'").all();
      expect(ev.results).toEqual([{ detail: 'Brevo: hard bounce' }]);
      expect((await (await call('/hooks/brevo/tok', env, [event])).json()).stopped).toBe(0);
    });
  });

  it('an unsubscribe on a won client keeps it won, but is recorded; soft bounces and opens stop nothing', async () => {
    await withLeads(async (database) => {
      const env = { BREVO_HOOK_TOKEN: 'tok', DB: database };
      await call('/hooks/brevo/tok', env, [
        { event: 'unsubscribed', email: 'hello@studio-b.example', ts_event: 1761900000 },
        { event: 'soft_bounce', email: 'office@studio-a.example', ts_event: 1761900000 },
        { event: 'opened', email: 'office@studio-a.example', ts_event: 1761900000 },
      ]);
      expect(await stage(database, 'arch/b')).toBe('won');
      expect((await database.prepare("SELECT detail FROM lead_events WHERE uid = 'arch/b' AND kind = 'stop'").first()).detail).toBe('Brevo: unsubscribed');
      expect(await stage(database, 'arch/a')).toBe('sent');
    });
  });
});


describe('durable provider receipt',()=>{
  it('requests a retry when the database cannot persist the event',async()=>{
    const env={BREVO_HOOK_TOKEN:TOKEN,DB:{prepare(){throw new Error('temporary database failure');}}};
    const response=await call(`/hooks/brevo/${TOKEN}`,env,{event:'delivered',email:'a@example.com',ts_event:1791450000});
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });
});
