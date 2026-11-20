/* ------------------------------------------------------------------------
 * Reply reviews and the proposals they produce.
 *
 * Kept out of db.js on purpose: db.js is one long file several people edit at
 * once, and this is a self-contained table plus the three writes the funnel
 * needs. It reads ValidationError and nowIso from db.js so errors keep
 * behaving the same way at the API edge.
 *
 * The one rule this file exists to enforce: a mission born from a reply is
 * born `proposed`. There is no code path here that creates anything else.
 * --------------------------------------------------------------------- */

import { ValidationError, nowIso } from './db.js';
import { BODY_EXCERPT_MAX } from './replies-classify.js';

const REVIEW_COLUMNS = 'id, uid, message_id, thread_id, from_email, subject, received_at, '
  + 'body_excerpt, intent, summary, asks, language, reviewed_at, status';

export const REVIEW_STATUSES = Object.freeze(['open', 'handled', 'dismissed']);

const TITLE_MAX = 200;

const clamp = (value, max) => String(value ?? '').slice(0, max);

/** A review row as the API hands it out: `asks` parsed, never raw JSON text. */
function shapeReview(row) {
  if (!row) return null;
  let asks = [];
  try {
    const parsed = JSON.parse(row.asks ?? '[]');
    if (Array.isArray(parsed)) asks = parsed;
  } catch {
    asks = [];
  }
  return { ...row, asks };
}

/* ------------------------------------------------------------- the review */

export async function getReviewByMessageId(db, messageId) {
  return shapeReview(await db.prepare(
    `SELECT ${REVIEW_COLUMNS} FROM reply_reviews WHERE message_id = ?`,
  ).bind(String(messageId)).first());
}

export async function getReview(db, id) {
  return shapeReview(await db.prepare(
    `SELECT ${REVIEW_COLUMNS} FROM reply_reviews WHERE id = ?`,
  ).bind(id).first());
}

/**
 * Store one reading. `message_id` is UNIQUE, so a second scan of the same
 * mailbox lands on the conflict clause and changes nothing — the scan is
 * idempotent at the database, not just in the loop above it.
 */
export async function insertReview(db, input = {}) {
  const messageId = typeof input.message_id === 'string' ? input.message_id.trim() : '';
  if (!messageId) throw new ValidationError('a review needs the message it came from', 'message_id');
  if (typeof input.intent !== 'string' || !input.intent) {
    throw new ValidationError('a review needs an intent', 'intent');
  }

  const at = nowIso();
  const row = await db.prepare(
    `INSERT INTO reply_reviews
       (uid, message_id, thread_id, from_email, subject, received_at,
        body_excerpt, intent, summary, asks, language, reviewed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO NOTHING
     RETURNING ${REVIEW_COLUMNS}`,
  ).bind(
    input.uid ?? null,
    messageId,
    input.thread_id ?? null,
    clamp(input.from_email, 320),
    clamp(input.subject, 500),
    input.received_at ?? null,
    clamp(input.body_excerpt, BODY_EXCERPT_MAX),
    input.intent,
    clamp(input.summary, 200),
    JSON.stringify(Array.isArray(input.asks) ? input.asks : []),
    typeof input.language === 'string' ? input.language : 'other',
    at,
    REVIEW_STATUSES.includes(input.status) ? input.status : 'open',
  ).first();

  // DO NOTHING returns no row: somebody else stored it between the check and
  // the write. The existing review is the truth.
  return shapeReview(row) ?? getReviewByMessageId(db, messageId);
}

/**
 * A review and its proposed missions in one transaction (audit item 7, 13 Nov).
 * Before, the review was written first and each proposal after it: a failure
 * in between left a review that every retry saw as « known », so the rest was
 * never filed. Now both are filed or neither is. If the message was filed
 * already (by an earlier call or a parallel one), nothing is written, and the
 * existing review comes back with created: false.
 */
