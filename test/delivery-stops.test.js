// Delivery stops are enforced, not only reported (Codex handover 003, NIRMATA
// 20 Nov): a bounced or suppressed address can never be picked by the planner
// or leave in an export, and a failed stop rule holds the sender until Andy
// resumes it with a review note. Twelve fictional addresses stand in for the
// twelve stops of 19 Nov (six « no », three bounces, three more « no »).
import { it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { setHqTimeZone } from '../src/worker/db.js';
import { saveSender, candidates } from '../src/worker/outreach.js';
import { buildDailyDraft } from '../src/worker/outreach-drafts.js';
import { approveDailyDraft, exportDailyDraft } from '../src/worker/outreach-review.js';
import { saveVerification } from '../src/worker/outreach-verification.js';

const SENDER = 'desk@example.test';
const DECLINED = Array.from({ length: 6 }, (_, i) => `no-${i}`);
const BOUNCED = Array.from({ length: 6 }, (_, i) => `bounce-${i}`);
const CLEAN = Array.from({ length: 4 }, (_, i) => `ok-${i}`);
const address = (id) => `${id}@example.test`;

async function setup() {
  const fresh = await freshDatabase();
  const db = fresh.database;
  setHqTimeZone('America/Lima');
  await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('plastic-surgeons-demo','Plastic surgeons','Demo',70,50,'x')").run();
  await db.prepare(`INSERT INTO leads (uid,dataset,id,business,name,website,category,country,languages,email,score,tier,payload,imported_at)
    SELECT 'plastic-surgeons-demo/' || value, 'plastic-surgeons-demo', value, 'Plastic surgeons', 'Robin ' || value, '', 'No site', 'Belgium', '["EN"]',
      value || '@example.test', 80, 'Hot', '{}', 'x' FROM json_each(?)`).bind(JSON.stringify([...DECLINED, ...BOUNCED, ...CLEAN])).run();
  await saveSender(db, { email: SENDER, daily_limit: 20, paused: false });
  return fresh;
}

const suppressedCount = async (db) => (await db.prepare('SELECT COUNT(*) AS n FROM email_suppression').first()).n;

it('suppresses hard bounces from a verification, pauses the sender on a failed rule, and holds every stopped address everywhere', async () => {
  const { database: db, dispose } = await setup();
  try {
    const now = new Date('2026-11-18T15:00:00Z');
    const batch = await buildDailyDraft(db, { day: '2026-11-18', sender: SENDER }, now);
    expect(batch.items).toHaveLength(16);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    const sendLog = batch.items.map((item, i) => ({ uids: [item.uid], status: 201, messageId: `<m-${i}@example.test>` }));
    const idOf = new Map(batch.items.map((item, i) => [item.uid.split('/')[1], sendLog[i].messageId]));
    const events = [
      ...BOUNCED.map((id) => ({ messageId: idOf.get(id), event: 'hard_bounce', date: '2026-11-19T10:00:00Z' })),
      ...[...DECLINED, ...CLEAN].map((id) => ({ messageId: idOf.get(id), event: 'delivered', date: '2026-11-19T10:00:00Z' })),
    ];

    // The export works before any verification.
    expect((await exportDailyDraft(db, batch.id)).held).toEqual([]);

    const proof = await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog, events }, now);
    expect(proof.summary.failed).toBe(true);
    expect(proof.summary.stops.map((s) => s.kind)).toEqual(Array(6).fill('hard_bounce'));
    // The six « no » arrive through the suppression door (intake kind 'suppression').
    await db.batch(DECLINED.map((id) => db.prepare("INSERT OR IGNORE INTO email_suppression (email,reason,source,at) VALUES (?, 'declined outreach', 'intake:nirmata', ?)")
      .bind(address(id), now.toISOString())));
    expect(await suppressedCount(db)).toBe(12);
    const sources = (await db.prepare("SELECT source, COUNT(*) AS n FROM email_suppression GROUP BY source ORDER BY source").all()).results;
    expect(sources).toEqual([{ source: 'intake:nirmata', n: 6 }, { source: `verification:${batch.id}`, n: 6 }]);

    // Held: the sender is paused, so even this already-approved batch releases nothing.
    const sender = await db.prepare('SELECT paused, reason FROM outreach_senders WHERE email = ?').bind(SENDER).first();
    expect(sender.paused).toBe(1);
    expect(sender.reason).toMatch(/^Stop rule failed on batch .* \(bounces_above_3_percent\)/);
    await expect(exportDailyDraft(db, batch.id)).rejects.toThrow(/sender is paused · Stop rule failed/);

    // A partial upload or a repeated click cannot lift the hold or the suppression.
    await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog.slice(0, 2), events: [] }, now);
    await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog.slice(0, 2), events: [] }, now);
    expect(await suppressedCount(db)).toBe(12);
    expect((await db.prepare('SELECT paused FROM outreach_senders WHERE email = ?').bind(SENDER).first()).paused).toBe(1);
    expect((await db.prepare('SELECT reason FROM outreach_senders WHERE email = ?').bind(SENDER).first()).reason).toBe(sender.reason);

    // Resuming needs an explicit review note; editing the limit keeps the hold's words.
    await saveSender(db, { email: SENDER, daily_limit: 15, paused: true, reason: 'typed over' });
    expect((await db.prepare('SELECT reason FROM outreach_senders WHERE email = ?').bind(SENDER).first()).reason).toBe(sender.reason);
    await expect(saveSender(db, { email: SENDER, daily_limit: 20, paused: false })).rejects.toThrow(/review/);
    await expect(saveSender(db, { email: SENDER, daily_limit: 20, paused: false, review_note: 'ok' })).rejects.toThrow(/10 characters/);
    await saveSender(db, { email: SENDER, daily_limit: 20, paused: false, review_note: 'Checked the six bounces; list cleaned' });
    expect((await db.prepare('SELECT paused, reason FROM outreach_senders WHERE email = ?').bind(SENDER).first()))
      .toEqual({ paused: 0, reason: expect.stringMatching(/^Resumed \d{4}-\d{2}-\d{2} after stop-rule review: Checked the six bounces/) });

    // After resuming: the twelve never leave in an export…
    const out = await exportDailyDraft(db, batch.id);
    const stopped = new Set([...DECLINED, ...BOUNCED].map((id) => `plastic-surgeons-demo/${id}`));
    expect(out.held.filter((h) => h.reasons.includes('suppressed')).map((h) => h.uid).sort()).toEqual([...stopped].sort());
    const released = out.files.flatMap((f) => JSON.parse(f.content).rows.map((r) => r.email));
    for (const id of [...DECLINED, ...BOUNCED]) expect(released).not.toContain(address(id));
    expect(released.sort()).toEqual(CLEAN.map(address).sort());

    // …and the planner never picks them again.
    const plan = await candidates(db, '2026-11-25', now);
    for (const row of plan.filter((r) => stopped.has(r.uid))) {
      expect(row.eligible).toBe(false);
      expect(row.reasons).toContain('suppressed');
    }
  } finally { await dispose(); }
});

