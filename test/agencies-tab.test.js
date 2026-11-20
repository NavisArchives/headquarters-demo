// An « Agencies » tab, split out of « Web design » (Andy, 13 Nov). LEADS found
// agencies only in whitelabel-agencies, so the list moves whole: its meta.business
// becomes « Agencies » and it is filed again through the approved-batch door.
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { receiveBatch, approveBatch, sha256Hex } from '../src/worker/lead-batches.js';
import { handleLeads } from '../src/worker/api/leads.js';
import { outreachRefusal } from '../src/public/assets/personal-lists.js';

const KEY = 'whitelabel-agencies';
const file = (business) => JSON.stringify({
  meta: { key: KEY, business, title: 'Agencies for white-label build work', collected: '2026-11-01', tiers: { hot: 70, warm: 50 } },
  rows: [{ id: 'pixel-studio', name: 'Pixel Studio', website: 'https://pixel.example', category: 'Agency', subcategory: 'Web agency', country: 'BE', score: 72 }],
});
async function file_(d, business) {
  const raw = file(business);
  await receiveBatch(d, 'leads', KEY, raw);
  return approveBatch(d, 'nirmata', { key: KEY, sha256: await sha256Hex(raw), rows: 1 });
}

describe('the Agencies tab', () => {
  it('moves the list whole, keeping each lead\'s state and notes', async () => {
    const { database: d, dispose } = await freshDatabase();
    try {
      await file_(d, 'Web design');
      await db.patchLeadState(d, `${KEY}/pixel-studio`, { stage: 'looked', notes: 'keep me' });
      const { imported } = await file_(d, 'Agencies');
      expect(imported[0].result).toBe('imported');
      expect(await db.getLead(d, `${KEY}/pixel-studio`)).toMatchObject({ business: 'Agencies', stage: 'looked', notes: 'keep me' });
      expect((await d.prepare('SELECT business FROM datasets WHERE key = ?').bind(KEY).first()).business).toBe('Agencies');
      const ask = (uid) => handleLeads(new Request(`http://hq.test/api/leads/${uid}/compose?lang=EN`), { DB: d }, new URL(`http://hq.test/api/leads/${uid}/compose?lang=EN`));
      expect((await ask(`${KEY}/pixel-studio`)).status).toBe(403);
    } finally { await dispose(); }
  }, 30000);

  it('says why no client email is written', () => {
    expect(outreachRefusal({ business: 'Agencies' })).toMatch(/white-label/);
    expect(outreachRefusal({ business: 'Web design', dataset: 'travel-volunteer-stays' })).toMatch(/Travel/);
    expect(outreachRefusal({ business: 'Web design', dataset: 'uk-leads' })).toBeNull();
  });
});