export async function fileReviewWithProposals(db, input = {}, proposals = []) {
  const messageId = typeof input.message_id === 'string' ? input.message_id.trim() : '';
  if (!messageId) throw new ValidationError('a review needs the message it came from', 'message_id');
  if (typeof input.intent !== 'string' || !input.intent) {
    throw new ValidationError('a review needs an intent', 'intent');
  }
  const automaticDecline=input.intent==='not_interested';
  if(automaticDecline)proposals=[];
  const titled = proposals.map((p) => ({ ...p, title: String(p?.title ?? '').trim() }));
  if (titled.some((p) => !p.title)) throw new ValidationError('a proposal needs a title', 'title');

  const existing = await getReviewByMessageId(db, messageId);
  if (existing) return { review: existing, created: false, proposed: 0 };

  const at = nowIso();
  const reviewId = '(SELECT filed.id FROM reply_reviews AS filed WHERE filed.message_id = ?)';
  const statements = [
    db.prepare(
      `INSERT INTO reply_reviews
         (uid, message_id, thread_id, from_email, subject, received_at,
          body_excerpt, intent, summary, asks, language, reviewed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.uid ?? null,
      messageId,
      input.thread_id ?? null,
      clamp(input.from_email, 320),
      clamp(input.subject, 500),
      input.received_at ?? null,
      clamp(input.body_excerpt, BODY_EXCERPT_MAX),
      input.intent,
      clamp(input.summary, 200),
      JSON.stringify(Array.isArray(input.asks) ? input.asks : []),
      typeof input.language === 'string' ? input.language : 'other',
      at,
      automaticDecline ? 'handled' : REVIEW_STATUSES.includes(input.status) ? input.status : 'open',
    ),
    ...(automaticDecline ? declineStatements(db,input,at) : []),
    ...titled.map((p) => db.prepare(
      `INSERT INTO missions
         (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, source_review_id, source, source_ref)
       VALUES (?, ?, ?, 'proposed', NULL, ?, 0, ?, ?, NULL, ${reviewId}, 'reply', CAST(${reviewId} AS TEXT))`,
    ).bind(p.title.slice(0, TITLE_MAX), String(p.detail ?? ''), p.slug ?? null, p.due ?? null, at, at, messageId, messageId)),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    // Filed by a parallel call between the check and the write: the batch
    // rolled back as a whole, and the review already there is the truth.
    if (!/UNIQUE/i.test(String(error?.message ?? error))) throw error;
    const filed = await getReviewByMessageId(db, messageId);
    if (!filed) throw error;
    return { review: filed, created: false, proposed: 0 };
  }
  return { review: await getReviewByMessageId(db, messageId), created: true, proposed: titled.length };
}

export async function setReviewStatus(db, id, status) {
  if (!REVIEW_STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${REVIEW_STATUSES.join(', ')}`, 'status');
  }
  return shapeReview(await db.prepare(
    `UPDATE reply_reviews SET status = ? WHERE id = ? RETURNING ${REVIEW_COLUMNS}`,
  ).bind(status, id).first());
}

/**
 * Every review, newest first, each with the lead it belongs to and the
 * proposals still waiting on it. Two queries, not one per row.
 */
export async function listReviews(db, filter = {}) {
  const where = [];
  const args = [];
  if (filter.status !== undefined) {
    if (!REVIEW_STATUSES.includes(filter.status)) {
      throw new ValidationError(`status must be one of ${REVIEW_STATUSES.join(', ')}`, 'status');
    }
    where.push('r.status = ?');
    args.push(filter.status);
  }

  const { results } = await db.prepare(
    `SELECT r.id, r.uid, r.message_id, r.thread_id, r.from_email, r.subject, r.received_at,
            r.body_excerpt, r.intent, r.summary, r.asks, r.language, r.reviewed_at, r.status,
            l.name AS lead_name
       FROM reply_reviews r
       LEFT JOIN leads l ON l.uid = r.uid
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(r.received_at, r.reviewed_at) DESC, r.id DESC`,
  ).bind(...args).all();

  const reviews = (results ?? []).map((row) => ({ ...shapeReview(row), proposals: [] }));
  if (!reviews.length) return reviews;

  const byId = new Map(reviews.map((review) => [review.id, review]));
  const proposals = await db.prepare(
    `SELECT id, title, detail, slug, status, due, source_review_id, created_at
       FROM missions
      WHERE source_review_id IS NOT NULL AND status = 'proposed'
      ORDER BY id ASC`,
  ).bind().all();

  for (const proposal of proposals.results ?? []) {
    byId.get(proposal.source_review_id)?.proposals.push(proposal);
  }
  return reviews;
}

/* ---------------------------------------------------------- the proposals */

/** The only writer of `status: 'proposed'`. Nothing else in HQ creates one. */
export async function createProposedMission(db, { title, detail = '', slug = null, due = null, reviewId }) {
  const clean = String(title ?? '').trim();
  if (!clean) throw new ValidationError('a proposal needs a title', 'title');
  const at = nowIso();
  return db.prepare(
    `INSERT INTO missions
       (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, source_review_id, source, source_ref)
     VALUES (?, ?, ?, 'proposed', NULL, ?, 0, ?, ?, NULL, ?, 'reply', ?)
     RETURNING id, title, detail, slug, status, due, source_review_id, created_at`,
  ).bind(clean.slice(0, TITLE_MAX), String(detail ?? ''), slug, due, at, at, reviewId, reviewId == null ? null : String(reviewId)).first();
}

/* -------------------------------------------------------- titles for them */

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * One ask -> one line the owner can read and act on without opening anything.
 * The lead's name carries the "who", the kind carries the "what", and the
 * model's own detail carries the specifics — quoted, not obeyed.
 */
