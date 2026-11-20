// Quick personalization (culling mode): the codes LEADS writes into extra.code,
// their order, and the three marks mapped onto the lead's own state.
import { describe, it, expect } from 'vitest';
import {
  codeOf, codedLeads, tierOf, marksOf, togglePatch, cullView, cullCounts, offerOf, applyHow, travelMessage, seenOf, sendBadge,
  listingOf, conditionsOf, FIELDS, fieldOf, fieldCounts,
} from '../src/public/assets/leads-cull-lib.js';

const lead = (code, stage = 'new', starred = false, extra = {}) => ({
  uid: `d/${code || 'x'}`, name: code || 'none', stage, starred, extra: code == null ? extra : { ...extra, code },
});

describe('codes', () => {
  it('reads S/B/F + number, and rejects anything else', () => {
    expect(codeOf(lead('S3'))).toEqual({ letter: 'S', n: 3, code: 'S3' });
    expect(codeOf(lead(' b12 '))).toEqual({ letter: 'B', n: 12, code: 'B12' });
    for (const bad of ['X1', 'S', 'S01x', '12', '', null]) expect(codeOf(lead(bad))).toBeNull();
  });

  it('keeps only coded leads, S before B before F, and S2 before S10', () => {
    const order = codedLeads([lead('F1'), lead('S10'), lead(null), lead('B2'), lead('S2'), lead('B1')]).map((l) => l.extra.code);
    expect(order).toEqual(['S2', 'S10', 'B1', 'B2', 'F1']);
  });
});

describe('marks map onto the lead state', () => {
  it('noted = looked, skip = passed, priority = star', () => {
    expect(marksOf(lead('S1', 'looked'))).toMatchObject({ noted: true, skip: false, locked: false });
    expect(marksOf(lead('S1', 'passed'))).toMatchObject({ skip: true, noted: false });
    expect(marksOf(lead('S1', 'new', true)).priority).toBe(true);
  });

  it('toggles on and back off', () => {
    expect(togglePatch(lead('S1'), 'noted')).toEqual({ stage: 'looked' });
    expect(togglePatch(lead('S1', 'looked'), 'noted')).toEqual({ stage: 'new' });
    expect(togglePatch(lead('S1'), 'skip')).toEqual({ stage: 'passed' });
    expect(togglePatch(lead('S1', 'passed'), 'skip')).toEqual({ stage: 'new' });
    expect(togglePatch(lead('S1', 'new', true), 'priority')).toEqual({ starred: false });
  });

  it('never moves a lead that was already written to backwards; only ★ still works', () => {
    for (const stage of ['sent', 'replied', 'talks', 'won', 'shortlist']) {
      expect(togglePatch(lead('B4', stage), 'noted')).toBeNull();
      expect(togglePatch(lead('B4', stage), 'skip')).toBeNull();
      expect(togglePatch(lead('B4', stage), 'priority')).toEqual({ starred: true });
    }
  });
});

describe('the view and the counter', () => {
  const all = [lead('S1', 'looked'), lead('S2'), lead('S3', 'passed'), lead('B1', 'new', true), lead('F1', 'sent'), lead(null)];

  it('filters by market and by mark; To do hides noted, skipped and already-written leads', () => {
    expect(cullView(all, { market: 'S', mark: 'all' }).map((l) => l.extra.code)).toEqual(['S1', 'S2', 'S3']);
    expect(cullView(all, { mark: 'todo' }).map((l) => l.extra.code)).toEqual(['S2', 'B1']);
    expect(cullView(all, { mark: 'priority' }).map((l) => l.extra.code)).toEqual(['B1']);
  });

  it('counts « noted / total » for the chosen market', () => {
    const s = cullCounts(all, 'S');
    expect(s).toMatchObject({ total: 3, noted: 1, skipped: 1 });
    expect(cullCounts(all).byMarket).toEqual({ S: 3, B: 1, F: 1, G: 0, I: 0, N: 0, D: 0, P: 0 });
    expect(cullCounts(all).all).toBe(5);
  });
});

