import { logMessage } from './message-log.js';
// The intake door: one route where machines file missions into HQ.
//
//   POST /api/intake                   file a mission (see docs/api.md)
//   GET  /api/missions?status=open     what is open, for an agent
//
// Both run before authenticate(): the callers are NIRMATA, an iOS Shortcut and
// the email worker, none of which has the owner's session. Each has its own
// bearer token, a Worker secret of its own, never HQ_PASSWORD. The token says
// who is calling; nothing in the body can claim to be someone else.
//
// Two kinds carry mail facts that a Claude chat session read (Andy's rule of
// 14 Oct: no AI in HQ; the session does the reading, HQ only stores it):
//   reply          one reply: its reading (intent, summary, asks), filed as a
//                  reply review with its proposed missions, and the lead moved
//                  to « replied ». Idempotent on the Gmail message id.
//   outreach_sent  one outreach email that went out: the lead moved to « sent »,
//                  its follow-up dated, the template, batch and subject on record.
//                  Idempotent on (lead, batch).
//
// What a caller can file is narrow on purpose. A mission is created as a
// plain `pending` mission; a proposition's title is written by HQ from
// structured fields, never by the sender; an email's own words only ever
// reach the detail, labelled unverified.
import { constantTimeEqual } from './auth.js';
import {
  ValidationError, nowIso, hqToday, getMission, listMissions, getLeadStage, patchLeadState, recordMailTimes,
} from './db.js';
import { getReviewByMessageId, fileReviewWithProposals, proposalsFor } from './db-replies.js';
import { validateClassification, ClassifierError } from './replies-classify.js';
import { uidForAddress, movesForward } from './api/gmail.js';
import { addDays } from '../public/assets/dates.js';
import { receiveBatch, approveBatch, listBatches, sha256Hex } from './lead-batches.js';
import { readSendList } from './send-list.js';
import { isPersonalUid, PERSONAL_REFUSAL } from '../public/assets/personal-lists.js';
import { isReadLimit, readLimitResponse } from './d1-limit.js';

/** Who may call, and the secret that proves it. */
export const INTAKE_SOURCES = Object.freeze({
  nirmata: 'INTAKE_TOKEN_NIRMATA',
  shortcut: 'INTAKE_TOKEN_SHORTCUT',
  email: 'INTAKE_TOKEN_EMAIL',
  // MARKETING's own token (the session was called LEADS when it was made): it
  // files lead batches and logs the outreach it sends. Only NIRMATA approves batches.
  leads: 'INTAKE_TOKEN_LEADS',
});

/** What each source may file. A Shortcut is Andy dictating a task; the email
 *  worker files propositions, warm replies, and Andy's own mission@ mails. */
const KINDS_FOR = Object.freeze({
  // The Claude sessions (« check the mail ») file through NIRMATA's token.
  nirmata: ['mission', 'proposition', 'warm_lead', 'reply', 'outreach_sent', 'outreach_batch', 'suppression'],
  shortcut: ['mission'],
  email: ['mission', 'proposition', 'warm_lead', 'reply'],
  // MARKETING logs what it sent with its own token and allowance (audit 10, 13 Nov):
  // a 50-email batch logged on NIRMATA's shared 20 a minute hit 429 from the 21st.
  leads: ['outreach_sent', 'outreach_batch', 'suppression'],
});
export const INTAKE_KINDS = Object.freeze(['mission', 'proposition', 'warm_lead', 'reply', 'outreach_sent', 'outreach_batch', 'suppression']);

export const PROPOSITION_CATEGORIES = Object.freeze({
  brand_deal: 'brand deal',
  site_request: 'website request',
  collaboration: 'collaboration',
  client_work: 'client work',
  meeting: 'meeting proposed',
  other: 'proposition',
});
const BRANDS = Object.freeze({ realis: 'Realis Studio', andyssarchives: 'andyssarchives' });

