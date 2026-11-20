// Fetch wrapper shared by app.js and the screens.
//
// Every route is same-origin, authenticated already, and answers JSON. A 401
// means the session ended (Access or the password-mode cookie expired
// mid-use) — there is nothing a screen can usefully do about that itself, so
// this fires a global event and lets app.js take over the whole page.
import { noteOfflineCopy } from './sw-client.js';

export class ApiError extends Error {
  constructor(message, { status = 0, field = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

/* A revisit shows at once (Andy in Lima, 3 Nov: every query crosses the Atlantic).
 * The last answer of a screen's read is returned immediately and refreshed behind
 * it for the next visit; any write forgets everything, so a screen never shows
 * its own change late. In memory only: gone on reload, nothing stored on disk.
 * Off until app.js turns it on, so a test always talks to its own stub. */
// Lists and totals only. A single record that gets edited (an invoice, a project's
// notes, a questionnaire) is always read fresh: a stale copy could be saved over newer data.
const CACHEABLE = /^\/api\/(missions|todos|overview|projects|prospects|leads|briefing|finance\/(overview|clients|invoices|expenses|orders|projects\/[^/?]+))(\?|$)/;
const MAX_AGE_MS = 5 * 60_000;
let cache = null;
let generation = 0;
const inFlight = new Map();

export function enableApiCache() { cache = new Map(); }
export function clearApiCache() { generation += 1; cache?.clear(); inFlight.clear(); }

/** One read at a time per address: two cards asking the same thing share it. */
function readThrough(url, options) {
  const running = inFlight.get(url);
  if (running) return running;
  const started = generation;
  const read = request(url, options, (raw) => {
    if (cache && started === generation) cache.set(url, { raw, at: Date.now() });
  }).finally(() => { if (inFlight.get(url) === read) inFlight.delete(url); });
  inFlight.set(url, read);
  return read;
}

/* A lead's stage, star, note or follow-up (13 Nov): the Leads list is the
 * heaviest read (4,600 rows), and Quick personalization writes one lead every
 * few seconds. So that write patches the one row in the cached list instead of
 * dropping it; every other cached read is still forgotten, since pipelines and
 * totals count stages. */
const LEADS_LIST = '/api/leads';
const LEAD_STATE_WRITE = /^\/api\/leads\/[^/?]+\/[^/?]+\/state$/;

function forgetAllButLeadsList(lead) {
  const hit = cache?.get(LEADS_LIST);
  clearApiCache();
  if (!hit || !lead?.uid) return;
  try {
    const list = JSON.parse(hit.raw);
    const rows = Array.isArray(list?.leads) ? list.leads : null;
    const at = rows ? rows.findIndex((row) => row.uid === lead.uid) : -1;
    if (at < 0) return;
    // The list keeps its own trimmed payload; the state fields come from the write.
    const { payload, ...fields } = lead;
    rows[at] = { ...rows[at], ...fields };
    cache.set(LEADS_LIST, { raw: JSON.stringify(list), at: hit.at });
  } catch { /* forgotten, then: the next visit reads it fresh */ }
}

export async function apiFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (cache && method === 'GET' && CACHEABLE.test(url)) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < MAX_AGE_MS) {
      readThrough(url, options).catch(() => {});
      return JSON.parse(hit.raw);
    }
    return readThrough(url, options);
  }
  // readOnly: a POST that only reads (the opens of many leads) forgets nothing.
  const { readOnly, ...sent } = options;
  const body = await request(url, sent);
  if (method === 'GET' || readOnly) return body;
  if (LEAD_STATE_WRITE.test(url) && body?.lead) forgetAllButLeadsList(body.lead);
  else clearApiCache();
  return body;
}

/* No answer within this long is a hung connection, not a slow one (audit D16,
 * P3: on a café network the Add button stayed grey with nothing happening). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** What a failed request says, in words Andy can act on (audit D16, P1, P2). */
export function offlineMessage(error, online = globalThis.navigator?.onLine !== false) {
  if (error?.name === 'AbortError') return 'No answer after 15 s: the outcome is unknown. Check the record before retrying; what you typed is kept.';
  if (!online) return 'No connection: nothing was saved. What you typed is kept on this device.';
  return error?.message && error.message !== 'Failed to fetch' ? error.message : 'HQ could not be reached: nothing was saved. Try again in a moment.';
}

async function request(url, options, onRaw) {
  let response;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    response = await fetch(url, {
      ...options,
      ...(controller && !options.signal ? { signal: controller.signal } : {}),
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
  } catch (networkError) {
    throw new ApiError(offlineMessage(networkError), { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
  }

  noteOfflineCopy(response);

  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('hq:session-ended'));
    throw new ApiError('your session ended', { status: response.status });
  }

  if (response.status === 204) return null;

  const raw = await response.text();
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = null; }
  }

  if (!response.ok) {
    const message = (body && body.error) || `request failed (${response.status})`;
    throw new ApiError(message, { status: response.status, field: body?.field ?? null });
  }

  if (raw && body !== null) onRaw?.(raw);
  return body;
}
