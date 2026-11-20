// What MARKETING may send next, read-only (Andy, 14 Nov: yes to Monday's surgeon
// follow-up batch). MARKETING cannot read D1; this gives it the rows of one list
// with everything it needs to pick a batch, and nothing it does not.
//
//   GET /api/intake/send-list?dataset=<key>[&stage=sent,replied]   (LEADS token only)
//
// Read only, no write path. Never the Travel list list, never a lead whose business
// is Agencies, never the research text (pitch, notes). The cold-email rule (Andy,
// 14 Nov, CLAUDE.md §6): a Netherlands lead only when it is a company (B.V./N.V.,
// legal_form from the KvK; unchecked is left out and counted), and every Swiss lead
// is marked personalised_only (one-by-one emails, never an identical batch).
import { ValidationError } from './db.js';
import { langsFor } from '../shared/outreach.js';
import { isPersonalDataset } from '../public/assets/personal-lists.js';
import { isPeopleDataset, samePersonMap } from '../public/assets/same-person.js';

const STAGES = ['new', 'looked', 'shortlist', 'sent', 'replied', 'talks', 'won', 'passed'];
const MAX_ROWS = 2000;

/** « sent,replied » -> ['sent', 'replied'], or every stage when empty. */
export function parseStages(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const list = [...new Set(String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const bad = list.filter((s) => !STAGES.includes(s));
  if (bad.length) throw new ValidationError(`stage must be among ${STAGES.join(', ')}`, 'stage');
  return list;
}

/** The Gmail message id an outreach_sent log carried (« … · message <id> »). */
export function messageIdFrom(detail) {
  return /(?:^|·\s*)message\s+(\S+)/.exec(String(detail ?? ''))?.[1] ?? null;
}

export async function readSendList(db, { dataset, stage } = {}) {
  const key = typeof dataset === 'string' ? dataset.trim() : '';
  if (!key) throw new ValidationError('which list? ?dataset=<key>', 'dataset');
  if (isPersonalDataset(key)) throw new ValidationError('that list is personal, never outreach', 'dataset');
  const stages = parseStages(stage);

  const known = await db.prepare('SELECT key, business FROM datasets WHERE key = ?').bind(key).first();
  if (!known) throw new ValidationError('no such list', 'dataset');

  const { results } = await db.prepare(
    `SELECT l.uid, lower(trim(l.email)) AS email, l.name, l.languages, l.country, l.business,
            CASE WHEN json_valid(l.payload) THEN l.payload->>'$.extra.hook' END AS hook,
            CASE WHEN json_valid(l.payload) THEN l.payload->>'$.extra.code' END AS code,
            CASE WHEN json_valid(l.payload) THEN l.payload->>'$.legal_form' END AS legal_form,
            COALESCE(s.stage, 'new') AS stage, s.sent_at, s.last_sent_at, s.last_reply_at, s.follow_up,
            (SELECT COUNT(*) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent') AS sends,
            (SELECT e.detail FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_sent_detail,
            (SELECT MAX(e.at) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'linkedin') AS linkedin_sent_at,
            (SELECT e.sent_to FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' AND e.sent_to IS NOT NULL ORDER BY e.at ASC, e.id ASC LIMIT 1) AS first_sent_to,
            (SELECT e.subject FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at ASC, e.id ASC LIMIT 1) AS first_subject,
            (SELECT r.thread_id FROM reply_reviews r WHERE r.uid = l.uid ORDER BY r.received_at DESC, r.id DESC LIMIT 1) AS reply_thread_id,
            EXISTS (SELECT 1 FROM email_suppression es WHERE es.email = lower(trim(l.email))) AS suppressed
     FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid
     WHERE l.dataset = ? AND l.business <> 'Agencies'
     ORDER BY l.score DESC, l.uid`,
  ).bind(key).all();

  // One letter per inbox (NIRMATA, 14 Nov): every lead in HQ that shares an address with
  // this list, and whether it was written to (a logged send, or marked sent). One read, grouped here.
  const { results: holders } = await db.prepare(
    `SELECT lower(trim(o.email)) AS email, o.uid,
            (EXISTS (SELECT 1 FROM lead_events e WHERE e.uid = o.uid AND e.kind = 'sent') OR s.sent_at IS NOT NULL) AS written
     FROM (SELECT DISTINCT lower(trim(l.email)) AS email FROM leads l WHERE l.dataset = ? AND trim(COALESCE(l.email, '')) <> '') mine
     JOIN leads o ON lower(trim(o.email)) = mine.email
     LEFT JOIN lead_state s ON s.uid = o.uid`,
  ).bind(key).all();
  const inbox = new Map();
  for (const h of holders ?? []) {
    if (!inbox.has(h.email)) inbox.set(h.email, []);
    inbox.get(h.email).push({ uid: h.uid, written: Number(h.written) === 1 });
  }

  // The same doctor filed in two lists (Becker, Marin: BE and LU; NIRMATA, 14 Nov). Only for
  // lists of people: every lead of those lists, and whether it was written to. A hint, never a block.
  let samePerson = new Map();
  const writtenUid = new Map();
  if (isPeopleDataset(key)) {
    const { results: people } = await db.prepare(
      `SELECT o.uid, o.dataset, o.name,
              (EXISTS (SELECT 1 FROM lead_events e WHERE e.uid = o.uid AND e.kind = 'sent') OR s.sent_at IS NOT NULL) AS written
       FROM leads o LEFT JOIN lead_state s ON s.uid = o.uid
       WHERE o.dataset >= 'plastic-surgeons-' AND o.dataset < 'plastic-surgeons.'`,
    ).all();
    samePerson = samePersonMap(people ?? []);
    for (const p of people ?? []) writtenUid.set(p.uid, Number(p.written) === 1);
  }

  // The cold-email rule (Andy, 14 Nov, CLAUDE.md §6): the Netherlands only for companies (B.V./N.V.,
  // checked on the KvK: payload.legal_form; missing means not checked, so left out); Switzerland only
  // one-by-one personalised emails, so its leads say so and never belong in an identical batch.
  const country = (c) => String(c ?? '').trim().toLowerCase();
  const isNL = (c) => ['nl', 'netherlands', 'the netherlands', 'nederland'].includes(country(c));
  const isCH = (c) => ['ch', 'switzerland', 'suisse', 'schweiz'].includes(country(c));
  const company = (form) => ['BV', 'NV'].includes(String(form ?? '').toUpperCase().replace(/[^A-Z]/g, ''));
  let nlLeftOut = 0;
  const allowed = (results ?? []).filter((r) => {
    if (isNL(r.country) && !company(r.legal_form)) { nlLeftOut += 1; return false; }
    return true;
  });

  const all = allowed.map((r) => {
    let languages = [];
    try { languages = JSON.parse(r.languages ?? '[]'); } catch { /* none */ }
    const sends = Number(r.sends ?? 0);
    return {
      uid: r.uid,
      email: r.email || null,
      name: r.name,
      lang: langsFor({ languages, country: r.country })[0] ?? null,
      country: r.country,
      stage: r.stage,
      hook: r.hook ?? null,
      code: r.code ?? null,
      sent_at: r.sent_at ?? null,
      last_sent_at: r.last_sent_at ?? null,
      follow_up: r.follow_up ?? null,
      sends,
      has_followup: sends >= 2,
      replied: Boolean(r.last_reply_at) || ['replied', 'talks', 'won'].includes(r.stage),
      suppressed: Number(r.suppressed) === 1,
      sent_message_id: messageIdFrom(r.last_sent_detail),
      reply_thread_id: r.reply_thread_id ?? null,
      // Shared inbox: how many leads share this address, and the other lead it was already
      // written to through, if any. Send to an inbox once, whichever lead it is filed under.
      inbox_leads: r.email ? (inbox.get(r.email)?.length ?? 1) : 0,
      inbox_written_via: r.email ? (inbox.get(r.email) ?? []).find((h) => h.uid !== r.uid && h.written)?.uid ?? null : null,
      // Same person under another lead (by name, people lists only): check before writing twice.
      same_person: (samePerson.get(r.uid) ?? []).map((o) => o.uid),
      same_person_written_via: (samePerson.get(r.uid) ?? []).find((o) => writtenUid.get(o.uid))?.uid ?? null,
      // Where the first letter went (0032), and whether the lead's address has changed since:
      // a follow-up there would land in an inbox that never saw the first one. Skipped unless Andy decides.
      // Andy's own LinkedIn message (NIRMATA, 14 Nov): context for the email, never a send by HQ.
      linkedin_sent_at: r.linkedin_sent_at ?? null,
      first_sent_to: r.first_sent_to ?? null,
      // The subject the first letter really carried (0035); null for sends logged before it.
      // A follow-up or closer repeats it, with no « Re: » (Andy, 16 Nov).
      first_subject: r.first_subject ?? null,
      address_changed_since_send: Boolean(r.first_sent_to && r.email && r.first_sent_to !== r.email),
      legal_form: r.legal_form ?? null,
      personalised_only: isCH(r.country),
    };
  });

  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const row of all) byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
  const picked = stages ? all.filter((r) => stages.includes(r.stage)) : all;
  const count = (fn) => picked.filter(fn).length;

  return {
    dataset: key,
    business: known.business,
    stages: stages ?? STAGES,
    counts: {
      in_list: all.length,
      by_stage: byStage,
      matching: picked.length,
      with_email: count((r) => r.email),
      suppressed: count((r) => r.suppressed),
      sent: count((r) => r.sends > 0),
      has_followup: count((r) => r.has_followup),
      replied: count((r) => r.replied),
      with_hook: count((r) => r.hook),
      shared_inbox: count((r) => r.inbox_leads > 1),
      inbox_already_written: count((r) => r.inbox_written_via),
      personalised_only: count((r) => r.personalised_only),
      address_changed_since_send: count((r) => r.address_changed_since_send),
      linkedin_sent: count((r) => r.linkedin_sent_at),
      same_person: count((r) => r.same_person.length > 0),
      same_person_already_written: count((r) => r.same_person_written_via),
      nl_left_out_not_a_company: nlLeftOut,
    },
    truncated: picked.length > MAX_ROWS,
    leads: picked.slice(0, MAX_ROWS),
  };
}