export const LIMITS = Object.freeze({
  body: 16_384,
  title: 200,
  detail: 4_000,
  key: 200,
  name: 120,
  subject: 500,
  excerpt: 2_000,
  batch: 80,
  email: 254,
  perMinute: 20,
  perDay: 500,
  // A batch log: every send of one batch (agency rule: batches under 300) in one request.
  batchSends: 300,
  batchBody: 98_304,
});
/** Requests per minute and per day, by source; each logged send counts as one. */
const RATE_FOR = Object.freeze({
  leads: { perMinute: 400, perDay: 3000 },
});
const rateOf = (source) => RATE_FOR[source] ?? { perMinute: LIMITS.perMinute, perDay: LIMITS.perDay };
// A token shorter than this is a mistake, not a secret.
const TOKEN_MIN = 32;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const unauthorized = () => json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

/** The source whose token this is, or null. Every configured token is
 *  compared, each in constant time, so the answer takes as long either way. */
export async function sourceFor(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  let found = null;
  // A token may be configured as itself or, better, only as its SHA-256
  // (`<NAME>_SHA256`, written by scripts/setup-intake-tokens.mjs): then the
  // file every session can read holds no token at all (NIRMATA, 13 Nov).
  const presentedHash = await sha256Hex(match[1]);
  for (const [source, secretName] of Object.entries(INTAKE_SOURCES)) {
    const secret = env?.[secretName];
    const hash = String(env?.[`${secretName}_SHA256`] ?? '').trim().toLowerCase();
    /* eslint-disable no-await-in-loop -- compare every token, always */
    if (typeof secret === 'string' && secret.length >= TOKEN_MIN && await constantTimeEqual(match[1], secret)) found = source;
    if (/^[0-9a-f]{64}$/.test(hash) && match[1].length >= TOKEN_MIN && await constantTimeEqual(presentedHash, hash)) found = source;
    /* eslint-enable no-await-in-loop */
  }
  return found;
}

/* ------------------------------------------------------------ validation --- */

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  // Control characters other than newlines and tabs never belong in a mission.
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !clean) throw new ValidationError(`${field} is required`, field);
  if (clean.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  return clean || null;
}

function dateOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError(`${field} must be a date, YYYY-MM-DD`, field);
  }
  return value;
}

/** The next working day after today in Andy's zone (hqToday) — what a new mission is due. */
export function nextWorkingDay(now = new Date()) {
  const today = hqToday(now);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const add = day === 5 ? 3 : day === 6 ? 2 : 1;
  return addDays(today, add);
}

/** The request, checked field by field. Throws ValidationError naming the field. */
export function validateIntake(body, source) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('the body must be a JSON object', 'body');
  if (body.source !== undefined && body.source !== source) {
    throw new ValidationError('source does not match the token', 'source');
  }
  const kind = body.kind;
  if (!INTAKE_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of ${INTAKE_KINDS.join(', ')}`, 'kind');
  }
  if (!KINDS_FOR[source].includes(kind)) throw new ValidationError(`${source} cannot file a ${kind}`, 'kind');
  if (kind === 'reply') return validateReply(body);
  if (kind === 'outreach_sent') return validateOutreach(body);
  if (kind === 'outreach_batch') return validateOutreachBatch(body);
  if (kind === 'suppression') return validateSuppression(body);

  const key = text(body.idempotency_key, 'idempotency_key', LIMITS.key, { required: true });
  const out = {
    kind,
    key,
    title: text(body.title, 'title', LIMITS.title, { required: kind === 'mission' }),
    detail: text(body.detail, 'detail', LIMITS.detail) ?? '',
    due: dateOrNull(body.due, 'due'),
    lead_uid: text(body.lead_uid, 'lead_uid', LIMITS.key, { required: kind === 'warm_lead' }),
    contact: null,
    brand: null,
    category: null,
  };

  const contact = body.contact;
  if (contact !== undefined && contact !== null) {
    if (typeof contact !== 'object' || Array.isArray(contact)) throw new ValidationError('contact must be { name, email }', 'contact');
    const email = text(contact.email, 'contact.email', LIMITS.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('contact.email is not an address', 'contact.email');
    out.contact = { name: text(contact.name, 'contact.name', LIMITS.name), email };
  }

  if (kind === 'proposition') {
    if (!out.contact?.name && !out.contact?.email) {
      throw new ValidationError('a proposition needs contact.name or contact.email', 'contact');
    }
    if (!Object.hasOwn(BRANDS, body.brand)) throw new ValidationError('brand must be realis or andyssarchives', 'brand');
    if (!Object.hasOwn(PROPOSITION_CATEGORIES, body.category)) {
      throw new ValidationError(`category must be one of ${Object.keys(PROPOSITION_CATEGORIES).join(', ')}`, 'category');
    }
    out.brand = body.brand;
    out.category = body.category;
  }
  return out;
}

function timestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date-time`, field);
  }
  return new Date(value).toISOString();
}

