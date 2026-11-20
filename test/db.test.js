import { describe, it, expect, beforeEach } from 'vitest';
import {
  nowIso, listMissions, getMission, createMission, updateMission, deleteMission,
  ValidationError, MISSION_STATUSES,
} from '../src/worker/db.js';

/**
 * A stand-in for the D1 binding. It records every statement and its bindings,
 * so a test can assert that values were bound rather than interpolated.
 */
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
        async run() { return { success: true, meta: { last_row_id: responses.lastId ?? 1, changes: responses.changes ?? 1 } }; },
      };
      return stmt;
    },
  };
}

const row = (over = {}) => ({
  id: 1, title: 'Send the unsent invoices', detail: '', slug: 'leads',
  status: 'pending', blocked_on: null, due: null, position: 0,
  created_at: '2026-09-20T10:00:00.000Z', updated_at: '2026-09-20T10:00:00.000Z',
  done_at: null, ...over,
});

describe('nowIso', () => {
  it('produces a UTC ISO string', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('MISSION_STATUSES', () => {
  it('is exactly the documented statuses, proposal first', () => {
    expect([...MISSION_STATUSES]).toEqual(['proposed', 'pending', 'in_progress', 'blocked', 'done']);
  });
});

describe('listMissions', () => {
  it('returns rows', async () => {
    const db = fakeDb({ all: [row()] });
    expect(await listMissions(db)).toHaveLength(1);
  });

  it('binds a status filter rather than interpolating it', async () => {
    const db = fakeDb({ all: [] });
    await listMissions(db, { status: 'blocked' });
    expect(db.calls[0].sql).toContain('?');
    expect(db.calls[0].sql).not.toContain("'blocked'");
    expect(db.calls[0].args).toContain('blocked');
  });

  it('binds a project filter', async () => {
    const db = fakeDb({ all: [] });
    await listMissions(db, { slug: 'realis-studio' });
    expect(db.calls[0].args).toContain('realis-studio');
  });

  it('rejects an unknown status filter instead of querying', async () => {
    const db = fakeDb({ all: [] });
    await expect(listMissions(db, { status: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });
});

describe('createMission', () => {
  it('needs only a title', async () => {
    const db = fakeDb({ first: row() });
    const m = await createMission(db, { title: 'Send the unsent invoices' });
    expect(m.title).toBe('Send the unsent invoices');
  });

  it('rejects an empty title', async () => {
    const db = fakeDb();
    await expect(createMission(db, { title: '   ' })).rejects.toMatchObject({ field: 'title' });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a missing title', async () => {
    const db = fakeDb();
    await expect(createMission(db, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it('trims the title', async () => {
    const db = fakeDb({ first: row() });
    await createMission(db, { title: '  padded  ' });
    expect(db.calls[0].args).toContain('padded');
  });

  it('rejects a title longer than 200 characters', async () => {
    const db = fakeDb();
    await expect(createMission(db, { title: 'x'.repeat(201) })).rejects.toMatchObject({ field: 'title' });
  });

  it('refuses to create a blocked mission with no reason', async () => {
    const db = fakeDb();
    await expect(createMission(db, { title: 'x', status: 'blocked' }))
      .rejects.toMatchObject({ field: 'blocked_on' });
    expect(db.calls).toHaveLength(0);
  });

  it('accepts a blocked mission that says what blocks it', async () => {
    const db = fakeDb({ first: row({ status: 'blocked', blocked_on: 'waiting on the accountant' }) });
    const m = await createMission(db, { title: 'x', status: 'blocked', blocked_on: 'waiting on the accountant' });
    expect(m.status).toBe('blocked');
  });

  it('binds every value rather than interpolating', async () => {
    const db = fakeDb({ first: row() });
    await createMission(db, { title: "Robert'); DROP TABLE missions;--" });
    expect(db.calls[0].sql).not.toContain('DROP TABLE');
    expect(db.calls[0].args).toContain("Robert'); DROP TABLE missions;--");
  });
});

describe('updateMission', () => {
  it('sets done_at when a mission becomes done', async () => {
    const db = fakeDb({ first: row({ status: 'done' }) });
    await updateMission(db, 1, { status: 'done' });
    // A status change first reads the current one (a proposal may only be
    // accepted), so the write is the statement after it.
    expect(db.calls.at(-1).sql).toContain('done_at');
  });

  it('clears done_at when a done mission reopens', async () => {
    const db = fakeDb({ first: row({ status: 'pending' }) });
    await updateMission(db, 1, { status: 'pending' });
    const write = db.calls.at(-1);
    expect(write.sql).toContain('done_at');
    expect(write.args).toContain(null);
  });

  it('refuses to block a mission with no reason', async () => {
    const db = fakeDb();
    await expect(updateMission(db, 1, { status: 'blocked' })).rejects.toMatchObject({ field: 'blocked_on' });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an unknown status', async () => {
    const db = fakeDb();
    await expect(updateMission(db, 1, { status: 'sideways' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an empty patch rather than writing nothing', async () => {
    const db = fakeDb();
    await expect(updateMission(db, 1, {})).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('ignores fields a caller may not set', async () => {
    const db = fakeDb({ first: row() });
    await updateMission(db, 1, { title: 'new', id: 99, created_at: 'forged' });
    const setClause = db.calls[0].sql.split('WHERE')[0];
    expect(setClause).not.toContain('created_at');
    expect(db.calls[0].args).not.toContain('forged');
  });

  it('always advances updated_at', async () => {
    const db = fakeDb({ first: row() });
    await updateMission(db, 1, { title: 'new' });
    expect(db.calls[0].sql).toContain('updated_at');
  });

  it('returns null when the row does not exist', async () => {
    const db = fakeDb({ first: null });
    expect(await updateMission(db, 999, { title: 'x' })).toBeNull();
  });
});

describe('getMission and deleteMission', () => {
  it('gets one row by bound id', async () => {
    const db = fakeDb({ first: row() });
    const m = await getMission(db, 1);
    expect(m.id).toBe(1);
    expect(db.calls[0].args).toContain(1);
  });

  it('returns null for a missing row', async () => {
    const db = fakeDb({ first: null });
    expect(await getMission(db, 42)).toBeNull();
  });

  it('reports whether a delete removed anything', async () => {
    expect(await deleteMission(fakeDb({ changes: 1 }), 1)).toBe(true);
    expect(await deleteMission(fakeDb({ changes: 0 }), 1)).toBe(false);
  });

  it('rejects a non-integer id rather than querying', async () => {
    const db = fakeDb();
    await expect(getMission(db, '1; DROP TABLE missions')).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });
});
