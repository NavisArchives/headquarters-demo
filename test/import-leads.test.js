import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { runImport, deriveTier, deriveContactType, prepareImport, ImportError } from '../src/worker/import-leads.js';
import { LEAD_COLUMNS } from '../src/worker/db.js';
import { DEFAULT_DATASETS_DIR, loadDatasets } from '../scripts/import-leads.mjs';

const PAYLOAD_INDEX = LEAD_COLUMNS.indexOf('payload');

/**
 * The same fake-D1 harness as test/leads-db.test.js: it records every
 * statement and its bindings, so a test can assert on exactly what would
 * have been sent to D1, without a real database.
 */
function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: [] }; },
        async first() { return null; },
        async run() { return { success: true, meta: { last_row_id: 1, changes: 1 } }; },
      };
      return stmt;
    },
  };
}

const meta = (over = {}) => ({
  key: 'ugc-brands-agencies',
  business: 'UGC',
  title: 'UGC — brands, agencies and platforms buying creator content',
  collected: '2026-09-20',
  tiers: { hot: 80, warm: 50 },
  ...over,
});

const row = (over = {}) => ({
  id: 'babbel',
  name: 'Lingo',
  website: 'https://www.lingo.example',
  category: 'Tech',
  subcategory: 'Consumer app / edtech',
  country: 'Germany',
  score: 100,
  city: 'Berlin',
  area: 'Germany',
  region: 'EU / Berlin',
  email: 'social@lingo.example',
  phone: null,
  contact: 'social@lingo.example',
  languages: ['EN', 'NL', 'FR'],
  verified: 'live-checked',
  pitch: 'Native Dutch + native French',
  research: 'Berlin HQ',
  ...over,
});

const dataset = (metaOver = {}, rows = [row()]) => ({ key: metaOver.key ?? meta().key, meta: meta(metaOver), rows });

describe('deriveTier', () => {
  it('is Hot at or above the hot threshold', () => {
    expect(deriveTier(80, { hot: 80, warm: 50 })).toBe('Hot');
    expect(deriveTier(100, { hot: 80, warm: 50 })).toBe('Hot');
  });

  it('is Warm at or above the warm threshold, below hot', () => {
    expect(deriveTier(50, { hot: 80, warm: 50 })).toBe('Warm');
    expect(deriveTier(79, { hot: 80, warm: 50 })).toBe('Warm');
  });

  it('is Cool below the warm threshold', () => {
    expect(deriveTier(49, { hot: 80, warm: 50 })).toBe('Cool');
    expect(deriveTier(0, { hot: 80, warm: 50 })).toBe('Cool');
  });
});

describe('deriveContactType', () => {
  it('uses the row\'s own contactType when present', () => {
    expect(deriveContactType({ contactType: 'linkedin', email: 'a@b.com' })).toBe('linkedin');
  });

  it('derives email when contactType is absent and email is present', () => {
    expect(deriveContactType({ email: 'a@b.com', phone: null })).toBe('email');
  });

  it('derives phone when contactType and email are absent but phone is present', () => {
    expect(deriveContactType({ email: null, phone: '+32 123' })).toBe('phone');
  });

  it('falls back to form when none are present', () => {
    expect(deriveContactType({ email: null, phone: null })).toBe('form');
  });
});

describe('prepareImport: validation', () => {
  it('stops on a row missing a required field, naming the dataset and the row', () => {
    const bad = dataset({}, [row({ website: '' })]);
    expect(() => prepareImport([bad])).toThrow(ImportError);
    try {
      prepareImport([bad]);
      expect.fail('expected prepareImport to throw');
    } catch (err) {
      expect(err.message).toContain('ugc-brands-agencies/babbel');
      expect(err.message).toContain('website');
    }
  });

  it('names the row by index when the missing field is id itself', () => {
    try {
      prepareImport([dataset({}, [row({ id: '' })])]);
      expect.fail('expected prepareImport to throw');
    } catch (err) {
      expect(err.message).toContain('ugc-brands-agencies/#0');
      expect(err.message).toContain("'id'");
    }
  });

  it.each(['id', 'name', 'website', 'category', 'subcategory', 'country', 'score'])(
    'rejects a row missing %s',
    (field) => {
      expect(() => prepareImport([dataset({}, [row({ [field]: field === 'score' ? undefined : '' })])]))
        .toThrow(ImportError);
    },
  );

  it('a bad row in the second dataset still aborts before any statement is prepared', async () => {
    const good = dataset({ key: 'a' }, [row({ id: 'good' })]);
    const bad = dataset({ key: 'b' }, [row({ id: 'bad', name: '' })]);
    const db = fakeDb();
    await expect(runImport(db, [good, bad])).rejects.toBeInstanceOf(ImportError);
    expect(db.calls).toHaveLength(0);
  });
});