function address(value, field, { required = false } = {}) {
  const email = text(value, field, LIMITS.email, { required });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError(`${field} is not an address`, field);
  return email ? email.toLowerCase() : null;
}

/** A reply as a session read it. The reading goes through the same validator
 *  as the reply scanner's, so nothing else can reach reply_reviews. The key is
 *  the Gmail message id: the same reply sent twice is filed once. */
function validateReply(body) {
  const messageId = text(body.message_id, 'message_id', LIMITS.key, { required: true });
  let reading;
  try {
    reading = validateClassification(body.reading);
  } catch (error) {
    if (error instanceof ClassifierError) throw new ValidationError(`reading: ${error.message}`, 'reading');
    throw error;
  }
  return {
    kind: 'reply',
    key: `reply:${messageId}`,
    message_id: messageId,
    thread_id: text(body.thread_id, 'thread_id', LIMITS.key),
    from: address(body.from, 'from', { required: true }),
    subject: text(body.subject, 'subject', LIMITS.subject) ?? '',
    received_at: timestamp(body.received_at, 'received_at'),
    excerpt: text(body.excerpt, 'excerpt', LIMITS.excerpt) ?? '',
    lead_uid: text(body.lead_uid, 'lead_uid', LIMITS.key),
    reading,
  };
}

/** One outreach email that went out. The key is (lead, batch): a batch log
 *  sent twice moves each lead once. */
function validateOutreach(body) {
  const uid = text(body.lead_uid, 'lead_uid', LIMITS.key, { required: true });
  const batch = text(body.batch, 'batch', LIMITS.batch, { required: true });
  return {
    kind: 'outreach_sent',
    key: `sent:${uid}:${batch}`,
    lead_uid: uid,
    batch,
    template: text(body.template, 'template', LIMITS.batch),
    message_id: text(body.message_id, 'message_id', LIMITS.key),
    to: address(body.to, 'to'),
    sent_at: timestamp(body.sent_at, 'sent_at'),
    sender: address(body.sender, 'sender'),
    // The subject the email really carried (0035): a follow-up repeats it, never a rebuilt one.
    subject: text(body.subject, 'subject', LIMITS.subject),
    body: text(body.body, 'body', LIMITS.detail),
    thread_id: text(body.thread_id, 'thread_id', LIMITS.key),
  };
}

/** Every send of one batch: { batch, template?, sent: [{ lead_uid, to?, sent_at?, message_id?, subject? }] }.
 *  Each send is filed as its own outreach_sent, under the same (lead, batch) key,
 *  so a batch logged twice, or partly logged one by one, moves each lead once. */
function validateOutreachBatch(body) {
  const batch = text(body.batch, 'batch', LIMITS.batch, { required: true });
  const template = text(body.template, 'template', LIMITS.batch);
  if (!Array.isArray(body.sent) || !body.sent.length) throw new ValidationError('sent must be a list of the emails that went out', 'sent');
  if (body.sent.length > LIMITS.batchSends) throw new ValidationError(`at most ${LIMITS.batchSends} sends in one batch log`, 'sent');
  const seen = new Set();
  const sends = body.sent.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError(`sent[${i}] must be an object`, `sent[${i}]`);
    const one = validateOutreach({ ...item, batch, template: item.template ?? template });
    if (seen.has(one.key)) throw new ValidationError(`sent[${i}]: ${one.lead_uid} is in the list twice`, `sent[${i}]`);
    seen.add(one.key);
    return one;
  });
  return { kind: 'outreach_batch', batch, sends };
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses never to be written to again (bounces, declines, do-not-contact).
 *  Replaces the hand-written SQL files (Andy, 19 Nov). One request = one audit line. */
