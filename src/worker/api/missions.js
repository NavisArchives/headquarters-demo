import {
  listMissions, getMission, createMission, updateMission, deleteMission, ValidationError,
} from '../db.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/missions';
const ITEM = /^\/api\/missions\/([^/]+)$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function badRequest(error) {
  return json({ error: error.message, field: error.field ?? null }, 400);
}

/** A database error can carry fragments of the query. That is for the logs. */
function serverError(error) {
  if (isReadLimit(error)) return readLimitResponse();
  console.error('missions api:', error);
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

/**
 * Handle the missions routes. Returns null when the path belongs to someone
 * else, so the Worker can carry on matching.
 */
export async function handleMissions(request, env, url) {
  const isCollection = url.pathname === COLLECTION;
  const item = ITEM.exec(url.pathname);
  if (!isCollection && !item) return null;

  try {
    if (isCollection) {
      if (request.method === 'GET') {
        const filter = {};
        if (url.searchParams.has('status')) filter.status = url.searchParams.get('status');
        if (url.searchParams.has('slug')) filter.slug = url.searchParams.get('slug');
        return json({ missions: await listMissions(env.DB, filter) });
      }
      if (request.method === 'POST') {
        return json({ mission: await createMission(env.DB, await readJsonObject(request)) }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    const id = Number(item[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: 'no such mission' }, 404);

    if (request.method === 'GET') {
      const mission = await getMission(env.DB, id);
      return mission ? json({ mission }) : json({ error: 'no such mission' }, 404);
    }
    if (request.method === 'PATCH') {
      const mission = await updateMission(env.DB, id, await readJsonObject(request));
      return mission ? json({ mission }) : json({ error: 'no such mission' }, 404);
    }
    if (request.method === 'DELETE') {
      const gone = await deleteMission(env.DB, id);
      return gone
        ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        : json({ error: 'no such mission' }, 404);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return badRequest(error);
    return serverError(error);
  }
}
