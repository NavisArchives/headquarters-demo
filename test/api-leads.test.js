import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleLeads } from '../src/worker/api/leads.js';

/**
 * A fake D1 flexible enough for leads.js's multi-query handlers: a single
 * request can run a lead select, a settings select and a draft select in
 * one call (GET detail, GET compose). Each handler matches part of the SQL
 * text and supplies a canned first/all/changes result; unmatched SQL falls
 * back to empty/null, so a test only has to describe the queries it cares
 * about. Every prepared statement (matched or not) is still recorded in
 * `calls`, so "zero db calls" assertions hold regardless.
 */
function fakeDb(handlers = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const handler = handlers.find((h) => h.match.test(sql)) ?? {};
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() {
          const rows = typeof handler.all === 'function' ? handler.all(call.args) : handler.all;
          return { results: rows ?? [] };
        },
        async first() {
          const row = typeof handler.first === 'function' ? handler.first(call.args) : handler.first;
          return row ?? null;
        },
        async run() {
          return { success: true, meta: { changes: handler.changes ?? 1, last_row_id: handler.lastId ?? 1 } };
        },
      };
      return stmt;
    },
  };
}

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

const leadFacts = (over = {}) => ({
  uid: 'ugc-brands-agencies/babbel', dataset: 'ugc-brands-agencies', id: 'babbel',
  business: 'UGC', name: 'Lingo', website: 'https://www.lingo.example',
  category: 'Tech', subcategory: 'Consumer app / edtech',
  city: 'Berlin', area: 'Germany', region: 'EU / Berlin', country: 'Germany',
  languages: '["EN","NL","FR"]', email: 'social@lingo.example', phone: null,
  contact: 'social@lingo.example', contact_type: 'email',
  score: 100, tier: 'Hot', verified: 'live-checked',
  payload: '{"pitch":"Native Dutch + native French","research":"Berlin HQ"}',
  imported_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const stateDefaults = (over = {}) => ({
  stage: 'new', starred: 0, notes: '', follow_up: null,
  looked_at: null, sent_at: null, replied_at: null, won_at: null, passed_at: null,
  updated_at: null,
  ...over,
});

const leadRow = (factsOver = {}, stateOver = {}) => ({ ...leadFacts(factsOver), ...stateDefaults(stateOver) });

const LEAD_SELECT = /FROM leads l LEFT JOIN lead_state/;
const EVENTS_SELECT = /FROM lead_events WHERE uid = \?/;
const SETTINGS_SELECT = /FROM settings WHERE key = \?/;
const DRAFT_SELECT = /FROM lead_drafts WHERE uid = \? AND lang = \?/;
const DRAFT_INSERT = /INSERT INTO lead_drafts/;
const DRAFT_DELETE = /DELETE FROM lead_drafts/;
const SETTINGS_INSERT = /INSERT INTO settings/;
const STATE_INSERT = /INSERT INTO lead_state/;
const EVENTS_INSERT = /INSERT INTO lead_events/;

/** A minimal stand-in for URL: leads.js only ever reads pathname,
 *  searchParams and origin off the object it's handed, so this lets a test
 *  hand it a hostile literal pathname (e.g. a literal "..") that the real
 *  WHATWG URL parser would normalize away before code ever saw it. */
function fakeUrl(pathname, search = '') {
  return { pathname, searchParams: new URLSearchParams(search), origin: 'https://hq.example.com' };
}

function call(method, path, body, env, url) {
  const target = url ?? new URL(`https://hq.example.com${path}`);
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return handleLeads(new Request('https://hq.example.com/', init), env, target);
}

describe('routing', () => {
  it('ignores paths that are not leads routes', async () => {
    expect(await call('GET', '/api/status', undefined, { DB: fakeDb() })).toBeNull();
  });

  it('404s an invalid dataset segment, running no query', async () => {
    const db = fakeDb();
    const res = await call('GET', '/api/leads/Not_Valid/babbel', undefined, { DB: db });
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it('404s an invalid id segment, running no query', async () => {
    const db = fakeDb();
    const res = await call('GET', '/api/leads/ugc-brands-agencies/Not_Valid!', undefined, { DB: db });
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['a literal .. segment', fakeUrl('/api/leads/../ugc-brands-agencies/babbel')],
    ['a %2F-encoded segment', fakeUrl('/api/leads/foo%2Fbar/babbel')],
    ['a semicolon segment', fakeUrl('/api/leads/foo;bar/babbel')],
  ])('404s a hostile uid segment (%s), running no query', async (_label, url) => {
    const db = fakeDb();
    const res = await call('GET', '', undefined, { DB: db }, url);
    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });
});

describe('GET /api/leads', () => {
  it('lists', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, all: [leadRow()] }]);
    const res = await call('GET', '/api/leads', undefined, { DB: db });
    expect(res.status).toBe(200);
    expect((await res.json()).leads).toHaveLength(1);
  });

  it('passes every filter listLeads accepts through as a bound arg', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, all: [] }]);
    await call(
      'GET',
      '/api/leads?business=UGC&category=Tech&area=Germany&tier=Hot&contact=email'
      + '&stage=sent&starred=true&language=NL&q=babbel&sort=name',
      undefined,
      { DB: db },
    );
    const args = db.calls[0].args;
    for (const value of ['UGC', 'Tech', 'Germany', 'Hot', 'email', 'sent']) {
      expect(args, `expected ${value} to be bound`).toContain(value);
    }
    expect(args).toContain(1); // starred=true -> 1
  });

  it('400s an invalid stage filter, with the field named', async () => {
    const res = await call('GET', '/api/leads?stage=sideways', undefined, { DB: fakeDb() });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('stage');
  });

  it('never caches', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, all: [] }]);
    const res = await call('GET', '/api/leads', undefined, { DB: db });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/leads/<uid>', () => {
  it('returns facts + state + events + drafts', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: EVENTS_SELECT, all: [{ id: 1, kind: 'stage', detail: 'sent', at: '2026-09-10T00:00:00.000Z' }] },
      {
        match: DRAFT_SELECT,
        first: (args) => (args[1] === 'EN'
          ? { uid: leadRow().uid, lang: 'EN', subject: 'Hi', body: 'Body', to_name: '', updated_at: 'x' }
          : null),
      },
    ]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/babbel', undefined, { DB: db });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lead.name).toBe('Lingo');
    expect(body.lead.events).toHaveLength(1);
    expect(body.drafts.EN.subject).toBe('Hi');
    expect(body.drafts.NL).toBeUndefined();
    expect(body.opens).toEqual([]);
  });

  it('404s an unknown uid', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, first: null }, { match: EVENTS_SELECT, all: [] }]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/nope', undefined, { DB: db });
    expect(res.status).toBe(404);
  });

  it('discards opens within ten minutes of sent_at and keeps the rest', async () => {
    const sentAt = '2026-09-10T12:00:00.000Z';
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow({}, { sent_at: sentAt }) },
      { match: EVENTS_SELECT, all: [] },
      { match: DRAFT_SELECT, first: null },
    ]);
    const kv = fakeKv({
      'opens:ugc-brands-agencies/babbel': JSON.stringify([
        '2026-09-10T12:05:00.000Z', // 5 min after send: Gmail's own fetch, discarded
        '2026-09-11T09:00:00.000Z', // a day later: a real open, kept
      ]),
    });
    const res = await call('GET', '/api/leads/ugc-brands-agencies/babbel', undefined, { DB: db, OPENS: kv });
    const body = await res.json();
    expect(body.opens).toEqual(['2026-09-11T09:00:00.000Z']);
  });

  it('degrades to an empty opens list when OPENS is not bound', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: EVENTS_SELECT, all: [] },
      { match: DRAFT_SELECT, first: null },
    ]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/babbel', undefined, { DB: db });
    expect((await res.json()).opens).toEqual([]);
  });
  it('answers the opens of many leads in one request (13 Nov)', async () => {
    const sentAt = '2026-09-10T12:00:00.000Z';
    const db = fakeDb([{ match: /FROM lead_state WHERE uid IN/, all: [{ uid: 'a/one', sent_at: sentAt }, { uid: 'a/two', sent_at: null }] }]);
    const kv = fakeKv({
      'opens:a/one': JSON.stringify(['2026-09-10T12:05:00.000Z', '2026-09-11T09:00:00.000Z']),
      'opens:a/two': JSON.stringify([]),
    });
    const res = await call('POST', '/api/leads/opens', { uids: ['a/one', 'a/two', 'a/three', 'a/one'] }, { DB: db, OPENS: kv });
    expect(res.status).toBe(200);
    expect((await res.json()).opens).toEqual({ 'a/one': ['2026-09-11T09:00:00.000Z'] });
    expect(db.calls).toHaveLength(1); // one query, whatever the count
    expect(JSON.parse(db.calls[0].args[0])).toEqual(['a/one', 'a/two', 'a/three']);
  });

  it('refuses a GET, a missing list and more than 200 leads at once', async () => {
    expect((await call('GET', '/api/leads/opens', undefined, { DB: fakeDb() })).status).toBe(405);
    expect((await call('POST', '/api/leads/opens', {}, { DB: fakeDb() })).status).toBe(400);
    const many = Array.from({ length: 201 }, (_, i) => `a/l${i}`);
    expect((await call('POST', '/api/leads/opens', { uids: many }, { DB: fakeDb() })).status).toBe(400);
  });

  it('answers no opens when OPENS is not bound', async () => {
    const res = await call('POST', '/api/leads/opens', { uids: ['a/one'] }, { DB: fakeDb() });
    expect((await res.json()).opens).toEqual({});
  });
});

