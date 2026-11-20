import { describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { setHqTimeZone } from '../src/worker/db.js';
import { saveSender } from '../src/worker/outreach.js';
import { buildDailyDraft, canonicalRows, draftHash, editDraft } from '../src/worker/outreach-drafts.js';
import { approveDailyDraft, exportDailyDraft } from '../src/worker/outreach-review.js';

const now = new Date('2026-11-18T15:00:00Z');
async function fixture(fn) {
  const { database: db, dispose } = await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-demo', 'Plastic surgeons', 'Fictional demo', 70, 50, 'x')").run();
    for (const id of ['a', 'b']) await db.prepare(`
      INSERT INTO leads (uid, dataset, id, business, name, website, category, country, languages, email, score, tier, payload, imported_at)
      VALUES (?, 'plastic-surgeons-demo', ?, 'Plastic surgeons', 'Robin Example', '', 'No site', 'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')
    `).bind(`plastic-surgeons-demo/${id}`, id, `${id}@example.com`).run();
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: false });
    await fn(db);
  } finally { await dispose(); }
}
const build = (db) => buildDailyDraft(db, { day: '2026-11-18', sender: 'demo@example.com' }, now);
const pythonCheck = (row, firstTouch) => {
  for (const key of ['email', 'subject', 'text', ...(firstTouch ? [] : ['in_reply_to'])]) expect(typeof row[key] === 'string' && Boolean(row[key].trim())).toBe(true);
  expect(row.text.includes('{{') || (row.text.includes('{') && row.text.includes('}'))).toBe(false);
  expect(/^\s*(re|tr|fw|fwd|aw|wg|antw)\s*:/i.test(row.subject)).toBe(false);
  if (firstTouch) expect(row.in_reply_to).toBeUndefined();
  else expect(row.in_reply_to.startsWith('<') && row.in_reply_to.endsWith('>')).toBe(true);
};

describe('canonical review and export', () => {
  it('uses fixed canonical keys, stable row order, and a text-sensitive hash', async () => {
    const a = { uid: 'demo/a', recipient: 'a@example.com', subject: 'A', body: 'Exact text\n', step: 1 };
    const b = { uid: 'demo/b', recipient: 'b@example.com', subject: 'B', body: 'Other', step: 2, in_reply_to: '<first@example.com>' };
    expect(Object.keys(canonicalRows([a], '2026-11-18')[0])).toEqual(['email', 'subject', 'text', 'in_reply_to', 'uids', 'day']);
    expect(await draftHash([a, b], '2026-11-18')).toBe(await draftHash([b, a], '2026-11-18'));
    expect(await draftHash([a, b], '2026-11-18')).not.toBe(await draftHash([{ ...a, body: a.body + ' ' }, b], '2026-11-18'));
  });
  it('approves the canonical hash, exports exact bytes, and an edit clears approval and reservations', () => fixture(async (db) => {
    const batch = await build(db);
    await expect(exportDailyDraft(db, batch.id)).rejects.toThrow(/approved/);
    const approved = await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    expect(approved.status).toBe('approved');
    const exported = await exportDailyDraft(db, batch.id);
    expect(exported.files).toHaveLength(1);
    expect(exported.files[0].kind).toBe('first-touch');
    for (const row of JSON.parse(exported.files[0].content).rows) pythonCheck(row, true);
    expect(exported.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.row_hashes[batch.items[0].uid]).toMatch(/^[a-f0-9]{64}$/);
    const changed = await editDraft(db, batch.id, { content_hash: batch.content_hash, uid: batch.items[0].uid, subject: batch.items[0].subject, body: batch.items[0].body + '\nExplicit edit' });
    expect(changed.status).toBe('draft');
    expect(changed.approved_at).toBeNull();
    expect(changed.approved_by).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outreach_reservations WHERE batch_id = ?').bind(batch.id).first()).n).toBe(0);
    await expect(exportDailyDraft(db, batch.id)).rejects.toThrow(/approved/);
  }));
  it('blocks changed lead state and paused senders without reserving capacity', () => fixture(async (db) => {
    const batch = await build(db);
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: true });
    await expect(approveDailyDraft(db, batch.id, batch.content_hash, 'Demo', now)).rejects.toThrow(/paused/);
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: false });
    await db.prepare("INSERT INTO lead_state (uid, stage, last_reply_at, updated_at) VALUES ('plastic-surgeons-demo/a', 'replied', '2026-11-18T14:00:00Z', 'x')").run();
    await expect(approveDailyDraft(db, batch.id, batch.content_hash, 'Demo', now)).rejects.toThrow(/conversation/);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outreach_reservations').first()).n).toBe(0);
  }));
  it('holds a follow-up with no provider message id rather than reconstructing one', () => fixture(async (db) => {
    await db.prepare("INSERT INTO lead_events (uid, kind, at, subject, sender, sent_to, detail) VALUES ('plastic-surgeons-demo/a', 'sent', '2026-10-01T12:00:00Z', 'Actual original', 'demo@example.com', 'a@example.com', 'Legacy report without an id')").run();
    await db.prepare("INSERT INTO lead_state (uid, stage, follow_up, last_sent_at, updated_at) VALUES ('plastic-surgeons-demo/a', 'sent', '2026-11-18', '2026-10-01T12:00:00Z', 'x')").run();
    const batch = await build(db);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo', now);
    const exported = await exportDailyDraft(db, batch.id);
    expect(exported.files.map((file) => file.kind)).toEqual(['first-touch']);
    expect(exported.held[0].reasons).toContain('unknown_original_message_id');
  }));
  it('splits first touches and follow-ups, holding unknown or different first senders', () => fixture(async (db) => {
    await db.prepare("INSERT INTO lead_events (uid, kind, at, subject, sender, sent_to, detail) VALUES ('plastic-surgeons-demo/a', 'sent', '2026-10-01T12:00:00Z', 'Actual original', 'demo@example.com', 'a@example.com', 'message <original@example.com>')").run();
    await db.prepare("INSERT INTO lead_state (uid, stage, follow_up, last_sent_at, updated_at) VALUES ('plastic-surgeons-demo/a', 'sent', '2026-11-18', '2026-10-01T12:00:00Z', 'x')").run();
    const batch = await build(db);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo', now);
    const exported = await exportDailyDraft(db, batch.id);
    expect(exported.files.map((file) => file.kind)).toEqual(['first-touch', 'followups']);
    for (const file of exported.files) for (const row of JSON.parse(file.content).rows) pythonCheck(row, file.kind === 'first-touch');
    await db.prepare("UPDATE lead_events SET sender = NULL WHERE uid = 'plastic-surgeons-demo/a'").run();
    expect((await exportDailyDraft(db, batch.id)).held[0].reasons).toContain('unknown_first_sender');
    await db.prepare("UPDATE lead_events SET sender = 'other@example.com' WHERE uid = 'plastic-surgeons-demo/a'").run();
    expect((await exportDailyDraft(db, batch.id)).held[0].reasons).toContain('different_first_sender');
  }));
});
