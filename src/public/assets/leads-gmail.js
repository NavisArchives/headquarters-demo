// The browser's side of the Gmail bridge (src/worker/api/gmail.js), which
// proxies the local Gmail server on the Mac.
//
// Every route here is allowed to be unreachable: deployed to Cloudflare, or
// with the Mac switched off, the worker answers 503 and nothing in the leads
// screen may break or shout about it. So each call degrades to a plain,
// inspectable value and only a genuine *action* (creating a draft, syncing
// the mailbox) ever surfaces an error to the person.

import { apiFetch, ApiError } from './api.js';

/** What the screen assumes when the bridge cannot be reached at all. */
const UNREACHABLE = Object.freeze({
  configured: false, connected: false, expired: false, email: '', unreachable: true,
});

let cachedStatus = null;

/**
 * `{ configured, connected, email, unreachable }`. Cached for the life of
 * the screen — the popup asks on every open, and the answer only changes
 * when the person completes the consent, which calls this with refresh.
 */
export async function gmailStatus({ refresh = false } = {}) {
  if (cachedStatus && !refresh) return cachedStatus;
  try {
    const body = await apiFetch('/api/gmail/status');
    cachedStatus = {
      configured: Boolean(body?.configured),
      connected: Boolean(body?.connected),
      // Google's 7-day sign-in ran out (the OAuth app is in Testing): the
      // Leads screen then offers « Connect Gmail ».
      expired: Boolean(body?.expired),
      email: body?.email || '',
      unreachable: false,
    };
  } catch {
    cachedStatus = UNREACHABLE;
  }
  return cachedStatus;
}

export function forgetGmailStatus() {
  cachedStatus = null;
}

/** The one-time consent URL, or '' when the bridge cannot hand one over. */
export async function authorizeUrl() {
  try {
    const body = await apiFetch('/api/gmail/authorize');
    return body?.url || '';
  } catch {
    return '';
  }
}

/**
 * Create the finished draft in Gmail. Unlike the reads above this throws,
 * because the person pressed a button and is owed an answer either way.
 * Resolves to whatever the bridge returns — `{ url, email }` in the
 * original's shape.
 */
export async function createGmailDraft(payload) {
  try {
    return await apiFetch('/api/gmail/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 503 || error.status === 0)) {
      throw new ApiError('Gmail is only reachable from the Mac, and it is not answering.', { status: 503 });
    }
    throw error;
  }
}

/**
 * Ask the bridge to read the mailbox and move the leads it recognises.
 * Returns `{ applied, skipped, unmatched }`; throws when unreachable, since
 * this too is only ever run by pressing a button.
 */
export async function syncMailbox() {
  const body = await apiFetch('/api/gmail/activity', { method: 'POST' });
  return {
    applied: Number(body?.applied) || 0,
    updated: Number(body?.updated) || 0,
    skipped: Number(body?.skipped) || 0,
    unmatched: Number(body?.unmatched) || 0,
  };
}

// A throttle only: the time an automatic read was last STARTED on this device.
// It is never shown as « last synced »; the last successful read is recorded by
// the Worker after it succeeded (src/worker/freshness.js).
const AUTO_SYNC_KEY = 'hq.mailboxSyncedAt';
export const AUTO_SYNC_EVERY_MS = 10 * 60 * 1000;

/**
 * The same sync, on its own: when HQ runs on the Mac with Gmail connected,
 * opening Home or Leads reads the mailbox at most every ten minutes, so who
 * wrote last and every follow-up date stay current without pressing a button
 * ("keep following up", Andy 14 Oct). Quiet: no toast, never a throw.
 * Returns the result, or null when it did not run.
 */
export async function autoSyncMailbox(now = Date.now()) {
  let last = 0;
  try { last = Number(localStorage.getItem(AUTO_SYNC_KEY)) || 0; } catch { /* private mode: run anyway */ }
  if (now - last < AUTO_SYNC_EVERY_MS) return null;
  const status = await gmailStatus();
  if (!status?.connected) return null;
  try { localStorage.setItem(AUTO_SYNC_KEY, String(now)); } catch { /* fine */ }
  try {
    return await syncMailbox();
  } catch {
    return null;
  }
}

/**
 * The classified replies, keyed by address (`{ bucket, ... }`), used by the
 * "Replies to act on" attention row. Always an object, never a throw: with
 * no bridge there are simply no classified replies, and the row falls back
 * to what D1 knows (leads sitting at `replied`).
 */
export async function fetchReplies() {
  try {
    const body = await apiFetch('/api/gmail/replies');
    if (!body || typeof body !== 'object' || body.error) return {};
    // The bridge may answer either the bare map or { replies: {...} }.
    const map = body.replies && typeof body.replies === 'object' ? body.replies : body;
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}