function validateSuppression(body) {
  const key = text(body.idempotency_key, 'idempotency_key', LIMITS.key, { required: true });
  const reason = text(body.reason, 'reason', LIMITS.name, { required: true });
  if (!Array.isArray(body.emails) || !body.emails.length) throw new ValidationError('emails must be a list of addresses', 'emails');
  if (body.emails.length > LIMITS.batchSends) throw new ValidationError(`at most ${LIMITS.batchSends} addresses in one request`, 'emails');
  const seen = new Set();
  const emails = body.emails.map((value, i) => {
    const email = String(value ?? '').trim().toLowerCase();
    if (email.length > LIMITS.email || !ADDRESS.test(email)) throw new ValidationError(`emails[${i}] is not an email address`, `emails[${i}]`);
    if (seen.has(email)) throw new ValidationError(`emails[${i}] is in the list twice`, `emails[${i}]`);
    seen.add(email);
    return email;
  });
  return { kind: 'suppression', key, reason, emails };
}

async function fileSuppression(db, source, input, now) {
  const at = now.toISOString();
  // Claim the key first: the same request again changes nothing.
  const claim = await db.prepare(
    `INSERT INTO suppression_requests (source, idempotency_key, reason, emails, suppressed, received_at)
     VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(source, idempotency_key) DO NOTHING RETURNING source`,
  ).bind(source, input.key, input.reason, input.emails.length, at).first();
  if (!claim) {
    const earlier = await db.prepare('SELECT suppressed, emails FROM suppression_requests WHERE source = ? AND idempotency_key = ?')
      .bind(source, input.key).first();
    return { status: 200, body: { duplicate: true, kind: 'suppression', suppressed: earlier?.suppressed ?? 0, emails: earlier?.emails ?? 0 } };
  }
  try {
    const results = await db.batch(input.emails.map((email) => db.prepare(
      'INSERT OR IGNORE INTO email_suppression (email, reason, source, at) VALUES (?, ?, ?, ?)',
    ).bind(email, input.reason, `intake:${source}`, at)));
    const suppressed = results.reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0);
    await db.prepare('UPDATE suppression_requests SET suppressed = ? WHERE source = ? AND idempotency_key = ?')
      .bind(suppressed, source, input.key).run();
    return { status: 201, body: { duplicate: false, kind: 'suppression', suppressed, already: input.emails.length - suppressed } };
  } catch (error) {
    await db.prepare('DELETE FROM suppression_requests WHERE source = ? AND idempotency_key = ?').bind(source, input.key).run();
    throw error;
  }
}

/** "New proposition: Jane Roe → Realis Studio: website request". Built from
 *  the structured fields only: who (a name, else the address's domain), which
 *  brand, which category. Nothing a sender wrote is ever the title. */
export function propositionTitle({ contact, brand, category }) {
  const domain = contact?.email ? contact.email.split('@').pop() : '';
  const who = (contact?.name || domain || 'someone').slice(0, 80);
  return `New proposition: ${who} → ${BRANDS[brand]}: ${PROPOSITION_CATEGORIES[category]}`;
}

const SOURCE_LABEL = Object.freeze({ nirmata: 'NIRMATA', shortcut: 'the iOS Shortcut', email: 'an email', leads: 'MARKETING' });

function propositionDetail(input, source) {
  const lines = [`Filed by ${SOURCE_LABEL[source]} — unverified.`];
  if (input.contact?.name) lines.push(`Name: ${input.contact.name}`);
  if (input.contact?.email) lines.push(`Email: ${input.contact.email}`);
  if (input.detail) lines.push('', `What they want (${source === 'email' ? 'from email, unverified' : 'as filed'}): ${input.detail}`);
  return lines.join('\n');
}

/* --------------------------------------------------------------- writing --- */

