// Pure helpers for the leads screen — no DOM, no fetch, no globals.
//
// Everything the old dashboard did in its head (assets/app.js: the stage
// vocabulary, the tile filters, the dimension counts, the sort comparators,
// the follow-up rule, the CSV columns) lives here as straight data
// transforms, so test/frontend-leads.test.js can exercise it under plain
// Node with no DOM. screens/leads.js and screens/leads-popup.js hold the
// rendering and the fetching; this file holds the thinking.

import { addDays, dayOf, daysBetween, isBareDay, parseDay } from './dates.js';

/* ---------------------------------------------------------------- *
 * The stage vocabulary, verbatim from the old app's STATUSES.
 * `won` is labelled "Accepted", as it was there and in db.js.
 * ---------------------------------------------------------------- */
export const STAGES = Object.freeze([
  { v: 'new', label: 'New', glyph: '○', key: '1', hint: 'untouched' },
  { v: 'looked', label: 'Looked at', glyph: '◔', key: '2', hint: 'reviewed, undecided' },
  { v: 'shortlist', label: 'Shortlisted', glyph: '◑', key: '3', hint: 'worth pitching' },
  { v: 'sent', label: 'Sent', glyph: '→', key: '4', hint: 'awaiting reply' },
  { v: 'replied', label: 'Replied', glyph: '↩', key: '5', hint: 'they answered' },
  { v: 'talks', label: 'In talks', glyph: '◉', key: '6', hint: 'negotiating / meeting' },
  { v: 'won', label: 'Accepted', glyph: '✓', key: '7', hint: 'signed, booked or on the roster' },
  { v: 'passed', label: 'Passed', glyph: '×', key: '8', hint: 'not a fit, or they declined' },
].map((stage, index) => Object.freeze({ ...stage, idx: index })));

export const STAGE_BY = Object.freeze(Object.fromEntries(STAGES.map((s) => [s.v, s])));

/** stage -> the lead_state column D1 stamps on first arrival (db.js STAGE_STAMP).
 *  `shortlist` and `talks` have no column of their own — their date is read
 *  back from lead_events instead, see `stageStamp`. */
export const STAGE_STAMP_FIELD = Object.freeze({
  looked: 'lookedAt', sent: 'sentAt', replied: 'repliedAt', won: 'wonAt', passed: 'passedAt',
});

export const FOLLOW_UP_DAYS = 7;

/* The next touch after a send is the server's (FOLLOW_UP_CADENCE in
   src/worker/db.js: 7 days, then 14, then the sequence ends). The +4 days this
   screen used to write was a second rule that disagreed with it (audit F2/O4). */

/** `YYYY-MM-DD`, n days from the given day. Dates are handled as plain days
 *  everywhere in the leads screen, never as instants. */
export function dayPlus(days, from = new Date()) {
  return addDays(dayOf(from), days);
}

/** The dropdown dimensions of the toolbar, broad to narrow. Country came in
 *  with the surgeon lists, which span four of them; Area stays because the
 *  single-country lists group by province, canton or market instead. Options
 *  are counted against the other selections, so choosing a country narrows the
 *  Area list to that country's own regions. */
export const DIMENSIONS = Object.freeze([
  { field: 'category', label: 'Category' },
  { field: 'country', label: 'Country' },
  { field: 'area', label: 'Area' },
  { field: 'languages', label: 'Language', multi: true },
  { field: 'tier', label: 'Tier' },
  { field: 'contactType', label: 'Contact' },
]);

export const CONTACT_LABEL = Object.freeze({
  email: 'Email', form: 'Form', linkedin: 'LinkedIn', portal: 'Portal', phone: 'Phone', other: 'Other',
});

/** verified -> [tick, title, colour]. '' means "checked once", no tick. */
export const VERIFIED = Object.freeze({
  ok: ['', 'Checked once', 'var(--muted)'],
  'live-checked': ['✓', 'Live-checked', 'var(--green)'],
  dead: ['⚠', 'Site offline', 'var(--red)'],
  mismatch: ['?', 'Mismatch', 'var(--amber)'],
});

