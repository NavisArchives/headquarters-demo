import {
  findLeadUidByEmail, findLeadUidByEmailDomain, getLeadStage, patchLeadState, recordMailTimes,
  STATE_STAGES, nowIso, ValidationError,
} from '../db.js';
import { outreachRefusal, SUPPRESSED_REFUSAL } from '../../public/assets/personal-lists.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';
import { recordMailboxRead } from '../freshness.js';

/* ------------------------------------------------------------------------
 * Gmail, through the Mac.
 *
 * The OAuth token lives in modules/leads/.gmail on this computer and never
 * leaves it. A small Python server (modules/leads/tools/serve.py) holds it
 * and does the Google talking; HQ only forwards to it. Two consequences,
 * both deliberate:
 *
 *   - Set GMAIL_BRIDGE (in .dev.vars, never in wrangler.jsonc) and Gmail
 *     works. The deployed Worker cannot reach 127.0.0.1, so it has no such
 *     var and every route answers 503 "gmail needs the Mac" — a state the
 *     screen can show, not an error it has to explain.
 *   - The bridge has no send endpoint, and neither does this. Drafts are
 *     created; a human presses Send in Gmail.
 * --------------------------------------------------------------------- */

const PREFIX = '/api/gmail/';

/**
 * Every route HQ will ask the bridge for. `accept` is what a browser may
 * call here; `method` is what serve.py insists on at the other end (its
 * POST routes read a JSON body, its GET routes have none), so a status
 * check stays a GET and the consent URL stays a POST whichever verb the
 * screen happens to use.
 *
 * `callback` is absent on purpose: Google's redirect goes straight to
 * 127.0.0.1, exactly as it does today, so the code never passes through HQ.
 * Nothing here can send mail — the bridge has no route that could, and this
 * list is the only way through.
 */
const PROXY_ROUTES = Object.freeze({
  // -> { configured, connected, email }
  status: { accept: ['GET', 'POST'], method: 'GET' },
  // -> { address: { bucket, why, when, subject, excerpt, links, from } }
  replies: { accept: ['GET', 'POST'], method: 'GET' },
  // <- {} -> { url } — the Google consent screen to send the person to
  authorize: { accept: ['GET', 'POST'], method: 'POST', body: 'optional' },
  // <- the downloaded Google desktop-client JSON -> the status shape
  config: { accept: ['POST'], method: 'POST', body: 'required' },
  // <- { to, subject, body, html, account } -> { id, email, url }
  drafts: { accept: ['POST'], method: 'POST', body: 'required' },
});

const ACTIVITY = 'activity';
const BRIDGE_TIMEOUT_MS = 15_000;

/** Free-mail domains say nothing about a company, so a lead is never matched
 *  by them. Verbatim from the old app's sync (modules/leads/assets/app.js). */
export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.be', 'live.com',
  'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'gmx.de', 'gmx.net', 'web.de', 'telenet.be', 'skynet.be', 'orange.fr', 'free.fr',
  'wanadoo.fr', 'aol.com', 'mail.com',
]);

/** Pipeline order, so the sync can only ever move a lead forward. */
const STAGE_ORDER = new Map(STATE_STAGES.map((stage, index) => [stage, index]));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const needsTheMac = () => json({ error: 'gmail needs the Mac', connected: false }, 503);
const bridgeDown = () => json({ error: 'gmail bridge not running', connected: false }, 503);
const unreadable = () => json({ error: 'gmail bridge sent something unreadable', connected: false }, 502);

/** The bridge address comes from the environment and nowhere else: a request
 *  can never point this proxy at a host of its choosing. */
function bridgeBase(env) {
  const raw = typeof env?.GMAIL_BRIDGE === 'string' ? env.GMAIL_BRIDGE.trim() : '';
  if (!raw) return null;
  let base;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  return base.protocol === 'http:' || base.protocol === 'https:' ? base : null;
}

function parseJsonObject(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError('body must be valid JSON', 'body');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object', 'body');
  }
  return body;
}

/** The only thing of the caller's that travels: its JSON, re-serialized, so
 *  nothing but JSON can reach the local server. */
