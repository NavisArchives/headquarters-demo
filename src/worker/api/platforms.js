import {
  listPlatforms, getPlatform, createPlatform, updatePlatform, deletePlatform,
} from '../platforms-db.js';
import { ValidationError } from '../db.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/platforms';
const ITEM = /^\/api\/platforms\/([^/]+)$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readJsonObject(request) {
  let body;
  try { body = await request.json(); } catch { throw new ValidationError('body must be valid JSON', 'body'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('body must be a JSON object', 'body');
  return body;
}

/** /api/platforms and /api/platforms/:id. Null when the path is someone else's. */
export async function handlePlatforms(request, env, url) {
  const isCollection = url.pathname === COLLECTION;
  const item = ITEM.exec(url.pathname);
  if (!isCollection && !item) return null;
  try {
    if (isCollection) {
      if (request.method === 'GET') return json({ platforms: await listPlatforms(env.DB) });
      if (request.method === 'POST') return json({ platform: await createPlatform(env.DB, await readJsonObject(request)) }, 201);
      return json({ error: 'method not allowed' }, 405);
    }
    const id = Number(item[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: 'no such platform' }, 404);
    if (request.method === 'GET') {
      const platform = await getPlatform(env.DB, id);
      return platform ? json({ platform }) : json({ error: 'no such platform' }, 404);
    }
    if (request.method === 'PATCH') {
      const platform = await updatePlatform(env.DB, id, await readJsonObject(request));
      return platform ? json({ platform }) : json({ error: 'no such platform' }, 404);
    }
    if (request.method === 'DELETE') {
      return await deletePlatform(env.DB, id)
        ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        : json({ error: 'no such platform' }, 404);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field ?? null }, 400);
    if (isReadLimit(error)) return readLimitResponse();
    console.error('platforms api:', error);
    return json({ error: 'something went wrong' }, 500);
  }
}
