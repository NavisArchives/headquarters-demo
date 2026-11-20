import { describe, it, expect } from 'vitest';

import {
  compose, DEFAULT_PROFILE, profileFor,
  langsFor as workerLangsFor, segmentFor as workerSegmentFor,
  SEGMENT_LABEL as WORKER_SEGMENT_LABEL,
} from '../src/shared/outreach.js';
import { STATE_STAGES } from '../src/worker/db.js';

import {
  COMPOSE_URL_LIMIT,
  STAGES, STAGE_BY, DIMENSIONS, CONTACT_LABEL, MODES, SEGMENT_LABEL, CSV_COLUMNS,
  normalizeLead, daysSince, relTime, formatDay, dayKey,
  isEmail, isUrl, shortUrl, tierClass, contactHref,
  stageStamp, openInfo, openedToday,
  dueReason, replyFor, needsYou, matchesTile, matchesQuery, matchesDims, dimValues,
  sortLeads, visibleLeads, hasFilters, inBusiness,
  businessTabs, stageCounts, inPlay, wonShare, attentionCounts, dimOptions,
  langsFor, segmentFor, signaturePreview,
  applyGreetingName, gmailComposeUrl,
  csvRow, csvCell, toCsv, csvFilename,
} from '../src/public/assets/leads-lib.js';

/* ------------------------------------------------------------------ *
 * Fixtures — rows in the exact shape GET /api/leads returns: facts,
 * the joined lead_state, and `languages`/`payload` still JSON text.
 * ------------------------------------------------------------------ */

function apiRow(overrides = {}) {
  const { payload, ...rest } = overrides;
  return {
    uid: 'ugc-brands-agencies/acme',
    dataset: 'ugc-brands-agencies',
    id: 'acme',
    business: 'UGC',
    name: 'Acme',
    website: 'https://www.acme.be/',
    category: 'Beauty',
    subcategory: 'Skincare',
    city: 'Ghent',
    area: 'Flanders',
    region: 'East Flanders',
    country: 'Belgium',
    languages: '["NL","EN"]',
    email: 'hello@acme.be',
    phone: null,
    contact: 'hello@acme.be',
    contact_type: 'email',
    score: 80,
    tier: 'Warm',
    verified: 'ok',
    payload: JSON.stringify({
      scoreLabel: '4/5',
      pitch: 'They post weekly, so repeat work is real.',
      evidence: 'Creator programme page, live.',
      evidenceUrl: 'https://acme.be/creators',
      research: 'Beauty-heavy, Dutch first.',
      extra: { Market: 'Belgium' },
      ...payload,
    }),
    imported_at: '2026-09-01T00:00:00.000Z',
    stage: 'new',
    starred: 0,
    notes: '',
    follow_up: null,
    looked_at: null,
    sent_at: null,
    replied_at: null,
    won_at: null,
    passed_at: null,
    updated_at: null,
    ...rest,
  };
}

const lead = (overrides) => normalizeLead(apiRow(overrides));

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

/* ------------------------------------------------------------------ */