describe('PATCH /api/leads/<uid>/state', () => {
  it('updates and returns the row', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: STATE_INSERT },
      { match: EVENTS_INSERT },
    ]);
    const res = await call('PATCH', '/api/leads/ugc-brands-agencies/babbel/state', { stage: 'sent' }, { DB: db });
    expect(res.status).toBe(200);
    expect((await res.json()).lead.stage).toBe('sent');
  });

  it('404s an unknown uid', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, first: null }]);
    const res = await call('PATCH', '/api/leads/ugc-brands-agencies/nope/state', { stage: 'sent' }, { DB: db });
    expect(res.status).toBe(404);
  });

  it('400s an empty patch, with the field named', async () => {
    const db = fakeDb();
    const res = await call('PATCH', '/api/leads/ugc-brands-agencies/babbel/state', {}, { DB: db });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('patch');
  });
});

describe('PUT, DELETE /api/leads/<uid>/draft/<lang>', () => {
  it('saves and returns the draft', async () => {
    const saved = {
      uid: 'ugc-brands-agencies/babbel', lang: 'EN', subject: 'Hi', body: 'Body', to_name: '', updated_at: '2026-09-20T00:00:00.000Z',
    };
    const db = fakeDb([{ match: DRAFT_INSERT, first: saved }]);
    const res = await call('PUT', '/api/leads/ugc-brands-agencies/babbel/draft/EN', { subject: 'Hi', body: 'Body' }, { DB: db });
    expect(res.status).toBe(200);
    expect((await res.json()).draft).toEqual(saved);
  });

  it('clears the draft', async () => {
    const db = fakeDb([{ match: DRAFT_DELETE, changes: 1 }]);
    const res = await call('DELETE', '/api/leads/ugc-brands-agencies/babbel/draft/EN', undefined, { DB: db });
    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s when there was nothing to clear', async () => {
    const db = fakeDb([{ match: DRAFT_DELETE, changes: 0 }]);
    const res = await call('DELETE', '/api/leads/ugc-brands-agencies/babbel/draft/EN', undefined, { DB: db });
    expect(res.status).toBe(404);
  });
});

