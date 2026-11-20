import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { handleTodos } from '../src/worker/api/todos.js';
import {
  buildCalendar, foldLine, icsText, handleCalendarFeed, feedUrl,
} from '../src/worker/calendar.js';

/**
 * To-dos (migration 0015) and the private calendar feed. Run on the engine
 * production uses — workerd's SQLite through Miniflare — so the CHECKs, the
 * unique import key and ON DELETE SET NULL are the real ones.
 */
async function withDatabase(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare(
      `INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
       VALUES ('clinics-belgium', 'Web design', 'Clinics', 70, 50, '2026-10-14T00:00:00Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
       VALUES ('clinics-belgium/morel', 'clinics-belgium', 'morel', 'Web design', 'Clinique Morel', 'https://example.com',
               'Clinic', 'BE', 'info@morel.example', 80, 'Hot', '{}', '2026-10-14T00:00:00Z')`,
    ).run();
    await fn(database);
  } finally {
    await dispose();
  }
}

const call = (database, method, path, body) => {
  const url = new URL(`http://localhost:8790${path}`);
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  // localhost:8790 is the demo, which hands out its own feed address.
  return handleTodos(new Request(url, init), { DB: database }, url, { demo: true });
};

describe('a to-do', () => {
  it('is made with a title, and may carry a date, a mission, a lead and a note', async () => {
    await withDatabase(async (database) => {
      const mission = await db.createMission(database, { title: 'Move to Lima', due: '2026-11-01' });
      const todo = await db.createTodo(database, {
        title: '  Travel clinic: yellow fever  ', due: '2026-10-20', mission_id: mission.id,
        lead_uid: 'clinics-belgium/morel', note: 'Ten days before Tarapoto',
      });
      expect(todo).toMatchObject({
        title: 'Travel clinic: yellow fever', due: '2026-10-20', mission_id: mission.id, mission_title: 'Move to Lima',
        lead_uid: 'clinics-belgium/morel', lead_name: 'Clinique Morel', note: 'Ten days before Tarapoto', done_at: null,
      });
      const bare = await db.createTodo(database, { title: 'Book the flight Lima → Tarapoto' });
      expect(bare).toMatchObject({ due: null, mission_id: null, lead_uid: null, note: '' });
    });
  });

  it('refuses an empty title, a date that does not exist, and a mission or lead that is not there', async () => {
    await withDatabase(async (database) => {
      await expect(db.createTodo(database, { title: '   ' })).rejects.toThrow('title is required');
      await expect(db.createTodo(database, { title: 'x', due: '2026-02-30' })).rejects.toThrow('due must be a date');
      await expect(db.createTodo(database, { title: 'x', due: '20 Oct' })).rejects.toThrow('due must be a date');
      await expect(db.createTodo(database, { title: 'x', mission_id: 999 })).rejects.toThrow('no such mission');
      await expect(db.createTodo(database, { title: 'x', lead_uid: 'nobody/none' })).rejects.toThrow('no such lead');
      expect(await db.listTodos(database)).toEqual([]);
    });
  });

  it('lists the open ones soonest first, the undated after, the ticked-off last', async () => {
    await withDatabase(async (database) => {
      const late = await db.createTodo(database, { title: 'Passport', due: '2026-10-28' });
      const none = await db.createTodo(database, { title: 'Flight' });
      const soon = await db.createTodo(database, { title: 'Clinic', due: '2026-10-20' });
      const done = await db.createTodo(database, { title: 'eSIM', due: '2026-10-19' });
      await db.updateTodo(database, done.id, { done: true });
      expect((await db.listTodos(database)).map((t) => t.title)).toEqual(['Clinic', 'Passport', 'Flight', 'eSIM']);
      expect((await db.listTodos(database, { open: true })).map((t) => t.id)).toEqual([soon.id, late.id, none.id]);
    });
  });

  it('keeps the first time it was ticked off, and comes back when unticked', async () => {
    await withDatabase(async (database) => {
      const todo = await db.createTodo(database, { title: 'Clinic' });
      const first = await db.updateTodo(database, todo.id, { done: true });
      expect(first.done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const again = await db.updateTodo(database, todo.id, { done: true });
      expect(again.done_at).toBe(first.done_at);
      const back = await db.updateTodo(database, todo.id, { done: false });
      expect(back.done_at).toBeNull();
      await expect(db.updateTodo(database, todo.id, { done: 'yes' })).rejects.toThrow('done must be true or false');
      await expect(db.updateTodo(database, todo.id, {})).rejects.toThrow('nothing to update');
    });
  });

  it('outlives its mission: deleting the mission leaves the to-do, on its own', async () => {
    await withDatabase(async (database) => {
      const mission = await db.createMission(database, { title: 'Move to Lima' });
      const todo = await db.createTodo(database, { title: 'Passport', mission_id: mission.id });
      await db.deleteMission(database, mission.id);
      expect(await db.getTodo(database, todo.id)).toMatchObject({ title: 'Passport', mission_id: null });
    });
  });

  it('is imported once: the same source twice adds nothing', async () => {
    await withDatabase(async (database) => {
      const insert = () => database.prepare(
        `INSERT INTO todos (title, due, source, created_at, updated_at)
         VALUES ('Travel clinic', '2026-10-20', 'roadmap:c-clinic', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')
         ON CONFLICT(source) WHERE source IS NOT NULL DO NOTHING`,
      ).run();
      await insert();
      await insert();
      expect(await db.listTodos(database)).toHaveLength(1);
    });
  });
});

describe('/api/todos', () => {
  it('makes, changes, ticks and deletes a to-do', async () => {
    await withDatabase(async (database) => {
      const made = await call(database, 'POST', '/api/todos', { title: 'Passport', due: '2026-10-28' });
      expect(made.status).toBe(201);
      const { todo } = await made.json();

      const changed = await call(database, 'PATCH', `/api/todos/${todo.id}`, { due: '2026-10-27', done: true });
      expect((await changed.json()).todo).toMatchObject({ due: '2026-10-27' });

      const open = await (await call(database, 'GET', '/api/todos?open=1')).json();
      expect(open.todos).toEqual([]);
      const all = await (await call(database, 'GET', '/api/todos')).json();
      expect(all.todos.map((t) => t.title)).toEqual(['Passport']);

      expect((await call(database, 'DELETE', `/api/todos/${todo.id}`)).status).toBe(204);
      expect((await call(database, 'DELETE', `/api/todos/${todo.id}`)).status).toBe(404);
    });
  });

  it('answers a bad date with the field it is about, and leaves other paths alone', async () => {
    await withDatabase(async (database) => {
      const bad = await call(database, 'POST', '/api/todos', { title: 'x', due: 'tomorrow' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ field: 'due' });
      expect(await call(database, 'GET', '/api/missions')).toBeNull();
    });
  });

  it('keeps one mission’s to-dos with ?mission=', async () => {
    await withDatabase(async (database) => {
      const mission = await db.createMission(database, { title: 'Move to Lima' });
      await db.createTodo(database, { title: 'Passport', mission_id: mission.id });
      await db.createTodo(database, { title: 'Something else' });
      const body = await (await call(database, 'GET', `/api/todos?mission=${mission.id}`)).json();
      expect(body.todos.map((t) => t.title)).toEqual(['Passport']);
      expect((await call(database, 'GET', '/api/todos?mission=abc')).status).toBe(400);
    });
  });
});

describe('the calendar feed', () => {
  it('keeps one secret address until a new one is asked for', async () => {
    await withDatabase(async (database) => {
      const first = await (await call(database, 'GET', '/api/calendar/link')).json();
      const again = await (await call(database, 'GET', '/api/calendar/link')).json();
      expect(again.url).toBe(first.url);
      expect(first.url).toMatch(/^http:\/\/localhost:8790\/cal\/[0-9a-f]{48}\.ics$/);
      expect(first.google).toContain(encodeURIComponent('webcal://localhost:8790/cal/'));
      const fresh = await (await call(database, 'POST', '/api/calendar/link')).json();
      expect(fresh.url).not.toBe(first.url);
    });
  });

  it('serves the deadlines to the right token only, and 404s for any other', async () => {
    await withDatabase(async (database) => {
      const mission = await db.createMission(database, { title: 'Move to Lima', due: '2026-11-01' });
      await db.createTodo(database, { title: 'Travel clinic, yellow fever', due: '2026-10-20', mission_id: mission.id });
      await db.createTodo(database, { title: 'Undated' });
      const ticked = await db.createTodo(database, { title: 'Ticked off', due: '2026-10-19' });
      await db.updateTodo(database, ticked.id, { done: true });
      const token = await db.calendarToken(database);

      const feed = (path) => {
        const url = new URL(`https://hq.example.com${path}`);
        return handleCalendarFeed(new Request(url), { DB: database }, url);
      };
      const ok = await feed(`/cal/${token}.ics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Content-Type')).toContain('text/calendar');
      const body = await ok.text();
      expect(body).toContain('SUMMARY:Travel clinic\\, yellow fever');
      expect(body).toContain('DTSTART;VALUE=DATE:20261020');
      expect(body).toContain('SUMMARY:Mission due: Move to Lima');
      expect(body).not.toContain('Undated');
      expect(body).not.toContain('Ticked off');

      expect((await feed(`/cal/${'0'.repeat(48)}.ics`)).status).toBe(404);
      expect((await feed(`/cal/${token.slice(0, -1)}.ics`)).status).toBe(404);
      expect(await feed('/api/todos')).toBeNull();
    });
  });

  it('serves nothing before an address was ever made', async () => {
    await withDatabase(async (database) => {
      const url = new URL(`https://hq.example.com/cal/${'a'.repeat(48)}.ics`);
      expect((await handleCalendarFeed(new Request(url), { DB: database }, url)).status).toBe(404);
    });
  });

  it('leaves a lead’s mission out: those move with the mail and live in HQ', async () => {
    await withDatabase(async (database) => {
      await database.prepare(
        `INSERT INTO missions (title, status, due, lead_uid, created_at, updated_at)
         VALUES ('Clinique Morel — your turn', 'pending', '2026-10-16', 'clinics-belgium/morel', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`,
      ).run();
      const items = await db.calendarItems(database);
      expect(items.missions).toEqual([]);
    });
  });
});

describe('the iCalendar text', () => {
  it('escapes what RFC 5545 asks for', () => {
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldLine(line);
    const encoder = new TextEncoder();
    for (const part of folded.split('\r\n')) expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('writes one all-day event per deadline, ending the next day', () => {
    const text = buildCalendar({ todos: [{ id: 7, title: 'Passport', due: '2026-10-31' }] }, Date.UTC(2026, 9, 15));
    expect(text).toContain('UID:todo-7@hq.example.com');
    expect(text).toContain('DTSTART;VALUE=DATE:20261031');
    expect(text).toContain('DTEND;VALUE=DATE:20261101');
    expect(text).toContain('DTSTAMP:20261015T000000Z');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it('gives the online address from the local HQ, and the demo keeps its own', () => {
    expect(feedUrl('abc', 'http://localhost:8787')).toBe('https://hq.example.com/cal/abc.ics');
    expect(feedUrl('abc', 'http://localhost:8790', { demo: true })).toBe('http://localhost:8790/cal/abc.ics');
    expect(feedUrl('abc', 'https://hq.example.com')).toBe('https://hq.example.com/cal/abc.ics');
  });
});
