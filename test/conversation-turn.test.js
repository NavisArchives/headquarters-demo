// « Whose turn is it » from message facts, one read model for Home and
// Outreach (Codex handover 003, NIRMATA 20 Nov). Fictional fixtures only.
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { whoseTurn, needsAndy } from '../src/shared/turn.js';
import { insertReview } from '../src/worker/db-replies.js';
import { recordMailTimes } from '../src/worker/db.js';
import { replyInbox } from '../src/worker/outreach-replies.js';
import { todayQueue } from '../src/worker/outreach.js';

const T1 = '2026-11-10T09:00:00.000Z';
const T2 = '2026-11-11T09:00:00.000Z';
const T3 = '2026-11-12T09:00:00.000Z';
const today = '2026-11-13';

describe('whoseTurn (pure)', () => {
  it('T1 in → yours; T2 out → theirs; T3 in → yours again, stage untouched', () => {
    expect(whoseTurn({ stage: 'replied', last_in: T1, today }).turn).toBe('yours');
    expect(whoseTurn({ stage: 'replied', last_in: T1, last_out: T2, today }).turn).toBe('theirs');
    expect(whoseTurn({ stage: 'talks', last_in: T3, last_out: T2, today }).turn).toBe('yours');
  });
  it('Andy wrote last and the follow-up day has come: follow_up_due', () => {
    expect(whoseTurn({ stage: 'sent', last_out: T2, follow_up: '2026-11-13', today }).turn).toBe('follow_up_due');
    expect(whoseTurn({ stage: 'sent', last_out: T2, follow_up: '2026-11-14', today }).turn).toBe('theirs');
  });
  it('discloses missing or conflicting facts instead of guessing', () => {
    expect(whoseTurn({ stage: 'replied', today })).toEqual({ turn: 'incomplete', reason: 'no_mail_times' });
    expect(whoseTurn({ stage: 'talks', last_out: T2, today })).toEqual({ turn: 'incomplete', reason: 'no_reply_time' });
    expect(whoseTurn({ stage: 'replied', last_in: 'not a date', last_out: T2, today })).toEqual({ turn: 'incomplete', reason: 'unreadable_time' });
    expect(whoseTurn({ stage: 'replied', last_in: T2, last_out: T2, today })).toEqual({ turn: 'incomplete', reason: 'same_time_both_ways' });
    expect(whoseTurn({ stage: 'replied', last_in: '2026-09-20', last_out: '2026-09-20', today })).toEqual({ turn: 'incomplete', reason: 'same_day_order_unknown' });
    expect(whoseTurn({ stage: 'replied', last_in: '2026-09-20T16:23:15Z', last_out: '2026-09-20', today })).toEqual({ turn: 'incomplete', reason: 'same_day_order_unknown' });
    expect(whoseTurn({ stage: 'replied', last_in: '2026-09-21', last_out: '2026-09-20', today }).turn).toBe('yours');
    expect(whoseTurn({ linked: false })).toEqual({ turn: 'incomplete', reason: 'reply_not_linked' });
  });
  it('closed: passed, won, or a « no » that is their latest word', () => {
    expect(whoseTurn({ stage: 'passed', last_in: T3, today }).turn).toBe('closed');
    expect(whoseTurn({ stage: 'won', last_in: T3, today }).turn).toBe('closed');
    expect(whoseTurn({ stage: 'replied', last_in: T3, last_out: T2, latest_intent: 'not_interested', today })).toEqual({ turn: 'closed', reason: 'said_no' });
  });
  it('a message Andy marked handled, with nothing newer, is not his turn', () => {
    expect(whoseTurn({ stage: 'replied', last_in: T3, latest_status: 'handled', latest_review_at: T3, today }).turn).toBe('handled');
    expect(whoseTurn({ stage: 'replied', last_in: T3, latest_status: 'handled', latest_review_at: T1, today }).turn).toBe('yours');
  });
  it('needsAndy: yours and incomplete only', () => {
    expect(['yours', 'theirs', 'follow_up_due', 'handled', 'closed', 'incomplete'].filter(needsAndy)).toEqual(['yours', 'incomplete']);
  });
});

