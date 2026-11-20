import { it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { setHqTimeZone } from '../src/worker/db.js';
import { saveSender } from '../src/worker/outreach.js';
import { buildDailyDraft, editDraft } from '../src/worker/outreach-drafts.js';
import { approveDailyDraft } from '../src/worker/outreach-review.js';
import { saveVerification, logVerifiedDelivered } from '../src/worker/outreach-verification.js';

it('logs only provider-confirmed delivery through intake once and retains actual subject/template/batch', async () => {
  const { database: db, dispose } = await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('plastic-surgeons-demo','Plastic surgeons','Demo',70,50,'x')").run();
    for (const id of ['a', 'b']) await db.prepare(`
      INSERT INTO leads (uid,dataset,id,business,name,website,category,country,languages,email,score,tier,payload,imported_at)
      VALUES (?,'plastic-surgeons-demo',?,'Plastic surgeons','Robin Example','','No site','Belgium','["EN"]',?,80,'Hot','{}','x')
    `).bind(`plastic-surgeons-demo/${id}`,id,`${id}@example.com`).run();
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: false });
    const now = new Date('2026-11-18T15:00:00Z');
    const batch = await buildDailyDraft(db, { day: '2026-11-18', sender: 'demo@example.com' }, now);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    const sendLog = batch.items.map((item, i) => ({ uids: [item.uid], status: 201, messageId: `<demo-${i}@example.com>` }));
    const delivery = [{ messageId: sendLog[0].messageId, event: 'delivered', date: '2026-11-19T14:00:00Z' }];
    const proof = await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog, events: delivery }, now);
    expect(proof.summary.counts.delivered).toBe(1);
    await expect(editDraft(db, batch.id, { content_hash: batch.content_hash, uid: batch.items[0].uid, subject: 'Changed', body: 'Changed' })).rejects.toThrow(/verified/);
    const first = await logVerifiedDelivered(db, batch.id, batch.content_hash, new Date('2026-11-19T15:00:00Z'));
    expect(first).toMatchObject({ filed: 1, duplicates: 0, failed: [] });
    const again = await logVerifiedDelivered(db, batch.id, batch.content_hash, new Date('2026-11-19T15:00:00Z'));
    expect(again).toMatchObject({ filed: 0, duplicates: 1, failed: [] });
    const events = (await db.prepare("SELECT uid,subject,template,batch,body FROM lead_events WHERE kind='sent'").all()).results;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ uid: batch.items[0].uid, subject: batch.items[0].subject, template: batch.items[0].template, batch: batch.id, body: batch.items[0].body.trim() });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outreach_reservations WHERE batch_id = ?').bind(batch.id).first()).n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM intake_requests WHERE source = 'hq'").first()).n).toBe(1);
    await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog,
      events: [{ messageId: sendLog[1].messageId, event: 'hard_bounce', date: '2026-11-19T14:00:00Z' }] }, now);
    const partial = await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: [sendLog[0]], events: delivery }, now);
    expect(partial.summary.counts.hard_bounce).toBe(1);
    expect(partial.summary.failed).toBe(true);
    await expect(logVerifiedDelivered(db, batch.id, batch.content_hash, now, 0, proof.verification_id)).rejects.toThrow(/evidence changed/);
    await expect(saveVerification(db, batch.id, { content_hash: batch.content_hash,
      send_log: [{ ...sendLog[0], messageId: '<different@example.com>' }], events: [] }, now)).rejects.toThrow(/identity changed/);

  } finally { await dispose(); }
});

it('processes at most 20 deliveries per request and resumes with a cursor', async () => {
  const { database: db, dispose } = await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    const ids = Array.from({ length: 21 }, (_, i) => `demo-${i}`);
    await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-demo', 'Plastic surgeons', 'Demo', 70, 50, 'x')").run();
    await db.prepare(`
      INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
        languages, email, score, tier, payload, imported_at)
      SELECT 'plastic-surgeons-demo/' || value, 'plastic-surgeons-demo', value,
        'Plastic surgeons', 'Robin Example', '', 'No site', 'Belgium', '["EN"]',
        value || '@example.com', 80, 'Hot', '{}', 'x' FROM json_each(?)
    `).bind(JSON.stringify(ids)).run();
    await saveSender(db, { email: 'demo@example.com', daily_limit: 21, paused: false });
    const now = new Date('2026-11-18T15:00:00Z');
    const batch = await buildDailyDraft(db, { day: '2026-11-18', sender: 'demo@example.com' }, now);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    const sendLog = batch.items.map((item, i) => ({ uids: [item.uid], status: 201, messageId: `<cursor-${i}@example.com>` }));
    await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog,
      events: sendLog.map((entry) => ({ messageId: entry.messageId, event: 'delivered', date: '2026-11-19T14:00:00Z' })) }, now);
    const first = await logVerifiedDelivered(db, batch.id, batch.content_hash, now);
    expect(first).toMatchObject({ filed: 20, next_offset: 20, total: 21 });
    const rest = await logVerifiedDelivered(db, batch.id, batch.content_hash, now, first.next_offset);
    expect(rest).toMatchObject({ filed: 1, next_offset: null });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE kind = 'sent'").first()).n).toBe(21);
    const retry = await logVerifiedDelivered(db, batch.id, batch.content_hash, now);
    expect(retry).toMatchObject({ filed: 0, duplicates: 20, next_offset: 20 });
  } finally { await dispose(); }
});