describe('the stage vocabulary', () => {
  it('is the same eight stages, in the same order, that D1 accepts', () => {
    expect(STAGES.map((s) => s.v)).toEqual([...STATE_STAGES]);
  });

  it('labels won as Accepted, as the old app did', () => {
    expect(STAGE_BY.won.label).toBe('Accepted');
  });

  it('gives every stage the number key that selects it', () => {
    expect(STAGES.map((s) => s.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });
});

describe('normalizeLead', () => {
  it('lifts the fields that only live inside payload', () => {
    const row = lead();
    expect(row.pitch).toBe('They post weekly, so repeat work is real.');
    expect(row.evidenceUrl).toBe('https://acme.be/creators');
    expect(row.research).toBe('Beauty-heavy, Dutch first.');
    expect(row.scoreLabel).toBe('4/5');
    expect(row.extra).toEqual({ Market: 'Belgium' });
  });

  it('parses languages and turns starred back into a boolean', () => {
    expect(lead().languages).toEqual(['NL', 'EN']);
    expect(lead({ starred: 1 }).starred).toBe(true);
    expect(lead({ starred: 0 }).starred).toBe(false);
  });

  it('defaults a lead with no state row to new, unstarred and unnoted', () => {
    const row = normalizeLead({ ...apiRow(), stage: undefined, starred: undefined, notes: undefined });
    expect(row.stage).toBe('new');
    expect(row.starred).toBe(false);
    expect(row.notes).toBe('');
  });

  it('shortens the website into a domain', () => {
    expect(lead().domain).toBe('acme.be');
  });

  it('survives a payload or languages that will not parse', () => {
    const row = normalizeLead({ ...apiRow(), payload: 'not json', languages: '{' });
    expect(row.languages).toEqual([]);
    expect(row.pitch).toBe('');
  });

  it('builds a haystack that covers everything the old search covered', () => {
    const row = lead({ notes: 'Rang them in March' });
    for (const term of ['acme', 'ghent', 'skincare', 'beauty', 'repeat work', 'dutch first', 'march']) {
      expect(row.haystack).toContain(term);
    }
  });
});

describe('time', () => {
  it('reads a bare date at 09:00, so today never reads as yesterday', () => {
    expect(daysSince('2026-09-20', NOW)).toBe(0);
    expect(relTime('2026-09-20', NOW)).toBe('today');
  });

  it('counts back in the old app\'s words', () => {
    expect(relTime('2026-09-19', NOW)).toBe('yesterday');
    expect(relTime('2026-09-10', NOW)).toBe('10d ago');
    expect(relTime('2026-06-20', NOW)).toBe('3mo ago');
    expect(relTime('2024-09-20', NOW)).toBe('2y ago');
  });

  it('says nothing about nothing', () => {
    expect(relTime(null)).toBe('');
    expect(relTime('not a date')).toBe('');
    expect(daysSince('')).toBeNull();
  });

  // The month's short name is whatever the runtime's locale data calls it
  // ("Sep" or "Sept" depending on the ICU version), so pin the shape, not
  // the spelling.
  it('formats a day as day-then-month, the way the panel showed it', () => {
    expect(formatDay('2026-09-20')).toMatch(/^20 Sept?$/);
    expect(formatDay('')).toBe('');
    expect(formatDay('not a date')).toBe('not a date');
  });

  it('keys a day in local time', () => {
    expect(dayKey(new Date(2026, 8, 20, 23, 59))).toBe('2026-09-20');
  });
});

describe('small text rules', () => {
  it('knows an email from a URL', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('https://b.co')).toBe(false);
    expect(isUrl('https://b.co')).toBe(true);
    expect(isUrl('a@b.co')).toBe(false);
  });

  it('shortens a URL to what you would read out', () => {
    expect(shortUrl('https://www.acme.be/')).toBe('acme.be');
  });

  it('maps a tier to its pill', () => {
    expect(tierClass('Hot')).toBe('tier-hot');
    expect(tierClass('Warm')).toBe('tier-warm');
    expect(tierClass('Cool')).toBe('tier-cool');
    expect(tierClass(undefined)).toBe('tier-cool');
  });

  it('resolves the contact link the way the old app did', () => {
    expect(contactHref(lead())).toBe('mailto:hello@acme.be');
    expect(contactHref(lead({ contact: 'https://acme.be/contact' })))
      .toBe('https://acme.be/contact');
    expect(contactHref(lead({ contact: '', contact_type: 'phone', phone: '+32 (0)9 111' })))
      .toBe('tel:+3209111');
    expect(contactHref(lead({ contact: 'ask at reception' }))).toBe('https://www.acme.be/');
  });
});

