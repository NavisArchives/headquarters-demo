import { replyInbox } from '../outreach-replies.js';
import { sourceFreshness } from '../freshness.js';
import { saveVerification, logVerifiedDelivered } from '../outreach-verification.js';
import { approveDailyDraft, exportDailyDraft } from '../outreach-review.js';
import { buildDailyDraft, editDraft, draftHash } from '../outreach-drafts.js';
import { ValidationError } from '../db.js';
import { planAttention, applyAttention, undoAttention } from '../attention.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';
import {
  cockpit, candidates, timeline, saveSender, createBatch, batchDetail,
  approveBatch, cancelBatch, recordAgreement,
} from '../outreach.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function bodyOf(request) {
  const raw = await request.text();
  if (raw.length > 1500000) throw new ValidationError('Request is too large', 'body');
  let body;
  try { body = JSON.parse(raw); } catch { throw new ValidationError('Use valid JSON', 'body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Use a JSON object', 'body');
  return body;
}

export async function handleOutreach(request, env, url, identity = {}, now = new Date()) {
  const path = url.pathname;
  if (!path.startsWith('/api/outreach/')) return null;
  try {
    if (path === '/api/outreach/replies' && request.method === 'GET') {
      return json({ ...await replyInbox(env.DB, now), freshness: await sourceFreshness(env, now) });
    }
    if (path === '/api/outreach/cockpit' && request.method === 'GET') {
      return json(await cockpit(env.DB, env.HQ_TIME_ZONE || 'America/Lima', now));
    }
    // « Needs your attention » by number or name: plan (nothing written), apply, undo.
    if (path === '/api/outreach/attention/plan' && request.method === 'POST') {
      return json({ plan: await planAttention(env.DB, await bodyOf(request), now) });
    }
    if (path === '/api/outreach/attention/apply' && request.method === 'POST') {
      return json(await applyAttention(env.DB, await bodyOf(request), now));
    }
    if (path === '/api/outreach/attention/undo' && request.method === 'POST') {
      return json(await undoAttention(env.DB, (await bodyOf(request)).undo, now));
    }
    if (path === '/api/outreach/planner' && request.method === 'GET') {
      return json({ candidates: await candidates(env.DB), limit: 280 });
    }
    if (path === '/api/outreach/contacts' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      if (!['sent', 'no_contact'].includes(state)) throw new ValidationError('Choose sent or no_contact', 'state');
      const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
      const where = state === 'sent'
        ? "EXISTS(SELECT 1 FROM lead_events e WHERE e.uid=l.uid AND e.kind='sent')"
        : "(s.stage='passed' OR es.email IS NOT NULL)";
      const rows = await env.DB.prepare(`
        SELECT l.uid, l.name, l.email, COALESCE(s.stage, 'new') AS stage,
          s.last_sent_at, s.follow_up, es.reason,
          (SELECT COUNT(*) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent') AS sends
        FROM leads l
        LEFT JOIN lead_state s ON s.uid = l.uid
        LEFT JOIN email_suppression es ON es.email = lower(trim(l.email))
        WHERE l.dataset <> 'travel-volunteer-stays' AND l.business <> 'Agencies' AND ${where}
        ORDER BY COALESCE(s.last_sent_at, s.updated_at, l.imported_at) DESC, l.uid
        LIMIT 101 OFFSET ?
      `).bind(offset).all();
      return json({ contacts: rows.results.slice(0, 100), more: rows.results.length > 100, offset });
    }
    if (path === '/api/outreach/senders') {
      if (request.method === 'GET') {
        return json({ senders: (await env.DB.prepare('SELECT * FROM outreach_senders ORDER BY email').all()).results });
      }
      if (request.method === 'PUT') {
        await saveSender(env.DB, await bodyOf(request));
        return json({ saved: true });
      }
    }
    if (path === '/api/outreach/batches/build' && request.method === 'POST') {
      return json({ batch: await buildDailyDraft(env.DB, await bodyOf(request), now) }, 201);
    }
    if (path === '/api/outreach/batches') {
      if (request.method === 'GET') {
        return json({ batches: (await env.DB.prepare(`
          SELECT b.*, (SELECT COUNT(*) FROM outreach_batch_items i WHERE i.batch_id = b.id) AS emails
          FROM outreach_batches b ORDER BY created_at DESC LIMIT 50
        `).all()).results });
      }
      if (request.method === 'POST') return json({ batch: await createBatch(env.DB, await bodyOf(request)) }, 201);
    }
    const batch = /^\/api\/outreach\/batches\/([a-zA-Z0-9-]+)(?:\/(approve|cancel|send|export|verify|log-delivered))?$/.exec(path);
    if (batch) {
      if (request.method === 'PATCH' && !batch[2]) {
        return json({ batch: await editDraft(env.DB, batch[1], await bodyOf(request)) });
      }
      if (request.method === 'GET' && !batch[2]) {
        const value = await batchDetail(env.DB, batch[1]);
        return value ? json({ batch: value }) : json({ error: 'Unknown batch' }, 404);
      }
      if (request.method === 'POST' && batch[2] === 'verify') {
        return json({ verification: await saveVerification(env.DB, batch[1], await bodyOf(request), now) });
      }
      if (request.method === 'POST' && batch[2] === 'log-delivered') {
        const body = await bodyOf(request);
        if (typeof body.verification_id !== 'string') throw new ValidationError('Reload the saved delivery verification first', 'verification_id');
        return json({ logging: await logVerifiedDelivered(env.DB, batch[1], body.content_hash, now, body.offset ?? 0, body.verification_id) });
      }
      if (request.method === 'GET' && batch[2] === 'export') {
        return json(await exportDailyDraft(env.DB, batch[1]));
      }
      if (request.method === 'POST' && batch[2] === 'approve') {
        const current = await batchDetail(env.DB, batch[1]);
        const daily = current && await draftHash(current.items, current.day) === current.content_hash;
        const hash = (await bodyOf(request)).content_hash;
        const actor = identity.email || 'Andy · authenticated HQ session';
        return json({ batch: await (daily ? approveDailyDraft : approveBatch)(env.DB, batch[1], hash, actor, now) });
      }
      if (request.method === 'POST' && batch[2] === 'cancel') {
        await cancelBatch(env.DB, batch[1]);
        return json({ cancelled: true });
      }
      if (request.method === 'POST' && batch[2] === 'send') {
        return json({ error: 'Sending is disabled on this review branch. Approval reserves capacity; it does not send email.' }, 409);
      }
    }
    if (path === '/api/outreach/timeline' && request.method === 'GET') {
      return json({ events: await timeline(env.DB, url.searchParams.get('uid') || '') });
    }
    const agreement = /^\/api\/outreach\/agreements\/(\d+)$/.exec(path);
    if (agreement) {
      if (request.method === 'GET') {
        return json({ agreement: await env.DB.prepare('SELECT * FROM signed_agreements WHERE prospect_id = ?').bind(Number(agreement[1])).first() });
      }
      if (request.method === 'PUT') {
        await recordAgreement(env.DB, Number(agreement[1]), await bodyOf(request));
        return json({ saved: true });
      }
    }
    return json({ error: 'Route or method not supported' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field }, 400);
    if (isReadLimit(error)) return readLimitResponse();
    console.error('outreach:', error);
    return json({ error: 'Outreach could not be loaded or saved. Check the current record before retrying.' }, 500);
  }
}
