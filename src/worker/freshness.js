// How fresh the replies list really is, per source (Codex handover 003, NIRMATA
// 20 Nov). Nothing here claims more than the code can back:
//   mailbox  — the Mac's Gmail bridge read (POST /api/gmail/activity). The last
//              SUCCESSFUL read is recorded only after it succeeded; a failed
//              attempt is recorded apart and never advances it.
//   replies  — when a reply was last filed into HQ (intake or the Mac bridge).
//              That is a record time, not a check of the inbox.
// « Mac online » is a third, separate fact (the header chip) and is not used here.
// Alerts for warm replies run only while HQ is open; nothing reaches a closed app.

export const MAILBOX_KEY = 'freshness:mailbox';
export const FRESH_FOR_MS = 30 * 60 * 1000; // the auto read runs every 10 min while HQ is open

/** Record one mailbox read. Success moves ok_at; a failure only moves attempt_at. */
export async function recordMailboxRead(kv, ok, now = new Date(), error = '') {
  if (!kv?.get || !kv?.put) return null;
  let prior = {};
  try { prior = (await kv.get(MAILBOX_KEY, 'json')) || {}; } catch { prior = {}; }
  const at = now.toISOString();
  const next = ok
    ? { ok_at: at, attempt_at: at, error: '' }
    : { ok_at: prior.ok_at || null, attempt_at: at, error: String(error || 'failed').slice(0, 120) };
  await kv.put(MAILBOX_KEY, JSON.stringify(next));
  return next;
}

/** fresh | stale | failed | unknown, with the times behind it. */
export function mailboxState(record, now = new Date()) {
  const okAt = record?.ok_at || null;
  const attemptAt = record?.attempt_at || null;
  const failedLast = Boolean(attemptAt && record?.error && (!okAt || attemptAt > okAt));
  let state = 'unknown';
  if (failedLast) state = 'failed';
  else if (okAt) state = now - Date.parse(okAt) <= FRESH_FOR_MS ? 'fresh' : 'stale';
  return { source: 'mailbox', state, last_success_at: okAt, last_attempt_at: attemptAt, error: failedLast ? record.error : '' };
}

export async function sourceFreshness(env, now = new Date()) {
  let record = null;
  try { record = env?.STATUS ? await env.STATUS.get(MAILBOX_KEY, 'json') : null; } catch { record = null; }
  const filed = env?.DB ? await env.DB.prepare('SELECT MAX(reviewed_at) AS at FROM reply_reviews').first() : null;
  return {
    mailbox: mailboxState(record, now),
    replies: { source: 'replies', state: filed?.at ? 'recorded' : 'unknown', last_recorded_at: filed?.at || null },
    alerts: 'while_open',
  };
}
