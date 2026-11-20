// GET /api/intake/send-list: what MARKETING may send next, read-only, LEADS token
// only (Andy, 14 Nov: yes to Monday's surgeon follow-up batch).
import { describe, it, expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import * as db from '../src/worker/db.js';
import { handleIntake } from '../src/worker/intake.js';
import { messageIdFrom, parseStages } from '../src/worker/send-list.js';

const TOKENS = {
  INTAKE_TOKEN_NIRMATA: 'n'.repeat(40),
  INTAKE_TOKEN_SHORTCUT: 's'.repeat(40),
  INTAKE_TOKEN_EMAIL: 'e'.repeat(40),
  INTAKE_TOKEN_LEADS: 'l'.repeat(40),
};

// Each test gets its own database, booted from a template migrated once per
// file (helpers/d1.js). Replaying every migration in every test made these
// the slowest tests in the suite, and under load they ran past their budget.
async function withEnv(fn) {
  const { database, dispose } = await freshDatabase();
  try {
    await fn({ DB: database, ...TOKENS }, database);
  } finally { await dispose(); }
}

const get = (env, query, { token = TOKENS.INTAKE_TOKEN_LEADS, method = 'GET' } = {}) => handleIntake(
  new Request(`https://hq.example/api/intake/send-list${query}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }),
  env, new URL(`https://hq.example/api/intake/send-list${query}`),
);

async function seed(database) {
  const run = (sql, ...args) => database.prepare(sql).bind(...args).run();
  await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-belgium', 'Plastic surgeons', 'BE', 70, 50, 'x')");
  await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('travel-volunteer-stays', 'Travel list', 'Travel', 70, 50, 'x')");
  const lead = (id, email, payload = '{}', languages = '["FR","NL"]', score = 80) => run(
    `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
     VALUES (?, 'plastic-surgeons-belgium', ?, 'Plastic surgeons', ?, '', 'Own practice site', 'Belgium', ?, ?, 'Hot', ?, ?, 'x')`,
    `plastic-surgeons-belgium/${id}`, id, `Dr ${id}`, email, score, payload, languages,
  );
  await lead('a', 'A@Clinic.be', JSON.stringify({ pitch: 'secret research', extra: { hook: 'your rhinoplasty page', code: 'S1' } }), '["FR"]', 90);
  await lead('b', 'b@clinic.be');
  await lead('c', 'c@clinic.be');
  await lead('d', 'gone@clinic.be');
  await run(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
     VALUES ('plastic-surgeons-belgium/nl', 'plastic-surgeons-belgium', 'nl', 'Plastic surgeons', 'Dr NL', '', 'x', 'Netherlands', 'nl@x.nl', 50, 'Warm', '{}', '["NL"]', 'x')`);
  await db.patchLeadState(database, 'plastic-surgeons-belgium/a', { stage: 'sent' });
  await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-belgium/a', 'sent', 'batch 2026-11-03 · template v3 · to a@clinic.be · message <CA+abc123@mail.gmail.com>', '2026-11-03T08:00:00Z')");
  await db.patchLeadState(database, 'plastic-surgeons-belgium/b', { stage: 'sent' });
  await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-belgium/b', 'sent', 'batch 1', '2026-10-20T08:00:00Z')");
  await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-belgium/b', 'sent', 'follow-up', '2026-10-27T08:00:00Z')");
  await db.patchLeadState(database, 'plastic-surgeons-belgium/c', { stage: 'replied' });
  await run("INSERT INTO reply_reviews (uid, message_id, thread_id, from_email, subject, received_at, body_excerpt, intent, summary, asks, language, reviewed_at, status) VALUES ('plastic-surgeons-belgium/c', 'm1', 't-777', 'c@clinic.be', 'Re', '2026-11-05T10:00:00Z', '', 'wants_info', '', '[]', 'fr', '2026-11-05T10:00:00Z', 'open')");
  await run("INSERT INTO email_suppression (email, reason, source, at) VALUES ('gone@clinic.be', 'hard_bounce', 'brevo:blocklist', '2026-10-09T00:00:00Z')");
}

describe('one letter per inbox (NIRMATA, 14 Nov)', () => {
  it('says how many leads share an address, and the lead it was already written to through', async () => {
    await withEnv(async (env, database) => {
      const run = (sql, ...args) => database.prepare(sql).bind(...args).run();
      await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-belgium', 'Plastic surgeons', 'BE', 70, 50, 'x'), ('aesthetic-clinics', 'Clinics', 'C', 70, 50, 'x')");
      const lead = (ds, id, email) => run(
        `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
         VALUES (?, ?, ?, 'Plastic surgeons', ?, '', 'x', 'Belgium', ?, 80, 'Hot', '{}', '["FR"]', 'x')`, `${ds}/${id}`, ds, id, id, email);
      await lead('plastic-surgeons-belgium', 'old', 'Info@Shared.be'); // already written to
      await lead('plastic-surgeons-belgium', 'new1', 'info@shared.be ');
      await lead('plastic-surgeons-belgium', 'own', 'own@doc.be');
      await lead('aesthetic-clinics', 'clinic', 'own@doc.be'); // the same inbox, in another list, never written to
      await run("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('plastic-surgeons-belgium/old', 'sent', 'batch 1', '2026-10-08T08:35:00Z')");
      const body = await (await get(env, '?dataset=plastic-surgeons-belgium')).json();
      const by = (id) => body.leads.find((l) => l.uid.endsWith(`/${id}`));
      expect(by('new1')).toMatchObject({ inbox_leads: 2, inbox_written_via: 'plastic-surgeons-belgium/old' });
      expect(by('old')).toMatchObject({ inbox_leads: 2, inbox_written_via: null }); // its own send is not « another lead »
      expect(by('own')).toMatchObject({ inbox_leads: 2, inbox_written_via: null }); // shared across lists, never written
      expect(body.counts).toMatchObject({ shared_inbox: 3, inbox_already_written: 1 });
    });
  }, 60000);
});

describe('the cold-email rule of 14 Nov: NL companies only, CH one by one', () => {
  it('returns NL leads only as B.V. or N.V., and flags every Swiss lead as personalised only', async () => {
    await withEnv(async (env, database) => {
      const run = (sql, ...args) => database.prepare(sql).bind(...args).run();
      await run("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('mixed', 'Plastic surgeons', 'M', 70, 50, 'x')");
      const lead = (id, country, payload) => run(
        `INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
         VALUES (?, 'mixed', ?, 'Plastic surgeons', ?, '', 'x', ?, ?, 80, 'Hot', ?, '["NL"]', 'x')`, `mixed/${id}`, id, id, country, `${id}@x.eu`, payload);
      await lead('bv', 'Netherlands', JSON.stringify({ legal_form: 'B.V.' }));
      await lead('nv', 'NL', JSON.stringify({ legal_form: 'nv' }));
      await lead('eenmanszaak', 'Netherlands', JSON.stringify({ legal_form: 'eenmanszaak' }));
      await lead('vof', 'Netherlands', JSON.stringify({ legal_form: 'v.o.f.' }));
      await lead('unchecked', 'Netherlands', '{}');
      await lead('zurich', 'Switzerland', '{}');
      await lead('brussels', 'Belgium', '{}');
      const body = await (await get(env, '?dataset=mixed')).json();
      expect(body.leads.map((l) => l.uid.split('/')[1]).sort()).toEqual(['brussels', 'bv', 'nv', 'zurich']);
      expect(body.leads.find((l) => l.uid.endsWith('/bv'))).toMatchObject({ legal_form: 'B.V.', personalised_only: false });
      expect(body.leads.find((l) => l.uid.endsWith('/zurich'))).toMatchObject({ personalised_only: true });
      expect(body.leads.find((l) => l.uid.endsWith('/brussels'))).toMatchObject({ personalised_only: false });
      expect(body.counts).toMatchObject({ personalised_only: 1, nl_left_out_not_a_company: 3, in_list: 4 });
    });
  }, 60000);
});

describe('the send list', () => {
  it('gives LEADS every row of one list, with what a batch needs, and counts', async () => {
    await withEnv(async (env, database) => {
      await seed(database);
      const res = await get(env, '?dataset=plastic-surgeons-belgium');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.counts).toMatchObject({ in_list: 4, matching: 4, with_email: 4, suppressed: 1, sent: 2, has_followup: 1, replied: 1, with_hook: 1 });
      expect(body.counts.by_stage).toMatchObject({ new: 1, sent: 2, replied: 1 });
      const a = body.leads.find((l) => l.uid.endsWith('/a'));
      expect(a).toMatchObject({
        email: 'a@clinic.be', name: 'Dr a', lang: 'FR', stage: 'sent', hook: 'your rhinoplasty page', code: 'S1',
        sends: 1, has_followup: false, replied: false, suppressed: false, sent_message_id: '<CA+abc123@mail.gmail.com>',
      });
      expect(JSON.stringify(body)).not.toContain('secret research');
      expect(body.leads.some((l) => l.country === 'Netherlands')).toBe(false); // NL without a checked company form: left out (rule of 14 Nov)
      expect(body.leads.find((l) => l.uid.endsWith('/b'))).toMatchObject({ sends: 2, has_followup: true, lang: 'NL' }); // HQ's own rule: NL first in Belgium when they speak it

      expect(body.leads.find((l) => l.uid.endsWith('/c'))).toMatchObject({ replied: true, reply_thread_id: 't-777' });
      expect(body.leads.find((l) => l.uid.endsWith('/d'))).toMatchObject({ suppressed: true });
    });
  }, 60000);

  it('filters by stage, and counts what the filter keeps', async () => {
    await withEnv(async (env, database) => {
      await seed(database);
      const body = await (await get(env, '?dataset=plastic-surgeons-belgium&stage=sent')).json();
      expect(body.leads.map((l) => l.uid.split('/')[1]).sort()).toEqual(['a', 'b']);
      expect(body.counts).toMatchObject({ in_list: 4, matching: 2, has_followup: 1 });
      expect((await get(env, '?dataset=plastic-surgeons-belgium&stage=nope')).status).toBe(400);
    });
  }, 60000);

  it('is LEADS only: NIRMATA, the Shortcut, email and no token are refused', async () => {
    await withEnv(async (env, database) => {
      await seed(database);
      for (const token of [TOKENS.INTAKE_TOKEN_NIRMATA, TOKENS.INTAKE_TOKEN_SHORTCUT, TOKENS.INTAKE_TOKEN_EMAIL]) {
        // eslint-disable-next-line no-await-in-loop -- one by one
        expect((await get(env, '?dataset=plastic-surgeons-belgium', { token })).status).toBe(403);
      }
      expect((await get(env, '?dataset=plastic-surgeons-belgium', { token: null })).status).toBe(401);
      expect((await get(env, '?dataset=plastic-surgeons-belgium', { token: 'x'.repeat(40) })).status).toBe(401);
    });
  }, 60000);

  it('has no write path: anything but GET is refused, and nothing changes', async () => {
    await withEnv(async (env, database) => {
      await seed(database);
      const snapshot = async () => JSON.stringify(await Promise.all(['leads', 'lead_state', 'lead_events', 'email_suppression', 'reply_reviews', 'intake_requests']
        .map((t) => database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().then((r) => r.results))));
      const before = await snapshot();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        // eslint-disable-next-line no-await-in-loop -- one by one
        expect((await get(env, '?dataset=plastic-surgeons-belgium', { method })).status).toBe(405);
      }
      await get(env, '?dataset=plastic-surgeons-belgium');
      expect(await snapshot()).toBe(before);
    });
  }, 60000);

  it('never serves the Travel list, an unknown list, or no list', async () => {
    await withEnv(async (env, database) => {
      await seed(database);
      expect((await get(env, '?dataset=travel-volunteer-stays')).status).toBe(400);
      expect((await get(env, '?dataset=nope')).status).toBe(400);
      expect((await get(env, '')).status).toBe(400);
    });
  }, 60000);

  it('reads the parts it parses', () => {
    expect(messageIdFrom('batch b · template t · to a@b.c · message <x@y>')).toBe('<x@y>');
    expect(messageIdFrom('first email · sent by Andy from HQ')).toBeNull();
    expect(parseStages('sent, replied,sent')).toEqual(['sent', 'replied']);
    expect(parseStages('')).toBeNull();
  });
});

describe('read cost (14 Nov: D1 free daily row-read limit)', () => {
  it('one call reads a few rows per lead, not every « sent » event per lead', async () => {
    await withEnv(async (env, database) => {
      await database.prepare("INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at) VALUES ('plastic-surgeons-belgium', 'Plastic surgeons', 'BE', 70, 50, 'x'), ('other', 'x', 'O', 70, 50, 'x')").run();
      // 400 leads, each with one « sent » and one stage event, in three set-based
      // statements (1,200 single inserts took ~20 s on a busy disk; same rows).
      await database.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 399)
        INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, languages, imported_at)
        SELECT CASE WHEN i < 200 THEN 'plastic-surgeons-belgium' ELSE 'other' END || '/l' || i,
          CASE WHEN i < 200 THEN 'plastic-surgeons-belgium' ELSE 'other' END, 'l' || i, 'Plastic surgeons',
          'Dr Name' || i || ' Test', '', 'x', 'Belgium', 'l' || i || '@x.example', 50, 'Warm', '{}', '["FR"]', 'x' FROM n`).run();
      await database.prepare(`INSERT INTO lead_events (uid, kind, detail, at, sent_to)
        SELECT uid, 'sent', 'batch a', '2026-10-01T00:00:00Z', email FROM leads WHERE dataset IN ('plastic-surgeons-belgium', 'other') ORDER BY uid`).run();
      await database.prepare(`INSERT INTO lead_events (uid, kind, detail, at)
        SELECT uid, 'stage', 'sent', '2026-10-01T00:00:00Z' FROM leads WHERE dataset IN ('plastic-surgeons-belgium', 'other') ORDER BY uid`).run();
      let rows = 0;
      const counted = new Proxy(database, { get(t, k) {
        if (k !== 'prepare') { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
        return (sql) => {
          const wrap = (stmt) => new Proxy(stmt, { get(s2, k2) {
            if (k2 === 'bind') return (...a) => wrap(s2.bind(...a));
            if (k2 === 'all') return async () => { const r = await s2.all(); rows += r.meta?.rows_read ?? 0; return r; };
            if (k2 === 'first') return async () => { const r = await s2.all(); rows += r.meta?.rows_read ?? 0; return r.results?.[0] ?? null; };
            const v = s2[k2]; return typeof v === 'function' ? v.bind(s2) : v;
          } });
          return wrap(t.prepare(sql));
        };
      } });
      const res = await get({ ...env, DB: counted }, '?dataset=plastic-surgeons-belgium');
      expect(res.status).toBe(200);
      // Before 0033 this was ~ 200 leads × 400 sent events × 3 subqueries; now a handful per lead.
      expect(rows).toBeLessThan(200 * 25);
    });
  });

  it('D1’s daily limit answers 503 in words, not a crash', async () => {
    const limit = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
    const throwing = { prepare: () => ({ bind() { return this; }, first: async () => { throw limit; }, all: async () => { throw limit; } }) };
    const res = await get({ ...TOKENS, DB: throwing }, '?dataset=plastic-surgeons-belgium');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'd1_daily_limit', error: expect.stringMatching(/19:00 Lima/) });
  });
});