describe('GET, PUT /api/settings/profile', () => {
  it('returns null when unset', async () => {
    const db = fakeDb([{ match: SETTINGS_SELECT, first: null }]);
    const res = await call('GET', '/api/settings/profile', undefined, { DB: db });
    expect((await res.json()).profile).toBeNull();
  });

  it('returns the stored profile', async () => {
    const db = fakeDb([{ match: SETTINGS_SELECT, first: { value: JSON.stringify({ name: 'Andy' }) } }]);
    const res = await call('GET', '/api/settings/profile', undefined, { DB: db });
    expect((await res.json()).profile).toEqual({ name: 'Andy' });
  });

  it('saves the profile', async () => {
    const db = fakeDb([{ match: SETTINGS_INSERT }]);
    const res = await call('PUT', '/api/settings/profile', { name: 'Andy' }, { DB: db });
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toEqual({ name: 'Andy' });
  });
});

describe('GET, PUT /api/settings/myinfo', () => {
  it('returns null when unset and saves what it is given', async () => {
    const empty = fakeDb([{ match: SETTINGS_SELECT, first: null }]);
    expect((await (await call('GET', '/api/settings/myinfo', undefined, { DB: empty })).json()).myinfo).toBeNull();
    const db = fakeDb([{ match: SETTINGS_INSERT }]);
    const res = await call('PUT', '/api/settings/myinfo', { person: { name: 'Andy' } }, { DB: db });
    expect(res.status).toBe(200);
    expect((await res.json()).myinfo).toEqual({ person: { name: 'Andy' } });
  });
});

