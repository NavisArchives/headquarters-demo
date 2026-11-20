/**
 * /api/finance/invoices/<id>/accept — « Accept quote ».
 *
 * GET reads the plan (what would change, and what already has); POST runs
 * the steps that are left and answers with the plan again, all done. Mounted
 * in index.js before finance because it needs what finance does not get: the
 * registry to add the project to, and who is asking.
 */
import { ValidationError } from '../db.js';
import { invalidateStatus } from '../status.js';
import { planAcceptQuote, acceptQuote, publicPlan } from '../accept-quote.js';

const PATH = /^\/api\/finance\/invoices\/([1-9][0-9]{0,9})\/accept$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function isAcceptPath(pathname) {
  return PATH.test(pathname);
}

export async function handleAccept(request, env, url, { registry, degraded, identity, ctx }) {
  const match = url.pathname.match(PATH);
  if (!match) return null;
  const id = Number(match[1]);
  const choose = (from) => ({
    ...(from.slug ? { slug: String(from.slug) } : {}),
    ...(from.name ? { name: String(from.name) } : {}),
    ...(from.parent ? { parent: String(from.parent) } : {}),
  });
  try {
    if (request.method === 'GET') {
      const plan = await planAcceptQuote(env.DB, id, registry, choose(Object.fromEntries(url.searchParams)));
      return plan ? json({ plan: publicPlan(plan) }) : json({ error: 'Not found' }, 404);
    }
    if (request.method === 'POST') {
      if (degraded) return json({ error: 'The project list is unavailable right now, so nothing can be changed. Try again in a moment.' }, 503);
      let input = {};
      try { input = await request.json(); } catch { input = {}; }
      const chosen = choose(input && typeof input === 'object' && !Array.isArray(input) ? input : {});
      const ran = await acceptQuote(env.DB, id, registry, chosen, { actor: identity?.email ?? 'local' });
      if (!ran) return json({ error: 'Not found' }, 404);
      await invalidateStatus(env, ctx);
      // Read again with the project now in the registry: every step shows done.
      const after = await planAcceptQuote(env.DB, id, [...registry, { slug: ran.slug, name: ran.name, kind: 'client', parent: ran.parent }], chosen);
      return json({ done: ran.done, slug: ran.slug, plan: publicPlan(after) });
    }
    return json({ error: 'Method or route not available' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field }, 400);
    console.error('accept quote:', error);
    return json({ error: 'Accept quote could not be completed. Run it again: finished steps are skipped.' }, 500);
  }
}
