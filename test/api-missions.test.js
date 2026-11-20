import { describe, it, expect } from 'vitest';
import { handleMissions } from '../src/worker/api/missions.js';

function fakeDb(responses = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: responses.all ?? [] }; },
        async first() { return responses.first ?? null; },
        async run() { return { success: true, meta: { changes: responses.changes ?? 1 } }; },
      };
      return stmt;
    },
  };
}

const mission = { id: 1, title: 'Send the unsent invoices', detail: '', slug: 'leads',
  status: 'pending', blocked_on: null, due: null, position: 0,
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z', done_at: null };

function call(method, path, body, db) {
  const url = new URL(`https://hq.example.com${path}`);
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return handleMissions(new Request(url, init), { DB: db }, url);
}

describe('routing', () => {
  it('ignores paths that are not missions routes', async () => {
    expect(await call('GET', '/api/status', undefined, fakeDb())).toBeNull();
  });

  it('405s an unsupported method on the collection', async () => {
    const res = await call('PUT', '/api/missions', {}, fakeDb());
    expect(res.status).toBe(405);
  });

  it('404s a non-numeric id', async () => {
    const res = await call('PATCH', '/api/missions/abc', { title: 'x' }, fakeDb());
    expect(res.status).toBe(404);
  });
});

describe('GET /api/missions', () => {
  it('returns the list', async () => {
    const res = await call('GET', '/api/missions', undefined, fakeDb({ all: [mission] }));
    expect(res.status).toBe(200);
    expect((await res.json()).missions).toHaveLength(1);
  });

  it('passes a status filter through', async () => {
    const db = fakeDb({ all: [] });
    await call('GET', '/api/missions?status=blocked', undefined, db);
    expect(db.calls[0].args).toContain('blocked');
  });

  it('400s an invalid status filter', async () => {
    const res = await call('GET', '/api/missions?status=sideways', undefined, fakeDb());
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('status');
  });

  it('never caches', async () => {
    const res = await call('GET', '/api/missions', undefined, fakeDb({ all: [] }));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('POST /api/missions', () => {
  it('creates and returns 201', async () => {
    const res = await call('POST', '/api/missions', { title: 'Send the unsent invoices' }, fakeDb({ first: mission }));
    expect(res.status).toBe(201);
    expect((await res.json()).mission.title).toBe('Send the unsent invoices');
  });

  it('400s an empty title, naming the field', async () => {
    const res = await call('POST', '/api/missions', { title: '' }, fakeDb());
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('title');
  });

  it('400s a blocked mission with no reason', async () => {
    const res = await call('POST', '/api/missions', { title: 'x', status: 'blocked' }, fakeDb());
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('blocked_on');
  });

  it('400s a body that is not JSON', async () => {
    const url = new URL('https://hq.example.com/api/missions');
    const res = await handleMissions(
      new Request(url, { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } }),
      { DB: fakeDb() }, url,
    );
    expect(res.status).toBe(400);
  });

  it('400s a body that is not an object', async () => {
    const res = await call('POST', '/api/missions', ['nope'], fakeDb());
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/missions/:id', () => {
  it('updates and returns the row', async () => {
    const res = await call('PATCH', '/api/missions/1', { status: 'done' }, fakeDb({ first: { ...mission, status: 'done' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).mission.status).toBe('done');
  });

  it('404s a row that does not exist', async () => {
    const res = await call('PATCH', '/api/missions/999', { title: 'x' }, fakeDb({ first: null }));
    expect(res.status).toBe(404);
  });

  it('400s an empty patch', async () => {
    const res = await call('PATCH', '/api/missions/1', {}, fakeDb());
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/missions/:id', () => {
  it('returns 204 when a row went', async () => {
    const res = await call('DELETE', '/api/missions/1', undefined, fakeDb({ changes: 1 }));
    expect(res.status).toBe(204);
  });

  it('404s when nothing was deleted', async () => {
    const res = await call('DELETE', '/api/missions/1', undefined, fakeDb({ changes: 0 }));
    expect(res.status).toBe(404);
  });
});

describe('failures', () => {
  it('500s a database error without leaking the query', async () => {
    const db = { prepare() { throw new Error('D1_ERROR: near "SELECT": syntax error at offset 42'); } };
    const res = await call('GET', '/api/missions', undefined, db);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('SELECT');
    expect(body).not.toContain('D1_ERROR');
  });
});
