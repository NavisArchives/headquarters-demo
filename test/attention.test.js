import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { insertReview } from '../src/worker/db-replies.js';
import { recordMailTimes } from '../src/worker/db.js';
import { todayQueue } from '../src/worker/outreach.js';
import { resolveRefs, planAttention, applyAttention, undoAttention } from '../src/worker/attention.js';

// Andy, 20 Nov: number every « needs your attention » item and let him act on
// several at once by number or by name (« 3, 7 and 9 are done », « 4 is interested »).
const T1 = '2026-11-10T09:00:00.000Z';
const today = '2026-11-13';
const now = new Date('2026-11-13T15:00:00Z');

async function seed(db) {
  await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
  for (const [id, stage, follow] of [['ana', 'replied', null], ['bob', 'replied', null], ['cara', 'sent', '2026-11-12']]) {
    await db.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, languages, email, score, tier, payload, imported_at)
      VALUES (?, 'demo', ?, 'UGC', ?, '', 'Demo', 'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')`).bind(`demo/${id}`, id, `Demo ${id}`, `${id}@example.test`).run();
    await db.prepare('INSERT INTO lead_state (uid, stage, follow_up, notes, updated_at) VALUES (?, ?, ?, ?, ?)').bind(`demo/${id}`, stage, follow, 'old note', T1).run();
  }
  for (const id of ['ana', 'bob']) {
    await insertReview(db, { uid: `demo/${id}`, message_id: `m-${id}`, thread_id: `t-${id}`, from_email: `${id}@example.test`, received_at: T1, intent: 'wants_info', summary: 'a question' });
    await recordMailTimes(db, `demo/${id}`, { repliedAt: T1 }, today);
  }
}
const titles = (q) => q.map((i) => i.title).sort();

describe('numbers on « needs your attention »', () => {
  it('every item gets N-<n>, and a number never shifts when another item is resolved', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await seed(db);
      const first = await todayQueue(db, 'America/Lima', now);
      expect(titles(first)).toEqual(['Demo ana', 'Demo bob', 'Demo cara']);
      expect(first.every((i) => /^N-\d+$/.test(i.number))).toBe(true);
      const before = Object.fromEntries(first.map((i) => [i.title, i.number]));
      const ana = first.find((i) => i.title === 'Demo ana');
      await applyAttention(db, { refs: [ana.number], action: 'handled' }, now);
      const second = await todayQueue(db, 'America/Lima', now);
      expect(titles(second)).toEqual(['Demo bob', 'Demo cara']);
      for (const i of second) expect(i.number).toBe(before[i.title]);
    } finally { await dispose(); }
  });
});

describe('refs: by number or by name, never a guess', () => {
  const queue = [{ number: 'N-3', title: 'BrightDesk' }, { number: 'N-7', title: 'Sunny Agency' }, { number: 'N-9', title: 'Sunny Dental' }];
  it('takes « N-3 », « 3 », « n 7 » and an exact or unique name', () => {
    const r = resolveRefs(queue, ['N-3', '3', 'n 7', 'brightdesk', 'Dental']);
    expect(r.map((x) => x.item?.number)).toEqual(['N-3', 'N-3', 'N-7', 'N-3', 'N-9']);
  });
  it('matches dictated names: spaces, punctuation and accents do not count', () => {
    const r = resolveRefs([...queue, { number: 'N-12', title: 'Clinique Élan' }], ['Bright desk', 'bright-desk.', 'clinique elan']);
    expect(r.map((x) => x.item?.number)).toEqual(['N-3', 'N-3', 'N-12']);
  });
  it('lists the candidates when a name matches several, and says when nothing matches', () => {
    const [many, none, gone] = resolveRefs(queue, ['Sunny', 'Hire it', '42']);
    expect(many.error).toMatch(/matches 2: N-7 Sunny Agency, N-9 Sunny Dental/);
    expect(none.error).toMatch(/nothing on the list is called « Hire it »/);
    expect(gone.error).toMatch(/N-42 is not on the list now/);
  });
});

describe('plan, apply, undo', () => {
  it('plans without writing a thing', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await seed(db);
      const plan = await planAttention(db, { refs: ['Demo ana', 'Demo cara'], action: 'interested' }, now);
      expect(plan.map((p) => [p.title, p.ok])).toEqual([['Demo ana', true], ['Demo cara', true]]);
      expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/ana'").first()).stage).toBe('replied');
      expect((await db.prepare("SELECT status FROM reply_reviews WHERE uid='demo/ana'").first()).status).toBe('open');
    } finally { await dispose(); }
  });
  it('« interested »: reply interested + handled, lead to In talks, off the list; Undo puts it all back', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await seed(db);
      const out = await applyAttention(db, { refs: ['Demo ana'], action: 'interested' }, now);
      expect(out.done).toHaveLength(1);
      expect(await db.prepare("SELECT intent, status FROM reply_reviews WHERE uid='demo/ana'").first()).toEqual({ intent: 'interested', status: 'handled' });
      expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/ana'").first()).stage).toBe('talks');
      expect(titles(await todayQueue(db, 'America/Lima', now))).toEqual(['Demo bob', 'Demo cara']);
      await undoAttention(db, out.undo, now);
      expect(await db.prepare("SELECT intent, status FROM reply_reviews WHERE uid='demo/ana'").first()).toEqual({ intent: 'wants_info', status: 'open' });
      expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/ana'").first()).stage).toBe('replied');
      expect(titles(await todayQueue(db, 'America/Lima', now))).toEqual(['Demo ana', 'Demo bob', 'Demo cara']);
    } finally { await dispose(); }
  });
  it('several at once; snooze moves a follow-up; a note is appended; what cannot be done is said, not forced', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await seed(db);
      const q = await todayQueue(db, 'America/Lima', now);
      const n = (t) => q.find((i) => i.title === t).number;
      const done = await applyAttention(db, { refs: [n('Demo ana'), n('Demo bob')], action: 'handled' }, now);
      expect(done.done.map((d) => d.title)).toEqual(['Demo ana', 'Demo bob']);
      const snooze = await applyAttention(db, { refs: ['Demo cara'], action: 'snooze', days: 3 }, now);
      expect(snooze.done).toHaveLength(1);
      expect((await db.prepare("SELECT follow_up FROM lead_state WHERE uid='demo/cara'").first()).follow_up).toBe('2026-11-16');
      await undoAttention(db, snooze.undo, now);
      expect((await db.prepare("SELECT follow_up FROM lead_state WHERE uid='demo/cara'").first()).follow_up).toBe('2026-11-12');
      const note = await applyAttention(db, { refs: ['Demo cara'], action: 'note', note: 'called, call back Monday' }, now);
      expect(note.done).toHaveLength(1);
      expect((await db.prepare("SELECT notes FROM lead_state WHERE uid='demo/cara'").first()).notes).toBe('old note\n2026-11-13: called, call back Monday');
      const odd = await applyAttention(db, { refs: ['Nobody', 'Demo cara'], action: 'snooze', days: 99 }, now).catch((e) => e);
      expect(odd.message).toMatch(/1 to 30 days/);
    } finally { await dispose(); }
  });
});

describe('a name on two items', () => {
  it('when only one of them can take the action, that one is meant; otherwise HQ asks', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      await seed(db);
      await db.prepare("INSERT INTO prospects (name, stage, next_step, next_at, created_at, updated_at) VALUES ('Demo ana', 'lead', 'Send the quote', '2026-11-12', ?, ?)").bind(T1, T1).run();
      const q = await todayQueue(db, 'America/Lima', now);
      expect(q.filter((i) => i.title === 'Demo ana').map((i) => i.kind).sort()).toEqual(['sales', 'warm_reply']);
      // « done »: only the reply can be marked handled, so it is the one meant.
      const done = await planAttention(db, { refs: ['Demo ana'], action: 'handled' }, now);
      expect(done[0]).toMatchObject({ ok: true, kind: 'warm_reply' });
      // « snooze »: only the deal can be snoozed.
      const later = await planAttention(db, { refs: ['Demo ana'], action: 'snooze', days: 2 }, now);
      expect(later[0]).toMatchObject({ ok: true, kind: 'sales' });
      // « note »: both are leads? no: only the reply carries a lead, so still one.
      const noted = await planAttention(db, { refs: ['Demo ana'], action: 'note', note: 'x' }, now);
      expect(noted[0]).toMatchObject({ ok: true, kind: 'warm_reply' });
    } finally { await dispose(); }
  });
});