describe('GET /api/leads/<uid>/compose', () => {
  it('composes a template draft with the designed HTML and a fresh pixel token', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: EVENTS_SELECT, all: [] },
      { match: SETTINGS_SELECT, first: null },
      { match: DRAFT_SELECT, first: null },
    ]);
    const kv = fakeKv();
    const res = await call(
      'GET',
      '/api/leads/ugc-brands-agencies/babbel/compose?lang=EN&mode=email',
      undefined,
      { DB: db, OPENS: kv },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.subject).toBe('string');
    expect(typeof body.body).toBe('string');
    expect(body.designedHtml).toContain('<img');
    expect([...kv.store.keys()].some((k) => k.startsWith('token:'))).toBe(true);
  });

  it('maps draft to_name to toName when composing with non-empty to_name', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: EVENTS_SELECT, all: [] },
      { match: SETTINGS_SELECT, first: null },
      {
        match: DRAFT_SELECT,
        first: (args) => (args[1] === 'EN'
          ? { uid: leadRow().uid, lang: 'EN', subject: 'Hi', body: 'Hi, let me tell you about this opportunity.', to_name: 'Marieke', updated_at: 'x' }
          : null),
      },
    ]);
    const kv = fakeKv();
    const res = await call(
      'GET',
      '/api/leads/ugc-brands-agencies/babbel/compose?lang=EN&mode=email',
      undefined,
      { DB: db, OPENS: kv },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // When a draft with to_name='Marieke' is provided, the greeting should be personalized to Marieke
    // rather than falling back to the company name (Lingo)
    expect(body.body).toContain('Hi Marieke');
  });

  it('404s an unknown uid', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, first: null }]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/nope/compose', undefined, { DB: db });
    expect(res.status).toBe(404);
  });

  it('400s an invalid mode, with the field named', async () => {
    const db = fakeDb([{ match: LEAD_SELECT, first: leadRow() }]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/babbel/compose?mode=sideways', undefined, { DB: db });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('mode');
  });

  it('still composes when OPENS is not bound', async () => {
    const db = fakeDb([
      { match: LEAD_SELECT, first: leadRow() },
      { match: EVENTS_SELECT, all: [] },
      { match: SETTINGS_SELECT, first: null },
      { match: DRAFT_SELECT, first: null },
    ]);
    const res = await call('GET', '/api/leads/ugc-brands-agencies/babbel/compose', undefined, { DB: db });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/leads/import', () => {
  // src/worker/import-leads.js exists (written alongside this task by
  // another agent) and does the real db.prepare() work via
  // upsertDataset/upsertLead, so a plain fakeDb (every write succeeds) is
  // enough here — this isn't re-testing import-leads.js's own logic, just
  // that the route wires request body -> runImport -> response.
  const meta = { business: 'UGC', title: 'UGC leads', collected: '2026-09-01', tiers: { hot: 80, warm: 50 } };
  const row = {
    id: 'babbel', name: 'Lingo', website: 'https://www.lingo.example', category: 'Tech',
    subcategory: 'Consumer app / edtech', country: 'Germany', score: 100,
  };

  it('imports and returns the summary', async () => {
    const datasets = [{ key: 'ugc-brands-agencies', meta, rows: [row] }];
    const res = await call('POST', '/api/leads/import', { datasets }, { DB: fakeDb() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalRows).toBe(1);
    expect(body.datasets[0]).toMatchObject({ key: 'ugc-brands-agencies', business: 'UGC', count: 1 });
  });

  it('400s a malformed import payload (an ImportError, not a 500)', async () => {
    const res = await call('POST', '/api/leads/import', { datasets: 'not-an-array' }, { DB: fakeDb() });
    expect(res.status).toBe(400);
  });
});

describe('failures', () => {
  it('500s a database error without leaking the message', async () => {
    const db = { prepare() { throw new Error('D1_ERROR: near "SELECT": syntax error at offset 42'); } };
    const res = await call('GET', '/api/leads', undefined, { DB: db });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('D1_ERROR');
    expect(text).not.toContain('SELECT');
  });
});

describe('wiring in src/worker/index.js', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/worker/index.js', import.meta.url)), 'utf8');

  it('runs the pixel before authenticate(), since a mail client sends no cookie and no Access header', () => {
    const pixelIdx = source.indexOf('handlePixel(');
    const authIdx = source.indexOf('authenticate(');
    expect(pixelIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(pixelIdx).toBeLessThan(authIdx);
  });

  it('runs the leads routes after authenticate(), behind the Access gate', () => {
    const leadsIdx = source.indexOf('handleLeads(');
    const authIdx = source.indexOf('authenticate(');
    expect(leadsIdx).toBeGreaterThan(-1);
    expect(leadsIdx).toBeGreaterThan(authIdx);
  });
});