async function rateLimited(db, source, now, count = 1) {
  const minute = new Date(now.getTime() - 60_000).toISOString();
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const row = await db.prepare(
    `SELECT SUM(received_at >= ?) AS minute, COUNT(*) AS day
     FROM intake_requests WHERE source = ? AND received_at >= ?`,
  ).bind(minute, source, day).first();
  const rate = rateOf(source);
  if (Number(row?.minute ?? 0) + count > rate.perMinute) return 60;
  if (Number(row?.day ?? 0) + count > rate.perDay) return 3600;
  return 0;
}

async function insertMission(db, { title, detail, due, source, ref, leadUid = null }) {
  const at = nowIso();
  return db.prepare(
    `INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid, source, source_ref)
     VALUES (?, ?, NULL, 'pending', NULL, ?, 0, ?, ?, NULL, ?, ?, ?)
     RETURNING id`,
  ).bind(title, detail, due, at, at, leadUid, source, ref).first();
}

/** A warm lead, filed by hand: the same mission the 0012 triggers write, or
 *  the one already open for that lead. */
async function warmLeadMission(db, input, source) {
  const open = await db.prepare(
    "SELECT id FROM missions WHERE lead_uid = ? AND status <> 'done'",
  ).bind(input.lead_uid).first();
  if (open) return { id: open.id, existed: true };
  const row = await db.prepare(
    'SELECT title, detail, due FROM warm_lead_mission_rows WHERE uid = ?',
  ).bind(input.lead_uid).first();
  if (!row) throw new ValidationError('no lead with that uid', 'lead_uid');
  const made = await insertMission(db, {
    title: row.title,
    detail: input.detail ? `${row.detail}\n\nFiled by ${SOURCE_LABEL[source]}: ${input.detail}` : row.detail,
    due: input.due ?? row.due,
    source,
    ref: input.key,
    leadUid: input.lead_uid,
  });
  return { id: made.id, existed: false };
}

/** Moves a lead forward to `stage` (never back) at `at`. True when it moved. */
async function forward(db, uid, stage, at) {
  const current = await getLeadStage(db, uid);
  if (current === null || !movesForward(current, stage)) return false;
  await patchLeadState(db, uid, { stage }, at);
  return true;
}

/** A reply: the review, its proposed missions, and the lead's stage and times. */
async function fileReply(db, input, now) {
  const known = await getReviewByMessageId(db, input.message_id);
  if (known) return { ref: String(known.id), result: { review_id: known.id, lead_uid: known.uid ?? null, proposed: 0 }, existed: true };

  let uid = null;
  if (input.lead_uid) {
    if (await getLeadStage(db, input.lead_uid) === null) throw new ValidationError('no lead with that uid', 'lead_uid');
    uid = input.lead_uid;
  } else {
    uid = await uidForAddress(db, input.from);
  }
  const lead = uid ? await db.prepare('SELECT name FROM leads WHERE uid = ?').bind(uid).first() : null;

  // The lead's side first: moving forward and recording the time are both safe
  // to repeat, so a retry after a failure further down just does them again.
  let moved = false;
  if (uid && !['auto_reply','not_interested'].includes(input.reading.intent)) {
    const at = input.received_at ?? now.toISOString();
    moved = await forward(db, uid, 'replied', at);
    await recordMailTimes(db, uid, { repliedAt: at });
  }
  // Then the review and its proposals, in one transaction (audit item 7): a
  // retry never meets a review whose missions were never filed.
  const filed = await fileReviewWithProposals(db, {
    uid,
    message_id: input.message_id,
    thread_id: input.thread_id,
    from_email: input.from,
    subject: input.subject,
    received_at: input.received_at,
    body_excerpt: input.excerpt,
    intent: input.reading.intent,
    summary: input.reading.summary,
    asks: input.reading.asks,
    language: input.reading.language,
    status: input.reading.intent === 'auto_reply' ? 'handled' : 'open',
  }, proposalsFor(input.reading, { who: lead?.name || input.from }));
  const review = filed.review;
  const proposed = filed.proposed;
  if (!filed.created) {
    return { ref: String(review.id), result: { review_id: review.id, lead_uid: review.uid ?? null, proposed: 0 }, existed: true };
  }
  return { ref: String(review.id), result: { review_id: review.id, lead_uid: uid, proposed, moved }, existed: false };
}

