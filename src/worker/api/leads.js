import {
  listLeads, getLead, patchLeadState, getDraft, saveDraft, clearDraft,
  getSetting, setSetting, nowIso, ValidationError, upsertLead,
} from '../db.js';
import { DEFAULT_PROFILE, profileFor } from '../../shared/outreach.js';
import { buildComposeRow, composeLead } from '../lead-compose.js';
import { buildDesignedEmail } from '../../shared/email-template.js';
import { runImport } from '../import-leads.js';
import { importApproved, listBatches } from '../lead-batches.js';
import { outreachRefusal } from '../../public/assets/personal-lists.js';
import { recordOwnSend, undoOwnSend, recordLinkedIn, undoLinkedIn } from '../lead-sends.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/leads';
const PROFILE_PATH = '/api/settings/profile';
const MYINFO_PATH = '/api/settings/myinfo';

// dataset and id are validated separately against this, the same kebab-case
// rule the project registry uses — a uid that fails either half is 404, and
// no query runs.
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ITEM_RE = /^\/api\/leads\/([^/]+)\/([^/]+)(?:\/(.*))?$/;
const DRAFT_SUFFIX = /^draft\/([^/]+)$/;
const LANG = /^[a-zA-Z]+$/;

// The three languages outreach.js and email-template.js know how to write in
// (see langsFor in ../../shared/outreach.js). Used only to enumerate which
// per-language drafts to attach to a lead's detail view.
const DRAFT_LANGS = ['EN', 'NL', 'FR'];
const COMPOSE_MODES = ['email', 'dm', 'followup', 'closer'];

const TEN_MINUTES_MS = 10 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function notFound() {
  return json({ error: 'no such lead' }, 404);
}

function badRequest(error) {
  return json({ error: error.message, field: error.field ?? null }, error.status === 422 ? 422 : 400);
}

/** A database error can carry fragments of the query. That is for the logs. */
function serverError(error) {
  if (isReadLimit(error)) return readLimitResponse();
  console.error('leads api:', error);
  return json({ error: 'something went wrong' }, 500);
}

async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError('body must be valid JSON', 'body');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object', 'body');
  }
  return body;
}

const PUBLIC_ORIGIN = 'https://hq.example.com';

/** Where the open pixel is served from: the request's own origin when that is
 *  the public HQ, otherwise the deployed one (env.PUBLIC_ORIGIN overrides). */
function pixelOrigin(env, url) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname) || url.hostname.endsWith('.localhost');
  return local ? (env.PUBLIC_ORIGIN || PUBLIC_ORIGIN) : url.origin;
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Discards opens within ten minutes of the exact send time (lead_state's
 *  own sent_at, stamped by patchLeadState) — Gmail's own prefetch or the
 *  sender re-reading their own message, per the old app's rule. */
function discardAutoOpens(timestamps, sentAt) {
  const sentMs = sentAt ? Date.parse(sentAt) : NaN;
  if (!Number.isFinite(sentMs)) return timestamps;
  return timestamps.filter((ts) => {
    const ms = Date.parse(ts);
    return !Number.isFinite(ms) || Math.abs(ms - sentMs) >= TEN_MINUTES_MS;
  });
}

/** Reads back the opens recorded by px.js for this uid. Degrades to an empty
 *  list, never an error, when OPENS isn't bound or holds nothing usable. */