async function lead(db, id, stage) {
  await db.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, languages, email, score, tier, payload, imported_at)
    VALUES (?, 'demo', ?, 'UGC', ?, '', 'Demo', 'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')`).bind(`demo/${id}`, id, `Demo ${id}`, `${id}@example.test`).run();
  await db.prepare('INSERT INTO lead_state (uid, stage, updated_at) VALUES (?, ?, ?)').bind(`demo/${id}`, stage, T1).run();
}
const review = (db, id, n, intent, at, extra = {}) => insertReview(db, { uid: `demo/${id}`, message_id: `m-${id}-${n}`,
  thread_id: `t-${id}`, from_email: `${id}@example.test`, received_at: at, intent, summary: `${intent} ${n}`, ...extra });

/** What Home counts and what the Outreach queue lists, as uid sets. */
async function bothViews(db, now) {
  const inbox = await replyInbox(db, now);
  const queue = await todayQueue(db, 'America/Lima', now);
  const home = [...inbox.warm, ...inbox.check].map((r) => r.uid || r.name).sort();
  const outreach = queue.filter((q) => q.kind === 'warm_reply' || q.kind === 'check_conversation').map((q) => q.title).sort();
  return { inbox, queue, home, outreach };
}

describe('one read model for Home and Outreach', () => {
  it('follows T1 → T2 → T3 in both views, and they always agree', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
      await lead(db, 'ana', 'replied');
      const now = new Date('2026-11-13T15:00:00Z');
      const names = async () => { const v = await bothViews(db, now); return { home: v.home, outreach: v.outreach, waiting: v.inbox.waiting.map((r) => r.uid) }; };

      await review(db, 'ana', 1, 'interested', T1);
      await recordMailTimes(db, 'demo/ana', { repliedAt: T1 }, today);
      expect(await names()).toEqual({ home: ['demo/ana'], outreach: ['Demo ana'], waiting: [] });

      await recordMailTimes(db, 'demo/ana', { sentAt: T2 }, today);
      expect(await names()).toEqual({ home: [], outreach: [], waiting: ['demo/ana'] });
      expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/ana'").first()).stage).toBe('replied');

      await review(db, 'ana', 2, 'wants_call', T3);
      await recordMailTimes(db, 'demo/ana', { repliedAt: T3 }, today);
      expect(await names()).toEqual({ home: ['demo/ana'], outreach: ['Demo ana'], waiting: [] });
    } finally { await dispose(); }
  });

  it('an automatic reply never makes it Andy\'s turn, even when the mailbox sync recorded its time', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
      await lead(db, 'ooo', 'sent');
      await recordMailTimes(db, 'demo/ooo', { sentAt: T1 }, today);
      await review(db, 'ooo', 1, 'auto_reply', T2, { status: 'handled' });
      await recordMailTimes(db, 'demo/ooo', { repliedAt: T2 }, today); // the Gmail sync sees « a message from them »
      const v = await bothViews(db, new Date('2026-11-13T15:00:00Z'));
      expect(v.home).toEqual([]);
      expect(v.outreach).toEqual([]);
      expect(v.queue.filter((q) => q.kind === 'warm_reply')).toEqual([]);
    } finally { await dispose(); }
  });

  it('shows missing facts and unlinked replies as « check », in both views; passed/won and suppression rules unchanged', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
      await lead(db, 'byhand', 'talks'); // moved to talks by hand, no mail either way
      await lead(db, 'done', 'won');
      await review(db, 'done', 1, 'interested', T3);
      await lead(db, 'no', 'replied');
      await review(db, 'no', 1, 'not_interested', T3);
      await insertReview(db, { uid: null, message_id: 'm-stranger', from_email: 'stranger@example.test', received_at: T2, intent: 'wants_info', summary: 'who?' });
      const v = await bothViews(db, new Date('2026-11-13T15:00:00Z'));
      expect(v.inbox.check.map((r) => [r.uid, r.reason])).toEqual([[null, 'reply_not_linked'], ['demo/byhand', 'no_mail_times']]);
      expect(v.home.length).toBe(v.outreach.length);
      expect(v.outreach).toEqual(['Demo byhand', 'stranger@example.test']);
      expect(v.inbox.declined.map((r) => r.uid)).toEqual(['demo/no']);
      expect([...v.inbox.warm, ...v.inbox.check, ...v.inbox.waiting].some((r) => r.uid === 'demo/done')).toBe(false);
    } finally { await dispose(); }
  });

  it('stays on indexes at volume: the pool never scans leads or lead_state', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
      // 3,000 synthetic leads in two statements, 30 of them in a conversation.
      await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2999)
        INSERT INTO leads (uid, dataset, id, business, name, website, category, country, languages, email, score, tier, payload, imported_at)
        SELECT 'demo/v' || i, 'demo', 'v' || i, 'UGC', 'V ' || i, '', 'Demo', 'Belgium', '["EN"]', 'v' || i || '@example.test', 50, 'Warm', '{}', 'x' FROM n`).run();
      await db.prepare(`INSERT INTO lead_state (uid, stage, last_sent_at, updated_at)
        SELECT uid, CASE WHEN CAST(substr(id, 2) AS INTEGER) % 100 = 0 THEN 'replied' ELSE 'sent' END, ?, ? FROM leads WHERE dataset = 'demo'`).bind(T1, T1).run();
      const sql = `WITH pool AS (SELECT uid FROM lead_state WHERE stage IN ('replied','talks') UNION SELECT uid FROM reply_reviews WHERE uid IS NOT NULL)
        SELECT l.uid FROM pool JOIN leads l ON l.uid = pool.uid LEFT JOIN lead_state s ON s.uid = l.uid`;
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results.map((r) => r.detail).join('\n');
      expect(plan).not.toMatch(/SCAN (l|s|leads|lead_state)\b(?! USING)/);
      expect(plan).toMatch(/lead_state_by_stage/);
      const v = await bothViews(db, new Date('2026-11-13T15:00:00Z'));
      expect(v.home.length).toBe(30); // replied with no reply time on record: « check », not guessed
      expect(v.home.length).toBe(v.outreach.length);
    } finally { await dispose(); }
  });
});
