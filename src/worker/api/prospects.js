import { ValidationError } from '../db.js';
import {
  listProspects, getProspect, createProspect, updateProspect, deleteProspect, getOnboarding, saveOnboarding,
  ensureLiveLink, revokeLiveLink, listTemplates, saveTemplate,
} from '../prospects-db.js';
import { liveUrl } from '../live.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/prospects';
const TEMPLATES = '/api/onboarding-templates';
const ITEM = /^\/api\/prospects\/([^/]+)$/;
const ONBOARDING = /^\/api\/prospects\/([^/]+)\/onboarding$/;
const LIVE = /^\/api\/prospects\/([^/]+)\/live$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** A database error can carry fragments of the query. That is for the logs. */
function serverError(error) {
  if (isReadLimit(error)) return readLimitResponse();
  console.error('prospects api:', error);
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

const idOf = (text) => {
  const id = Number(text);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * /api/prospects, /api/prospects/:id and /api/prospects/:id/onboarding.
 * The last one is what the client-facing questionnaire uses, and it answers
 * with the questionnaire only: no contact details, no notes, no stage.
 */
export async function handleProspects(request, env, url) {
  const onboarding = ONBOARDING.exec(url.pathname);
  const live = LIVE.exec(url.pathname);
  const item = ITEM.exec(url.pathname);
  const isCollection = url.pathname === COLLECTION;
  const isTemplates = url.pathname === TEMPLATES;
  if (!onboarding && !live && !item && !isCollection && !isTemplates) return null;

  try {
    // The questionnaire templates: the built-in ones and those Andy saved.
    if (isTemplates) {
      if (request.method === 'GET') return json({ templates: await listTemplates(env.DB) });
      if (request.method === 'POST') return json({ template: await saveTemplate(env.DB, await readJsonObject(request)) }, 201);
      return json({ error: 'method not allowed' }, 405);
    }

    // The live mirror's link: POST gives the one that works (or a new one,
    // 7 days), DELETE stops it at once.
    if (live) {
      const id = idOf(live[1]);
      if (!id) return json({ error: 'no such prospect' }, 404);
      if (request.method === 'POST') {
        const link = await ensureLiveLink(env.DB, id);
        if (!link) return json({ error: 'no such prospect' }, 404);
        // The address the client opens: Realis Studio's own domain for a Realis
        // prospect, the HQ domain for an andyssarchives one; the demo keeps its own.
        const { brand } = await getProspect(env.DB, id);
        const address = liveUrl(brand, link.token, { demoOrigin: env.DEMO === 'on' ? url.origin : null });
        return json({ live: { expires_at: link.expires_at, url: address } });
      }
      if (request.method === 'DELETE') {
        return await revokeLiveLink(env.DB, id)
          ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
          : json({ error: 'no such prospect' }, 404);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (onboarding) {
      const id = idOf(onboarding[1]);
      if (!id) return json({ error: 'no such prospect' }, 404);
      if (request.method === 'GET') {
        const form = await getOnboarding(env.DB, id);
        return form ? json({ onboarding: form }) : json({ error: 'no such prospect' }, 404);
      }
      if (request.method === 'PATCH') {
        const body = await readJsonObject(request);
        const saved = await saveOnboarding(env.DB, id, body.answers);
        return saved ? json(saved) : json({ error: 'no such prospect' }, 404);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (isCollection) {
      if (request.method === 'GET') {
        // ?for=pipeline: the deals only; ?slug=<project>: that project's client onboardings.
        const slug = url.searchParams.get('slug');
        const only = url.searchParams.get('for') === 'pipeline' ? { client: false } : {};
        return json({ prospects: await listProspects(env.DB, slug ? { slug } : only) });
      }
      if (request.method === 'POST') return json({ prospect: await createProspect(env.DB, await readJsonObject(request)) }, 201);
      return json({ error: 'method not allowed' }, 405);
    }

    const id = idOf(item[1]);
    if (!id) return json({ error: 'no such prospect' }, 404);
    if (request.method === 'GET') {
      const prospect = await getProspect(env.DB, id);
      return prospect ? json({ prospect }) : json({ error: 'no such prospect' }, 404);
    }
    if (request.method === 'PATCH') {
      const prospect = await updateProspect(env.DB, id, await readJsonObject(request));
      return prospect ? json({ prospect }) : json({ error: 'no such prospect' }, 404);
    }
    if (request.method === 'DELETE') {
      return await deleteProspect(env.DB, id)
        ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        : json({ error: 'no such prospect' }, 404);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field ?? null }, 400);
    return serverError(error);
  }
}
