// The leads list carries only what the screen reads (NIRMATA, 3 Nov: 11.6 MB).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { normalizeLead, matchesQuery } from '../src/public/assets/leads-lib.js';

const FULL = {
  name: 'Copy of name', email: 'copy@example.com', website: 'https://copy.example', id: 'copy',
  pitch: 'A pitch', research: 'Berlin HQ', evidence: 'Seen', evidenceUrl: 'https://proof.example', openingLine: 'Hello', contactAlt: 'alt@example.com', scoreLabel: '90+',
  extra: { code: 'S1', Listing: 'https://list.example', sendable: 'no' },
};

async function withLead(payload, fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('d', 'Web design', 'D', 70, 50, '2026-10-01T00:00:00Z')").run();
    await database.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
      VALUES ('d/a', 'd', 'a', 'Web design', 'A', 'https://example.com', 'Studio', 'BE', 'a@example.com', 80, 'Hot', ?, '2026-10-01T00:00:00Z')`).bind(payload).run();
    await fn(database);
  } finally { await dispose(); }
}

describe('the leads list payload', () => {
  it('carries what the list uses and leaves the long texts to the pop-up', async () => {
    await withLead(JSON.stringify(FULL), async (database) => {
      const [row] = await db.listLeads(database);
      const sent = JSON.parse(row.payload);
      for (const k of ['name', 'email', 'website', 'id', 'pitch', 'research', 'openingLine']) expect(sent).not.toHaveProperty(k);
      expect(sent).toMatchObject({ evidence: 'Seen', evidenceUrl: 'https://proof.example', scoreLabel: '90+', contactAlt: 'alt@example.com' });
      expect(sent.extra).toEqual({ code: 'S1', Listing: 'https://list.example', sendable: 'no' }); // no nulls sent
      const lead = normalizeLead(row);
      expect(lead.pitch).toBe('');
      expect(lead.evidence).toBe('Seen');
      const whole = await db.getLead(database, 'd/a');
      expect(JSON.parse(whole.payload)).toEqual(FULL); // the pop-up's own read keeps it all
      expect(normalizeLead(whole).pitch).toBe('A pitch');
    });
  }, 30000);

  it('keeps numbers and objects as they were', async () => {
    const typed = { scoreLabel: 92, extra: { code: 'B2', sendRule: { allow: ['BE', 'LU'], since: 3 }, sendable: true } };
    await withLead(JSON.stringify(typed), async (database) => {
      const sent = JSON.parse((await db.listLeads(database))[0].payload);
      expect(sent).toEqual(typed);
    });
  }, 30000);

  it('keeps the Travel list list whole', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('travel-volunteer-stays', 'Travel list', 'P', 70, 50, '2026-10-01T00:00:00Z')").run();
      await database.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
        VALUES ('travel-volunteer-stays/a', 'travel-volunteer-stays', 'a', 'Travel list', 'A', 'https://example.com', 'Stay', 'PE', 'a@example.com', 80, 'Hot', ?, '2026-10-01T00:00:00Z')`).bind(JSON.stringify(FULL)).run();
      expect(JSON.parse((await db.listLeads(database))[0].payload)).toEqual(FULL);
    } finally { await dispose(); }
  }, 30000);

  it('still finds a word that only the full payload holds', async () => {
    await withLead(JSON.stringify(FULL), async (database) => {
      expect(await db.listLeads(database, { q: 'Berlin' })).toHaveLength(1);
      expect(await db.listLeads(database, { q: 'Berlin', shape: 'uids' })).toEqual(['d/a']);
      expect(await db.listLeads(database, { q: 'Tokyo', shape: 'uids' })).toEqual([]);
    });
  }, 30000);

  it('hands the CSV export the whole record', async () => {
    await withLead(JSON.stringify(FULL), async (database) => {
      const [row] = await db.listLeads(database, { shape: 'full' });
      expect(JSON.parse(row.payload)).toEqual(FULL);
      expect(normalizeLead(row).research).toBe('Berlin HQ');
    });
  }, 30000);

  it('counts a server hit as a match on screen, for that query only', async () => {
    await withLead(JSON.stringify(FULL), async (database) => {
      const lead = normalizeLead((await db.listLeads(database))[0]);
      expect(matchesQuery(lead, 'Berlin')).toBe(false); // research is not in the list
      const hits = { q: 'Berlin', uids: new Set(['d/a']) };
      expect(matchesQuery(lead, 'Berlin', hits)).toBe(true);
      expect(matchesQuery(lead, 'Berlin HQ', hits)).toBe(false); // stale hits never count
    });
  }, 30000);

  it('copes with no extra, and with a payload that is not JSON', async () => {
    await withLead(JSON.stringify({ pitch: 'x' }), async (database) => {
      expect(normalizeLead((await db.listLeads(database))[0]).extra.code ?? null).toBeNull();
    });
    await withLead('not json', async (database) => {
      expect(normalizeLead((await db.listLeads(database))[0]).pitch).toBe('');
    });
  }, 30000);
});
