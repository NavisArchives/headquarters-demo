// Quick personalization (« culling mode »), the pure part (Andy, 27 Oct).
//
// Andy opens each coded lead's site, looks, and dictates what is wrong with it
// in the LEADS chat, naming the lead by its code (S3, B12, F7). LEADS writes
// the codes into the row's `extra.code` (letter = market: S Suisse romande,
// B Belgium, F France), once, never reused. Here they are read, sorted and
// filtered; the marks are the lead's own state, so a re-import never touches
// them:
//   ✓ noted    = stage « looked » (only from « new »: a lead already written
//                to never moves backwards)
//   ✕ skip     = stage « passed »
//   ★ priority = the star
//
// P is different (Andy, 28 Oct): his personal Travel stays list, never outreach.
// It is its own tab, never part of « All », and its decisions are his own next
// step, not marks for an email someone else writes. Nothing is ever sent from
// HQ for it; « Email myself » only prepares a text he sends from his Gmail.
//   ✉ email myself = stage « shortlist »
//   ✎ fill their form (or the portal) = stage « looked »
//   ✕ skip = stage « passed »
// Exported for the screen and the test; no DOM here.

// G United Kingdom, I Ireland, N Nordics, D Germany (LEADS, 29 Oct): research and
// one-to-one markets; whether each row may be emailed is extra.sendable, below.
export const CODE_RE = /^([SBFPGIND])(\d+)$/;

export const MARKETS = [
  { v: 'S', label: 'Suisse romande' },
  { v: 'B', label: 'Belgium' },
  { v: 'F', label: 'France' },
  { v: 'G', label: 'United Kingdom' },
  { v: 'I', label: 'Ireland' },
  { v: 'N', label: 'Nordics' },
  { v: 'D', label: 'Germany' },
  { v: 'P', label: 'Travel stays', personal: true },
];

/** Letters that are Andy's own lists: shown on their own tab, never in « All ». */
export const PERSONAL = new Set(MARKETS.filter((m) => m.personal).map((m) => m.v));
export const isPersonal = (letter) => PERSONAL.has(letter);

export const TRAVEL_FILTERS = [
  { v: 'all', label: 'All', short: 'All' },
  { v: 'todo', label: 'To do', short: 'To do' },
  { v: 'email', label: '✉ Email', short: '✉' },
  { v: 'form', label: '✎ Form', short: '✎' },
  { v: 'skip', label: '✕ Skip', short: '✕' },
];

export const MARK_FILTERS = [
  { v: 'all', label: 'All', short: 'All' },
  { v: 'todo', label: 'To do', short: 'To do' },
  { v: 'noted', label: '✓ Noted', short: '✓' },
  { v: 'skip', label: '✕ Skip', short: '✕' },
  { v: 'priority', label: '★ Priority', short: '★' },
];

/** Fields of work, so Andy can personalize one trade at a time (Andy via
 *  NIRMATA, 30 Oct). Mapped from LEADS's `category`; anything not listed
 *  (Professional services, a category added later) is « Other », so a row
 *  never disappears from every field. */
export const FIELDS = [
  { v: 'architects', label: 'Architects', short: 'Arch.', cats: ['architects', 'architecture'] },
  { v: 'doctors', label: 'Doctors & clinics', short: 'Doctors', cats: ['health practice', 'dental', 'medical centre', 'aesthetic', 'aesthetic clinic', 'dermatology', 'eye care'] },
  { v: 'hospitality', label: 'Hospitality', short: 'Hotels', cats: ['hospitality'] },
  { v: 'construction', label: 'Construction', short: 'Build', cats: ['construction & industry'] },
  { v: 'realestate', label: 'Real estate', short: 'Estate', cats: ['real estate'] },
  // The web-wave lists (13 Nov): local trades, each list naming its own categories.
  { v: 'local', label: 'Local businesses', short: 'Local', cats: ['driving schools', 'guest houses', 'kitchens & bathrooms', 'osteopaths & physios', 'events & catering', 'wellness & spa', 'restaurants & event venues', 'opticians', 'garages', 'landscapers', 'beauty', 'restaurants'] },
  { v: 'other', label: 'Other', short: 'Other', cats: [] },
];

/** The field a lead belongs to: one of FIELDS' `v`, « other » when unmapped. */
export function fieldOf(lead) {
  const category = String(lead?.category ?? '').trim().toLowerCase();
  const mapped = FIELDS.find((f) => f.cats.includes(category))?.v;
  if (mapped) return mapped;
  // A web-wave row with a hand-written category (« gîte (Gîtes de France 3 épis) »)
  // is still a local business, not « Other ».
  return String(lead?.dataset ?? '').startsWith('web-wave') ? 'local' : 'other';
}

/** How many rows of one market fall in each field, plus `all`. */
export function fieldCounts(leads, market = 'all') {
  const rows = cullView(leads, { market, mark: 'all' });
  const out = { all: rows.length };
  for (const f of FIELDS) out[f.v] = rows.filter((l) => fieldOf(l) === f.v).length;
  return out;
}