async function readOpens(env, uid, sentAt) {
  const kv = env.OPENS;
  if (!kv) return [];
  let raw;
  try {
    raw = await kv.get(`opens:${uid}`, 'json');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return discardAutoOpens(raw, sentAt);
}

/** The opens of many leads in one request (13 Nov): the Leads screen used to
 *  fetch each sent lead's whole record to read its opens — up to 150 requests,
 *  ~0.5 s each from Lima. One D1 query for the sent dates, then the KV reads in
 *  parallel inside the Worker. Leads with no opens are left out of the answer. */
const OPENS_BATCH_MAX = 200;
async function handleOpensBatch(env, request) {
  const body = await readJsonObject(request);
  const uids = Array.isArray(body.uids) ? [...new Set(body.uids.filter((u) => typeof u === 'string' && u))] : null;
  if (!uids) throw new ValidationError('uids must be a list', 'uids');
  if (uids.length > OPENS_BATCH_MAX) throw new ValidationError(`at most ${OPENS_BATCH_MAX} leads at once`, 'uids');
  if (!uids.length || !env.OPENS) return json({ opens: {} });
  const { results } = await env.DB.prepare(
    'SELECT uid, sent_at FROM lead_state WHERE uid IN (SELECT value FROM json_each(?))',
  ).bind(JSON.stringify(uids)).all();
  const sentAt = new Map((results ?? []).map((row) => [row.uid, row.sent_at]));
  const pairs = await Promise.all(uids.map(async (uid) => [uid, await readOpens(env, uid, sentAt.get(uid) ?? null)]));
  return json({ opens: Object.fromEntries(pairs.filter(([, list]) => list.length)) });
}

async function handleList(env, url) {
  const filter = {};
  const params = url.searchParams;
  if (params.has('business')) filter.business = params.get('business');
  if (params.has('category')) filter.category = params.get('category');
  if (params.has('area')) filter.area = params.get('area');
  if (params.has('tier')) filter.tier = params.get('tier');
  if (params.has('contact')) filter.contact = params.get('contact');
  if (params.has('stage')) filter.stage = params.get('stage');
  if (params.has('starred')) filter.starred = params.get('starred') === 'true' || params.get('starred') === '1';
  if (params.has('language')) filter.language = params.get('language');
  if (params.has('q')) filter.q = params.get('q');
  if (params.has('sort')) filter.sort = params.get('sort');

  // ?only=uids: the screen's search asks which leads match words that the
  // trimmed list no longer carries (pitch, research). ?full=1: whole records,
  // for the CSV export.
  if (params.get('only') === 'uids') {
    return json({ uids: await listLeads(env.DB, { ...filter, shape: 'uids' }) });
  }
  if (params.get('full') === '1') filter.shape = 'full';
  return json({ leads: await listLeads(env.DB, filter) });
}

async function handleDetail(env, uid) {
  const lead = await getLead(env.DB, uid);
  if (!lead) return notFound();

  const drafts = {};
  for (const lang of DRAFT_LANGS) {
    // eslint-disable-next-line no-await-in-loop -- three tiny lookups, sequential is fine here
    const draft = await getDraft(env.DB, uid, lang);
    if (draft) drafts[lang] = draft;
  }

  const opens = await readOpens(env, uid, lead.sent_at);
  // What they wrote back, readable on the lead itself (audit C11, P7): the
  // newest three replies HQ filed, with the reading and the excerpt it stored.
  const { results: replies } = await env.DB.prepare(
    `SELECT received_at, from_email, subject, intent, summary, body_excerpt AS excerpt, thread_id
     FROM reply_reviews WHERE uid = ? ORDER BY COALESCE(received_at, reviewed_at) DESC, id DESC LIMIT 3`,
  ).bind(uid).all();

  return json({ lead, drafts, opens, replies: replies ?? [] });
}

async function handleStatePatch(env, uid, request) {
  const patch = await readJsonObject(request);
  const state = await patchLeadState(env.DB, uid, patch, nowIso());
  return state ? json({ lead: state }) : notFound();
}

async function handleDraftPut(env, uid, lang, request) {
  const lead = await getLead(env.DB, uid);
  const refusal = lead && outreachRefusal(lead);
  if (refusal) return json({ error: refusal }, 403);
  const body = await readJsonObject(request);
  const draft = await saveDraft(env.DB, uid, lang, body);
  return json({ draft });
}

async function handleDraftDelete(env, uid, lang) {
  const gone = await clearDraft(env.DB, uid, lang);
  return gone
    ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    : notFound();
}

async function handleProfileGet(env) {
  const profile = await getSetting(env.DB, 'profile');
  return json({ profile: profile ?? null });
}

async function handleProfilePut(env, request) {
  const body = await readJsonObject(request);
  await setSetting(env.DB, 'profile', body);
  return json({ profile: body });
}

async function handleMyInfoGet(env) {
  const info = await getSetting(env.DB, 'myinfo');
  return json({ myinfo: info ?? null });
}

async function handleMyInfoPut(env, request) {
  const body = await readJsonObject(request);
  await setSetting(env.DB, 'myinfo', body);
  return json({ myinfo: body });
}

async function handleCompose(env, uid, url) {
  const lead = await getLead(env.DB, uid);
  if (!lead) return notFound();
  const refusal = outreachRefusal(lead);
  if (refusal) return json({ error: refusal }, 403);

  const mode = url.searchParams.get('mode') ?? undefined;
  if (mode !== undefined && !COMPOSE_MODES.includes(mode)) {
    throw new ValidationError(`mode must be one of ${COMPOSE_MODES.join(', ')}`, 'mode');
  }
  const lang = url.searchParams.get('lang') ?? undefined;
  // One sentence about this prospect, typed in the pop-up. It only shapes a
  // freshly composed draft; once a draft is saved the sentence is inside it.
  const hook = url.searchParams.get('hook') ?? undefined;

  const storedProfile = await getSetting(env.DB, 'profile');
  const profile = storedProfile ?? DEFAULT_PROFILE;
  // B's subject, typed in the pop-up like the hook (sector copy, 13 Nov).
  const subject = url.searchParams.get('subject') ?? undefined;
  // What a follow-up must know: once, 7 days on, never after a reply.
  const mail = await env.DB.prepare(
    `SELECT s.last_sent_at, s.last_reply_at,
            (SELECT COUNT(*) FROM lead_events e WHERE e.uid = ? AND e.kind = 'sent') AS sends,
            (SELECT e.subject FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at, e.id LIMIT 1) AS first_subject
     FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid WHERE l.uid = ?`,
  ).bind(uid, uid).first();
  const row = buildComposeRow(lead);
  const composed = await composeLead(env.DB, { ...lead, ...mail }, { lang, mode, profile, hook, subject });

  const token = randomToken();
  if (env.OPENS) {
    await env.OPENS.put(`token:${token}`, JSON.stringify({ uid, sentAt: nowIso() }));
  }
  // The recipient's mail client fetches this, so it must be a public address:
  // HQ usually runs on localhost, which nobody outside this Mac can reach.
  const pixelUrl = `${pixelOrigin(env, url)}/px/${token}.gif`;
  // The brand signs the email: Realis Studio for a website lead, andyssarchives
  // for UGC. Its address becomes the draft's From, whatever Gmail is connected.
  const signedAs = profileFor(row, profile);
  // Only UGC emails are designed. Realis emails go out as Andy's plain text,
  // so no banner image, no layout: building one anyway is what put the
  // "A refined website built to convert" picture into the preview.
  const designedHtml = row.business === 'UGC'
    ? buildDesignedEmail({ body: composed.body, profile: signedAs, pixelUrl })
    : '';

  return json({
    subject: composed.subject, body: composed.body, toName: composed.toName ?? '', designedHtml,
    ...(composed.noDraft ? { noDraft: composed.noDraft } : {}),
    ...(composed.sector ? { sector: composed.sector } : {}),
    from: signedAs.email, brand: signedAs.studio, pixelUrl,
  });
}

/** `runImport` lives in src/worker/import-leads.js, written by another agent
 *  in parallel with this task. Its own ImportError (a bad dataset or row) is a
 *  client mistake, so it maps to 400 like ValidationError does, not 500. */
async function handleImport(env, request) {
  const body = await readJsonObject(request);
  try {
    return json(await runImport(env.DB, body.datasets));
  } catch (error) {
    if (error?.name === 'ImportError') return badRequest(error);
    throw error;
  }
}

/**
 * One lead, added by hand.
 *
 * The only way into the leads table used to be a full dataset import, and the
 * empty state literally told the owner to run curl. That is no use to someone
 * who has just found a surgeon's number on a clinic page and wants it in the
 * pipeline before he forgets.
 *
 * Two things are deliberately NOT taken from the caller:
 *   - the id, which is derived from the name, because a colliding or
 *     non-kebab id silently detaches a lead's state or makes it unreachable;
 *   - the tier, which comes from the dataset's own stored thresholds, so a
 *     hand-added lead is scored by the same rules as an imported one.
 * And `business` decides which brand writes to this person, so it is taken
 * from the dataset rather than typed.
 */
async function handleLeadCreate(env, request) {
  const body = await readJsonObject(request);

  const datasetKey = typeof body.dataset === 'string' ? body.dataset.trim() : '';
  if (!datasetKey) throw new ValidationError('which list does this lead belong to?', 'dataset');
  const dataset = await env.DB.prepare(
    'SELECT key, business, tier_hot, tier_warm FROM datasets WHERE key = ?',
  ).bind(datasetKey).first();
  if (!dataset) throw new ValidationError('that list does not exist', 'dataset');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new ValidationError('a name is required', 'name');

  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!base) throw new ValidationError('that name has no letters in it', 'name');

  // A name someone already added gets a numbered neighbour rather than
  // overwriting them. Silently replacing a lead would take its notes,
  // its drafts and its whole history with it.
  let id = base;
  for (let n = 2; n < 50; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- one probe per collision
    const taken = await env.DB.prepare('SELECT uid FROM leads WHERE uid = ?').bind(`${datasetKey}/${id}`).first();
    if (!taken) break;
    id = `${base}-${n}`;
  }

  const score = Number.isInteger(body.score) ? body.score : 50;
  const tier = score >= dataset.tier_hot ? 'Hot' : (score >= dataset.tier_warm ? 'Warm' : 'Cool');

  const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
  const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : null;
  // A surgeon with no site is the commonest lead worth adding by hand, and
  // the leads table has always insisted on something in this column. Rather
  // than invent a URL, it says what is true — and the category says it too,
  // which is what makes the outreach template pick the "no website" wording
  // instead of claiming to have come across a site that does not exist.
  const given = typeof body.website === 'string' ? body.website.trim() : '';
  const website = given || 'No website found';
  const hasSite = Boolean(given);
  const contactType = email ? 'email' : (phone ? 'phone' : 'other');

  const languages = Array.isArray(body.languages)
    ? body.languages.filter((l) => ['NL', 'FR', 'EN', 'DE'].includes(l))
    : [];

  const row = {
    dataset: datasetKey,
    id,
    business: dataset.business,
    name,
    website,
    category: typeof body.category === 'string' && body.category.trim()
      ? body.category.trim()
      : (hasSite ? 'Own practice site' : 'No site'),
    subcategory: typeof body.subcategory === 'string' && body.subcategory.trim() ? body.subcategory.trim() : null,
    city: typeof body.city === 'string' && body.city.trim() ? body.city.trim() : null,
    area: typeof body.area === 'string' && body.area.trim() ? body.area.trim() : null,
    region: typeof body.region === 'string' && body.region.trim() ? body.region.trim() : null,
    country: typeof body.country === 'string' && body.country.trim() ? body.country.trim() : 'Belgium',
    languages,
    email,
    phone,
    contact: email ?? phone ?? null,
    contact_type: contactType,
    score,
    tier,
    verified: null,
  };
  // The payload is what the outreach templates read for the things that never
  // became columns. A hand-added lead says plainly where it came from.
  row.payload = JSON.stringify({
    ...row,
    languages,
    evidence: typeof body.why === 'string' && body.why.trim() ? body.why.trim() : 'Added by hand in HQ.',
    research: '',
    extra: {
      Presence: hasSite ? 'Own practice site' : 'No site',
      Need: hasSite ? 'unknown' : 'no website',
      Source: 'added by hand',
    },
    contactType,
  });

  const lead = await upsertLead(env.DB, row);
  // The list's count is the number of rows it actually has, never a number
  // a caller supplied.
  await env.DB.prepare(
    'UPDATE datasets SET row_count = (SELECT COUNT(*) FROM leads WHERE dataset = ?) WHERE key = ?',
  ).bind(datasetKey, datasetKey).run();
  return json({ lead: lead ?? { uid: `${datasetKey}/${id}` } }, 201);
}