export const SORTS = Object.freeze([
  { v: 'fit', label: 'Best fit first' },
  { v: 'touched', label: 'Recently touched' },
  { v: 'name', label: 'Name' },
  { v: 'stage', label: 'Pipeline stage' },
  { v: 'country', label: 'Country' },
  { v: 'area', label: 'Area' },
  { v: 'category', label: 'Category' },
]);

export const TILES = Object.freeze([
  { v: 'star', label: 'Starred', glyph: '★', hint: 'your priorities' },
  { v: 'opened', label: 'Opened your email', glyph: '◉', hint: 'a mail client loaded the image' },
  { v: 'needsyou', label: 'Replies to act on', glyph: '↩', hint: 'they answered, or asked you something' },
  { v: 'due', label: 'Follow-up due', glyph: '◷', hint: 'their follow-up date has come' },
  { v: 'email', label: 'Has email', glyph: '✉', hint: 'a real inbox to write to' },
  { v: 'live', label: 'Live-checked', glyph: '✓', hint: 're-opened and confirmed' },
]);

/* ---------------------------------------------------------------- *
 * Small format helpers, ported from the old app's esc/rel/fmtDate.
 * ---------------------------------------------------------------- */

function millis(now) {
  return now instanceof Date ? now.getTime() : now;
}

/** A bare `YYYY-MM-DD` counts in calendar days against today's local date,
 *  so a follow-up dated today reads « today » at any hour, in any zone. A full
 *  timestamp counts whole days elapsed since that instant. */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const text = String(iso);
  if (isBareDay(text)) return daysBetween(text, dayOf(millis(now)));
  const then = new Date(text).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((millis(now) - then) / 864e5);
}

