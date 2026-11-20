import { describe, it, expect } from 'vitest';
import {
  LEAD_COLUMNS, STATE_STAGES,
  upsertDataset, upsertLead, listLeads, getLead, patchLeadState,
  getDraft, saveDraft, clearDraft, getSetting, setSetting,
  ValidationError,
} from '../src/worker/db.js';

/**
 * The same fake-D1 harness as test/db.test.js: it records every statement
 * and its bindings, so a test can assert that values were bound rather than
 * interpolated. `first` and `all` are static per-test responses — every
 * `.first()` call gets the same `responses.first`, every `.all()` call gets
 * the same `responses.all`.
 */
function fakeDb(responses = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      const stmt = {
        bind(...args) { call.args = args; return stmt; },
        async all() { return { results: responses.all ?? [] }; },
        async first() { return responses.first ?? null; },
        async run() { return { success: true, meta: { last_row_id: responses.lastId ?? 1, changes: responses.changes ?? 1 } }; },
      };
      return stmt;
    },
  };
}

const leadFacts = (over = {}) => ({
  uid: 'ugc-brands-agencies/babbel', dataset: 'ugc-brands-agencies', id: 'babbel',
  business: 'UGC', name: 'Lingo', website: 'https://www.lingo.example',
  category: 'Tech', subcategory: 'Consumer app / edtech',
  city: 'Berlin', area: 'Germany', region: 'EU / Berlin', country: 'Germany',
  languages: '["EN","NL","FR"]', email: 'social@lingo.example', phone: null,
  contact: 'social@lingo.example', contact_type: 'email',
  score: 100, tier: 'Hot', verified: 'live-checked',
  payload: '{"pitch":"Native Dutch + native French","research":"Berlin HQ"}',
  imported_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const stateDefaults = (over = {}) => ({
  stage: 'new', starred: 0, notes: '', follow_up: null,
  looked_at: null, sent_at: null, replied_at: null, won_at: null, passed_at: null,
  updated_at: null,
  ...over,
});

const leadRow = (factsOver = {}, stateOver = {}) => ({ ...leadFacts(factsOver), ...stateDefaults(stateOver) });

describe('LEAD_COLUMNS', () => {
  it('is frozen and includes uid, dataset and id first', () => {
    expect(Object.isFrozen(LEAD_COLUMNS)).toBe(true);
    expect(LEAD_COLUMNS.slice(0, 3)).toEqual(['uid', 'dataset', 'id']);
    expect(LEAD_COLUMNS).toContain('payload');
    expect(LEAD_COLUMNS).toContain('imported_at');
  });
});

describe('STATE_STAGES', () => {
  it('is exactly the old app\'s eight stages', () => {
    expect(Object.isFrozen(STATE_STAGES)).toBe(true);
    expect([...STATE_STAGES]).toEqual(['new', 'looked', 'shortlist', 'sent', 'replied', 'talks', 'won', 'passed']);
  });
});

describe('upsertLead', () => {
  const validRow = () => ({
    dataset: 'ugc-brands-agencies', id: 'babbel', business: 'UGC', name: 'Lingo',
    website: 'https://www.lingo.example', category: 'Tech', country: 'Germany',
    score: 100, tier: 'Hot', payload: { pitch: 'x' }, languages: ['EN', 'NL'],
  });

  it('binds every value rather than interpolating', async () => {
    const db = fakeDb();
    await upsertLead(db, { ...validRow(), name: "Robert'); DROP TABLE leads;--" });
    expect(db.calls[0].sql).not.toContain('DROP TABLE');
    expect(db.calls[0].sql).not.toContain('Lingo');
    expect(db.calls[0].args).toContain("Robert'); DROP TABLE leads;--");
    // score is an integer, but it must still be bound, never interpolated.
    expect(db.calls[0].sql).not.toMatch(/\b100\b/);
    expect(db.calls[0].args).toContain(100);
  });

  it('never references lead_state', async () => {
    const db = fakeDb();
    await upsertLead(db, validRow());
    for (const call of db.calls) expect(call.sql).not.toContain('lead_state');
  });

  it('derives uid as dataset/id, ignoring any uid the caller passes', async () => {
    const db = fakeDb();
    await upsertLead(db, { ...validRow(), uid: 'nonsense/uid' });
    expect(db.calls[0].args).toContain('ugc-brands-agencies/babbel');
    expect(db.calls[0].args).not.toContain('nonsense/uid');
  });

  it('serializes a languages array to a JSON string', async () => {
    const db = fakeDb();
    await upsertLead(db, validRow());
    expect(db.calls[0].args).toContain('["EN","NL"]');
  });

  it('serializes a payload object to a JSON string', async () => {
    const db = fakeDb();
    await upsertLead(db, validRow());
    expect(db.calls[0].args).toContain('{"pitch":"x"}');
  });

  it('rejects an invalid tier before querying', async () => {
    const db = fakeDb();
    await expect(upsertLead(db, { ...validRow(), tier: 'Lukewarm' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a missing required field before querying', async () => {
    const db = fakeDb();
    await expect(upsertLead(db, { ...validRow(), name: '' })).rejects.toMatchObject({ field: 'name' });
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a non-integer score', async () => {
    const db = fakeDb();
    await expect(upsertLead(db, { ...validRow(), score: '100' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('upsertDataset', () => {
  it('binds every value, mapping tiers.hot/warm to tier_hot/tier_warm', async () => {
    const db = fakeDb();
    await upsertDataset(db, {
      key: 'ugc-brands-agencies', business: 'UGC', title: 'Brands buying UGC',
      tiers: { hot: 80, warm: 50 }, count: 42,
    });
    expect(db.calls[0].sql).toContain('tier_hot');
    expect(db.calls[0].sql).toContain('tier_warm');
    expect(db.calls[0].args).toContain(80);
    expect(db.calls[0].args).toContain(50);
    expect(db.calls[0].args).toContain(42);
  });

  it('rejects a missing key before querying', async () => {
    const db = fakeDb();
    await expect(upsertDataset(db, { business: 'UGC', title: 'x', tiers: { hot: 1, warm: 1 } }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });
});

describe('listLeads', () => {
  it('with no filter, orders by score descending', async () => {
    const db = fakeDb({ all: [leadRow()] });
    await listLeads(db);
    expect(db.calls[0].sql).toMatch(/ORDER BY l\.score DESC/);
  });

  it('with stage, binds the stage rather than interpolating it', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { stage: 'sent' });
    expect(db.calls[0].sql).not.toContain("'sent'");
    expect(db.calls[0].args).toContain('sent');
  });

  it('rejects an unknown stage filter instead of querying', async () => {
    const db = fakeDb({ all: [] });
    await expect(listLeads(db, { stage: 'ghosted' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an unknown sort instead of querying', async () => {
    const db = fakeDb({ all: [] });
    await expect(listLeads(db, { sort: 'vibes' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('with q, searches name, city, category, payload (pitch/research) and notes', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { q: 'babbel' });
    const sql = db.calls[0].sql;
    expect(sql).toMatch(/l\.name LIKE \? ESCAPE '\\'/);
    expect(sql).toMatch(/l\.city LIKE \? ESCAPE '\\'/);
    expect(sql).toMatch(/l\.category LIKE \? ESCAPE '\\'/);
    expect(sql).toMatch(/l\.payload LIKE \? ESCAPE '\\'/);
    expect(sql).toMatch(/notes.*LIKE \? ESCAPE '\\'/);
    expect(db.calls[0].args).toContain('%babbel%');
  });

  it('escapes % in the search term so a lead named "100%" is findable', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { q: '100%' });
    expect(db.calls[0].args).toContain('%100\\%%');
  });

  it('escapes _ so a search for it does not match every row', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { q: '_' });
    expect(db.calls[0].args).toContain('%\\_%');
    expect(db.calls[0].args).not.toContain('%_%');
  });

  it('matches languages against the quoted JSON form', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { language: 'NL' });
    expect(db.calls[0].args).toContain('%"NL"%');
  });

  it('binds business, category, area, tier and contact filters', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db, { business: 'UGC', category: 'Tech', area: 'Germany', tier: 'Hot', contact: 'email' });
    const args = db.calls[0].args;
    expect(args).toEqual(expect.arrayContaining(['UGC', 'Tech', 'Germany', 'Hot', 'email']));
  });

  it('a lead with no lead_state row lists as stage: new, starred: 0, notes: ""', async () => {
    const db = fakeDb({ all: [{ ...leadFacts(), stage: null, starred: null, notes: null, follow_up: null }] });
    const [lead] = await listLeads(db);
    expect(lead.stage).toBe('new');
    expect(lead.starred).toBe(0);
    expect(lead.notes).toBe('');
  });

  it('joins and coalesces state in SQL too, not only in JS', async () => {
    const db = fakeDb({ all: [] });
    await listLeads(db);
    expect(db.calls[0].sql).toMatch(/LEFT JOIN lead_state/);
    expect(db.calls[0].sql).toMatch(/COALESCE\(s\.stage, 'new'\)/);
    expect(db.calls[0].sql).toMatch(/COALESCE\(s\.starred, 0\)/);
  });
});

describe('getLead', () => {
  it('returns facts + state + last 20 events', async () => {
    const db = fakeDb({ first: leadRow(), all: [{ id: 1, kind: 'stage', detail: 'looked', at: '2026-09-20T10:00:00.000Z' }] });
    const lead = await getLead(db, 'ugc-brands-agencies/babbel');
    expect(lead.uid).toBe('ugc-brands-agencies/babbel');
    expect(lead.events).toHaveLength(1);
    expect(db.calls.some((c) => c.sql.includes('lead_events') && c.sql.includes('LIMIT 20'))).toBe(true);
  });

  it('binds the uid rather than interpolating it', async () => {
    const db = fakeDb({ first: leadRow(), all: [] });
    await getLead(db, "x'; DROP TABLE leads;--");
    expect(db.calls[0].sql).not.toContain('DROP TABLE');
    expect(db.calls[0].args).toContain("x'; DROP TABLE leads;--");
  });

  it('returns null for an unknown uid, without querying events', async () => {
    const db = fakeDb({ first: null });
    expect(await getLead(db, 'nope/nope')).toBeNull();
    expect(db.calls.some((c) => c.sql.includes('SELECT id, kind, detail, at FROM lead_events'))).toBe(false);
  });
});

describe('patchLeadState', () => {
  it('rejects an empty patch before querying', async () => {
    const db = fakeDb();
    await expect(patchLeadState(db, 'x/1', {})).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects an unknown stage before querying', async () => {
    const db = fakeDb();
    await expect(patchLeadState(db, 'x/1', { stage: 'ghosted' })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('returns null for an unknown uid, without writing', async () => {
    const db = fakeDb({ first: null });
    const result = await patchLeadState(db, 'nope/nope', { stage: 'looked' }, '2026-09-20T10:00:00.000Z');
    expect(result).toBeNull();
    expect(db.calls.some((c) => /INSERT INTO lead_state|INSERT INTO lead_events/.test(c.sql))).toBe(false);
  });

  it('moving to looked sets looked_at (when unset) and appends a stage event', async () => {
    const db = fakeDb({ first: leadRow() });
    const at = '2026-09-20T10:00:00.000Z';
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'looked' }, at);
    expect(result.looked_at).toBe(at);

    const upsert = db.calls.find((c) => c.sql.includes('INSERT INTO lead_state'));
    expect(upsert.args).toContain('looked');
    expect(upsert.args).toContain(at);

    const event = db.calls.find((c) => c.sql.includes('INSERT INTO lead_events'));
    expect(event.args).toEqual(['ugc-brands-agencies/babbel', 'stage', 'looked', at]);
  });

  it('does not overwrite looked_at once it is already set', async () => {
    const firstLookedAt = '2026-09-10T09:00:00.000Z';
    const db = fakeDb({ first: leadRow({}, { looked_at: firstLookedAt }) });
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'looked' }, '2026-09-20T10:00:00.000Z');
    expect(result.looked_at).toBe(firstLookedAt);
  });

  it('moving to sent sets sent_at', async () => {
    const db = fakeDb({ first: leadRow() });
    const at = '2026-09-20T10:00:00.000Z';
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'sent' }, at);
    expect(result.sent_at).toBe(at);
  });

  it('moving to replied sets replied_at', async () => {
    const db = fakeDb({ first: leadRow() });
    const at = '2026-09-20T10:00:00.000Z';
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'replied' }, at);
    expect(result.replied_at).toBe(at);
  });

  it('moving to won sets won_at', async () => {
    const db = fakeDb({ first: leadRow() });
    const at = '2026-09-20T10:00:00.000Z';
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'won' }, at);
    expect(result.won_at).toBe(at);
  });

  it('moving to passed sets passed_at', async () => {
    const db = fakeDb({ first: leadRow() });
    const at = '2026-09-20T10:00:00.000Z';
    const result = await patchLeadState(db, 'ugc-brands-agencies/babbel', { stage: 'passed' }, at);
    expect(result.passed_at).toBe(at);
  });

  it('a star change appends a star event', async () => {
    const db = fakeDb({ first: leadRow() });
    await patchLeadState(db, 'ugc-brands-agencies/babbel', { starred: true }, '2026-09-20T10:00:00.000Z');
    const event = db.calls.find((c) => c.sql.includes('INSERT INTO lead_events'));
    expect(event.args[1]).toBe('star');
  });

  it('a notes change appends a note event', async () => {
    const db = fakeDb({ first: leadRow() });
    await patchLeadState(db, 'ugc-brands-agencies/babbel', { notes: 'Called, no answer' }, '2026-09-20T10:00:00.000Z');
    const event = db.calls.find((c) => c.sql.includes('INSERT INTO lead_events'));
    expect(event.args[1]).toBe('note');
  });

  it('a follow_up change appends a followup event', async () => {
    const db = fakeDb({ first: leadRow() });
    await patchLeadState(db, 'ugc-brands-agencies/babbel', { follow_up: '2026-10-01' }, '2026-09-20T10:00:00.000Z');
    const event = db.calls.find((c) => c.sql.includes('INSERT INTO lead_events'));
    expect(event.args[1]).toBe('followup');
  });

  it('rejects non-string notes before querying', async () => {
    const db = fakeDb();
    await expect(patchLeadState(db, 'x/1', { notes: 42 })).rejects.toBeInstanceOf(ValidationError);
    expect(db.calls).toHaveLength(0);
  });

  it('binds every value rather than interpolating', async () => {
    const db = fakeDb({ first: leadRow() });
    await patchLeadState(db, 'ugc-brands-agencies/babbel', { notes: "'); DROP TABLE lead_state;--" }, '2026-09-20T10:00:00.000Z');
    for (const call of db.calls) expect(call.sql).not.toContain('DROP TABLE');
  });
});

describe('drafts', () => {
  it('getDraft returns null when there is no row', async () => {
    const db = fakeDb({ first: null });
    expect(await getDraft(db, 'x/1', 'nl')).toBeNull();
  });

  it('saveDraft binds uid, lang and the draft fields', async () => {
    const db = fakeDb({ first: { uid: 'x/1', lang: 'nl', subject: 'Hoi', body: 'B', to_name: 'Lingo', updated_at: 'now' } });
    await saveDraft(db, 'x/1', 'nl', { subject: 'Hoi', body: 'B', to_name: 'Lingo' });
    expect(db.calls[0].args).toEqual(expect.arrayContaining(['x/1', 'nl', 'Hoi', 'B', 'Lingo']));
  });

  it('clearDraft reports whether a row was removed', async () => {
    expect(await clearDraft(fakeDb({ changes: 1 }), 'x/1', 'nl')).toBe(true);
    expect(await clearDraft(fakeDb({ changes: 0 }), 'x/1', 'nl')).toBe(false);
  });
});

describe('settings', () => {
  it('getSetting parses the stored JSON', async () => {
    const db = fakeDb({ first: { value: '{"tone":"direct"}' } });
    expect(await getSetting(db, 'profile')).toEqual({ tone: 'direct' });
  });

  it('getSetting returns null when absent', async () => {
    const db = fakeDb({ first: null });
    expect(await getSetting(db, 'profile')).toBeNull();
  });

  it('setSetting stores JSON.stringify(value), bound rather than interpolated', async () => {
    const db = fakeDb();
    await setSetting(db, 'profile', { tone: 'direct' });
    expect(db.calls[0].args).toContain('{"tone":"direct"}');
    expect(db.calls[0].sql).not.toContain('direct');
  });
});