export function proposalTitle(kind, ask, who) {
  const name = who || 'them';
  const detail = String(ask?.detail ?? '').trim();
  const place = ask?.url ? hostOf(ask.url) : '';

  switch (kind) {
    case 'answer_question':
      return detail ? `Answer ${name} — ${detail}` : `Answer ${name}`;
    case 'send_portfolio':
      return `Send your portfolio to ${name}`;
    case 'send_rate':
      return `Send your rate card to ${name}`;
    case 'sign_up':
      return place ? `Sign up on ${place} (${name} pointed you there)` : `Sign up where ${name} pointed you`;
    case 'book_call':
      return `Book a call with ${name}`;
    case 'provide_details':
      return detail ? `Send ${name} — ${detail}` : `Send ${name} the details they asked for`;
    case 'follow_up_later':
      return ask?.due_hint ? `Follow up with ${name} after ${ask.due_hint}` : `Follow up with ${name} later`;
    default:
      return `Read what ${name} wrote and decide`;
  }
}

/**
 * Every proposal a reading produces, as plain objects. Pure: no database, no
 * clock, so a test can read the whole funnel off one classification.
 */
export function proposalsFor(classification, { who, slug = null } = {}) {
  if (!classification || ['auto_reply','not_interested'].includes(classification.intent)) return [];
  const name = who || 'them';
  const out = [];

  for (const ask of classification.asks ?? []) {
    out.push({
      title: proposalTitle(ask.kind, ask, name),
      detail: [ask.detail, ask.url ? `Link they sent: ${ask.url}` : '']
        .filter(Boolean).join('\n'),
      slug,
      due: null,
    });
  }


  if (!out.length) {
    // Never silence. An unclear reply still gets a line that says so, rather
    // than a made-up action or nothing at all.
    out.push({
      title: `Read what ${name} wrote and decide`,
      detail: classification.summary || '',
      slug,
      due: null,
    });
  }

  return out;
}


// A definite refusal is housekeeping, never a proposed mission. Preserve clients.
function declineStatements(db,input,at) {
  const email=String(input.from_email || '').trim().toLowerCase();
  if(!email.includes('@'))throw new ValidationError('A decline needs the actual sender address','from_email');
  const eligible=`SELECT l.uid FROM leads l WHERE lower(trim(l.email))=?
    AND NOT EXISTS(SELECT 1 FROM clients c WHERE lower(trim(c.email))=lower(trim(l.email)))
    AND NOT EXISTS(SELECT 1 FROM prospects p WHERE p.lead_uid=l.uid AND p.client_id IS NOT NULL)`;
  return [
    db.prepare("INSERT OR IGNORE INTO email_suppression(email,reason,source,at) VALUES(?,'declined outreach','reply',?)").bind(email,at),
    db.prepare(`INSERT INTO lead_state(uid,stage,passed_at,updated_at) SELECT uid,'passed',?,? FROM (${eligible}) WHERE 1
      ON CONFLICT(uid) DO UPDATE SET stage=CASE WHEN lead_state.stage='won' THEN 'won' ELSE 'passed' END,follow_up=NULL,
      passed_at=CASE WHEN lead_state.stage='won' THEN lead_state.passed_at ELSE COALESCE(lead_state.passed_at,excluded.passed_at) END,updated_at=excluded.updated_at`).bind(at,at,email),
    db.prepare(`UPDATE lead_state SET follow_up=NULL,updated_at=? WHERE uid IN (SELECT uid FROM leads WHERE lower(trim(email))=?)`).bind(at,email),
    db.prepare(`INSERT INTO lead_events(uid,kind,detail,at,message_key,provenance)
      SELECT uid,'declined','Declined outreach; future contact stopped',?,? || ':' || uid,'reply' FROM leads WHERE lower(trim(email))=?
      ON CONFLICT(message_key) WHERE message_key IS NOT NULL DO NOTHING`).bind(at,`decline:${input.message_id}`,email),
    db.prepare(`UPDATE prospects SET stage='lost',lost_reason='Declined outreach',next_at=NULL,updated_at=?
      WHERE client_id IS NULL AND stage NOT IN ('won','lost') AND lower(trim(email))=?
      AND NOT EXISTS(SELECT 1 FROM clients c WHERE lower(trim(c.email))=lower(trim(prospects.email)))`).bind(at,email),
    db.prepare(`UPDATE outreach_batches SET status='cancelled',cancelled_at=? WHERE status IN ('draft','approved')
      AND id IN (SELECT batch_id FROM outreach_batch_items WHERE recipient=?)`).bind(at,email),
    db.prepare("DELETE FROM outreach_reservations WHERE batch_id IN (SELECT id FROM outreach_batches WHERE status='cancelled')"),
  ];
}
