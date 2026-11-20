// The Leads screen reads the lists' names without every lead a second time (13 Nov).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { handleWorkspace } from '../src/worker/api/workspace.js';

describe('/api/leads/workspace?only=datasets', () => {
  it('gives each list its meta and no rows', async () => {
    const { database, dispose } = await freshDatabase();
    try {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, row_count, imported_at) VALUES ('uk-leads', 'Web design', 'UK', 70, 50, 1, '2026-11-01T00:00:00Z')").run();
      await db.upsertLead(database, { dataset: 'uk-leads', id: 'a', business: 'Web design', name: 'A', website: 'https://a.example', category: 'x', country: 'GB', score: 70, tier: 'Hot', payload: {} });
      const url = new URL('http://hq.test/api/leads/workspace?only=datasets');
      const body = await (await handleWorkspace(new Request(url), { DB: database }, url)).json();
      expect(body.datasets).toEqual([{ meta: expect.objectContaining({ key: 'uk-leads', title: 'UK', tiers: { hot: 70, warm: 50 } }) }]);
      expect(body).not.toHaveProperty('progress');
      expect(JSON.stringify(body)).not.toContain('"rows"');
    } finally { await dispose(); }
  }, 30000);
});

describe('the demo never reaches the Mac', () => {
  it('has no services bridge when DEMO is on', async () => {
    const { macBridge } = await import('../src/worker/api/services.js');
    expect(macBridge({ DEMO: 'on', GMAIL_BRIDGE: 'http://127.0.0.1:4180' })).toBeNull();
    expect(macBridge({ GMAIL_BRIDGE: 'http://127.0.0.1:4180' })).not.toBeNull();
  });
});
