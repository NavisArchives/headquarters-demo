import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanBriefing, readBriefing, handleBriefing, TRAVEL_DATASET } from '../src/worker/briefing.js';

/** The morning briefing (22 Oct): the pushed JSON is checked, leads and Travel are counted live. */
async function withDatabase(fn) {
  const { database: db, dispose } = await freshDatabase();
  try {
    await fn(db);
  } finally {
    await dispose();
  }
}

const GOOD = {
  date: '2026-10-23',
  findings: [
    { id: 'mail', type: 'emails', title: 'Important emails', summary: 'Two replies.', items: [{ label: 'Dr X · Re: devis', detail: 'Says yes', href: 'https://mail.google.com/mail/u/0/#inbox/abc' }] },
    { id: 'victor', type: 'commits', title: 'Victor-Alexis', items: [{ label: 'a1b2c3d · Projects page', href: 'http://localhost:4323/' }, { label: 'Report', href: '/missions' }] },
  ],
};

const lead = (db, uid, dataset, tier, score, importedAt) => db.prepare(
  `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, score, tier, payload, imported_at)
   VALUES (?, ?, ?, 'B', ?, 'https://example.com', 'C', 'BE', ?, ?, '{}', ?)`,
).bind(uid, dataset, uid.split('/')[1], `Name ${uid}`, score, tier, importedAt).run();
const dataset = (db, key, title) => db.prepare(
  `INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES (?, ?, ?, 75, 55, '2026-10-01T00:00:00Z')`,
).bind(key, key === TRAVEL_DATASET ? 'Travel list' : 'Web design', title).run();