describe('P · Travel stays (Andy\'s personal list)', () => {
  const p = (code, stage = 'new', extra = {}) => ({ ...lead(code, stage), ...extra });
  const mixed = [lead('S1'), lead('B1'), p('P2'), p('P1', 'shortlist'), p('P10', 'passed')];

  it('reads P codes and keeps them after S, B and F, numerically', () => {
    expect(codeOf(p('P7'))).toEqual({ letter: 'P', n: 7, code: 'P7' });
    expect(codedLeads(mixed).map((l) => l.extra.code)).toEqual(['S1', 'B1', 'P1', 'P2', 'P10']);
  });

  it('never shows P in « All » or its counts; P is its own tab', () => {
    expect(cullView(mixed, { market: 'all' }).map((l) => l.extra.code)).toEqual(['S1', 'B1']);
    expect(cullCounts(mixed).all).toBe(2);
    expect(cullCounts(mixed).byMarket.P).toBe(3);
    expect(cullView(mixed, { market: 'P' }).map((l) => l.extra.code)).toEqual(['P1', 'P2', 'P10']);
  });

  it('decisions: ✉ email myself = shortlist, ✎ their form = looked, ✕ skip = passed; again clears', () => {
    expect(togglePatch(p('P2'), 'email')).toEqual({ stage: 'shortlist' });
    expect(togglePatch(p('P2'), 'form')).toEqual({ stage: 'looked' });
    expect(togglePatch(p('P2'), 'skip')).toEqual({ stage: 'passed' });
    expect(togglePatch(p('P1', 'shortlist'), 'email')).toEqual({ stage: 'new' });
    expect(togglePatch(p('P1', 'shortlist'), 'form')).toEqual({ stage: 'looked' });
    // S/B/F marks do not apply to P, and a place he already wrote to is history.
    expect(togglePatch(p('P2'), 'priority')).toBeNull();
    expect(togglePatch(p('P3', 'sent'), 'email')).toBeNull();
  });

  it('filters and counts the Travel decisions', () => {
    expect(cullView(mixed, { market: 'P', mark: 'todo' }).map((l) => l.extra.code)).toEqual(['P2']);
    expect(cullView(mixed, { market: 'P', mark: 'email' }).map((l) => l.extra.code)).toEqual(['P1']);
    expect(cullCounts(mixed, 'P')).toMatchObject({ total: 3, decided: 2, email: 1, form: 0, skipped: 1 });
  });

  it('says how to apply and what the place offers', () => {
    expect(applyHow({ email: 'hola@x.example' })).toEqual({ kind: 'email', label: 'Email: hola@x.example', address: 'hola@x.example' });
    expect(applyHow({ contact: 'https://www.workaway.info/en/host/1' })).toMatchObject({ kind: 'portal', label: 'Apply on Workaway' });
    expect(applyHow({ website: 'https://site.example' })).toMatchObject({ kind: 'site', url: 'https://site.example' });
    expect(offerOf({ research: 'Offers: private room, meals · BEST match · Opened profile' })).toBe('private room, meals');
  });

  it('sends Andy to the listing when the offer is not on their own site (Retreat T\'ika, 29 Oct)', () => {
    const retreat = {
      website: 'https://retreat-one.example', contactType: 'portal',
      contact: 'https://bookretreats.example/jobs/job/on-site-yoga-teacher-retreat-one-rj685',
      evidenceUrl: 'https://bookretreats.example/jobs/job/on-site-yoga-teacher-retreat-one-rj685',
      evidence: 'Must already be in the Sacred Valley for an interview; CV + cover letter + ayni statement.',
    };
    expect(listingOf(retreat)).toBe(retreat.evidenceUrl);
    expect(applyHow(retreat)).toEqual({ kind: 'portal', label: 'Apply on BookRetreats', url: retreat.evidenceUrl });
    expect(conditionsOf(retreat)).toMatch(/^Must already be in the Sacred Valley/);
    expect(applyHow({ ...retreat, evidenceUrl: '', contact: 'https://www.worldpackers.com/positions/1' })).toMatchObject({ label: 'Apply on Worldpackers' });
    // LEADS's Listing wins over the evidence link; an empty Listing falls back to it.
    expect(listingOf({ ...retreat, extra: { Listing: 'https://www.workaway.info/en/host/9' } })).toBe('https://www.workaway.info/en/host/9');
    expect(listingOf({ ...retreat, extra: { Listing: '' } })).toBe(retreat.evidenceUrl);
  });

  it('keeps their own site when the offer is on it', () => {
    const own = { website: 'https://www.place.example', contactType: 'portal', evidenceUrl: 'https://place.example/volunteer' };
    expect(listingOf(own)).toBeNull();
    expect(applyHow(own)).toEqual({ kind: 'portal', label: 'Apply on their site', url: 'https://www.place.example' });
    expect(applyHow({ website: 'https://site.example', contactType: 'form' })).toMatchObject({ kind: 'site', label: 'Contact form on their site' });
    expect(conditionsOf({ evidence: '  ' })).toBeNull();
  });

  it('writes a message to copy, in English or Spanish, signed by Andy, and nothing else', () => {
    const en = travelMessage({ name: 'Casa Alba — eco-lodge' });
    expect(en).toContain('Casa Alba');
    expect(en).not.toContain('eco-lodge —');
    expect(en.trim().endsWith('Andy')).toBe(true);
    expect(travelMessage({ name: 'Casa Alba' }, 'es')).toMatch(/^Hola,/);
  });
});

