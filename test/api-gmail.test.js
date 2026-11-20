import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handleGmail } from '../src/worker/api/gmail.js';

/**
 * Same fake D1 as test/api-leads.test.js: each handler matches part of the
 * SQL text and supplies a canned result, and every prepared statement is
 * recorded in `calls` so "no write happened" assertions hold.
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
          return { success: true, meta: { changes: handler.changes ?? 1, last_row_id: 1 } };
        },
      };
      return stmt;
    },
  };
}

/** A fetch that records what would have gone to the Mac. */
function fakeFetch(handler = () => jsonResponse({})) {
  const calls = [];
  const impl = async (target, init = {}) => {
    calls.push({
      url: String(target),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ?? null,
      signal: init.signal,
    });
    return handler(String(target), init);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

const BRIDGE = 'http://127.0.0.1:8765';

function call(method, path, { body, env = {}, fetchImpl, timeoutMs, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const request = new Request(`https://hq.example.com${path}`, init);
  const url = new URL(`https://hq.example.com${path}`);
  return handleGmail(request, env, url, { fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

const UID = 'ugc-brands-agencies/babbel';
const EMAIL_LOOKUP = /SELECT uid FROM leads WHERE LOWER\(TRIM\(email\)\) = \?/;
const DOMAIN_LOOKUP = /LOWER\(TRIM\(email\)\) LIKE \?/;
const STAGE_LOOKUP = /^SELECT COALESCE\(s\.stage/;
const LEAD_SELECT = /FROM leads l LEFT JOIN lead_state/;
const STATE_INSERT = /INSERT INTO lead_state/;

/** The row patchLeadState reads before it writes. */
const leadStateRow = (stage) => ({
  uid: UID, email: 'social@lingo.example', stage, starred: 0, notes: '', follow_up: null,
  looked_at: null, sent_at: null, replied_at: null, won_at: null, passed_at: null, updated_at: null,
});

/** A db that knows one lead, sitting at `stage`. */
function dbWithLead(stage, { email = 'social@lingo.example' } = {}) {
  return fakeDb([
    { match: STAGE_LOOKUP, first: { stage } },
    { match: EMAIL_LOOKUP, first: (args) => (args[0] === email ? { uid: UID } : null) },
    { match: DOMAIN_LOOKUP, all: [] },
    { match: LEAD_SELECT, first: leadStateRow(stage) },
  ]);
}

const ROUTES = ['status', 'config', 'authorize', 'drafts', 'replies', 'activity'];
const METHOD_FOR = { status: 'GET', replies: 'GET', config: 'POST', authorize: 'POST', drafts: 'POST', activity: 'POST' };

describe('without a bridge (the deployed Worker)', () => {
  for (const route of ROUTES) {
    it(`answers 503 "needs the Mac" for ${route}, without reaching out`, async () => {
      const fetchImpl = fakeFetch();
      const res = await call(METHOD_FOR[route], `/api/gmail/${route}`, {
        env: { DB: fakeDb() },
        body: METHOD_FOR[route] === 'POST' ? {} : undefined,
        fetchImpl,
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: 'gmail needs the Mac', connected: false });
      expect(fetchImpl.calls).toHaveLength(0);
    });
  }

  it('treats a nonsense GMAIL_BRIDGE as no bridge at all', async () => {
    const fetchImpl = fakeFetch();
    const res = await call('GET', '/api/gmail/status', { env: { GMAIL_BRIDGE: 'not a url' }, fetchImpl });
    expect(res.status).toBe(503);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('never reaches the real mailbox from the demo, even with a bridge configured', async () => {
    for (const route of ROUTES) {
      const fetchImpl = fakeFetch();
      // eslint-disable-next-line no-await-in-loop -- one route at a time, each with its own recorder
      const res = await call(METHOD_FOR[route], `/api/gmail/${route}`, {
        env: { DB: fakeDb(), DEMO: 'on', GMAIL_BRIDGE: BRIDGE },
        body: METHOD_FOR[route] === 'POST' ? {} : undefined,
        fetchImpl,
      });
      expect(res.status).toBe(503);
      expect(fetchImpl.calls).toHaveLength(0);
    }
  });
});

describe('proxying to the bridge', () => {
  it('passes a status check through and returns the bridge JSON', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ configured: true, connected: true, email: 'me@gmail.com' }));
    const res = await call('GET', '/api/gmail/status', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, connected: true, email: 'me@gmail.com' });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/gmail/status`);
    expect(fetchImpl.calls[0].method).toBe('GET');
    expect(fetchImpl.calls[0].body).toBeNull();
  });

  it('posts a draft with its body and returns what Gmail gave back', async () => {
    const draft = { to: 'social@lingo.example', subject: 'Hello', body: 'text', html: '<p>text</p>', account: 'me@gmail.com' };
    const fetchImpl = fakeFetch(() => jsonResponse({ id: 'r-1', email: 'me@gmail.com', url: 'https://mail.google.com/#drafts/1' }));
    const res = await call('POST', '/api/gmail/drafts', { env: { GMAIL_BRIDGE: BRIDGE }, body: draft, fetchImpl });

    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://mail.google.com/#drafts/1');
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].method).toBe('POST');
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/gmail/drafts`);
    expect(JSON.parse(fetchImpl.calls[0].body)).toEqual(draft);
    expect(fetchImpl.calls[0].headers['Content-Type']).toBe('application/json');
  });

  it('keeps the bridge error status when Gmail refuses', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: 'The email body is empty.' }, 400));
    const res = await call('POST', '/api/gmail/drafts', { env: { GMAIL_BRIDGE: BRIDGE }, body: { subject: 'x' }, fetchImpl });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The email body is empty.');
  });

  it('asks the bridge for a consent URL with POST even when the screen uses GET', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }));
    const res = await call('GET', '/api/gmail/authorize', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });

    expect(res.status).toBe(200);
    expect(fetchImpl.calls[0].method).toBe('POST');
    expect(fetchImpl.calls[0].body).toBe('{}');
  });

  it('never proxies the OAuth callback — the redirect goes straight to the Mac', async () => {
    const fetchImpl = fakeFetch();
    const res = await call('GET', '/api/gmail/callback?code=abc', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('404s a route that is not on the list, such as one that could send', async () => {
    const fetchImpl = fakeFetch();
    for (const path of ['/api/gmail/send', '/api/gmail/messages/send', '/api/gmail/', '/api/gmail/status/x']) {
      // eslint-disable-next-line no-await-in-loop -- four quick assertions
      const res = await call('POST', path, { env: { GMAIL_BRIDGE: BRIDGE }, body: {}, fetchImpl });
      expect(res.status).toBe(404);
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('leaves paths that are not Gmail routes to the rest of the Worker', async () => {
    expect(await call('GET', '/api/leads', { env: { GMAIL_BRIDGE: BRIDGE } })).toBeNull();
  });

  it('405s a method the route does not take', async () => {
    const fetchImpl = fakeFetch();
    const res = await call('GET', '/api/gmail/drafts', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(405);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('rejects a body that is not a JSON object before anything leaves', async () => {
    const fetchImpl = fakeFetch();
    const request = new Request('https://hq.example.com/api/gmail/config', {
      method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' },
    });
    const res = await handleGmail(request, { GMAIL_BRIDGE: BRIDGE }, new URL('https://hq.example.com/api/gmail/config'), { fetchImpl });
    expect(res.status).toBe(400);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('what crosses the boundary', () => {
  it('forwards no HQ cookie and no Access header, and returns none of the bridge headers', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ connected: true }, 200, {
      'Set-Cookie': 'bridge=1', 'X-Bridge': 'yes', 'Cache-Control': 'max-age=600',
    }));
    const res = await call('POST', '/api/gmail/config', {
      env: { GMAIL_BRIDGE: BRIDGE },
      body: { installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } },
      headers: { Cookie: 'hq_session=secret', 'Cf-Access-Jwt-Assertion': 'token' },
      fetchImpl,
    });

    const sent = fetchImpl.calls[0].headers;
    const names = Object.keys(sent).map((n) => n.toLowerCase());
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('cf-access-jwt-assertion');
    expect(names).not.toContain('authorization');
    // Only what serve.py needs: JSON, from what looks like its own page.
    expect(names.sort()).toEqual(['content-type', 'origin']);
    expect(sent.Origin).toBe(BRIDGE);

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('X-Bridge')).toBeNull();
  });

  it('sends the bridge only the JSON body, never the raw request', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: '1' }));
    await call('POST', '/api/gmail/drafts', {
      env: { GMAIL_BRIDGE: BRIDGE },
      body: { to: 'a@b.com', subject: 's', body: 'b', html: '<p>b</p>' },
      headers: { 'X-Sneaky': 'value' },
      fetchImpl,
    });
    expect(Object.keys(fetchImpl.calls[0].headers)).not.toContain('X-Sneaky');
  });

  it('takes the bridge address from env only, never from the request', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ connected: true }));
    const request = new Request('https://hq.example.com/api/gmail/status', {
      headers: { 'X-Forwarded-Host': 'evil.example.com', Host: 'evil.example.com' },
    });
    const url = new URL('https://evil.example.com/api/gmail/status');
    await handleGmail(request, { GMAIL_BRIDGE: BRIDGE }, url, { fetchImpl });
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/gmail/status`);
  });
});

describe('when the Mac is not answering', () => {
  it('answers 503 on a refused connection', async () => {
    const fetchImpl = fakeFetch(() => { throw new TypeError('fetch failed: ECONNREFUSED'); });
    const res = await call('GET', '/api/gmail/status', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'gmail bridge not running', connected: false });
  });

  it('gives up on a bridge that never answers', async () => {
    const fetchImpl = fakeFetch((target, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const res = await call('GET', '/api/gmail/status', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl, timeoutMs: 5 });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('gmail bridge not running');
  });

  it('502s an answer that is not JSON at all', async () => {
    const fetchImpl = fakeFetch(() => new Response('<html>404</html>', { status: 404 }));
    const res = await call('GET', '/api/gmail/status', { env: { GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(502);
    expect((await res.json()).connected).toBe(false);
  });
});

describe('the mailbox sync writes to HQ', () => {
  const activity = (data) => fakeFetch(() => jsonResponse({ email: 'me@gmail.com', sent: {}, replied: {}, ...data }));

  it('moves a new lead to sent, stamped with the moment it was sent', async () => {
    const db = dbWithLead('new');
    const fetchImpl = activity({ sent: { 'social@lingo.example': '2026-09-19T10:00:00Z' } });
    const res = await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.unmatched).toEqual([]);

    // Read the mailbox with a GET; write the pipeline once.
    expect(fetchImpl.calls[0].method).toBe('GET');
    expect(fetchImpl.calls[0].url).toBe(`${BRIDGE}/api/gmail/activity`);
    const writes = db.calls.filter((c) => STATE_INSERT.test(c.sql));
    expect(writes).toHaveLength(1);
    expect(writes[0].args[1]).toBe('sent');
    expect(writes[0].args.at(-1)).toBe('2026-09-19T10:00:00Z');
    // Matched by address, lowercased, bound — never spliced into the SQL.
    const lookup = db.calls.find((c) => EMAIL_LOOKUP.test(c.sql));
    expect(lookup.args).toEqual(['social@lingo.example']);
    expect(lookup.sql).toContain('?');
  });

  it('records the newest send for a lead even when its stage does not move, and schedules the follow-up', async () => {
    const db = fakeDb([
      { match: STAGE_LOOKUP, first: { stage: 'talks' } },
      { match: EMAIL_LOOKUP, first: { uid: UID } },
      { match: /SELECT last_sent_at, last_reply_at, follow_up FROM lead_state/, first: { last_sent_at: null, last_reply_at: '2026-10-12T09:00:00Z', follow_up: null } },
      { match: /UPDATE lead_state SET last_sent_at/, changes: 1 },
    ]);
    const fetchImpl = activity({ sent: { 'social@lingo.example': '2026-10-14T14:11:00Z' } });
    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();
    expect(body).toMatchObject({ applied: 0, skipped: 1, updated: 1 });
    const write = db.calls.find((c) => /UPDATE lead_state SET last_sent_at/.test(c.sql));
    expect(write.args.slice(0, 3)).toEqual(['2026-10-14T14:11:00Z', '2026-10-12T09:00:00Z', '2026-10-21']);
  });

  it('refuses to drag a lead in talks back to replied', async () => {
    const db = dbWithLead('talks');
    const fetchImpl = activity({ replied: { 'social@lingo.example': '2026-09-19T11:00:00Z' } });
    const res = await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl });

    const body = await res.json();
    expect(body).toMatchObject({ applied: 0, skipped: 1, unmatched: [] });
    expect(db.calls.filter((c) => STATE_INSERT.test(c.sql))).toHaveLength(0);
  });

  it('leaves a won lead alone too', async () => {
    const db = dbWithLead('won');
    const fetchImpl = activity({ sent: { 'social@lingo.example': '2026-09-19T11:00:00Z' } });
    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();
    expect(body).toMatchObject({ applied: 0, skipped: 1 });
    expect(db.calls.filter((c) => STATE_INSERT.test(c.sql))).toHaveLength(0);
  });

  it('carries a lead the whole way when it was written to and then answered', async () => {
    let stage = 'new';
    const db = fakeDb([
      { match: STAGE_LOOKUP, first: () => ({ stage }) },
      { match: EMAIL_LOOKUP, first: { uid: UID } },
      { match: LEAD_SELECT, first: () => leadStateRow(stage) },
      { match: STATE_INSERT, changes: 1 },
    ]);
    // The fake db has no memory, so stand in for what a real write would do.
    const fetchImpl = fakeFetch(() => jsonResponse({
      email: 'me@gmail.com',
      sent: { 'social@lingo.example': '2026-09-18T09:00:00Z' },
      replied: { 'social@lingo.example': '2026-09-19T09:00:00Z' },
    }));
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = original(sql);
      if (STATE_INSERT.test(sql)) {
        const run = stmt.run.bind(stmt);
        stmt.run = async () => { stage = db.calls.at(-1).args[1]; return run(); };
      }
      return stmt;
    };

    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();
    expect(body.applied).toBe(2);
    const stages = db.calls.filter((c) => STATE_INSERT.test(c.sql)).map((c) => c.args[1]);
    expect(stages).toEqual(['sent', 'replied']);
  });

  it('matches a person at the lead\'s own domain when the address is unknown', async () => {
    const db = fakeDb([
      { match: STAGE_LOOKUP, first: { stage: 'new' } },
      { match: EMAIL_LOOKUP, first: null },
      { match: DOMAIN_LOOKUP, all: [{ uid: UID }] },
      { match: LEAD_SELECT, first: leadStateRow('new') },
    ]);
    const fetchImpl = activity({ sent: { 'Marie@Lingo.example': '2026-09-19T10:00:00Z' } });
    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();

    expect(body.applied).toBe(1);
    expect(db.calls.find((c) => DOMAIN_LOOKUP.test(c.sql)).args).toEqual(['%@lingo.example']);
  });

  it('never matches by a free-mail domain, and reports the address instead', async () => {
    const db = fakeDb([
      { match: STAGE_LOOKUP, first: { stage: 'new' } },
      { match: EMAIL_LOOKUP, first: null },
      { match: DOMAIN_LOOKUP, all: [{ uid: UID }] },
    ]);
    const fetchImpl = activity({ sent: { 'someone@gmail.com': '2026-09-19T10:00:00Z' } });
    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();

    expect(body.unmatched).toEqual(['someone@gmail.com']);
    expect(db.calls.filter((c) => DOMAIN_LOOKUP.test(c.sql))).toHaveLength(0);
  });

  it('puts an address nobody owns in unmatched, and writes nothing', async () => {
    const db = fakeDb([
      { match: STAGE_LOOKUP, first: null },
      { match: EMAIL_LOOKUP, first: null },
      { match: DOMAIN_LOOKUP, all: [] },
    ]);
    const fetchImpl = activity({ replied: { 'stranger@unknown-company.com': '2026-09-19T10:00:00Z' } });
    const body = await (await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl })).json();

    expect(body).toMatchObject({ applied: 0, skipped: 0, unmatched: ['stranger@unknown-company.com'] });
    expect(db.calls.filter((c) => STATE_INSERT.test(c.sql))).toHaveLength(0);
  });

  it('passes a bridge complaint (no token yet) straight through', async () => {
    const db = fakeDb();
    const fetchImpl = fakeFetch(() => jsonResponse({ error: 'Connect Gmail in Gmail setup first.' }, 409));
    const res = await call('POST', '/api/gmail/activity', { env: { DB: db, GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(409);
    expect(db.calls).toHaveLength(0);
  });

  it('is a POST — reading the mailbox changes HQ, so it is not a GET', async () => {
    const fetchImpl = fakeFetch();
    const res = await call('GET', '/api/gmail/activity', { env: { DB: fakeDb(), GMAIL_BRIDGE: BRIDGE }, fetchImpl });
    expect(res.status).toBe(405);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('wiring', () => {
  const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('runs the Gmail routes after authenticate(), behind the Access gate', () => {
    const source = read('../src/worker/index.js');
    const gmailIdx = source.indexOf('handleGmail(request');
    const authIdx = source.indexOf('authenticate(');
    expect(gmailIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(gmailIdx).toBeGreaterThan(authIdx);
  });

  it('leaves Gmail to api/gmail.js — workspace.js no longer shadows it', () => {
    const source = read('../src/worker/api/workspace.js');
    expect(source).not.toContain('/api/gmail/');
    expect(source).not.toContain('LOCAL_GMAIL_URL');
  });

  it('has no send route anywhere in the Gmail module', () => {
    const source = read('../src/worker/api/gmail.js');
    expect(source).not.toMatch(/['"`]send['"`]/);
    expect(source).not.toContain('messages/send');
  });

  it('keeps GMAIL_BRIDGE out of wrangler.jsonc, so the deployed Worker has none', () => {
    expect(read('../wrangler.jsonc')).not.toContain('GMAIL_BRIDGE');
  });
});
