// An address that unsubscribed or bounced is never written to again, on any list (audit, 13 Nov).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { suppressEmail, recordStop } from '../src/worker/brevo-hook.js';
import { handleLeads } from '../src/worker/api/leads.js';
import { normalizeLead } from '../src/public/assets/leads-lib.js';

async function withDb(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    for (const key of ['uk-leads', 'be-leads']) {
      // eslint-disable-next-line no-await-in-loop
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES (?, 'Web design', ?, 70, 50, '2026-11-01T00:00:00Z')").bind(key, key).run();
    }
    await fn(database);
  } finally { await dispose(); }
}
const add = (d, dataset, id, email) => db.upsertLead(d, { dataset, id, business: 'Web design', name: id, website: `https://${id}.example`, category: 'x', country: 'BE', score: 70, tier: 'Hot', email, payload: {} });
const compose = (d, uid) => handleLeads(new Request(`http://hq.test/api/leads/${uid}/compose?lang=FR`), { DB: d }, new URL(`http://hq.test/api/leads/${uid}/compose?lang=FR`));

describe('email suppression', () => {
  it('follows the address onto another list, whatever its case', async () => {
    await withDb(async (d) => {
      await add(d, 'uk-leads', 'a', 'Hello@Studio.example');
      expect(await suppressEmail(d, 'hello@studio.example', 'unsubscribed', 'brevo', '2026-11-13T10:00:00Z')).toBe(true);
      expect(await suppressEmail(d, 'HELLO@studio.example', 'hard bounce', 'brevo', '2026-11-13T11:00:00Z')).toBe(false); // the first stop stays
      await add(d, 'be-leads', 'b', ' hello@studio.example ');
      const list = (await db.listLeads(d)).map(normalizeLead);
      expect(list.every((l) => l.suppressed)).toBe(true);
      expect((await compose(d, 'be-leads/b')).status).toBe(403);
    });
  }, 30000);

  it('leaves everyone else alone', async () => {
    await withDb(async (d) => {
      await add(d, 'uk-leads', 'a', 'ok@studio.example');
      await suppressEmail(d, 'other@studio.example', 'spam', 'brevo', '2026-11-13T10:00:00Z');
      expect(normalizeLead((await db.listLeads(d))[0]).suppressed).toBe(false);
      expect((await compose(d, 'uk-leads/a')).status).toBe(200);
    });
  }, 30000);

  it('the migration back-fills from stops already on leads', async () => {
    await withDb(async (d) => {
      await add(d, 'uk-leads', 'a', 'Gone@Studio.example');
      await recordStop(d, 'uk-leads/a', 'hard bounce', '2026-11-01T10:00:00Z');
      await d.prepare('DELETE FROM email_suppression').run(); // as before 0027
      const sql = (await import('node:fs')).readFileSync(new URL('../migrations/0027_email_suppression.sql', import.meta.url), 'utf8');
      await d.exec(sql.split('\n').filter((l) => !l.startsWith('--')).join(' ').replace(/\s+/g, ' '));
      const row = await d.prepare('SELECT * FROM email_suppression').first();
      expect(row).toMatchObject({ email: 'gone@studio.example', reason: 'hard bounce', source: 'backfill:lead_events' });
    });
  }, 30000);
});