describe('G/I/N/D markets, the « seen » hint and the send rule (LEADS, 29 Oct)', () => {
  it('reads G, I, N and D codes, ordered after S/B/F and before P', () => {
    for (const c of ['G1', 'I2', 'N3', 'D4']) expect(codeOf(lead(c))?.code).toBe(c);
    expect(codeOf(lead('X1'))).toBeNull();
    const order = codedLeads([lead('P1'), lead('D1'), lead('N1'), lead('I1'), lead('G1'), lead('F1'), lead('S1')]).map((l) => l.extra.code);
    expect(order).toEqual(['S1', 'F1', 'G1', 'I1', 'N1', 'D1', 'P1']);
  });

  it('keeps G/I/N/D in « All » (they are not personal) with their own tabs', () => {
    const rows = [lead('S1'), lead('G1'), lead('D1'), lead('P1')];
    expect(cullView(rows, { market: 'all' }).map((l) => l.extra.code)).toEqual(['S1', 'G1', 'D1']);
    expect(cullCounts(rows).byMarket).toMatchObject({ G: 1, D: 1, I: 0, N: 0 });
  });

  it('shows the « seen » note as a hint only when LEADS wrote one', () => {
    expect(seenOf({ evidence: 'seen: menu breaks on a phone' })).toBe('seen: menu breaks on a phone');
    expect(seenOf({ evidence: 'Opened profile' })).toBeNull();
    expect(seenOf({})).toBeNull();
  });

  it('badges rows that may not be emailed: pending Andy, research only; nothing for sendable rows', () => {
    expect(sendBadge({ extra: { sendable: 'pending-andy', sendRule: 'one-to-one only' } })).toEqual({ kind: 'pending', label: 'pending Andy', why: 'one-to-one only' });
    expect(sendBadge({ extra: { sendable: 'no' } })).toMatchObject({ kind: 'research', label: 'research only' });
    expect(sendBadge({ extra: { sendable: 'yes' } })).toBeNull();
    expect(sendBadge({ extra: {} })).toBeNull();
  });
});

describe('field of work (Andy via NIRMATA, 30 Oct)', () => {
  const at = (code, category, stage = 'new') => ({ ...lead(code, stage), category });

  it('maps LEADS categories, and anything new falls into Other', () => {
    expect(fieldOf({ category: 'Architecture' })).toBe('architects');
    expect(fieldOf({ category: 'Aesthetic clinic' })).toBe('doctors');
    expect(fieldOf({ category: 'Construction & industry' })).toBe('construction');
    expect(fieldOf({ category: 'Professional services' })).toBe('other');
    expect(fieldOf({ category: 'Something LEADS adds next week' })).toBe('other');
    expect(fieldOf({})).toBe('other');
    expect(FIELDS.at(-1).v).toBe('other');
  });

  it('filters within the list, counts follow, and the Travel list ignores it', () => {
    const leads = [at('B1', 'Architects'), at('B2', 'Dental'), at('B3', 'Architecture', 'looked'), at('F1', 'Architects'), at('P1', 'Hospitality')];
    expect(fieldCounts(leads, 'B')).toMatchObject({ all: 3, architects: 2, doctors: 1, hospitality: 0 });
    expect(cullView(leads, { market: 'B', mark: 'all', field: 'architects' }).map((l) => l.extra.code)).toEqual(['B1', 'B3']);
    expect(cullView(leads, { market: 'all', mark: 'all', field: 'architects' }).map((l) => l.extra.code)).toEqual(['B1', 'B3', 'F1']);
    expect(cullCounts(leads, 'B', 'architects')).toMatchObject({ total: 2, noted: 1 });
    expect(cullView(leads, { market: 'P', mark: 'all', field: 'architects' })).toHaveLength(1);
  });
});

describe('web wave (13 Nov): tier first, and a field of its own', () => {
  const ww = (code, tier, category = 'Driving schools') => ({ ...lead(code, 'new', false, { tier }), dataset: 'web-wave-r4-fr-be', category });

  it('puts T1 before T2 before T3, then the code; rows with no tier come last', () => {
    const rows = [ww('B1', 'T3'), ww('B2', 'T1'), lead('B3'), ww('F1', 'T2'), ww('B4', 'T1')];
    expect(codedLeads(rows).map((l) => l.extra.code)).toEqual(['B2', 'B4', 'F1', 'B1', 'B3']);
    expect(tierOf({ scoreLabel: 'T2' })).toBe(2);
    expect(tierOf({ scoreLabel: '82' })).toBe(9);
  });

  it('maps the web-wave trades to « Local businesses », hand-written ones included', () => {
    for (const c of ['Driving schools', 'Guest houses', 'Kitchens & bathrooms', 'Osteopaths & physios', 'Events & catering', 'Wellness & spa', 'Restaurants & event venues']) {
      expect(fieldOf({ category: c })).toBe('local');
    }
    expect(fieldOf({ category: 'gîte (Gîtes de France 3 épis)', dataset: 'web-wave-age2-fr-be' })).toBe('local');
    expect(fieldOf({ category: 'gîte', dataset: 'architects-be-lu' })).toBe('other');
    expect(FIELDS.at(-1).v).toBe('other');
  });
});