/**
 * Handle the leads and profile-settings routes. Returns null when the path
 * belongs to someone else, so the Worker can carry on matching.
 */
export async function handleLeads(request, env, url) {
  const { pathname } = url;

  try {
    if (pathname === COLLECTION) {
      if (request.method === 'GET') return await handleList(env, url);
      if (request.method === 'POST') return await handleLeadCreate(env, request);
      return json({ error: 'method not allowed' }, 405);
    }

    if (pathname === `${COLLECTION}/opens`) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return await handleOpensBatch(env, request);
    }

    // The approved batches (lead-batches.js): the log, and « Import now ».
    if (pathname === `${COLLECTION}/batches`) {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return json({ batches: await listBatches(env.DB) });
    }
    if (pathname === `${COLLECTION}/batches/run`) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return json({ imported: await importApproved(env.DB) });
    }

    if (pathname === `${COLLECTION}/import`) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return await handleImport(env, request);
    }

    if (pathname === PROFILE_PATH) {
      if (request.method === 'GET') return await handleProfileGet(env);
      if (request.method === 'PUT') return await handleProfilePut(env, request);
      return json({ error: 'method not allowed' }, 405);
    }

    if (pathname === MYINFO_PATH) {
      if (request.method === 'GET') return await handleMyInfoGet(env);
      if (request.method === 'PUT') return await handleMyInfoPut(env, request);
      return json({ error: 'method not allowed' }, 405);
    }

    const match = ITEM_RE.exec(pathname);
    if (!match) return null;

    const [, dataset, id, rawSuffix] = match;
    if (!KEBAB.test(dataset) || !KEBAB.test(id)) return notFound();
    const uid = `${dataset}/${id}`;
    const suffix = rawSuffix ?? '';

    if (suffix === '') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handleDetail(env, uid);
    }

    if (suffix === 'state') {
      if (request.method !== 'PATCH') return json({ error: 'method not allowed' }, 405);
      return await handleStatePatch(env, uid, request);
    }

    // Andy sent it from Gmail and says so (audit A4, A5): never before.
    if (suffix === 'sent') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const lead = await getLead(env.DB, uid);
      if (!lead) return notFound();
      const refusal = outreachRefusal(lead);
      if (refusal) return json({ error: refusal }, 403);
      const body = await readJsonObject(request);
      return json(await recordOwnSend(env.DB, uid, { mode: body.mode ?? 'email', request_id: body.request_id, subject: body.subject ?? null, body: body.body ?? null, sender: body.sender ?? null }));
    }
    if (suffix === 'sent/undo') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!await getLead(env.DB, uid)) return notFound();
      return json({ lead: await undoOwnSend(env.DB, uid, await readJsonObject(request)) });
    }

    // Andy messaged them on LinkedIn himself (NIRMATA, 14 Nov): recorded, never sent by HQ.
    if (suffix === 'linkedin') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const lead = await getLead(env.DB, uid);
      if (!lead) return notFound();
      const refusal = outreachRefusal({ ...lead, suppressed: false });
      if (refusal) return json({ error: refusal }, 403);
      return json(await recordLinkedIn(env.DB, uid));
    }
    if (suffix === 'linkedin/undo') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!await getLead(env.DB, uid)) return notFound();
      return json({ lead: await undoLinkedIn(env.DB, uid, await readJsonObject(request)) });
    }

    if (suffix === 'compose') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      return await handleCompose(env, uid, url);
    }

    const draftMatch = DRAFT_SUFFIX.exec(suffix);
    if (draftMatch) {
      const lang = draftMatch[1];
      if (!LANG.test(lang)) return notFound();
      if (request.method === 'PUT') return await handleDraftPut(env, uid, lang, request);
      if (request.method === 'DELETE') return await handleDraftDelete(env, uid, lang);
      return json({ error: 'method not allowed' }, 405);
    }

    return notFound();
  } catch (error) {
    if (error instanceof ValidationError) return badRequest(error);
    return serverError(error);
  }
}