async function bodyFor(route, request) {
  const spec = PROXY_ROUTES[route];
  if (spec.method !== 'POST') return null;

  const text = request.method === 'POST' ? (await request.text()).trim() : '';
  if (!text) {
    if (spec.body === 'required') throw new ValidationError('body must be a JSON object', 'body');
    return '{}';
  }
  return JSON.stringify(parseJsonObject(text));
}

/**
 * One call to the local server. Sends the JSON body and nothing else: no HQ
 * session cookie, no Access header, no client header of any kind. The Origin
 * it does send is derived from the configured bridge URL — serve.py answers a
 * POST only when it looks like it came from its own page.
 *
 * Returns { status, data } — data null when the answer was not JSON — or null
 * when the bridge could not be reached at all (not running, or too slow).
 */
async function callBridge(base, route, { method, body = null, fetchImpl, timeoutMs }) {
  const target = new URL(`/api/gmail/${route}`, base).toString();
  const headers = {};
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = base.origin;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      method, headers, body, redirect: 'manual', signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    return { status: response.status, data };
  } catch {
    // Connection refused, DNS, or the 15 s abort: all the same to the screen.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The bridge's answer, re-emitted as our own Response: the status and the
 *  JSON travel, the bridge's headers do not. */
function relay(result) {
  if (!result) return bridgeDown();
  if (result.data === null) return unreadable();
  return json(result.data, result.status);
}

async function proxyRoute(base, route, request, deps) {
  const body = await bodyFor(route, request);
  return relay(await callBridge(base, route, { method: PROXY_ROUTES[route].method, body, ...deps }));
}

/* ------------------------------------------------------------------ sync */

function domainOf(address) {
  const at = String(address ?? '').lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/** Only forward. A lead in talks never drops back to sent because Gmail
 *  happens to remember the message that started the conversation. */
export function movesForward(current, next) {
  const from = STAGE_ORDER.get(current);
  const to = STAGE_ORDER.get(next);
  return from !== undefined && to !== undefined && from < to;
}

/** { sent: { address: iso }, replied: { address: iso } } -> a flat list,
 *  sent first so a lead that was written to and then answered ends on
 *  replied with its sent_at still stamped. */
function eventsOf(data) {
  const events = [];
  for (const stage of ['sent', 'replied']) {
    const map = data?.[stage];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [address, at] of Object.entries(map)) {
      if (typeof address === 'string' && address.includes('@')) {
        events.push({ stage, address: address.toLowerCase(), at: typeof at === 'string' ? at : null });
      }
    }
  }
  return events;
}

/** Exported for the reply funnel, which matches the same addresses the same way. */
export async function uidForAddress(db, address) {
  return uidFor(db, address);
}

async function uidFor(db, address) {
  const direct = await findLeadUidByEmail(db, address);
  if (direct) return direct;

  const domain = domainOf(address);
  if (!domain || FREE_MAIL.has(domain)) return null;
  return findLeadUidByEmailDomain(db, domain);
}

/**
 * POST /api/gmail/activity — read the mailbox, write the pipeline.
 *
 * HQ owns the pipeline now, so what the mailbox knows has to land in D1. If
 * this still wrote to the old browser storage the two would drift apart
 * silently, which is the one failure nobody would notice.
 */
async function syncActivity(base, env, deps) {
  const result = await callBridge(base, ACTIVITY, { method: 'GET', ...deps });
  if (!result) return bridgeDown();
  if (result.data === null) return unreadable();
  if (result.status !== 200) return json(result.data, result.status);

  const db = env.DB;
  let applied = 0;
  let skipped = 0;
  const unmatched = new Set();
  // The newest send and the newest reply per lead, gathered across all of
  // that lead's addresses, then written once per lead below.
  const times = new Map();

  for (const event of eventsOf(result.data)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of addresses, and each write depends on the read before it
    const uid = await uidFor(db, event.address);
    if (!uid) {
      unmatched.add(event.address);
      continue;
    }

    if (event.at) {
      const entry = times.get(uid) ?? {};
      const key = event.stage === 'sent' ? 'sentAt' : 'repliedAt';
      if (!entry[key] || event.at > entry[key]) entry[key] = event.at;
      times.set(uid, entry);
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    const stage = await getLeadStage(db, uid);
    if (stage === null || !movesForward(stage, event.stage)) {
      skipped += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- see above
    await patchLeadState(db, uid, { stage: event.stage }, event.at || nowIso());
    applied += 1;
  }

  // Whose turn it is, and the follow-up date, for every lead the mailbox
  // mentions — not only the ones whose stage moved.
  let updated = 0;
  for (const [uid, entry] of times) {
    // eslint-disable-next-line no-await-in-loop -- one small write per lead
    if (await recordMailTimes(db, uid, entry)) updated += 1;
  }

  return json({
    applied,
    updated,
    skipped,
    unmatched: [...unmatched],
    unmatchedCount: unmatched.size,
    email: typeof result.data.email === 'string' ? result.data.email : '',
  });
}

/* ----------------------------------------------------------------- route */

/**
 * Handle /api/gmail/*. Returns null when the path belongs to someone else.
 * `fetchImpl` is injected the way status.js injects it, so a test can watch
 * exactly what would be sent to the Mac.
 */
export async function handleGmail(request, env, url, { fetchImpl = fetch, timeoutMs = BRIDGE_TIMEOUT_MS } = {}) {
  const { pathname } = url;
  if (!pathname.startsWith(PREFIX)) return null;

  const route = pathname.slice(PREFIX.length);
  // Anything not named above — /callback, /send, a typo — is simply not a
  // route here, and no request leaves the Worker.
  if (route !== ACTIVITY && !Object.hasOwn(PROXY_ROUTES, route)) {
    return json({ error: 'not found' }, 404);
  }

  // The demo shares .dev.vars with the local HQ, so it would reach the real
  // mailbox: fictional data only, and no 15 s wait on a bridge that is down.
  const base = env?.DEMO === 'on' ? null : bridgeBase(env);
  if (!base) return needsTheMac();

  try {
    if (route === ACTIVITY) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      // Freshness (src/worker/freshness.js): success is recorded only after the
      // read and its writes succeeded; a failure never moves the last success.
      let response;
      try {
        response = await syncActivity(base, env, { fetchImpl, timeoutMs });
      } catch (error) {
        await recordMailboxRead(env?.STATUS, false, new Date(), 'HQ could not save what the mailbox said').catch(() => {});
        throw error;
      }
      await recordMailboxRead(env?.STATUS, response.status === 200, new Date(),
        response.status === 503 ? 'the Mac did not answer' : `the mailbox read answered ${response.status}`).catch(() => {});
      return response;
    }
    if (!PROXY_ROUTES[route].accept.includes(request.method)) {
      return json({ error: 'method not allowed' }, 405);
    }
    // A Gmail draft never goes to someone on a personal list (the Travel list).
    if (route === 'drafts') {
      const to = await request.clone().json().then((b) => b?.to).catch(() => null);
      const address = typeof to === 'string' ? to.trim().toLowerCase() : '';
      // An address that unsubscribed or bounced, whether or not a lead carries it (0027).
      if (env?.DB && address && await env.DB.prepare('SELECT 1 FROM email_suppression WHERE email = ?').bind(address).first()) {
        return json({ error: SUPPRESSED_REFUSAL }, 403);
      }
      const uid = env?.DB && address ? await findLeadUidByEmail(env.DB, address) : null;
      const lead = uid ? await env.DB.prepare(
        'SELECT uid, dataset, business FROM leads WHERE uid = ?',
      ).bind(uid).first() : null;
      const refusal = lead && outreachRefusal(lead);
      if (refusal) return json({ error: refusal }, 403);
    }
    return await proxyRoute(base, route, request, { fetchImpl, timeoutMs });
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field ?? null }, 400);
    if (isReadLimit(error)) return readLimitResponse();
    console.error('gmail api:', error);
    return json({ error: 'something went wrong' }, 500);
  }
}
