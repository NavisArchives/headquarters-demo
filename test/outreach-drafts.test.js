import { describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { buildDailyDraft, editDraft, readDraft } from '../src/worker/outreach-drafts.js';
import { saveSender } from '../src/worker/outreach.js';
import { setHqTimeZone } from '../src/worker/db.js';
import { handleOutreach } from '../src/worker/api/outreach.js';
import { composeLead } from '../src/worker/lead-compose.js';

const now = new Date('2026-11-18T15:00:00Z');
async function fixture(fn) {
  const { database: db, dispose } = await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    await db.prepare(`
      INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
      VALUES ('plastic-surgeons-demo', 'Plastic surgeons', 'Fictional demo', 70, 50, 'x')
    `).run();
    for (const id of ['a', 'b', 'c', 'd']) {
      await db.prepare(`
        INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
          languages, email, score, tier, payload, imported_at)
        VALUES (?, 'plastic-surgeons-demo', ?, 'Plastic surgeons', 'Robin Example', '', 'No site',
          'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')
      `).bind(`plastic-surgeons-demo/${id}`, id, `${id}@example.com`).run();
    }
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: true });
    await fn(db);
  } finally { await dispose(); }
}
const build = (db) => buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-18' }, now);

async function call(db, path, method = 'GET', body) {
  const request = new Request(`https://hq.test${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleOutreach(request, { DB: db }, new URL(request.url), {}, now);
}

describe('persisted daily drafts', () => {
  it('builds through the API and survives a paused sender save and an API reload', () => fixture(async (db) => {
    const response = await call(db, '/api/outreach/batches/build', 'POST', { sender: 'demo@example.com', day: '2026-11-18' });
    expect(response.status).toBe(201);
    const { batch } = await response.json();
    expect(batch.items).toHaveLength(2);
    expect((await call(db, '/api/outreach/senders', 'PUT', { email: 'demo@example.com', daily_limit: 5, paused: true })).status).toBe(200);
    const refreshed = await (await call(db, `/api/outreach/batches/${batch.id}`)).json();
    expect(refreshed.batch.items).toHaveLength(2);
    const changed = await call(db, `/api/outreach/batches/${batch.id}`, 'PATCH', {
      uid: batch.items[0].uid, content_hash: batch.content_hash, subject: 'A saved edit', body: 'Saved exact copy.\n',
    });
    expect(changed.status).toBe(200);
    const again = await (await call(db, `/api/outreach/batches/${batch.id}`)).json();
    expect(again.batch.items.find((row) => row.uid === batch.items[0].uid).body).toBe('Saved exact copy.\n');
  }));

  it('stores verbatim compose copy and survives sender settings, reload, editing and removing', () => fixture(async (db) => {
    const batch = await build(db);
    expect(batch.items).toHaveLength(2);
    const lead = await db.prepare('SELECT * FROM leads WHERE uid = ?').bind(batch.items[0].uid).first();
    const composed = await composeLead(db, lead, { mode: 'email', lang: 'EN' }, now);
    expect(batch.items[0].body).toBe(composed.body);
    await saveSender(db, { email: 'demo@example.com', daily_limit: 10, paused: true });
    expect((await readDraft(db, batch.id)).items).toEqual(batch.items);
    const edited = await editDraft(db, batch.id, { uid: batch.items[0].uid, content_hash: batch.content_hash,
      subject: 'Explicitly edited subject', body: 'Explicitly edited body.\n' });
    expect(edited.items[0].body).toBe('Explicitly edited body.\n');
    expect(edited.content_hash).not.toBe(batch.content_hash);
    expect((await readDraft(db, batch.id)).items[0].subject).toBe('Explicitly edited subject');
    const removed = await editDraft(db, batch.id, { uid: edited.items[0].uid, content_hash: edited.content_hash, remove: true });
    expect(removed.items).toHaveLength(1);
    await expect(editDraft(db, batch.id, { uid: removed.items[0].uid, content_hash: batch.content_hash, remove: true })).rejects.toThrow(/changed/);
  }));

  it('does not rebuild leads already held in an open batch', () => fixture(async (db) => {
    const first = await build(db);
    const second = await build(db);
    expect(second.items.map((row) => row.uid).some((uid) => first.items.some((row) => row.uid === uid))).toBe(false);
    expect(second.skipped.filter((row) => row.reasons.includes('already_in_open_batch'))).toHaveLength(2);
  }));
});