export function relTime(iso, now = Date.now()) {
  const days = daysSince(iso, now);
  if (days == null) return '';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function formatDay(iso) {
  if (!iso) return '';
  const text = String(iso);
  const date = parseDay(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Local calendar day, `YYYY-MM-DD` — the unit the "opened today" badge counts in. */
export function dayKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || ''); }
export function isUrl(value) { return /^https?:\/\//i.test(value || ''); }
export function shortUrl(value) {
  return String(value || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

export function tierClass(tier) {
  if (tier === 'Hot') return 'tier-hot';
  if (tier === 'Warm') return 'tier-warm';
  return 'tier-cool';
}

/** Where the Contact cell's "Open" link points, as the old app resolved it. */
export function contactHref(lead) {
  if (isEmail(lead.contact)) return `mailto:${lead.contact}`;
  if (isUrl(lead.contact)) return lead.contact;
  if (lead.contactType === 'phone' && lead.phone) return `tel:${lead.phone.replace(/[^\d+]/g, '')}`;
  return lead.website || '';
}

/* ---------------------------------------------------------------- *
 * Normalising an /api/leads row into what the screen renders.
 * ---------------------------------------------------------------- */

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * One row of `GET /api/leads` (facts + the joined lead_state, languages and
 * payload still JSON text) into the flat shape the screen reads. `payload`
 * carries the fields that never became columns — pitch, evidence,
 * evidenceUrl, research, scoreLabel, extra, openingLine — so they are lifted
 * out here rather than re-parsed at every render.
 */
export function normalizeLead(row) {
  const payload = parseJson(row.payload, {});
  const languages = parseJson(row.languages, []);
  const website = row.website || '';
  const lead = {
    uid: row.uid,
    dataset: row.dataset,
    id: row.id,
    business: row.business,
    name: row.name || '',
    website,
    domain: shortUrl(website),
    category: row.category || '',
    subcategory: row.subcategory || '',
    city: row.city || '',
    area: row.area || '',
    region: row.region || '',
    country: row.country || '',
    languages: Array.isArray(languages) ? languages : [],
    email: row.email || '',
    phone: row.phone || '',
    contact: row.contact || '',
    contactType: row.contact_type || '',
    score: Number(row.score) || 0,
    scoreLabel: payload.scoreLabel || String(row.score ?? ''),
    tier: row.tier || 'Cool',
    verified: row.verified || '',
    pitch: payload.pitch || '',
    evidence: payload.evidence || '',
    evidenceUrl: payload.evidenceUrl || '',
    research: payload.research || '',
    openingLine: payload.openingLine || '',
    contactAlt: payload.contactAlt || '',
    extra: payload.extra && typeof payload.extra === 'object' ? payload.extra : {},
    stage: row.stage || 'new',
    // Andy's last LinkedIn message (NIRMATA, 14 Nov), or null.
    linkedinSentAt: row.linkedin_sent_at || null,
    // Unsubscribed, bounced or complained, on any list (0027).
    suppressed: Boolean(Number(row.suppressed ?? 0)),
    starred: Boolean(Number(row.starred ?? 0)),
    notes: row.notes || '',
    followUp: row.follow_up || '',
    lookedAt: row.looked_at || '',
    sentAt: row.sent_at || '',
    repliedAt: row.replied_at || '',
    wonAt: row.won_at || '',
    passedAt: row.passed_at || '',
    updatedAt: row.updated_at || '',
  };
  lead.haystack = [
    lead.name, lead.subcategory, lead.category, lead.city, lead.area, lead.country,
    lead.region, lead.domain, lead.contact, lead.email, lead.evidence, lead.pitch,
    lead.research, lead.notes, lead.languages.join(' '),
  ].join(' ').toLowerCase();
  return lead;
}

/** The date to show against a stage button: the stamped column where D1 has
 *  one, otherwise the first `stage` event that named it. */
export function stageStamp(lead, stage, events = []) {
  const field = STAGE_STAMP_FIELD[stage];
  if (field && lead[field]) return lead[field];
  const hits = (events || [])
    .filter((e) => e && e.kind === 'stage' && e.detail === stage)
    .map((e) => e.at)
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  return hits[0] || '';
}

/* ---------------------------------------------------------------- *
 * Opens. The pixel's timestamps arrive per lead on the detail call,
 * already past the worker's ten-minute self-open rule (api/leads.js).
 * What is left here is the reading: how many, when, and "today".
 * ---------------------------------------------------------------- */

export function openInfo(timestamps) {
  const hits = (timestamps || []).filter(Boolean);
  if (!hits.length) return null;
  const sorted = hits.slice().sort((a, b) => String(a).localeCompare(String(b)));
  return { count: sorted.length, first: sorted[0], last: sorted[sorted.length - 1] };
}

export function openedToday(timestamps, now = Date.now()) {
  const today = dayKey(millis(now));
  return (timestamps || []).some((ts) => ts && dayKey(new Date(ts)) === today);
}

/* ---------------------------------------------------------------- *
 * Filters — the old app's matchesTile / matchesChips / matchesQuery.
 * ---------------------------------------------------------------- */

/** A follow-up date that has arrived. One rule, the server's (audit C13, O6):
 *  the date is set by the 7/14 cadence after each email and cleared when the
 *  sequence ends or they reply, so Home's « Follow up N » and this filter
 *  always count the same leads. Won and passed are finished, never due. */
export function dueReason(lead, now = Date.now()) {
  if (lead.stage === 'won' || lead.stage === 'passed') return '';
  if (lead.followUp) {
    const days = daysSince(lead.followUp, now);
    if (days != null && days >= 0) {
      return `follow-up ${days === 0 ? 'today' : `was ${relTime(lead.followUp, now)}`}`;
    }
  }
  return '';
}

/** The classified reply for a lead, by address first and then by company
 *  domain — the old app's `replyFor`. `replies` is whatever the local Gmail
 *  service returned; online it is always empty. */
export function replyFor(lead, replies) {
  if (!replies) return null;
  const address = (lead.email || '').toLowerCase();
  if (address && replies[address]) return replies[address];
  const domain = address.split('@')[1] || String(lead.domain || '').toLowerCase();
  if (!domain) return null;
  let hit = null;
  for (const key of Object.keys(replies)) {
    if (key.split('@')[1] === domain) hit = replies[key];
  }
  return hit;
}

/**
 * "Replies to act on". The old app could only mean a reply the local Gmail
 * reader had classified as warm or signup. In HQ the same fact also lives in
 * D1 — a lead sitting at `replied` answered you and has not been moved on —
 * so both count, and the tile still works with no Mac attached.
 */
export function needsYou(lead, replies) {
  if (lead.stage === 'replied') return true;
  const reply = replyFor(lead, replies);
  return Boolean(reply && (reply.bucket === 'warm' || reply.bucket === 'signup'));
}

export function matchesTile(lead, tile, ctx = {}) {
  if (tile == null) return true;
  if (STAGE_BY[tile]) return lead.stage === tile;
  if (tile === 'star') return lead.starred;
  if (tile === 'due') return Boolean(dueReason(lead, ctx.now));
  if (tile === 'email') return Boolean(lead.email);
  if (tile === 'opened') return Boolean(openInfo((ctx.opens || {})[lead.uid]));
  if (tile === 'needsyou') return needsYou(lead, ctx.replies);
  if (tile === 'live') return lead.verified === 'live-checked';
  return true;
}

/** The values a lead contributes to one dimension's dropdown. */
export function dimValues(lead, dimension) {
  if (dimension.multi) return (lead[dimension.field] || []).filter(Boolean).map(String);
  if (dimension.field === 'contactType') {
    const value = CONTACT_LABEL[lead.contactType] || lead.contactType;
    return value ? [String(value)] : [];
  }
  const value = lead[dimension.field];
  return value ? [String(value)] : [];
}

/** `except` skips one dimension, so its own dropdown counts the options it
 *  would still offer rather than only the ones already selected. */
export function matchesDims(lead, selected = {}, except = null) {
  return DIMENSIONS.every((dimension) => {
    if (dimension.field === except) return true;
    const chosen = selected[dimension.field] || [];
    if (!chosen.length) return true;
    return dimValues(lead, dimension).some((value) => chosen.includes(value));
  });
}

/** Every space-separated term must appear somewhere — the old `_hay` rule.
 *  The list no longer carries pitch and research (13 Nov), so a lead the server
 *  found for this query (it searches the whole record) counts as a match too. */
export function matchesQuery(lead, query, serverHits = null) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  if (serverHits && serverHits.q === String(query).trim() && serverHits.uids.has(lead.uid)) return true;
  return terms.every((term) => lead.haystack.includes(term));
}

export function inBusiness(lead, business) {
  return !business || business === 'all' || lead.business === business;
}

const COMPARATORS = {
  fit: (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  touched: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.score - a.score,
  stage: (a, b) => STAGE_BY[b.stage].idx - STAGE_BY[a.stage].idx || b.score - a.score,
  name: (a, b) => a.name.localeCompare(b.name),
  country: (a, b) => (a.country || '').localeCompare(b.country || '')
    || (a.area || '').localeCompare(b.area || '') || b.score - a.score,
  area: (a, b) => (a.area || '').localeCompare(b.area || '') || b.score - a.score,
  category: (a, b) => (a.category || '').localeCompare(b.category || '') || b.score - a.score,
};

/** Best fit first floats your starred leads to the top, as it did before. */
export function sortLeads(leads, sort = 'fit') {
  const compare = COMPARATORS[sort] || COMPARATORS.fit;
  return leads.slice().sort((a, b) => {
    if (sort === 'fit' || !COMPARATORS[sort]) {
      const starDelta = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (starDelta) return starDelta;
    }
    return compare(a, b);
  });
}

/** The visible list: business tab, then tile, then dropdowns, then search. */
export function visibleLeads(leads, state = {}, ctx = {}) {
  const matched = (leads || []).filter((lead) => inBusiness(lead, state.business)
    && matchesTile(lead, state.tile ?? null, ctx)
    && matchesDims(lead, state.dims, null)
    && matchesQuery(lead, state.q, state.serverHits));
  // « Follow-up due » reads most overdue first, not by fit (audit C13, O6).
  if (state.tile === 'due') {
    return [...matched].sort((a, b) => String(a.followUp || '9999').localeCompare(String(b.followUp || '9999')) || String(a.uid).localeCompare(String(b.uid)));
  }
  return sortLeads(matched, state.sort);
}

export function hasFilters(state = {}) {
  if (state.tile != null) return true;
  if (String(state.q || '').trim()) return true;
  return DIMENSIONS.some((d) => ((state.dims || {})[d.field] || []).length > 0);
}

/* ---------------------------------------------------------------- *
 * Roll-ups for the sidebar and the tabs.
 * ---------------------------------------------------------------- */

export function businessTabs(leads) {
  const order = [];
  const counts = new Map();
  for (const lead of leads || []) {
    if (!counts.has(lead.business)) { order.push(lead.business); counts.set(lead.business, 0); }
    counts.set(lead.business, counts.get(lead.business) + 1);
  }
  return [{ v: 'all', label: 'All leads', n: (leads || []).length }]
    .concat(order.map((business) => ({ v: business, label: business, n: counts.get(business) })));
}

export function stageCounts(leads) {
  const counts = Object.fromEntries(STAGES.map((s) => [s.v, 0]));
  for (const lead of leads || []) {
    if (counts[lead.stage] === undefined) counts[lead.stage] = 0;
    counts[lead.stage] += 1;
  }
  return counts;
}

/** Shortlisted, sent, replied and in talks — the leads actually moving. */
export function inPlay(counts) {
  return (counts.shortlist || 0) + (counts.sent || 0) + (counts.replied || 0) + (counts.talks || 0);
}

/** What share of everything you sent has been accepted. */
export function wonShare(counts) {
  const outreach = ['sent', 'replied', 'talks', 'won', 'passed']
    .reduce((total, key) => total + (counts[key] || 0), 0);
  if (!outreach) return 'nothing sent yet';
  return `${Math.round((100 * (counts.won || 0)) / outreach)}% of outreach`;
}

export function attentionCounts(leads, ctx = {}) {
  const counts = { star: 0, opened: 0, needsyou: 0, due: 0, email: 0, live: 0 };
  for (const lead of leads || []) {
    if (lead.starred) counts.star += 1;
    if (openInfo((ctx.opens || {})[lead.uid])) counts.opened += 1;
    if (needsYou(lead, ctx.replies)) counts.needsyou += 1;
    if (dueReason(lead, ctx.now)) counts.due += 1;
    if (lead.email) counts.email += 1;
    if (lead.verified === 'live-checked') counts.live += 1;
  }
  return counts;
}

const TIER_ORDER = ['Hot', 'Warm', 'Cool'];

/**
 * One dropdown's options with their counts, over the leads that pass every
 * *other* filter — so the numbers say what each option would give you. A
 * selected option is always listed, even when its count has fallen to zero.
 */
export function dimOptions(leads, dimension, state = {}, ctx = {}) {
  const chosen = (state.dims || {})[dimension.field] || [];
  const counts = new Map();
  for (const lead of leads || []) {
    if (!inBusiness(lead, state.business)) continue;
    if (!matchesTile(lead, state.tile ?? null, ctx)) continue;
    if (!matchesDims(lead, state.dims, dimension.field)) continue;
    if (!matchesQuery(lead, state.q, state.serverHits)) continue;
    for (const value of dimValues(lead, dimension)) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  for (const value of chosen) if (!counts.has(value)) counts.set(value, 0);

  const options = [...counts.entries()].map(([value, count]) => ({ value, count }));
  options.sort((a, b) => {
    if (dimension.field === 'tier') return TIER_ORDER.indexOf(a.value) - TIER_ORDER.indexOf(b.value);
    return b.count - a.count || a.value.localeCompare(b.value);
  });
  return options;
}

/* ---------------------------------------------------------------- *
 * Outreach helpers the popup needs but that are pure text work.
 * ---------------------------------------------------------------- */

const GREETINGS = {
  EN: { named: 'Hi ', bare: 'Hi there' },
  FR: { named: 'Bonjour ', bare: 'Bonjour' },
  NL: { named: 'Hallo ', bare: 'Hallo' },
};
const GREETING_LINE = /^(Hi there|Hi|Hallo|Hello|Bonjour|Beste)([^\n,!]*)([,!])/;

/**
 * Rewrite the draft's opening to greet the name typed in the TO field. The
 * old app re-ran the template through `fill()` for this; here the templates
 * live on the worker and the name is a client-side edit, so the greeting
 * line is rewritten in place and the rest of the body left exactly as typed.
 * A body that does not open with a greeting is returned untouched.
 */
/** Mirrors `surnameOf` in src/shared/outreach.js: everything after the first name. */
export function surnameOf(name) {
  const words = String(name || '').trim().replace(/^(?:dr\.?|docteur|dokter|prof\.?)\s+/i, '').split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.slice(1).join(' ') : (words[0] || '');
}

export function applyGreetingName(body, name, lang = 'EN') {
  const greeting = GREETINGS[lang] || GREETINGS.EN;
  const text = String(body ?? '');
  const clean = String(name ?? '').trim();
  if (!GREETING_LINE.test(text)) return text;
  return text.replace(GREETING_LINE, (match, word, rest, punctuation) => {
    // "Bonjour Docteur Haddad," / "Beste dokter Haddad,": keep the
    // title and the greeting word, swap in the new name's surname.
    const title = rest.match(/^\s+(Docteur|dokter)\b/i);
    if (title) return `${word} ${title[1]}${clean ? ` ${surnameOf(clean)}` : ''}${punctuation}`;
    return (clean ? greeting.named + clean : greeting.bare) + punctuation;
  });
}

/**
 * The Gmail compose window the old app opened, unchanged: no Gmail
 * connection, no API, just a URL. The body rides along so the window is
 * never empty even when the clipboard refuses; the designed HTML, when
 * there is one, is what the caller puts on the clipboard to paste over it.
 */
/**
 * A Gmail compose window with the message already in it.
 *
 * `fs=1&tf=cm` is the full-screen compose form, and it is what Gmail itself
 * redirects `view=cm` to; using it directly saves the redirect. `/u/0/` picks
 * the first signed-in account rather than whichever Gmail last used, which
 * matters on a machine with four Google accounts signed in.
 *
 * What this CANNOT do is choose the send-as alias. Gmail ignores a `from`
 * parameter, so the compose window always opens as the account's default
 * address and the sender has to be switched by hand. Everything that calls
 * this has to say so.
 */
/** The Gmail account every compose window opens in. Andy sends from one
 *  Gmail with brand aliases (hello@realisstudio.com, contact@andyssarchives.com)
 *  and switches the sender in the compose window. Naming the account with
 *  `authuser` opens it however many Google accounts are signed in; `/u/0/`
 *  opened whichever happened to be first. */
export const GMAIL_ACCOUNT = 'owner@example.com';

export function gmailComposeUrl(email, subject, body, account = GMAIL_ACCOUNT) {
  // `view=cm` is what actually opens the compose form. Without it Gmail
  // ignores the rest and lands on the inbox.
  const params = new URLSearchParams({ view: 'cm', fs: '1', tf: '1' });
  if (account) params.set('authuser', account);
  if (email) params.set('to', email);
  if (subject) params.set('su', subject);
  if (body) params.set('body', body);
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/** Google for this lead by name, with the town and the trade to disambiguate:
 *  the registers give initials and shared surnames, so a bare name search
 *  lands on the wrong person often enough to be worth the extra words. */
export function searchUrl(lead) {
  const trade = String(lead?.business || '').toLowerCase().includes('surgeon')
    ? 'plastic surgeon'
    : '';
  const words = [lead?.name, lead?.city, trade].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(words)}`;
}

/** Past roughly this length a browser or Gmail will truncate the URL, and a
 *  half-delivered message is worse than one that asks to be pasted. */
export const COMPOSE_URL_LIMIT = 7000;

/* ---------------------------------------------------------------- *
 * Two rules the composer needs on screen before the worker answers:
 * which languages this lead can be written in, and which template
 * segment it falls into. Both mirror src/shared/outreach.js exactly
 * (`langsFor`, `segmentFor`, `SEGMENT_LABEL`) and exist here only
 * because that module runs on the worker and is never served to the
 * browser. The pills have to be drawn before `compose` is called, and
 * the first pill must be the language `compose` would pick by itself.
 * test/frontend-leads.test.js pins these against the worker's copy.
 * ---------------------------------------------------------------- */

const NL_COUNTRIES = ['Netherlands', 'Belgium'];
const FR_COUNTRIES = ['France', 'Belgium', 'Switzerland', 'Luxembourg'];

export function langsFor(lead) {
  const have = (lead.languages || []).slice();
  const out = [];
  if (have.includes('NL') && NL_COUNTRIES.includes(lead.country)) out.push('NL');
  if (have.includes('FR') && FR_COUNTRIES.includes(lead.country)) out.push('FR');
  for (const lang of ['EN', 'FR', 'NL']) {
    if (have.includes(lang) && !out.includes(lang)) out.push(lang);
  }
  return out.length ? out : ['EN'];
}

/** UGC lists carry business "UGC"; every other list is a website prospect
 *  (Web design, Plastic surgeons, Architects, …) and belongs to Realis. Mirrors
 *  src/shared/outreach.js, which the worker composes with. */
export function isWebLead(lead) {
  const b = String(lead?.business || '').trim().toLowerCase();
  return b !== '' && b !== 'ugc';
}

export function segmentFor(lead) {
  if (isWebLead(lead)) return 'webdesign';
  const category = (lead.category || '').toLowerCase();
  if (category.includes('agency') || category.includes('platform')) return 'agency';
  if (category.includes('community') || category.includes('source')) return 'source';
  if (category.includes('beauty')) return 'beauty';
  if (category.includes('food')) return 'food';
  if (category.includes('tech')) return 'tech';
  return 'brand';
}

export const SEGMENT_LABEL = Object.freeze({
  beauty: 'Beauty brand', food: 'Food brand', tech: 'Tech brand', brand: 'Brand',
  agency: 'Agency / platform roster', source: 'Not an outreach target', webdesign: 'Web design prospect',
});

/** The three composer modes, in the old app's order. `followup` is what the
 *  worker calls the old app's "follow" mode. */
export const MODES = Object.freeze([
  { v: 'email', label: 'Email' },
  { v: 'dm', label: 'DM' },
  { v: 'followup', label: 'Follow-up' },
]);

/** The profile fields the outreach templates read, in editor order. */
export const PROFILE_FIELDS = Object.freeze([
  { key: 'name', label: 'Name' },
  { key: 'studio', label: 'Studio' },
  { key: 'email', label: 'Your Gmail address (the account Open in Gmail uses)' },
  { key: 'phone', label: 'Phone' },
  { key: 'portfolio', label: 'Portfolio link' },
  { key: 'social', label: 'TikTok handle' },
  { key: 'hero', label: 'Photo link for the email (leave blank for the default)' },
]);

/**
 * The sign-off every draft ends with. This mirrors `signature()` in
 * src/shared/outreach.js line for line; it is repeated here only because
 * that module lives on the worker and is never served to the browser, and
 * the profile editor showed a live preview of it. If the sign-off's shape
 * ever changes there, change it here too — test/frontend-leads.test.js
 * pins this copy.
 */
export function signaturePreview(profile = {}) {
  const lines = [];
  lines.push((profile.name || '') + (profile.studio ? ` — ${profile.studio}` : ''));
  if (profile.portfolio) lines.push(profile.portfolio);
  const contact = [];
  if (profile.email) contact.push(profile.email);
  if (profile.phone) contact.push(profile.phone);
  if (contact.length) lines.push(contact.join(' · '));
  if (profile.social) lines.push(profile.social);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- *
 * Export. The old app's column list, in the old app's order.
 * ---------------------------------------------------------------- */

export const CSV_COLUMNS = Object.freeze([
  'business', 'list', 'name', 'status', 'starred', 'score', 'tier', 'category', 'subcategory',
  'city', 'area', 'country', 'languages', 'email', 'phone', 'contact', 'contactType', 'website',
  'evidenceUrl', 'evidence', 'pitch', 'research', 'verified', 'lookedAt', 'sentAt', 'repliedAt',
  'wonAt', 'passedAt', 'followUp', 'notes',
]);

export function csvRow(lead, listTitle) {
  return [
    lead.business, listTitle || lead.dataset, lead.name,
    (STAGE_BY[lead.stage] || STAGE_BY.new).label, lead.starred ? 'yes' : '',
    lead.score, lead.tier, lead.category, lead.subcategory, lead.city, lead.area, lead.country,
    lead.languages.join(' / '), lead.email, lead.phone, lead.contact, lead.contactType,
    lead.website, lead.evidenceUrl, lead.evidence, lead.pitch, lead.research, lead.verified,
    lead.lookedAt, lead.sentAt, lead.repliedAt, lead.wonAt, lead.passedAt, lead.followUp, lead.notes,
  ];
}

export function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header plus one line per lead, with the BOM Excel needs to read UTF-8. */
export function toCsv(leads, listTitles = {}) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const lead of leads || []) {
    lines.push(csvRow(lead, listTitles[lead.dataset]).map(csvCell).join(','));
  }
  return `﻿${lines.join('\n')}`;
}

export function csvFilename(business, now = Date.now()) {
  const scope = !business || business === 'all' ? 'all' : business.toLowerCase().replace(/\s+/g, '-');
  return `leads-${scope}-${dayKey(millis(now))}.csv`;
}

/**
 * The written email as a quiet letter for pasting into Gmail: the same words,
 * set in clean type, links live, and the sign-off under a thin rule. No
 * images and no layout tables, so it reads like a person wrote it.
 */
export function letterHtml(body, pixelUrl = '') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const live = (s, color = '#1a1a1a') => esc(s)
    .replace(/https?:\/\/[^\s<]+[^\s<.,:;!?)]/g, (u) => `<a href="${u}" style="color:${color};text-decoration:underline;text-underline-offset:2px">${u.replace(/^https?:\/\/(www\.)?/, '')}</a>`)
    .replace(/\+\d[\d ]{7,}\d/g, (t) => `<a href="tel:${t.replace(/ /g, '')}" style="color:${color};text-decoration:none;white-space:nowrap">${t}</a>`)
    .replace(/\n/g, '<br>');
  const blocks = String(body || '').trim().split(/\n{2,}/);
  const postscript = /^P\.?-?S\b/i.test(blocks[blocks.length - 1] || '') && blocks.length > 2 ? blocks.pop() : '';
  // The sign-off is the last block: "Bien à vous,\nAndy\n…", or just
  // "Andy\n…" when the closing words sit in their own paragraph above it.
  let sign = blocks.length > 1 ? blocks.pop().split('\n') : [];
  const closing = /,\s*$/.test(sign[0] || '') ? sign.shift() : blocks.pop() ?? '';
  const p = 'margin:0 0 16px;';
  const paras = blocks.map((b) => `<p style="${p}">${live(b)}</p>`).join('');
  const [name = '', studio = '', ...rest] = sign;
  const hasSite = rest.some((line) => /realisstudio\.com/.test(line));
  const details = [...rest, ...(hasSite ? [] : ['https://www.realisstudio.com'])];
  const signature = `<p style="${p}">${live(closing)}</p>`
    + (sign.length ? `<div style="border-top:1px solid #e2e2e2;padding-top:14px;margin-top:8px">`
      + `<div style="font-size:15px;color:#1a1a1a">${esc(name)}</div>`
      + (studio ? `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#1a1a1a;margin-top:4px">${esc(studio)}</div>` : '')
      + `<div style="font-size:12px;line-height:1.7;color:#8a8a8a;margin-top:4px">${details.map((line) => live(line, '#8a8a8a')).join('<br>')}</div>`
      + `</div>` : '')
    + (postscript ? `<p style="margin:20px 0 0;font-size:12px;color:#8a8a8a">${live(postscript, '#8a8a8a')}</p>` : '');
  // The open pixel: 1x1, no alt text, so it never shows or reads aloud.
  const pixel = /^https:\/\/[^\s"<>]+\.gif$/.test(pixelUrl)
    ? `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`
    : '';
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:560px">${paras}${signature}${pixel}</div>`;
}
