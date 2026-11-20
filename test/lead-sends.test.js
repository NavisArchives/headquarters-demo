// An email Andy sent himself from the pop-up (audit A4, A5): forward only,
// one « sent » event, the follow-up rhythm, and an undo.
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { recordOwnSend, undoOwnSend, recordLinkedIn, undoLinkedIn } from '../src/worker/lead-sends.js';

async function withLead(stage, fn, { followUp = null, lastSent = null } = {}) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('d', 'Web design', 'D', 70, 50, 'x')").run();
    await database.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
      VALUES ('d/a', 'd', 'a', 'Web design', 'A', '', 'Studio', 'BE', 'a@example.com', 80, 'Hot', '{}', 'x')`).run();
    if (stage) {
      await database.prepare('INSERT INTO lead_state (uid, stage, follow_up, last_sent_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind('d/a', stage, followUp, lastSent, '2026-10-01T00:00:00Z').run();
    }
    await fn(database);
  } finally { await dispose(); }
}
const sentEvents = async (database) => (await database.prepare("SELECT detail FROM lead_events WHERE uid = 'd/a' AND kind = 'sent' ORDER BY id").all()).results.map((r) => r.detail);

describe('Andy says he sent it', () => {
  it('moves a new lead to sent, logs the first email, and dates the follow-up 7 days on', async () => {
    await withLead(null, async (database) => {
      const { lead, undo } = await recordOwnSend(database, 'd/a', { mode: 'email', at: '2026-11-02T15:00:00.000Z' });
      expect(lead.stage).toBe('sent');
      expect(lead.follow_up).toBe('2026-11-09');
      expect(await sentEvents(database)).toEqual(['first email · sent by Andy from HQ']);
      expect(undo).toMatchObject({ stage: 'new', follow_up: null, last_sent_at: null });
    });
  }, 30000);

  it('never moves a lead in talks or won back to sent (F2)', async () => {
    for (const stage of ['replied', 'talks', 'won']) {
      // eslint-disable-next-line no-await-in-loop -- one database each
      await withLead(stage, async (database) => {
        const { lead } = await recordOwnSend(database, 'd/a', { mode: 'email', at: '2026-11-02T15:00:00.000Z' });
        expect(lead.stage).toBe(stage);
      });
    }
  }, 60000);

  it('a follow-up clears « Follow-up due »: the date moves on, and the timeline says so (O4)', async () => {
    await withLead('sent', async (database) => {
      await database.prepare("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('d/a', 'sent', 'first email', '2026-09-21T09:00:00.000Z')").run();
      const { lead } = await recordOwnSend(database, 'd/a', { mode: 'followup', at: '2026-11-13T15:00:00.000Z' });
      expect(lead.follow_up).toBe('2026-11-27'); // second email → +14
      expect(await sentEvents(database)).toEqual(['first email', 'follow-up · sent by Andy from HQ']);
    }, { followUp: '2026-09-28', lastSent: '2026-09-21T09:00:00.000Z' });
  }, 30000);

  it('undo puts the lead back exactly as it was', async () => {
    await withLead('looked', async (database) => {
      const { undo } = await recordOwnSend(database, 'd/a', { mode: 'email', at: '2026-11-02T15:00:00.000Z' });
      const back = await undoOwnSend(database, 'd/a', undo);
      expect(back.stage).toBe('looked');
      expect(back.follow_up).toBeNull();
      expect(await sentEvents(database)).toEqual([]);
    });
  }, 30000);

  it('undo refuses once another email was recorded after it', async () => {
    await withLead('looked', async (database) => {
      const first = await recordOwnSend(database, 'd/a', { mode: 'email', at: '2026-11-02T15:00:00.000Z' });
      await recordOwnSend(database, 'd/a', { mode: 'followup', at: '2026-11-09T15:00:00.000Z' });
      await expect(undoOwnSend(database, 'd/a', first.undo)).rejects.toMatchObject({ field: 'event_id' });
    });
  }, 30000);

  it('refuses an undo that is not one', async () => {
    await withLead('looked', async (database) => {
      await expect(undoOwnSend(database, 'd/a', { event_id: 1, stage: 'nope', follow_up: null, last_sent_at: null })).rejects.toMatchObject({ field: 'stage' });
      await expect(db.getLeadStage(database, 'd/a')).resolves.toBe('looked');
    });
  }, 30000);
});

describe('the address an own send went to (0032)', () => {
  it('is the lead address at the time of the send', async () => {
    await withLead(null, async (database) => {
      await recordOwnSend(database, 'd/a', { mode: 'email', at: '2026-11-02T15:00:00.000Z' });
      const row = await database.prepare("SELECT sent_to FROM lead_events WHERE uid = 'd/a' AND kind = 'sent'").first();
      expect(row.sent_to).toBe('a@example.com');
    });
  });
});

describe('« LinkedIn sent » (NIRMATA, 14 Nov)', () => {
  it('records Andy’s LinkedIn message without touching the email stage or follow-up', async () => {
    await withLead('sent', async (database) => {
      const { lead, undo } = await recordLinkedIn(database, 'd/a', { at: '2026-11-14T15:00:00.000Z' });
      expect(lead).toMatchObject({ stage: 'sent', follow_up: '2026-11-20', linkedin_sent_at: '2026-11-14T15:00:00.000Z' });
      expect(await sentEvents(database)).toEqual([]);
      expect(undo.event_id).toBeGreaterThan(0);
      const listed = await db.listLeads(database);
      expect(listed[0].linkedin_sent_at).toBe('2026-11-14T15:00:00.000Z');
    }, { followUp: '2026-11-20' });
  });

  it('undo takes back the newest LinkedIn record only', async () => {
    await withLead(null, async (database) => {
      const first = await recordLinkedIn(database, 'd/a', { at: '2026-11-13T15:00:00.000Z' });
      const second = await recordLinkedIn(database, 'd/a', { at: '2026-11-14T15:00:00.000Z' });
      await expect(undoLinkedIn(database, 'd/a', first.undo)).rejects.toThrow(/nothing was undone/);
      const lead = await undoLinkedIn(database, 'd/a', second.undo);
      expect(lead.linkedin_sent_at).toBe('2026-11-13T15:00:00.000Z');
      await expect(undoLinkedIn(database, 'd/a', {})).rejects.toThrow(/event_id/);
    });
  });

  it('an unknown lead is null', async () => {
    await withLead(null, async (database) => {
      expect(await recordLinkedIn(database, 'd/nobody')).toBeNull();
    });
  });
});