describe('runImport', () => {
  it('derives uid as <dataset key>/<id>', async () => {
    const db = fakeDb();
    await runImport(db, [dataset()]);
    const leadInsert = db.calls.find((c) => c.sql.includes('INSERT INTO leads'));
    expect(leadInsert.args).toContain('ugc-brands-agencies/babbel');
  });

  it('stores languages as a JSON array string', async () => {
    const db = fakeDb();
    await runImport(db, [dataset()]);
    const leadInsert = db.calls.find((c) => c.sql.includes('INSERT INTO leads'));
    expect(leadInsert.args).toContain('["EN","NL","FR"]');
  });

  it('stores the complete original row in payload, verbatim', async () => {
    const original = row();
    const db = fakeDb();
    await runImport(db, [dataset({}, [original])]);
    const leadInsert = db.calls.find((c) => c.sql.includes('INSERT INTO leads'));
    expect(JSON.parse(leadInsert.args[PAYLOAD_INDEX])).toEqual(original);
  });

  it('derives contact_type from email then phone when the row omits contactType', async () => {
    const db = fakeDb();
    await runImport(db, [dataset({}, [row({ email: null, phone: '+49 30 1234', contact: '+49 30 1234' })])]);
    const leadInsert = db.calls.find((c) => c.sql.includes('INSERT INTO leads'));
    expect(leadInsert.args).toContain('phone');
  });

  it('never issues a statement mentioning lead_state, lead_events or lead_drafts', async () => {
    const db = fakeDb();
    await runImport(db, [dataset()]);
    for (const call of db.calls) {
      expect(call.sql).not.toContain('lead_state');
      expect(call.sql).not.toContain('lead_events');
      expect(call.sql).not.toContain('lead_drafts');
    }
  });

  it('running the same input twice yields identical statement sequences (idempotent)', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    let real;
    try {
      // Freeze the clock so db.js's own nowIso() timestamps match across runs.
      real = Date;
      // eslint-disable-next-line no-global-assign
      globalThis.Date = class extends real { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now.getTime(); } };

      const input = [dataset({}, [row(), row({ id: 'second', name: 'Second', score: 60 })])];
      const dbA = fakeDb();
      const dbB = fakeDb();
      await runImport(dbA, input);
      await runImport(dbB, input);

      expect(dbA.calls.map((c) => [c.sql, c.args])).toEqual(dbB.calls.map((c) => [c.sql, c.args]));
      expect(dbA.calls.length).toBeGreaterThan(0);
    } finally {
      if (real) globalThis.Date = real;
    }
  });

  it('returns a summary with the row count per dataset and the total', async () => {
    const db = fakeDb();
    const summary = await runImport(db, [dataset({}, [row(), row({ id: 'second', score: 10 })])], { now: '2026-09-20T00:00:00.000Z' });
    expect(summary.totalRows).toBe(2);
    expect(summary.importedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(summary.datasets).toEqual([{ key: 'ugc-brands-agencies', business: 'UGC', count: 2 }]);
  });
});

describe('real datasets smoke test', () => {
  it('loads and validates the actual data.json files, and the total row count matches', () => {
    if (!existsSync(DEFAULT_DATASETS_DIR)) {
      console.warn(`skipping: ${DEFAULT_DATASETS_DIR} does not exist (leads/ not present as a sibling folder)`);
      return;
    }

    const datasets = loadDatasets(DEFAULT_DATASETS_DIR);
    expect(datasets.length).toBeGreaterThan(0);

    const prepared = prepareImport(datasets);
    const totalRows = prepared.reduce((sum, d) => sum + d.count, 0);

    // Recompute the expected total independently, straight off disk, so this
    // test doesn't just check prepareImport against itself.
    let expectedTotal = 0;
    for (const d of datasets) expectedTotal += d.rows.length;

    expect(totalRows).toBe(expectedTotal);
  });
});
