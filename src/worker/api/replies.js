/* ------------------------------------------------------------------------
 * The reply funnel.
 *
 *   POST /api/replies/scan        read the new replies, store what they say,
 *                                 propose missions
 *   GET  /api/replies             every review, with its waiting proposals
 *   POST /api/replies/:id/dismiss this one has been dealt with
 *
 * Accepting a proposal is not here: it is PATCH /api/missions/:id
 * { status: 'pending' }, and declining is DELETE. One vocabulary for missions,
 * whatever gave birth to them.
 *
 * Two things this route will never do, by construction rather than by care:
 * it never sends, drafts or touches mail (the only outbound call it makes is
 * to the classifier), and it never follows a link an email contained.
 * --------------------------------------------------------------------- */

import { ValidationError } from '../db.js';
import { uidForAddress, handleGmail } from './gmail.js';
import {
  classifyReply, classifyReplyViaBridge, readiness, bridgeBaseOf,
  apiKeyOf, ClassifierError, BODY_EXCERPT_MAX,
} from '../replies-classify.js';
import {
  getReviewByMessageId, listReviews, setReviewStatus,
  fileReviewWithProposals, proposalsFor,
} from '../db-replies.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/replies';
const SCAN = '/api/replies/scan';
const DISMISS = /^\/api\/replies\/(\d+)\/dismiss$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const needsAKey = () => json({ error: 'reply reading needs the Mac' }, 503);
const cannotRead = (note) => json({ error: `reply reading ${note}` }, 503);

/**
 * How a reply gets read: on the Mac, with the Claude Code CLI on the owner's own
 * subscription, never by an API from the Worker (Andy, 14 Oct: no API key, no
 * server-side AI; apiKeyOf always answers null). No Mac is not a crash: the
 * scan answers 503 with the state the button should wear.
 */
function readerFor(env) {

  const base = bridgeBaseOf(env);
  if (base) return { via: 'bridge', read: (item, deps) => classifyReplyViaBridge(base, item, deps) };

  return null;
}

/** What a reply the reader could not make sense of becomes on the Mac path:
 *  a review that says so, and one mission telling the owner to go look. The
 *  alternative — dropping it — is how a reply goes unanswered for a week. */
const UNREADABLE = Object.freeze({
  intent: 'unclear',
  summary: 'could not be read',
  asks: [],
  language: 'other',
});

/* ------------------------------------------------------------ the mailbox */

/**
 * The bridge's replies, through the existing proxy so there is exactly one
 * place that knows how to reach the Mac. Returns { ok: true, replies } or
 * { ok: false, response } — the proxy's own 503 travels unchanged, so "needs
 * the Mac" reads the same here as on the leads screen.
 */
async function pullReplies(env, deps) {
  const url = new URL('https://hq.local/api/gmail/replies');
  const response = await handleGmail(new Request(url, { method: 'GET' }), env, url, deps);
  if (!response || !response.ok) return { ok: false, response: response ?? json({ error: 'gmail needs the Mac' }, 503) };

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return { ok: false, response: json({ error: 'gmail bridge sent something unreadable' }, 502) };

  const map = body.replies && typeof body.replies === 'object' ? body.replies : body;
  return { ok: true, replies: map && typeof map === 'object' ? map : {} };
}

/**
 * The bridge keys its replies by address and keeps only the most recent
 * message per sender; it carries no Gmail message id. So the identity of a
 * reply is the sender plus the moment it arrived — stable across scans, which
 * is all `message_id` has to be. A bridge that one day does send ids is
 * preferred over this.
 */
function identify(address, reply) {
  const explicit = [reply?.message_id, reply?.id].find((v) => typeof v === 'string' && v.trim());
  if (explicit) return explicit.trim();
  return `${String(reply?.from || address).toLowerCase()}|${reply?.when || ''}`;
}

/** The bridge's record, reduced to the fields the classifier and the row need. */
function normalize(address, reply) {
  return {
    message_id: identify(address, reply),
    thread_id: typeof reply?.thread_id === 'string' ? reply.thread_id : null,
    from_email: String(reply?.from || address).toLowerCase(),
    subject: String(reply?.subject ?? ''),
    received_at: typeof reply?.when === 'string' && reply.when ? reply.when : null,
    body: String(reply?.excerpt ?? '').slice(0, BODY_EXCERPT_MAX),
  };
}