/** The 3rd email's template: a short reminder that says the lead is off the prospect list. */
export const CLOSER_TEMPLATE = 'closer-3rd';

/** After the closer: passed, no follow-up date, a dated note, never offered again. A lead
 *  that replied, is in talks or was won is left as it is (its email is still logged). */
async function closeAfterCloser(db, uid, at) {
  const note = `closed after 3rd email, removed from prospect list, ${String(at).slice(0, 10)}`;
  const done = await db.prepare(
    `UPDATE lead_state SET stage = 'passed', passed_at = COALESCE(passed_at, ?), follow_up = NULL,
            notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || CHAR(10) || ? END, updated_at = ?
     WHERE uid = ? AND stage NOT IN ('replied', 'talks', 'won', 'passed')`,
  ).bind(at, note, note, at, uid).run();
  if (!done.meta?.changes) return false;
  await db.prepare("INSERT INTO lead_events (uid, kind, detail, at) VALUES (?, 'stage', 'passed', ?)").bind(uid, at).run();
  return true;
}

/** The address a send went to, lowercased: the one given, else the lead's own, else null. */
export async function sentToFor(db, uid, given) {
  const named = String(given ?? '').trim().toLowerCase();
  if (named) return named;
  const row = await db.prepare('SELECT lower(trim(email)) AS email FROM leads WHERE uid = ?').bind(uid).first();
  return row?.email || null;
}

/** An outreach email that went out: stage, follow-up date, and what was sent. */
async function fileOutreach(db, input, now) {
  const uid = input.lead_uid;
  if (isPersonalUid(uid)) throw new ValidationError(PERSONAL_REFUSAL, 'lead_uid');
  if (await getLeadStage(db, uid) === null) throw new ValidationError('no lead with that uid', 'lead_uid');
  const at = input.sent_at ?? now.toISOString();
  const prior=await getLeadStage(db,uid);
  const detail = [`batch ${input.batch}`, input.template && `template ${input.template}`, input.to && `to ${input.to}`, input.message_id && `message ${input.message_id}`].filter(Boolean).join(' · ');
  const sentTo=await sentToFor(db,uid,input.to);
  const saved=await logMessage(db,uid,{key:input.message_id?`gmail:${input.sender || 'unknown'}:${input.message_id}`:`batch:${uid}:${input.batch}`,at,detail,batch:input.batch,template:input.template,to:sentTo,sender:input.sender,subject:input.subject,body:input.body,thread_id:input.thread_id,provenance:input.message_id?'provider_reported':'reported'});
  const current=await getLeadStage(db,uid);
  const moved=prior!==current;
  const closed=current==='passed' && prior!=='passed';
  const state = await db.prepare('SELECT follow_up FROM lead_state WHERE uid = ?').bind(uid).first();
  return { ref: uid, result: { lead_uid: uid, moved, follow_up: state?.follow_up ?? null, ...(closed ? { closed: true } : {}) } };
}

/** Files every send of a batch log, each under its own (lead, batch) claim.
 *  One send that cannot be filed (an unknown uid, the Travel list) is reported
 *  and frees its claim; the others are filed all the same. */
async function fileOutreachBatch(db, source, input, now) {
  const result = { kind: 'outreach_batch', batch: input.batch, filed: 0, moved: 0, duplicates: 0, failed: [] };
  for (const send of input.sends) {
    /* eslint-disable no-await-in-loop -- in order; a few hundred small writes */
    const claim = await db.prepare(
      `INSERT INTO intake_requests (source, idempotency_key, kind, mission_id, received_at)
       VALUES (?, ?, 'outreach_sent', NULL, ?)
       ON CONFLICT(source, idempotency_key) DO NOTHING
       RETURNING source`,
    ).bind(source, send.key, now.toISOString()).first();
    if (!claim) { result.duplicates += 1; continue; }
    try {
      const made = await fileOutreach(db, send, now);
      await db.prepare('UPDATE intake_requests SET ref = ? WHERE source = ? AND idempotency_key = ?').bind(made.ref, source, send.key).run();
      result.filed += 1;
      if (made.result.moved) result.moved += 1;
    } catch (error) {
      await db.prepare('DELETE FROM intake_requests WHERE source = ? AND idempotency_key = ? AND ref IS NULL')
        .bind(source, send.key).run();
      if (!(error instanceof ValidationError)) throw error;
      result.failed.push({ lead_uid: send.lead_uid, error: error.message });
    }
    /* eslint-enable no-await-in-loop */
  }
  return { status: result.filed ? 201 : 200, body: result };
}

