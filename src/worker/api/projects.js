import { getProjectMeta, saveProjectMeta, getOverview, ValidationError } from '../db.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export async function handleProjects(request, env, url, slugs) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/meta$/);
  if (!match && url.pathname !== '/api/overview') return null;
  try {
    if (!match) return request.method === 'GET' ? json(await getOverview(env.DB)) : json({ error: 'Method not allowed' }, 405);
    const slug = match[1];
    if (!slugs.has(slug)) return json({ error: 'No such project' }, 404);
    if (request.method === 'GET') return json({ meta: await getProjectMeta(env.DB, slug) });
    if (request.method === 'PUT') {
      let input;
      try { input = await request.json(); } catch { throw new ValidationError('Expected JSON'); }
      return json({ meta: await saveProjectMeta(env.DB, slug, input) });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    if (isReadLimit(error)) return readLimitResponse();
    console.error('projects api:', error);
    return json({ error: 'Project data unavailable' }, 500);
  }
}