/* --------------------------------------------------------------- the scan */

async function scan(env, deps) {
  const reader = readerFor(env);
  if (!reader) {
    // No key and no Mac: say which is missing rather than naming a key the
    // owner does not need to buy.
    return bridgeBaseOf(env) ? cannotRead('needs Claude on the Mac') : needsAKey();
  }

  const pulled = await pullReplies(env, deps);
  if (!pulled.ok) return pulled.response;

  const db = env.DB;
  const entries = Object.entries(pulled.replies)
    .filter(([address, reply]) => address.includes('@') && reply && typeof reply === 'object');

  // Two replies from the same company arrive under two addresses but are one
  // message: the bridge stores the same record twice. Read each id once.
  const seen = new Set();
  let read = 0;
  let known = 0;
  let proposed = 0;
  const failed = [];

  for (const [address, reply] of entries) {
    const item = normalize(address, reply);
    if (seen.has(item.message_id)) continue;
    seen.add(item.message_id);

    // eslint-disable-next-line no-await-in-loop -- a handful of replies, and each step depends on the last
    if (await getReviewByMessageId(db, item.message_id)) { known += 1; continue; }

    let classification;
    let unreadable = false;
    try {
      // eslint-disable-next-line no-await-in-loop -- see above
      classification = await reader.read(item, deps);
    } catch (error) {
      if (!(error instanceof ClassifierError)) throw error;
      failed.push({ from: item.from_email, why: error.message });
      // On the API path a failure is usually a rate limit or an outage worth
      // retrying on the next scan, so the reply is left unread. On the Mac
      // path there is no bill and no queue: the reply is filed as unread-able
      // so the owner sees it instead of it disappearing into a counter.
      if (reader.via !== 'bridge') continue;
      classification = UNREADABLE;
      unreadable = true;
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    const uid = await uidForAddress(db, item.from_email);
    // eslint-disable-next-line no-await-in-loop -- see above
    const lead = uid ? await db.prepare('SELECT name FROM leads WHERE uid = ?').bind(uid).first() : null;

    const who = lead?.name || item.from_email;
    const proposals = unreadable
      ? [{
        title: `Read this reply yourself — ${who}`,
        detail: `HQ could not read this reply. Open it in Gmail and decide. From: ${item.from_email}`,
      }]
      : proposalsFor(classification, { who });

    // The review and its proposals in one transaction (audit item 7): never a
    // review whose missions went missing, which no later scan would refile.
    // eslint-disable-next-line no-await-in-loop -- see above
    const filed = await fileReviewWithProposals(db, {
      uid,
      message_id: item.message_id,
      thread_id: item.thread_id,
      from_email: item.from_email,
      subject: item.subject,
      received_at: item.received_at,
      body_excerpt: item.body,
      intent: classification.intent,
      summary: classification.summary,
      asks: classification.asks,
      language: classification.language,
      // An autoresponder needs nothing from anybody, so it is filed, not queued.
      status: classification.intent === 'auto_reply' ? 'handled' : 'open',
    }, proposals);
    read += 1;
    proposed += filed.proposed;
  }

  return json({ read, known, proposed, failed, reviews: await listReviews(db) });
}

/* -------------------------------------------------------------- the route */

export async function handleReplies(request, env, url, deps = {}) {
  const { pathname } = url;
  if (pathname !== COLLECTION && !pathname.startsWith(`${COLLECTION}/`)) return null;

  try {
    if (pathname === SCAN) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return await scan(env, deps);
    }

    if (pathname === COLLECTION) {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const filter = {};
      if (url.searchParams.has('status')) filter.status = url.searchParams.get('status');
      return json({
        reviews: await listReviews(env.DB, filter),
        // What the screen needs to grey out its own buttons instead of
        // waiting for a 503 to tell it.
        ...await readiness(env, deps),
      });
    }

    const dismiss = DISMISS.exec(pathname);
    if (dismiss) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const review = await setReviewStatus(env.DB, Number(dismiss[1]), 'dismissed');
      return review ? json({ review }) : json({ error: 'no such review' }, 404);
    }

    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field ?? null }, 400);
    if (isReadLimit(error)) return readLimitResponse();
    console.error('replies api:', error);
    return json({ error: 'something went wrong' }, 500);
  }
}