/** Authenticated HQ verification uses the same validator, claims and logging loop.
 * This is internal only: no new intake token or externally selectable source. */
export async function fileVerifiedOutreachBatch(db, body, now = new Date()) {
  return fileOutreachBatch(db, 'hq', validateOutreachBatch(body), now);
}

/** Files one request. Returns { status, body }. */
export async function fileIntake(db, source, body, now = new Date()) {
  const input = validateIntake(body, source);

  const retry = await rateLimited(db, source, now, input.kind === 'outreach_batch' ? input.sends.length : 1);
  if (retry) return { status: 429, body: { error: 'too many requests' }, retryAfter: retry };
  if (input.kind === 'outreach_batch') return fileOutreachBatch(db, source, input, now);
  if (input.kind === 'suppression') return fileSuppression(db, source, input, now);

  // Claim the key first. Losing the claim means this exact request was filed
  // already: answer with what it made, never make a second one.
  const mailKind = input.kind === 'reply' || input.kind === 'outreach_sent';
  const claim = await db.prepare(
    `INSERT INTO intake_requests (source, idempotency_key, kind, mission_id, received_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(source, idempotency_key) DO NOTHING
     RETURNING source`,
  ).bind(source, input.key, input.kind, now.toISOString()).first();
  if (!claim) {
    const earlier = await db.prepare(
      'SELECT mission_id, kind, ref FROM intake_requests WHERE source = ? AND idempotency_key = ?',
    ).bind(source, input.key).first();
    // A reply claim with nothing recorded is one that died half-way (the Worker
    // stopped before it could free the key). Filing a reply is safe to repeat,
    // so it simply goes through again. (Not an outreach: each run would add a
    // « sent » event, and the follow-up rhythm counts those.)
    const unfinished = mailKind && earlier && earlier.ref == null && earlier.mission_id == null;
    if (mailKind && !unfinished) return { status: 200, body: { duplicate: true, kind: input.kind, ref: earlier?.ref ?? null } };
    if (!unfinished) {
      const mission = earlier?.mission_id ? await getMission(db, earlier.mission_id) : null;
      return { status: 200, body: { duplicate: true, mission } };
    }
  }

  try {
    if (mailKind) {
      const made = input.kind === 'reply' ? await fileReply(db, input, now) : await fileOutreach(db, input, now);
      await db.prepare(
        'UPDATE intake_requests SET ref = ? WHERE source = ? AND idempotency_key = ?',
      ).bind(made.ref, source, input.key).run();
      return { status: made.existed ? 200 : 201, body: { duplicate: Boolean(made.existed), kind: input.kind, ...made.result } };
    }
    let id;
    let existed = false;
    if (input.kind === 'warm_lead') {
      ({ id, existed } = await warmLeadMission(db, input, source));
    } else if (input.kind === 'proposition') {
      ({ id } = await insertMission(db, {
        title: propositionTitle(input),
        detail: propositionDetail(input, source),
        due: input.due ?? nextWorkingDay(now),
        source,
        ref: input.key,
      }));
    } else {
      ({ id } = await insertMission(db, {
        title: input.title,
        detail: input.detail,
        due: input.due,
        source,
        ref: input.key,
      }));
    }
    await db.prepare(
      'UPDATE intake_requests SET mission_id = ? WHERE source = ? AND idempotency_key = ?',
    ).bind(id, source, input.key).run();
    return { status: existed ? 200 : 201, body: { duplicate: existed, mission: await getMission(db, id) } };
  } catch (error) {
    // Nothing was filed: free the key so a corrected retry can go through.
    await db.prepare('DELETE FROM intake_requests WHERE source = ? AND idempotency_key = ? AND mission_id IS NULL AND ref IS NULL')
      .bind(source, input.key).run();
    throw error;
  }
}