describe('stageStamp', () => {
  it('prefers the column D1 stamps', () => {
    expect(stageStamp(lead({ sent_at: '2026-09-01T10:00:00.000Z' }), 'sent')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('falls back to the first matching event for the stages with no column', () => {
    const events = [
      { kind: 'stage', detail: 'talks', at: '2026-09-11T10:00:00.000Z' },
      { kind: 'stage', detail: 'talks', at: '2026-09-09T10:00:00.000Z' },
      { kind: 'note', detail: '', at: '2026-09-10T10:00:00.000Z' },
    ];
    expect(stageStamp(lead(), 'talks', events)).toBe('2026-09-09T10:00:00.000Z');
    expect(stageStamp(lead(), 'shortlist', events)).toBe('');
  });
});

describe('opens', () => {
  it('reports how many and when', () => {
    const info = openInfo(['2026-09-20T09:00:00.000Z', '2026-09-18T09:00:00.000Z']);
    expect(info).toEqual({
      count: 2, first: '2026-09-18T09:00:00.000Z', last: '2026-09-20T09:00:00.000Z',
    });
  });

  it('is null when the pixel never fired', () => {
    expect(openInfo([])).toBeNull();
    expect(openInfo(undefined)).toBeNull();
  });

  it('counts "today" against the local calendar day, not 24 hours', () => {
    const now = new Date(2026, 8, 20, 10, 0);
    expect(openedToday([new Date(2026, 8, 20, 0, 5).toISOString()], now)).toBe(true);
    expect(openedToday([new Date(2026, 8, 19, 23, 55).toISOString()], now)).toBe(false);
    expect(openedToday([], now)).toBe(false);
  });
});

describe('dueReason', () => {
  it('goes by the follow-up date only: a sent lead without one is not due (audit C13)', () => {
    // The server's cadence sets the date after each email and clears it when the
    // sequence ends; a « sent a week ago » rule here counted leads Home did not.
    expect(dueReason(lead({ stage: 'sent', sent_at: '2026-09-13T09:00:00.000Z' }), NOW)).toBe('');
    expect(dueReason(lead({ stage: 'sent', sent_at: '2026-09-13T09:00:00.000Z', follow_up: '2026-09-20' }), NOW)).toBe('follow-up today');
  });

  it('is due when a follow-up date has arrived or passed', () => {
    expect(dueReason(lead({ follow_up: '2026-09-20' }), NOW)).toBe('follow-up today');
    expect(dueReason(lead({ follow_up: '2026-09-18' }), NOW)).toBe('follow-up was 2d ago');
    expect(dueReason(lead({ follow_up: '2026-09-25' }), NOW)).toBe('');
  });

  it('never chases a lead that is finished either way', () => {
    expect(dueReason(lead({ stage: 'won', follow_up: '2026-01-01' }), NOW)).toBe('');
    expect(dueReason(lead({ stage: 'passed', follow_up: '2026-01-01' }), NOW)).toBe('');
  });
});

describe('replies to act on', () => {
  const replies = { 'hello@acme.be': { bucket: 'warm' }, 'sales@other.be': { bucket: 'declined' } };

  it('matches the lead\'s own address', () => {
    expect(replyFor(lead(), replies)).toEqual({ bucket: 'warm' });
  });

  it('falls back to anyone at the same company', () => {
    const other = lead({ email: 'someone@other.be', contact: 'someone@other.be' });
    expect(replyFor(other, replies)).toEqual({ bucket: 'declined' });
  });

  it('is nothing at all when the Gmail bridge said nothing', () => {
    expect(replyFor(lead(), {})).toBeNull();
    expect(replyFor(lead(), null)).toBeNull();
  });

  it('counts a warm or signup reply, and a lead sitting at replied', () => {
    expect(needsYou(lead(), replies)).toBe(true);
    expect(needsYou(lead({ stage: 'replied' }), {})).toBe(true);
    expect(needsYou(lead({ email: 'sales@other.be', contact: 'sales@other.be' }), replies)).toBe(false);
    expect(needsYou(lead(), {})).toBe(false);
  });
});

describe('matchesTile', () => {
  const ctx = { opens: { 'ugc-brands-agencies/acme': ['2026-09-19T09:00:00.000Z'] }, replies: {}, now: NOW };

  it('filters by stage', () => {
    expect(matchesTile(lead({ stage: 'sent' }), 'sent', ctx)).toBe(true);
    expect(matchesTile(lead({ stage: 'new' }), 'sent', ctx)).toBe(false);
  });

  it('passes everything through when no tile is pressed', () => {
    expect(matchesTile(lead(), null, ctx)).toBe(true);
  });

  it('filters by each of the attention rows', () => {
    expect(matchesTile(lead({ starred: 1 }), 'star', ctx)).toBe(true);
    expect(matchesTile(lead(), 'star', ctx)).toBe(false);
    expect(matchesTile(lead(), 'opened', ctx)).toBe(true);
    expect(matchesTile(lead({ uid: 'x/y' }), 'opened', ctx)).toBe(false);
    expect(matchesTile(lead({ stage: 'replied' }), 'needsyou', ctx)).toBe(true);
    expect(matchesTile(lead({ stage: 'sent', sent_at: '2026-09-01T09:00:00.000Z', follow_up: '2026-09-08' }), 'due', ctx)).toBe(true);
    expect(matchesTile(lead({ stage: 'sent', sent_at: '2026-09-01T09:00:00.000Z' }), 'due', ctx)).toBe(false); // no date: the cadence ended
    expect(matchesTile(lead(), 'email', ctx)).toBe(true);
    expect(matchesTile(lead({ email: null }), 'email', ctx)).toBe(false);
    expect(matchesTile(lead({ verified: 'live-checked' }), 'live', ctx)).toBe(true);
    expect(matchesTile(lead(), 'live', ctx)).toBe(false);
  });
});

describe('search', () => {
  it('needs every term to appear somewhere', () => {
    expect(matchesQuery(lead(), 'acme ghent')).toBe(true);
    expect(matchesQuery(lead(), 'acme antwerp')).toBe(false);
  });

  it('matches the pitch, the research and the notes, not just the name', () => {
    expect(matchesQuery(lead(), 'repeat')).toBe(true);
    expect(matchesQuery(lead(), 'dutch')).toBe(true);
    expect(matchesQuery(lead({ notes: 'called them' }), 'called')).toBe(true);
  });

  it('is empty-search-friendly', () => {
    expect(matchesQuery(lead(), '')).toBe(true);
    expect(matchesQuery(lead(), '   ')).toBe(true);
  });
});

/** Dimensions are looked up by field, never by position: inserting one
 *  (Country arrived with the surgeon lists) must not shift these tests. */
const dim = (field) => DIMENSIONS.find((d) => d.field === field);

describe('the dropdown dimensions', () => {
  it('offers category, country, area, language, tier and contact', () => {
    expect(DIMENSIONS.map((d) => d.field))
      .toEqual(['category', 'country', 'area', 'languages', 'tier', 'contactType']);
  });

  it('reads a contact route through its label', () => {
    expect(dimValues(lead(), dim('contactType'))).toEqual([CONTACT_LABEL.email]);
    expect(dimValues(lead({ contact_type: 'form' }), dim('contactType'))).toEqual(['Form']);
  });

  it('spreads a multi-value dimension over each of its values', () => {
    expect(dimValues(lead(), dim('languages'))).toEqual(['NL', 'EN']);
  });

  it('keeps a lead that matches any selected value of a dimension', () => {
    expect(matchesDims(lead(), { category: ['Beauty', 'Food'] })).toBe(true);
    expect(matchesDims(lead(), { category: ['Food'] })).toBe(false);
  });

  it('needs every dimension with a selection to match', () => {
    expect(matchesDims(lead(), { category: ['Beauty'], country: ['France'] })).toBe(false);
  });

  it('ignores the dimension whose own options are being counted', () => {
    expect(matchesDims(lead(), { category: ['Food'] }, 'category')).toBe(true);
  });
});

describe('sorting', () => {
  const a = lead({ uid: 'a/a', name: 'Beta', score: 90, updated_at: '2026-09-01T00:00:00.000Z' });
  const b = lead({ uid: 'b/b', name: 'Alpha', score: 70, updated_at: '2026-09-19T00:00:00.000Z' });
  const starred = lead({ uid: 'c/c', name: 'Gamma', score: 10, starred: 1 });

  it('puts the best fit first, and a starred lead above all of them', () => {
    expect(sortLeads([a, b, starred], 'fit').map((l) => l.name)).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  it('sorts by most recently touched', () => {
    expect(sortLeads([a, b], 'touched').map((l) => l.name)).toEqual(['Alpha', 'Beta']);
  });

  it('sorts by name', () => {
    expect(sortLeads([a, b], 'name').map((l) => l.name)).toEqual(['Alpha', 'Beta']);
  });

  it('does not reorder the caller\'s array', () => {
    const input = [a, b];
    sortLeads(input, 'name');
    expect(input.map((l) => l.name)).toEqual(['Beta', 'Alpha']);
  });
});

describe('visibleLeads', () => {
  const leads = [
    lead({ uid: 'a/a', name: 'Acme', business: 'UGC', score: 90 }),
    lead({ uid: 'b/b', name: 'Bricks', business: 'Web design', category: 'Architecture', score: 80 }),
    lead({ uid: 'c/c', name: 'Cedar', business: 'UGC', stage: 'sent', score: 70 }),
  ];

  it('narrows to the business tab', () => {
    expect(inBusiness(leads[1], 'UGC')).toBe(false);
    const shown = visibleLeads(leads, { business: 'UGC', dims: {}, sort: 'fit' });
    expect(shown.map((l) => l.name)).toEqual(['Acme', 'Cedar']);
  });

  it('shows everything under All leads', () => {
    expect(visibleLeads(leads, { business: 'all', dims: {}, sort: 'fit' })).toHaveLength(3);
  });

  it('stacks the tile, the dropdowns and the search', () => {
    const shown = visibleLeads(leads, {
      business: 'all', tile: 'sent', dims: { category: ['Beauty'] }, q: 'cedar', sort: 'fit',
    });
    expect(shown.map((l) => l.name)).toEqual(['Cedar']);
  });

  it('knows when anything is filtering', () => {
    expect(hasFilters({ dims: {} })).toBe(false);
    expect(hasFilters({ tile: 'star', dims: {} })).toBe(true);
    expect(hasFilters({ q: 'x', dims: {} })).toBe(true);
    expect(hasFilters({ dims: { tier: ['Hot'] } })).toBe(true);
    expect(hasFilters({ q: '  ', dims: {} })).toBe(false);
  });
});

describe('roll-ups', () => {
  const leads = [
    lead({ uid: 'a/a', business: 'UGC', stage: 'sent', sent_at: '2026-09-01T09:00:00.000Z', follow_up: '2026-09-08' }),
    lead({ uid: 'b/b', business: 'UGC', stage: 'won', starred: 1 }),
    lead({ uid: 'c/c', business: 'Web design', stage: 'passed', email: null, verified: 'live-checked' }),
    lead({ uid: 'd/d', business: 'Web design', stage: 'shortlist' }),
  ];

  it('counts the business tabs, All leads first', () => {
    expect(businessTabs(leads)).toEqual([
      { v: 'all', label: 'All leads', n: 4 },
      { v: 'UGC', label: 'UGC', n: 2 },
      { v: 'Web design', label: 'Web design', n: 2 },
    ]);
  });

  it('counts every stage, including the empty ones', () => {
    const counts = stageCounts(leads);
    expect(counts).toMatchObject({ new: 0, shortlist: 1, sent: 1, won: 1, passed: 1 });
    expect(Object.keys(counts)).toHaveLength(8);
  });

  it('calls shortlisted, sent, replied and in-talks "in play"', () => {
    expect(inPlay(stageCounts(leads))).toBe(2);
  });

  it('reads the won stage as a share of everything sent', () => {
    expect(wonShare(stageCounts(leads))).toBe('33% of outreach');
    expect(wonShare(stageCounts([lead()]))).toBe('nothing sent yet');
  });

  it('counts each attention row', () => {
    const counts = attentionCounts(leads, {
      opens: { 'a/a': ['2026-09-19T09:00:00.000Z'] }, replies: {}, now: NOW,
    });
    expect(counts).toEqual({ star: 1, opened: 1, needsyou: 0, due: 1, email: 3, live: 1 });
  });
});

describe('dimOptions', () => {
  const leads = [
    lead({ uid: 'a/a', category: 'Beauty', country: 'Belgium', tier: 'Hot' }),
    lead({ uid: 'b/b', category: 'Beauty', country: 'France', tier: 'Cool' }),
    lead({ uid: 'c/c', category: 'Food', country: 'Belgium', tier: 'Warm' }),
  ];
  const category = dim('category');

  it('counts every option, commonest first', () => {
    expect(dimOptions(leads, category, { dims: {} })).toEqual([
      { value: 'Beauty', count: 2 }, { value: 'Food', count: 1 },
    ]);
  });

  it('counts an option against the other filters, not its own', () => {
    const options = dimOptions(leads, category, { dims: { country: ['Belgium'] } });
    expect(options).toEqual([{ value: 'Beauty', count: 1 }, { value: 'Food', count: 1 }]);
  });

  it('keeps a chosen option listed even when nothing is left under it', () => {
    const options = dimOptions(leads, category, { q: 'nothing matches this', dims: { category: ['Food'] } });
    expect(options).toEqual([{ value: 'Food', count: 0 }]);
  });

  it('orders tiers hot, warm, cool rather than by count', () => {
    expect(dimOptions(leads, dim('tier'), { dims: {} }).map((o) => o.value))
      .toEqual(['Hot', 'Warm', 'Cool']);
  });
});

/* ------------------------------------------------------------------ *
 * The two rules the composer mirrors from the worker. These tests are
 * what makes that copy safe: they compare it against the real thing.
 * ------------------------------------------------------------------ */

describe('langsFor and segmentFor mirror the worker exactly', () => {
  const rows = [
    lead(),
    lead({ country: 'Netherlands', languages: '["NL","FR","EN"]' }),
    lead({ country: 'France', languages: '["FR","EN"]' }),
    lead({ country: 'Germany', languages: '["NL"]' }),
    lead({ languages: '[]' }),
    lead({ business: 'Web design', category: 'Architecture' }),
    lead({ category: 'Agency/Platform' }),
    lead({ category: 'Creator community' }),
    lead({ category: 'Food & drink' }),
    lead({ category: 'Tech' }),
    lead({ category: 'Furniture' }),
  ];

  it('picks the same languages, in the same order', () => {
    for (const row of rows) expect(langsFor(row)).toEqual(workerLangsFor(row));
  });

  it('never offers an empty set of language pills', () => {
    expect(langsFor(lead({ languages: '[]' }))).toEqual(['EN']);
  });

  it('picks the same segment', () => {
    for (const row of rows) expect(segmentFor(row)).toBe(workerSegmentFor(row));
  });

  it('uses the same segment labels', () => {
    expect(SEGMENT_LABEL).toEqual({ ...WORKER_SEGMENT_LABEL });
  });

  it('offers the three composer modes the compose route accepts', () => {
    expect(MODES.map((m) => m.v)).toEqual(['email', 'dm', 'followup']);
  });
});

describe('signaturePreview mirrors the sign-off the worker writes', () => {
  it('ends a real composed follow-up exactly', () => {
    // Realis emails now carry Andy's fixed sign-off in every mode, so the
    // generated block the Your details screen previews is only written for
    // UGC leads. Test it where it is still used.
    const row = {
      business: 'UGC', name: 'Brand X', category: 'Beauty',
      country: 'Belgium', languages: ['NL'],
    };
    const { body } = compose(row, { lang: 'NL', mode: 'followup', profile: DEFAULT_PROFILE });
    expect(body.endsWith(signaturePreview(profileFor(row, DEFAULT_PROFILE)))).toBe(true);
  });

  it('drops the lines the profile has not filled in', () => {
    expect(signaturePreview({ name: 'Andy' })).toBe('Andy');
    expect(signaturePreview({ name: 'Andy', studio: 'Archive', phone: '+32' }))
      .toBe('Andy — Archive\n+32');
  });
});

describe('applyGreetingName', () => {
  it('greets the name typed into the TO field', () => {
    expect(applyGreetingName('Hi Acme,\n\nrest', 'Sofie', 'EN')).toBe('Hi Sofie,\n\nrest');
    expect(applyGreetingName('Hallo Acme,\n\nrest', 'Jan', 'NL')).toBe('Hallo Jan,\n\nrest');
    expect(applyGreetingName('Bonjour,\n\nrest', 'Luc', 'FR')).toBe('Bonjour Luc,\n\nrest');
  });

  it('falls back to the bare greeting when the name is cleared', () => {
    expect(applyGreetingName('Hi Acme,\n\nrest', '', 'EN')).toBe('Hi there,\n\nrest');
    expect(applyGreetingName('Hallo Jan,\n\nrest', '   ', 'NL')).toBe('Hallo,\n\nrest');
  });

  it('keeps the punctuation the template chose', () => {
    expect(applyGreetingName('Hi Acme!\n\nrest', 'Sofie', 'EN')).toBe('Hi Sofie!\n\nrest');
  });

  it('leaves a body that does not open with a greeting alone', () => {
    expect(applyGreetingName('Quick one about your site.', 'Sofie', 'EN'))
      .toBe('Quick one about your site.');
  });

  it('only ever touches the opening line', () => {
    const body = 'Hi Acme,\n\nHi again later in the text.';
    expect(applyGreetingName(body, 'Sofie', 'EN')).toBe('Hi Sofie,\n\nHi again later in the text.');
  });
});

describe('gmailComposeUrl', () => {
  it('opens the full-screen compose window with the message already in it', () => {
    const url = new URL(gmailComposeUrl('hello@acme.be', 'Subject line', 'Body text'));
    // `authuser` names the account, so the window opens in Andy's Gmail
    // however many Google accounts are signed in on the machine.
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/');
    expect(url.searchParams.get('authuser')).toBe('owner@example.com');
    // `view=cm` is what opens the compose form at all. Without it Gmail
    // ignores the other parameters and shows the inbox, which is exactly what
    // "Open in Gmail" used to do: a tab, no message, lead marked sent.
    expect(url.searchParams.get('view')).toBe('cm');
    expect(url.searchParams.get('fs')).toBe('1');
    expect(url.searchParams.get('to')).toBe('hello@acme.be');
    expect(url.searchParams.get('su')).toBe('Subject line');
    expect(url.searchParams.get('body')).toBe('Body text');
  });

  it('carries a whole website email without coming near the URL limit', () => {
    const body = 'x'.repeat(2000);
    expect(gmailComposeUrl('a@b.be', 'Subject', body).length).toBeLessThan(COMPOSE_URL_LIMIT);
  });

  it('leaves out what it does not have', () => {
    const url = new URL(gmailComposeUrl('', '', ''));
    expect(url.searchParams.has('to')).toBe(false);
    expect(url.searchParams.has('su')).toBe(false);
    expect(url.searchParams.has('body')).toBe(false);
  });
});

describe('CSV export', () => {
  it('keeps the old app\'s columns, in the old app\'s order', () => {
    expect(CSV_COLUMNS).toEqual([
      'business', 'list', 'name', 'status', 'starred', 'score', 'tier', 'category', 'subcategory',
      'city', 'area', 'country', 'languages', 'email', 'phone', 'contact', 'contactType', 'website',
      'evidenceUrl', 'evidence', 'pitch', 'research', 'verified', 'lookedAt', 'sentAt', 'repliedAt',
      'wonAt', 'passedAt', 'followUp', 'notes',
    ]);
  });

  it('writes one cell per column, with the stage as its label', () => {
    const row = csvRow(lead({ stage: 'won', starred: 1 }), 'UGC — brands');
    expect(row).toHaveLength(CSV_COLUMNS.length);
    expect(row[1]).toBe('UGC — brands');
    expect(row[3]).toBe('Accepted');
    expect(row[4]).toBe('yes');
    expect(row[12]).toBe('NL / EN');
  });

  it('falls back to the dataset key when the list has no title', () => {
    expect(csvRow(lead())[1]).toBe('ugc-brands-agencies');
  });

  it('quotes a cell that would otherwise break the row', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has, comma')).toBe('"has, comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
  });

  it('starts with the BOM Excel needs and a header line', () => {
    const csv = toCsv([lead()], { 'ugc-brands-agencies': 'UGC — brands' });
    const lines = csv.split('\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe(`﻿${CSV_COLUMNS.join(',')}`);
    expect(lines).toHaveLength(2);
  });

  it('names the file after the tab and the day', () => {
    expect(csvFilename('all', new Date(2026, 8, 20))).toBe('leads-all-2026-09-20.csv');
    expect(csvFilename('Web design', new Date(2026, 8, 20))).toBe('leads-web-design-2026-09-20.csv');
  });
});

describe('letterHtml', async () => {
  const { letterHtml } = await import('../src/public/assets/leads-lib.js');
  const body = 'Bonjour Dr X,\n\nUn exemple :\nDr Marc Aubin — https://www.docteuraubin.example\n\nAppelez-moi au +32 400 00 00 00.\n\nBien à vous,\nAndy\nRealis Studio\nBruxelles';
  it('keeps the words, links the site and phone, and has no images', () => {
    const html = letterHtml(body);
    expect(html).toContain('<p style="margin:0 0 16px;">Bonjour Dr X,</p>');
    expect(html).toContain('href="https://www.docteuraubin.example"');
    expect(html).toContain('href="tel:+32400000000"');
    expect(html).toContain('Realis Studio');
    expect(html).not.toMatch(/<img/);
  });
  it('escapes markup in the text', () => {
    expect(letterHtml('a <b>\n\nx\nAndy')).toContain('a &lt;b&gt;');
  });
});

describe('doctor greeting', async () => {
  const { applyGreetingName, surnameOf } = await import('../src/public/assets/leads-lib.js');
  it('takes the family name', () => {
    expect(surnameOf('Yanis Haddad')).toBe('Haddad');
    expect(surnameOf('Dr. Pieter Van den Berg')).toBe('Van den Berg');
    expect(surnameOf('Haddad')).toBe('Haddad');
  });
  it('keeps Docteur / dokter when the name is edited', () => {
    expect(applyGreetingName('Bonjour Docteur Haddad,\n\nx', 'Karim Saleh', 'FR')).toBe('Bonjour Docteur Saleh,\n\nx');
    expect(applyGreetingName('Beste dokter Haddad,\n\nx', 'Karim Saleh', 'NL')).toBe('Beste dokter Saleh,\n\nx');
    expect(applyGreetingName('Beste dokter Haddad,', '', 'NL')).toBe('Beste dokter,');
  });
});

describe('letterHtml postscript', async () => {
  const { letterHtml } = await import('../src/public/assets/leads-lib.js');
  it('keeps the signature intact and sets the P.-S. under it', () => {
    const html = letterHtml('Bonjour,\n\nTexte.\n\nBien cordialement,\n\nAndy\nRealis Studio, Bruxelles\n+32 400 00 00 00\n\nP.-S. Dites-le-moi.');
    expect(html).toContain('<div style="font-size:15px;color:#1a1a1a">Andy</div>');
    expect(html.indexOf('P.-S.')).toBeGreaterThan(html.indexOf('Realis Studio, Bruxelles'));
  });
});

describe('letterHtml open pixel', async () => {
  const { letterHtml } = await import('../src/public/assets/leads-lib.js');
  it('adds a 1x1 pixel only for a public https gif', () => {
    expect(letterHtml('Hi,\n\nText.\n\nThanks,\nAndy', 'https://hq.example.com/px/abc.gif')).toContain('<img src="https://hq.example.com/px/abc.gif" width="1" height="1" alt=""');
    expect(letterHtml('Hi,\n\nText.\n\nThanks,\nAndy', 'http://localhost:8787/px/abc.gif')).not.toContain('<img');
    expect(letterHtml('Hi,\n\nText.\n\nThanks,\nAndy')).not.toContain('<img');
  });
});

describe('« Follow-up due » (audit C13)', () => {
  it('reads most overdue first, not by fit', () => {
    const due = [
      lead({ uid: 'x/new', score: 99, stage: 'sent', follow_up: '2026-09-19' }),
      lead({ uid: 'x/old', score: 10, stage: 'sent', follow_up: '2026-08-01' }),
      lead({ uid: 'x/mid', score: 50, stage: 'sent', follow_up: '2026-09-01' }),
    ];
    const shown = visibleLeads(due, { tile: 'due', dims: {}, sort: 'fit' }, { now: NOW });
    expect(shown.map((l) => l.uid)).toEqual(['x/old', 'x/mid', 'x/new']);
  });
});