it('a soft-bounce failure pauses the sender but suppresses no one (soft bounces are temporary)', async () => {
  const { database: db, dispose } = await setup();
  try {
    const now = new Date('2026-11-18T15:00:00Z');
    const batch = await buildDailyDraft(db, { day: '2026-11-18', sender: SENDER }, now);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    const sendLog = batch.items.map((item, i) => ({ uids: [item.uid], status: 201, messageId: `<s-${i}@example.test>` }));
    const events = sendLog.slice(0, 2).map((e) => ({ messageId: e.messageId, event: 'soft_bounce', date: '2026-11-19T10:00:00Z' }));
    const proof = await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog, events }, now);
    expect(proof.summary.failed).toBe(true);
    expect(await suppressedCount(db)).toBe(0);
    expect((await db.prepare('SELECT paused FROM outreach_senders WHERE email = ?').bind(SENDER).first()).paused).toBe(1);
  } finally { await dispose(); }
});

it('a passing verification changes nothing, and HQ sending still answers 409', async () => {
  const { database: db, dispose } = await setup();
  try {
    const now = new Date('2026-11-18T15:00:00Z');
    const batch = await buildDailyDraft(db, { day: '2026-11-18', sender: SENDER }, now);
    await approveDailyDraft(db, batch.id, batch.content_hash, 'Demo reviewer', now);
    const sendLog = batch.items.map((item, i) => ({ uids: [item.uid], status: 201, messageId: `<p-${i}@example.test>` }));
    await saveVerification(db, batch.id, { content_hash: batch.content_hash, send_log: sendLog,
      events: sendLog.map((e) => ({ messageId: e.messageId, event: 'delivered', date: '2026-11-19T10:00:00Z' })) }, now);
    expect(await suppressedCount(db)).toBe(0);
    expect((await db.prepare('SELECT paused FROM outreach_senders WHERE email = ?').bind(SENDER).first()).paused).toBe(0);
    const { handleOutreach } = await import('../src/worker/api/outreach.js');
    const request = new Request(`https://hq.test/api/outreach/batches/${batch.id}/send`, { method: 'POST' });
    expect((await handleOutreach(request, { DB: db }, new URL(request.url))).status).toBe(409);
  } finally { await dispose(); }
});
