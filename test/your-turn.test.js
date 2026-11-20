// « They replied, your turn to answer » is on Home today, and their words are on
// the lead (audit C11: M2, P7).
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';

installDom();
const { homeItems } = await import('../src/public/assets/todos.js');

describe("Home's lead missions", () => {
  const missions = [
    { id: 1, title: 'Clinique Aurore — they replied, your turn to answer', status: 'in_progress', due: '2026-11-16', lead_uid: 'w/aurore', turn: 'yours' },
    { id: 2, title: 'Atelier Nord — waiting for their answer (you wrote 10 Nov)', status: 'pending', due: '2026-11-16', lead_uid: 'w/nord', turn: 'theirs' },
    { id: 3, title: 'Old style — waiting', status: 'pending', due: '2026-11-14', lead_uid: 'w/old' },
  ];
  it('shows a reply waiting for Andy today, whatever its due date, and holds a « waiting » one', () => {
    const items = homeItems({ missions, today: '2026-11-14' }).filter((i) => i.kind === 'lead');
    expect(items.map((i) => i.id)).toEqual([1, 3]);
    expect(items.find((i) => i.id === 1).due).toBe('2026-11-14');
  });
});

describe('whose turn a lead mission is', () => {
  it('is read from the lead\'s mail times', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('w', 'Web design', 'W', 70, 50, 'x')").run();
      for (const id of ['aurore', 'nord']) {
        // eslint-disable-next-line no-await-in-loop -- setup
        await database.prepare("INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at) VALUES (?, 'w', ?, 'Web design', ?, '', 'Studio', 'BE', ?, 80, 'Hot', '{}', 'x')")
          .bind(`w/${id}`, id, id, `${id}@x.be`).run();
      }
      await db.patchLeadState(database, 'w/aurore', { stage: 'replied' });
      await database.prepare("UPDATE lead_state SET last_sent_at = '2026-11-01T09:00:00Z', last_reply_at = '2026-11-12T09:00:00Z' WHERE uid = 'w/aurore'").run();
      // Replied once, then Andy wrote again: their turn now.
      await db.patchLeadState(database, 'w/nord', { stage: 'replied' });
      await database.prepare("UPDATE lead_state SET last_reply_at = '2026-11-08T09:00:00Z', last_sent_at = '2026-11-10T09:00:00Z' WHERE uid = 'w/nord'").run();
      // The warm-lead triggers (0012/0014) made the two lead missions already.
      await database.prepare("INSERT INTO missions (title, detail, status, position, created_at, updated_at) VALUES ('plain', '', 'pending', 0, 'x', 'x')").run();
      const turns = Object.fromEntries((await db.listMissions(database)).map((m) => [m.lead_uid ?? 'none', m.turn]));
      expect(turns).toMatchObject({ 'w/aurore': 'yours', none: null });
      expect(turns['w/nord']).toBe('theirs');
    } finally { await dispose(); }
  }, 30000);
});