describe('the morning briefing', () => {
  it('takes a well-formed briefing and refuses what is not', () => {
    expect(cleanBriefing(GOOD).findings.map((f) => f.type)).toEqual(['emails', 'commits']);
    expect(() => cleanBriefing({ ...GOOD, date: 'tomorrow' })).toThrow(/date/);
    expect(() => cleanBriefing({ ...GOOD, findings: [{ ...GOOD.findings[0], type: 'gossip' }] })).toThrow(/type/);
    expect(() => cleanBriefing({ ...GOOD, findings: [GOOD.findings[0], GOOD.findings[0]] })).toThrow(/unique/);
    expect(() => cleanBriefing({ ...GOOD, findings: [{ ...GOOD.findings[0], items: [{ label: 'x', href: 'javascript:alert(1)' }] }] })).toThrow(/href/);
    expect(() => cleanBriefing({ ...GOOD, findings: [{ ...GOOD.findings[0], items: [{ label: 'x', href: 'http://evil.example/' }] }] })).toThrow(/href/);
  });

  it('counts the leads live, new since yesterday first, and leaves the Travel list list out (audit C12)', async () => {
    await withDatabase(async (db) => {
      const now = Date.parse('2026-10-23T06:00:00Z');
      const fresh = '2026-10-23T01:00:00Z';
      const old = '2026-10-01T00:00:00Z';
      await dataset(db, 'clinics', 'Aesthetic clinics');
      await dataset(db, TRAVEL_DATASET, 'Travel');
      await lead(db, 'clinics/a', 'clinics', 'Hot', 80, fresh);
      await lead(db, 'clinics/b', 'clinics', 'Hot', 95, old);
      await lead(db, 'clinics/c', 'clinics', 'Warm', 60, fresh);
      await lead(db, `${TRAVEL_DATASET}/p1`, TRAVEL_DATASET, 'Hot', 90, fresh);
      await lead(db, `${TRAVEL_DATASET}/p2`, TRAVEL_DATASET, 'Warm', 60, old);
      await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('morning_briefing', ?, ?)`).bind(JSON.stringify(cleanBriefing(GOOD)), fresh).run();
      const out = await readBriefing(db, now);
      expect(out.findings.map((f) => f.type)).toEqual(['leads', 'emails', 'commits']);
      const leads = out.findings[0];
      expect(leads.counts).toEqual({ new: 2, hot: 2, warm: 1, total: 3 });
      expect(leads.items[0].label).toBe('Name clinics/a'); // new since yesterday first
      expect(leads.items[0].href).toBe('/leads?lead=clinics%2Fa');
      expect(leads.items.some((i) => i.label.includes(TRAVEL_DATASET))).toBe(false);
      // The Travel list list is personal: never a card in the work briefing.
      expect(out.findings.some((f) => f.type === 'travel' || JSON.stringify(f).includes(TRAVEL_DATASET))).toBe(false);
    });
  });

  it('stores a checked briefing through the API and refuses a bad one without writing', async () => {
    await withDatabase(async (db) => {
      const call = (method, body) => {
        const url = new URL('http://localhost:8790/api/briefing');
        return handleBriefing(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }), { DB: db }, url);
      };
      expect((await call('POST', { ...GOOD, date: 'x' })).status).toBe(400);
      expect(await db.prepare("SELECT 1 FROM settings WHERE key = 'morning_briefing'").first()).toBeNull();
      expect((await call('POST', GOOD)).status).toBe(201);
      const got = await (await call('GET')).json();
      expect(got.briefing.findings.map((f) => f.id)).toEqual(['mail', 'victor']);
      expect(await handleBriefing(new Request('http://x/api/other'), { DB: db }, new URL('http://x/api/other'))).toBeNull();
    });
  });

  it('checks a file without sending anything (--check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brf-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(good, JSON.stringify(GOOD));
    writeFileSync(bad, JSON.stringify({ ...GOOD, date: 'nope' }));
    const ok = execFileSync('node', ['scripts/briefing-push.mjs', good, '--check'], { encoding: 'utf8' });
    expect(ok).toMatch(/valid: 2026-10-23, 2 findings/);
    expect(() => execFileSync('node', ['scripts/briefing-push.mjs', bad, '--check'], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/NOT VALID/);
  });
});

describe('the pipeline card (A4)', () => {
  const NOW = Date.parse('2026-10-30T07:00:00Z');
  const deal = (db, { name, stage, next = null, updated, client = null, lead = null }) => db.prepare(
    `INSERT INTO prospects (name, organisation, brand, stage, next_at, client_id, lead_uid, template, created_at, updated_at)
     VALUES (?, '', 'realis', ?, ?, ?, ?, 'light', ?, ?)`,
  ).bind(name, stage, next, client, lead, updated, updated).run();

  it('lists what needs Andy, one reason per deal, proposals first, and leaves clients and closed deals out', async () => {
    await withDatabase(async (db) => {
      await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('surgeons', 'Web design', 'Surgeons', 70, 50, 'x')").run();
      await lead(db, 'surgeons/quiet', 'surgeons', 'Hot', 80, '2026-10-01T00:00:00Z');
      await lead(db, 'surgeons/dealt', 'surgeons', 'Hot', 80, '2026-10-01T00:00:00Z');
      await db.prepare("INSERT INTO lead_state (uid, stage, starred, notes, updated_at) VALUES ('surgeons/quiet', 'replied', 0, '', '2026-10-18T00:00:00Z'), ('surgeons/dealt', 'talks', 0, '', '2026-10-10T00:00:00Z')").run();
      await deal(db, { name: 'Dr Proposal', stage: 'proposal', next: '2026-11-02T10:00', updated: '2026-10-22T00:00:00Z' });
      await deal(db, { name: 'Dr Nodate', stage: 'meeting', updated: '2026-10-29T00:00:00Z' });
      await deal(db, { name: 'Dr Idle', stage: 'lead', next: '2026-11-05T10:00', updated: '2026-10-15T00:00:00Z', lead: 'surgeons/dealt' });
      await deal(db, { name: 'Dr Fine', stage: 'meeting', next: '2026-11-01T10:00', updated: '2026-10-29T00:00:00Z' });
      await deal(db, { name: 'Dr Won', stage: 'won', updated: '2026-09-01T00:00:00Z' });
      await db.prepare("INSERT INTO clients (name, initials, country, created_at) VALUES ('Client', 'CL', 'BE', 'x')").run();
      await deal(db, { name: 'Onboarding', stage: 'onboarding', updated: '2026-09-01T00:00:00Z', client: 1 });

      const { findings } = await readBriefing(db, NOW);
      const card = findings.find((f) => f.type === 'pipeline');
      expect(findings[0].type).toBe('pipeline');
      // Dr Proposal and Dr Idle both have a next step still ahead: they are
      // moving, so neither « chase it » nor « untouched » (audit C12, M4).
      expect(card.summary).toBe('4 open deals · 1 proposal out · 1 deal and 1 conversation need you');
      expect(card.items.map((i) => [i.label, i.detail])).toEqual([
        ['Name surgeons/quiet', 'Replied, quiet for 12 days, with no deal'],
        ['Dr Nodate', 'No next step date'],
      ]);
      expect(card.items.every((i) => i.href.startsWith('/pipeline/') || i.href.startsWith('/leads?lead='))).toBe(true);
    });
  });

  it('a lead with a deal of its own (same name or address) is listed once, as the deal', async () => {
    await withDatabase(async (db) => {
      await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('hotels', 'Web design', 'Hotels', 70, 50, 'x')").run();
      await db.prepare("INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at) VALUES ('hotels/verhoeven', 'hotels', 'verhoeven', 'B', 'Maison Verhoeven', '', 'Hotel', 'BE', 'events@verhoeven.example', 80, 'Hot', '{}', 'x')").run();
      await db.prepare("INSERT INTO lead_state (uid, stage, starred, notes, updated_at) VALUES ('hotels/verhoeven', 'talks', 0, '', '2026-10-01T00:00:00Z')").run();
      await deal(db, { name: 'Maison Verhoeven', stage: 'proposal', updated: '2026-10-01T00:00:00Z' });
      const card = (await readBriefing(db, NOW)).findings.find((f) => f.type === 'pipeline');
      expect(card.items.map((i) => i.label)).toEqual(['Maison Verhoeven']);
      expect(card.counts['need you']).toBe(card.items.length);
    });
  });

  it('is not shown when there is no deal and no quiet conversation', async () => {
    await withDatabase(async (db) => {
      const { findings } = await readBriefing(db, NOW);
      expect(findings.some((f) => f.type === 'pipeline')).toBe(false);
    });
  });
});

// The pipeline tests' deal helper, at file level for these tests.
const dealRow = (db, { name, stage, next = null, updated, client = null, lead = null }) => db.prepare(
  `INSERT INTO prospects (name, organisation, brand, stage, next_at, client_id, lead_uid, template, created_at, updated_at)
   VALUES (?, '', 'realis', ?, ?, ?, ?, 'light', ?, ?)`,
).bind(name, stage, next, client, lead, updated, updated).run();

describe('the briefing runs the day (audit C12)', () => {
  const NOW = Date.parse('2026-10-30T07:00:00Z');
  it('chases a sent proposal only with no next step ahead, and says « answer them » when the lead wrote since', async () => {
    await withDatabase(async (db) => {
      await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('w', 'Web design', 'W', 70, 50, 'x')").run();
      await lead(db, 'w/wrote', 'w', 'Hot', 80, '2026-10-01T00:00:00Z');
      await db.prepare("INSERT INTO lead_state (uid, stage, starred, notes, updated_at, last_reply_at) VALUES ('w/wrote', 'talks', 0, '', '2026-10-28T00:00:00Z', '2026-10-28T09:00:00Z')").run();
      await dealRow(db, { name: 'Dr Stale', stage: 'proposal', next: '2026-10-20T10:00', updated: '2026-10-15T00:00:00Z' });
      await dealRow(db, { name: 'Dr Answered', stage: 'proposal', updated: '2026-10-15T00:00:00Z', lead: 'w/wrote' });
      const card = (await readBriefing(db, NOW)).findings.find((f) => f.type === 'pipeline');
      expect(card.items.map((i) => [i.label, i.detail])).toEqual([
        ['Dr Answered', 'They wrote since: answer them'],
        ['Dr Stale', expect.stringMatching(/^Proposal sent, no movement for \d+ days: chase it$/)],
      ]);
    });
  });

  it('opens on « Today »: overdue invoices not snoozed, then replies waiting for Andy', async () => {
    await withDatabase(async (db) => {
      await db.prepare("INSERT INTO clients (name, initials, country, created_at) VALUES ('Client', 'CL', 'BE', 'x')").run();
      const ins = (number, due, snoozed = null, seq = 1) => db.prepare(
        `INSERT INTO invoices (number, seq, year, client_id, subject, status, issued_on, due_on, currency, vat_treatment, subtotal_cents, vat_cents, total_cents, kind, notes, created_at, updated_at, chase_snoozed_until)
         VALUES (?, ?, 2026, 1, 'Website', 'issued', '2026-09-01', ?, 'EUR', 'exempt_small', 100000, 0, 100000, 'invoice', '', 'x', 'x', ?)`,
      ).bind(number, seq, due, snoozed).run();
      await ins('1.R.A.CL.01', '2026-10-01');
      await ins('2.R.A.CL.02', '2026-10-01', '2026-12-31', 2);
      await db.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('w', 'Web design', 'W', 70, 50, 'x')").run();
      await lead(db, 'w/aurore', 'w', 'Hot', 80, '2026-10-01T00:00:00Z');
      await db.prepare("INSERT INTO lead_state (uid, stage, starred, notes, updated_at, last_sent_at, last_reply_at) VALUES ('w/aurore', 'replied', 0, '', '2026-10-28T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-28T09:00:00Z')").run();
      const { findings } = await readBriefing(db, NOW);
      expect(findings[0].type).toBe('today');
      const labels = findings[0].items.map((i) => i.label);
      expect(labels[0]).toBe('Chase 1.R.A.CL.01');
      expect(labels).not.toContain('Chase 2.R.A.CL.02'); // snoozed
      expect(findings[0].items[0].href).toMatch(/^\/finance\?invoice=\d+$/);
    });
  });
});