/** `{ letter, n, code }` for a lead with a valid code, else null. */
export function codeOf(lead) {
  const raw = String(lead?.extra?.code ?? '').trim().toUpperCase();
  const m = CODE_RE.exec(raw);
  return m ? { letter: m[1], n: Number(m[2]), code: raw } : null;
}

const LETTER_ORDER = { S: 0, B: 1, F: 2, G: 3, I: 4, N: 5, D: 6, P: 7 };

/** Coded leads only, in market order (S, B, F) then by number: S2 before S10. */
/** The web-wave tier, 1–3 (T1 best), from scoreLabel or extra.tier; 9 when the row has none. */
export function tierOf(lead) {
  for (const value of [lead?.scoreLabel, lead?.extra?.tier]) {
    const m = /^T([1-3])$/i.exec(String(value ?? '').trim());
    if (m) return Number(m[1]);
  }
  return 9;
}

/** Coded leads, best tier first (Andy works T1 before T3), then by code. */
export function codedLeads(leads = []) {
  return leads
    .map((lead) => ({ lead, c: codeOf(lead), t: tierOf(lead) }))
    .filter((x) => x.c)
    .sort((a, b) => a.t - b.t || LETTER_ORDER[a.c.letter] - LETTER_ORDER[b.c.letter] || a.c.n - b.c.n)
    .map((x) => x.lead);
}

/** What Andy has marked on a lead (several may be true; ★ combines with the others). */
export function marksOf(lead) {
  const stage = lead.stage || 'new';
  if (isPersonal(codeOf(lead)?.letter)) {
    return {
      email: stage === 'shortlist',
      form: stage === 'looked',
      skip: stage === 'passed',
      // Once he has actually written (sent, replied…), the decision is history.
      locked: !['new', 'shortlist', 'looked', 'passed'].includes(stage),
    };
  }
  return {
    noted: stage === 'looked',
    skip: stage === 'passed',
    priority: Boolean(lead.starred),
    // A lead already written to (sent, replied, talks, won…) keeps its stage:
    // only ★ can still be toggled on it.
    locked: !['new', 'looked', 'passed'].includes(stage),
  };
}

const DECISION_STAGE = { email: 'shortlist', form: 'looked', skip: 'passed' };

/**
 * The state patch that toggles `mark` on `lead`, or null when the toggle is
 * not allowed (a lead past the culling stages can only be starred).
 */
export function togglePatch(lead, mark) {
  const m = marksOf(lead);
  if (isPersonal(codeOf(lead)?.letter)) {
    if (m.locked || !DECISION_STAGE[mark]) return null;
    // One decision at a time: picking one replaces the other; picking it again clears it.
    return { stage: m[mark] ? 'new' : DECISION_STAGE[mark] };
  }
  if (mark === 'priority') return { starred: !m.priority };
  if (m.locked) return null;
  if (mark === 'noted') return { stage: m.noted ? 'new' : 'looked' };
  if (mark === 'skip') return { stage: m.skip ? 'new' : 'passed' };
  return null;
}

/** Filter by market letter ('all' = every outreach market, never a personal
 *  one; or a letter), by mark filter and by field of work. */
export function cullView(leads, { market = 'all', mark = 'all', field = 'all' } = {}) {
  return codedLeads(leads).filter((lead) => {
    const c = codeOf(lead);
    if (market === 'all' ? isPersonal(c.letter) : c.letter !== market) return false;
    // The field filter is for outreach lists; the personal list ignores it.
    if (field !== 'all' && !isPersonal(c.letter) && fieldOf(lead) !== field) return false;
    const m = marksOf(lead);
    if (mark === 'todo') return !m.noted && !m.email && !m.form && !m.skip && !m.locked;
    if (mark === 'email') return Boolean(m.email);
    if (mark === 'form') return Boolean(m.form);
    if (mark === 'noted') return m.noted;
    if (mark === 'skip') return m.skip;
    if (mark === 'priority') return m.priority;
    return true;
  });
}

/** « 12 / 80 noted » for the current market, and the per-market counts. */
export function cullCounts(leads, market = 'all', field = 'all') {
  const coded = codedLeads(leads);
  const all = coded.filter((l) => !isPersonal(codeOf(l).letter));
  const inMarket = cullView(leads, { market, mark: 'all', field });
  const byMarket = Object.fromEntries(MARKETS.map((x) => [x.v, coded.filter((l) => codeOf(l).letter === x.v).length]));
  return {
    total: inMarket.length,
    noted: inMarket.filter((l) => marksOf(l).noted).length,
    skipped: inMarket.filter((l) => marksOf(l).skip).length,
    priority: inMarket.filter((l) => marksOf(l).priority).length,
    email: inMarket.filter((l) => marksOf(l).email).length,
    form: inMarket.filter((l) => marksOf(l).form).length,
    decided: inMarket.filter((l) => { const m = marksOf(l); return m.email || m.form || m.skip; }).length,
    byMarket,
    all: all.length,
  };
}

/* ------------------------------------------------- Travel stays (P) --- */

