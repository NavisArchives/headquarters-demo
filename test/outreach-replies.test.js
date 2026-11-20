import { it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { insertReview } from '../src/worker/db-replies.js';
import { replyInbox } from '../src/worker/outreach-replies.js';
import { handleLeads } from '../src/worker/api/leads.js';

it('shows replied/talks newest first, keeps ambiguous replies, and passes a stored refusal through the state API', async () => {
  const { database: db, dispose } = await freshDatabase();
  try {
    await db.prepare("INSERT INTO datasets (key,business,title,tier_hot,tier_warm,imported_at) VALUES ('demo','UGC','Demo',70,50,'x')").run();
    const rows = [['older', 'replied', 'interested', '2026-11-17T12:00:00Z'],
      ['newer', 'talks', 'wants_call', '2026-11-18T12:00:00Z'],
      ['unclear', 'replied', 'unclear', '2026-11-16T12:00:00Z'],
      ['no', 'replied', 'not_interested', '2026-11-19T12:00:00Z'],
      ['won', 'won', 'not_interested', '2026-11-19T12:00:00Z']];
    for (const [id, stage, intent, at] of rows) {
      await db.prepare(`
        INSERT INTO leads (uid, dataset, id, business, name, website, category, country, languages, email, score, tier, payload, imported_at)
        VALUES (?, 'demo', ?, 'UGC', ?, '', 'Demo', 'Belgium', '["EN"]', ?, 80, 'Hot', '{}', 'x')
      `).bind(`demo/${id}`, id, `Demo ${id}`, `${id}@example.com`).run();
      await db.prepare('INSERT INTO lead_state (uid,stage,last_reply_at,follow_up,updated_at) VALUES (?,?,?,?,?)')
        .bind(`demo/${id}`, stage, at, '2026-12-01', at).run();
      await insertReview(db, { uid: `demo/${id}`, message_id: `demo-${id}`, thread_id: `thread-${id}`,
        from_email: `${id}@example.com`, received_at: at, intent, summary: `Demo ${intent}` });
    }
    const inbox = await replyInbox(db);
    expect(inbox.warm.map((row) => row.uid)).toEqual(['demo/newer', 'demo/older', 'demo/unclear']);
    expect(inbox.declined.map((row) => row.uid)).toEqual(['demo/no']);
    expect(inbox.mail_sync).toMatch(/not live/);
    expect(inbox.warm[0].thread_href).toBe('https://mail.google.com/mail/u/0/#all/thread-newer');
    const missionsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM missions').first()).n;
    const request = new Request('https://hq.test/api/leads/demo/no/state', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'passed', follow_up: null }),
    });
    expect((await handleLeads(request, { DB: db }, new URL(request.url))).status).toBe(200);
    expect((await replyInbox(db)).declined).toEqual([]);
    expect(await db.prepare("SELECT stage,follow_up FROM lead_state WHERE uid='demo/no'").first()).toEqual({ stage: 'passed', follow_up: null });
    expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/unclear'").first()).stage).toBe('replied');
    expect((await db.prepare("SELECT stage FROM lead_state WHERE uid='demo/won'").first()).stage).toBe('won');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM missions').first()).n).toBe(missionsBefore);
  } finally { await dispose(); }
});
