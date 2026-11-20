import { describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { buildDailyDraft } from '../src/worker/outreach-drafts.js';
import { approveDailyDraft } from '../src/worker/outreach-review.js';
import { saveSender } from '../src/worker/outreach.js';
import { setHqTimeZone } from '../src/worker/db.js';

// 10:00 in Lima on 18 Nov: « tomorrow » is 19 Nov, the day a 10:00 Brussels batch leaves.
const now = new Date('2026-11-18T15:00:00Z');

async function fixture(fn, { sites = 0 } = {}) {
  const { database: db, dispose } = await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    await db.prepare(`
      INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
      VALUES ('plastic-surgeons-demo', 'Plastic surgeons', 'Fictional demo', 70, 50, 'x')
    `).run();
    if (sites) {
      await db.prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
          languages, email, score, tier, payload, imported_at)
        SELECT 'plastic-surgeons-demo/site-' || printf('%05d', i), 'plastic-surgeons-demo', 'site-' || i,
          'Plastic surgeons', 'Site Example', 'https://site-' || i || '.example.com', 'Clinic', 'Belgium',
          '["EN"]', 'site-' || i || '@example.com', 99, 'Hot', '{}', 'x'
        FROM n
      `).bind(sites).run();
    }
    await db.prepare(`
      INSERT INTO leads (uid, dataset, id, business, name, website, category, country,
        languages, email, score, tier, payload, imported_at)
      VALUES ('plastic-surgeons-demo/zz-nosite', 'plastic-surgeons-demo', 'zz-nosite', 'Plastic surgeons',
        'Robin Example', '', 'No site', 'Belgium', '["EN"]', 'nosite@example.com', 1, 'Cool', '{}', 'x')
    `).run();
    await saveSender(db, { email: 'demo@example.com', daily_limit: 2, paused: false });
    await fn(db);
  } finally { await dispose(); }
}

describe('F2 — the next day is buildable, nothing further ahead', () => {
  it('builds and approves today and tomorrow (Lima)', () => fixture(async (db) => {
    const today = await buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-18' }, now);
    expect(today.day).toBe('2026-11-18');
    await db.prepare("UPDATE outreach_batches SET status = 'cancelled'").run();
    const tomorrow = await buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-19' }, now);
    expect(tomorrow.day).toBe('2026-11-19');
    const approved = await approveDailyDraft(db, tomorrow.id, tomorrow.content_hash, 'Demo', now);
    expect(approved.status).toBe('approved');
  }));

  it('refuses the day after tomorrow and yesterday', () => fixture(async (db) => {
    await expect(buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-20' }, now)).rejects.toThrow(/today or tomorrow/);
    await expect(buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-17' }, now)).rejects.toThrow(/today or tomorrow/);
  }));

  it('a batch built for tomorrow can no longer be approved once that day has passed', () => fixture(async (db) => {
    const batch = await buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-19' }, now);
    const later = new Date('2026-11-20T15:00:00Z');
    await expect(approveDailyDraft(db, batch.id, batch.content_hash, 'Demo', later)).rejects.toThrow(/stale/);
  }));
});

describe('F3 — no-website leads fill the batch first, even past the 2,000-row pre-cut', () => {
  it('a no-site lead ranked after 2,000 higher-scored leads still lands first', () => fixture(async (db) => {
    const batch = await buildDailyDraft(db, { sender: 'demo@example.com', day: '2026-11-18' }, now);
    expect(batch.items[0].uid).toBe('plastic-surgeons-demo/zz-nosite');
  }, { sites: 2001 }), 60000);
});

describe('F1 — batch rows are found by lead and by recipient through an index', () => {
  it('0038 creates both indexes', async () => {
    const { database: db, dispose } = await freshDatabase();
    try {
      const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outreach_batch_items'").all();
      const names = results.map((row) => row.name);
      expect(names).toContain('outreach_batch_items_uid');
      expect(names).toContain('outreach_batch_items_recipient');
    } finally { await dispose(); }
  });
});
