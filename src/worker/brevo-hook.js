// Brevo's transactional webhook: since hello@ sends through Brevo's SMTP
// relay, Brevo knows when a message is opened. It POSTs each event here, and
// an open is recorded exactly where px.js records one — `opens:<uid>` in the
// OPENS KV — so the Leads screen needs no change to show it.
//
// A hard bounce, an invalid address, a block, an unsubscribe or a spam
// complaint (A5, 30 Oct) is a lead never to email again: it moves to « passed »
// with the reason on its history, so no later batch picks it up. A won lead
// keeps its stage; the event is still recorded. Soft bounces are ignored.
//
// Like the pixel, this runs before authenticate(): Brevo has no cookie and no
// Access header. The secret in the path (env.BREVO_HOOK_TOKEN) is the only
// gate, so an unset token or a wrong one answers 404 like any unknown path.

import { sha256Hex } from './lead-batches.js';
import { getLeadStage, patchLeadState } from './db.js';

const PATH = /^\/hooks\/brevo\/([^/]+)$/;

// Real opens only. Brevo reports Apple Mail Privacy Protection fetches as
// proxy_open / unique_proxy_open — a machine loading the image, not a person.
const OPEN_EVENTS = new Set(['opened', 'unique_opened']);
const MAX_HITS = 200;
/** Brevo event → the reason written on the lead. */
export const STOP_EVENTS = Object.freeze({
  hard_bounce: 'hard bounce', invalid_email: 'invalid address', blocked: 'blocked by Brevo',
  unsubscribed: 'unsubscribed', spam: 'marked as spam', complaint: 'marked as spam',
});

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Constant-time string compare, so the token can't be guessed byte by byte. */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** When the event happened, as ISO. Brevo sends ts_event / ts_epoch (seconds
 *  or ms) and a "YYYY-MM-DD HH:MM:SS" date; fall back to now. */
export function eventTime(event, now = Date.now()) {
  for (const key of ['ts_event', 'ts_epoch', 'ts']) {
    const n = Number(event?.[key]);
    if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const d = Date.parse(String(event?.date || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(event?.date || '')) ? '' : 'Z'));
  return new Date(Number.isFinite(d) ? d : now).toISOString();
}

/** Every lead uid whose stored email is this address (a shared clinic inbox
 *  can belong to several doctors). */
async function uidsFor(env, email) {
  if (!env.DB || !email) return [];
  const { results } = await env.DB
    .prepare('SELECT uid FROM leads WHERE lower(trim(email)) = ?')
    .bind(String(email).trim().toLowerCase())
    .all();
  return (results || []).map((r) => r.uid);
}

async function recordOpen(kv, uid, iso) {
  const key = `opens:${uid}`;
  const hits = (await kv.get(key, 'json')) ?? [];
  if (hits.includes(iso)) return false; // Brevo retries: never count one event twice
  hits.push(iso);
  hits.sort();
  if (hits.length > MAX_HITS) hits.splice(0, hits.length - MAX_HITS);
  await kv.put(key, JSON.stringify(hits));
  return true;
}

/** One stop event for one lead: passed (unless won), follow-up cleared, the
 *  reason on its history. Brevo retries, so the same event is recorded once. */
/** Never email this address again (0027). Lower-cased; a second stop keeps the first. */
export async function suppressEmail(db, email, reason, source, iso) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address.includes('@')) return false;
  const r = await db.prepare('INSERT OR IGNORE INTO email_suppression (email, reason, source, at) VALUES (?, ?, ?, ?)')
    .bind(address, reason, source, iso).run();
  return Number(r?.meta?.changes ?? 0) > 0;
}

export async function recordStop(db, uid, reason, iso) {
  const detail = `Brevo: ${reason}`;
  const seen = await db.prepare("SELECT 1 FROM lead_events WHERE uid = ? AND kind = 'stop' AND detail = ? AND at = ?").bind(uid, detail, iso).first();
  if (seen) return false;
  const stage = await getLeadStage(db, uid);
  if (stage === null) return false;
  if (stage !== 'won' && stage !== 'passed') await patchLeadState(db, uid, { stage: 'passed', follow_up: null }, iso);
  await db.prepare("INSERT INTO lead_events (uid,kind,detail,at,message_key) VALUES (?,'stop',?,?,?) ON CONFLICT(message_key) WHERE message_key IS NOT NULL DO NOTHING").bind(uid,detail,iso,`stop:${uid}:${reason}:${iso}`).run();
  return true;
}

/** Handle `POST /hooks/brevo/<token>`. Returns null for every other path. */
export async function handleBrevoHook(request, env, url) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  if (!env.BREVO_HOOK_TOKEN || !sameToken(match[1], env.BREVO_HOOK_TOKEN)) return notFound();
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  const events = Array.isArray(body) ? body : [body];

  let recorded = 0;
  let stopped = 0;
  let failed = false;
  // Store provider facts before processing. Retries repair incomplete effects.
  if(env.DB) {
    for(const event of events) {
      if(!event || typeof event!=='object')continue;
      try {
        const key=await sha256Hex(JSON.stringify(event));
        await env.DB.prepare('INSERT OR IGNORE INTO outreach_delivery_events(event_key,email,kind,happened_at,received_at) VALUES(?,?,?,?,?)')
          .bind(key,String(event.email || '').trim().toLowerCase(),String(event.event || '').toLowerCase(),eventTime(event),new Date().toISOString()).run();
      }catch(error){failed=true;console.error('brevo receipt:',error);}
    }
  }
  if (env.DB) {
    for (const event of events) {
      const reason = STOP_EVENTS[String(event?.event || '').toLowerCase()];
      if (!reason) continue;
      try {
        const iso = eventTime(event);
        // The address itself is suppressed, even if no lead carries it today (0027).
        await suppressEmail(env.DB, event.email, reason, 'brevo', iso);
        for (const uid of await uidsFor(env, event.email)) {
          if (await recordStop(env.DB, uid, reason, iso)) stopped += 1;
        }
      } catch (error) {
        failed = true;
        console.error('brevo hook (stop):', error);
      }
    }
  }
  if (env.OPENS) {
    for (const event of events) {
      if (!OPEN_EVENTS.has(String(event?.event || '').toLowerCase())) continue;
      try {
        const iso = eventTime(event);
        for (const uid of await uidsFor(env, event.email)) {
          if (await recordOpen(env.OPENS, uid, iso)) recorded += 1;
        }
      } catch (error) {
        failed = true;
        console.error('brevo hook:', error);
      }
    }
  }
  // A failed write must be retried; unknown event kinds are still acknowledged.
  return new Response(JSON.stringify({ ok: !failed, recorded, stopped }), {
    status: failed ? 503 : 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