const OPEN = ['pending', 'in_progress', 'blocked'];

/** Handles the two token routes; anything else returns null and goes on to
 *  the normal session check. */
/* ----------------------------------------------------------- lead batches --- */

// POST /api/intake/lead-batch?key=<dataset>   body: the data.json bytes  (leads only)
// POST /api/intake/lead-approval              { key, sha256, rows }      (nirmata only)
// GET  /api/intake/lead-batches                the import log             (leads, nirmata)
const BATCH_ROUTES = Object.freeze({
  // Two keys: only LEADS files, only NIRMATA approves (one token can never do both).
  '/api/intake/lead-batch': { method: 'POST', sources: ['leads'] },
  '/api/intake/lead-approval': { method: 'POST', sources: ['nirmata'] },
  '/api/intake/lead-batches': { method: 'GET', sources: ['leads', 'nirmata'] },
  // What MARKETING may send next: read-only, LEADS only (send-list.js; Andy, 14 Nov).
  '/api/intake/send-list': { method: 'GET', sources: ['leads'] },
});

async function handleBatchRoute(route, request, env, url, source) {
  if (request.method !== route.method) return json({ error: 'method not allowed' }, 405, { Allow: route.method });
  if (!route.sources.includes(source)) return json({ error: `${source} may not call ${url.pathname}` }, 403);
  try {
    if (url.pathname === '/api/intake/lead-batches') return json({ batches: await listBatches(env.DB) });
    if (url.pathname === '/api/intake/send-list') {
      return json(await readSendList(env.DB, { dataset: url.searchParams.get('dataset'), stage: url.searchParams.get('stage') }));
    }
    const raw = await request.text();
    if (url.pathname === '/api/intake/lead-batch') {
      return json(await receiveBatch(env.DB, source, url.searchParams.get('key'), raw), 201);
    }
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'the body must be JSON', field: 'body' }, 400); }
    return json(await approveBatch(env.DB, source, body), 201);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field }, error.status === 422 ? 422 : 400);
    if (isReadLimit(error)) return readLimitResponse();
    throw error;
  }
}

export async function handleIntake(request, env, url) {
  const isIntake = url.pathname === '/api/intake';
  const isAgentList = url.pathname === '/api/missions' && /^Bearer\s/i.test(request.headers.get('Authorization') || '');
  const batchRoute = BATCH_ROUTES[url.pathname];
  if (!isIntake && !isAgentList && !batchRoute) return null;

  const source = await sourceFor(request, env);
  if (!source) return unauthorized();
  if (batchRoute) return handleBatchRoute(batchRoute, request, env, url, source);

  if (isAgentList) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
    const wanted = url.searchParams.get('status') || 'open';
    try {
      const missions = wanted === 'open'
        ? (await listMissions(env.DB)).filter((m) => OPEN.includes(m.status))
        : await listMissions(env.DB, { status: wanted });
      return json({ missions });
    } catch (error) {
      if (error instanceof ValidationError) return json({ error: error.message, field: error.field }, error.status === 422 ? 422 : 400);
      throw error;
    }
  }

  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  const raw = await request.text();
  // A batch log carries up to 300 sends; everything else stays small.
  const limit = KINDS_FOR[source].includes('outreach_batch') ? LIMITS.batchBody : LIMITS.body;
  if (raw.length > limit) return json({ error: `the body must be at most ${limit} bytes` }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'the body must be JSON', field: 'body' }, 400); }
  if (body?.kind !== 'outreach_batch' && raw.length > LIMITS.body) {
    return json({ error: `the body must be at most ${LIMITS.body} bytes` }, 413);
  }

  try {
    const result = await fileIntake(env.DB, source, body);
    return json(result.body, result.status, result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {});
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field }, error.status === 422 ? 422 : 400);
    throw error;
  }
}