/** What the place offers, in one short line, from the list's own research. */
export function offerOf(lead, max = 140) {
  const research = String(lead.research ?? '');
  const m = /Offers:\s*([^·]+)/i.exec(research);
  const text = (m ? m[1] : (lead.evidence || research || '')).replace(/\s+/g, ' ').trim().replace(/[;,.\s]+$/, '');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const PORTALS = [[/workaway\./i, 'Workaway'], [/worldpackers\./i, 'Worldpackers'], [/volunteerworld\./i, 'Volunteer World'], [/helpx\./i, 'HelpX'], [/bookretreats\./i, 'BookRetreats']];

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isWebUrl = (value) => /^https?:\/\//i.test(value);

/** The page the offer was found on, when it is not their own site — a job
 *  board or a volunteering portal (Retreat One's yoga role is on
 *  retreats.example, not retreat-one.example). Null when the offer is on their site. */
export function listingOf(lead) {
  const site = hostOf(lead?.website);
  // LEADS's own Listing first (when filled in), then the evidence link.
  for (const candidate of [lead?.extra?.Listing, lead?.evidenceUrl, lead?.contact]) {
    const url = String(candidate ?? '').trim();
    if (isWebUrl(url) && hostOf(url) && hostOf(url) !== site) return url;
  }
  return null;
}

/** How to apply: `{ kind: 'email' | 'portal' | 'site', label, address?, url? }`.
 *  A listing elsewhere wins over their own site, so the label and the button
 *  lead to the page where the offer actually is (NIRMATA, 29 Oct). */
export function applyHow(lead) {
  const email = String(lead.email || '').trim();
  if (email) return { kind: 'email', label: `Email: ${email}`, address: email };
  const listing = listingOf(lead);
  const url = listing || String(lead.contact || lead.website || '').trim();
  const portal = PORTALS.find(([re]) => re.test(url));
  if (portal) return { kind: 'portal', label: `Apply on ${portal[1]}`, url };
  if (listing) return { kind: 'portal', label: `Apply on ${hostOf(listing)}`, url: listing };
  if (lead.contactType === 'portal' && url) return { kind: 'portal', label: 'Apply on their site', url };
  return { kind: 'site', label: url ? 'Contact form on their site' : 'No contact yet', url: url || null };
}

/** What the place asks of a volunteer (the list's evidence), in full, for the
 *  sheet: Andy reads the conditions before he decides. Null when there is none. */
export function conditionsOf(lead) {
  const text = String(lead?.evidence ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

/** The ready-to-copy message for one place, in English or Spanish. Andy sends
 *  it himself from his own Gmail or the portal; HQ never sends it. */
export function travelMessage(lead, lang = 'en') {
  const place = String(lead.name || '').split(' — ')[0].trim() || 'your place';
  if (lang === 'es') {
    return [
      'Hola,',
      '',
      `Soy Andy, profesor de yoga (200 h Vinyasa y 300 h Shivayog) y fotógrafo y cineasta, de Bélgica. Estaré de viaje en Perú a partir de noviembre y vi vuestra propuesta (${place}). Me encantaría colaborar con vosotros como voluntario.`,
      '',
      'Puedo aportar: clases de yoga y meditación, fotos y vídeos para vuestras redes y vuestra web (con mi propio equipo) y ayuda en el día a día.',
      '',
      'Adjunto mi CV y mis certificados. ¿Qué fechas os vendrían bien y cuánto tiempo suelen quedarse los voluntarios?',
      '',
      'Muchas gracias,',
      'Andy',
    ].join('\n');
  }
  return [
    'Hello,',
    '',
    `I'm Andy, a yoga teacher (200h Vinyasa and 300h Shivayog) and a photographer and filmmaker from Belgium. I'm travelling in Travel from November, came across ${place}, and would love to join you as a volunteer.`,
    '',
    'What I can bring: yoga and meditation classes, photos and video for your social media and website (with my own gear), and a hand with whatever the place needs.',
    '',
    "I've attached my CV and certificates. Which dates would suit you, and how long do volunteers usually stay?",
    '',
    'Thank you,',
    'Andy',
  ].join('\n');
}


/* ------------------------------------- hints and send rules (S/B/F/G/I/N/D) --- */

/** LEADS's « seen: … » note (what was observed on the site), as a culling hint
 *  for Andy. Never email text. Null when the row has none. */
export function seenOf(lead, max = 140) {
  const ev = String(lead?.evidence ?? '').trim();
  if (!/^seen:/i.test(ev)) return null;
  const text = ev.replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Whether this row may be emailed at all, from LEADS's extra.sendable:
 *   'pending-andy' → « pending Andy » (UK/IE/SE/FI/NO: one-to-one only, once
 *                    Andy widens the BE/LU/FR cold-email rule in chat)
 *   'no'           → « research only » (DE/DK, or a UK sole trader)
 * `why` is LEADS's own sendRule. Null for sendable rows (and rows without it).
 */
export function sendBadge(lead) {
  const v = String(lead?.extra?.sendable ?? '').trim().toLowerCase();
  const why = String(lead?.extra?.sendRule ?? '').trim();
  if (v === 'pending-andy') return { kind: 'pending', label: 'pending Andy', why };
  if (v === 'no') return { kind: 'research', label: 'research only', why };
  return null;
}
