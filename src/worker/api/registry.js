/**
 * Making, changing and retiring a project, from the interface.
 *
 * Mounted before `handleProjects` so it claims the mutating verbs on
 * /api/projects while `/api/projects/<slug>/meta` stays where it was.
 *
 * Everything here goes through the same validator the committed file is held
 * to. There is no second, laxer rulebook for things made in HQ — the only
 * difference is that four keys are refused outright, because they are the
 * ones that decide what this Worker fetches and what the Mac runs.
 */
import { ValidationError } from '../db.js';
import { invalidateStatus, probeHttp } from '../status.js';
import * as store from '../registry-store.js';

const SLUG = '([a-z0-9][a-z0-9-]*)';
const ONE = new RegExp(`^/api/projects/${SLUG}(?:/(archive|unarchive|revert|history|restore|discard))?$`);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function body(request) {
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new ValidationError('Send a JSON object', 'body');
  }
}

function failed(error) {
  if (error instanceof ValidationError) {
    const payload = { error: error.message, field: error.field };
    if (error.errors) payload.errors = error.errors;
    if (error.counts) payload.counts = error.counts;
    return json(payload, error.errors ? 422 : 400);
  }
  return json({ error: 'That could not be saved' }, 500);
}

/**
 * @param registry  the merged registry, archived included
 * @param file      the committed file, so an edit knows which layer it writes
 * @param degraded  true when D1 could not be read; every write is refused
 */
export async function handleRegistry(request, env, url, { registry, file, degraded, identity, ctx }) {
  const path = url.pathname;
  const method = request.method;
  const one = path.match(ONE);
  const isCreate = path === '/api/projects' && method === 'POST';
  const isOne = Boolean(one) && method !== 'GET';
  const isHistory = Boolean(one) && one[2] === 'history' && method === 'GET';

  if (!isCreate && !isOne && !isHistory) return null;

  // A write against a registry we could not read would be a write against a
  // guess. Refuse it in words the owner can act on.
  if (degraded) {
    return json({ error: 'The project list is unavailable right now, so nothing can be changed. Try again in a moment.' }, 503);
  }

  const actor = identity?.email ?? 'local';

  try {
    if (isCreate) {
      const made = await store.createProject(env.DB, await body(request), registry, { actor });
      await invalidateStatus(env, ctx);
      // Check the address once, now, so the card is not Unknown for five
      // minutes. A failing check never refuses the save: a client whose site
      // does not exist yet is the commonest reason to make a project at all.
      let probe = null;
      if (made.status?.probe === 'http' && made.status?.url) {
        probe = await probeHttp(made.status.url, made.status).catch(() => null);
      } else if (made.status?.probe === 'http' && made.links?.live?.url) {
        probe = await probeHttp(made.links.live.url, made.status).catch(() => null);
      }
      return json({ project: made, probe }, 201);
    }

    const slug = one[1];
    const action = one[2];

    if (!action && method === 'PATCH') {
      const patch = await body(request);
      const expect = request.headers.get('If-Unmodified-Since-Updated-At') || patch.expect_updated_at || null;
      delete patch.expect_updated_at;
      const saved = await store.updateProject(env.DB, slug, patch, { file, existing: registry, actor, expectUpdatedAt: expect });
      await invalidateStatus(env, ctx);
      return json({ project: saved });
    }

    if (!action && method === 'DELETE') {
      await store.discardProject(env.DB, slug, { file, actor });
      await invalidateStatus(env, ctx);
      return json({ discarded: slug });
    }

    if (action === 'archive' && method === 'POST') {
      const out = await store.setArchived(env.DB, slug, true, { existing: registry, actor });
      await invalidateStatus(env, ctx);
      return json(out);
    }

    if (action === 'unarchive' && method === 'POST') {
      const out = await store.setArchived(env.DB, slug, false, { existing: registry, actor });
      await invalidateStatus(env, ctx);
      return json(out);
    }

    if (action === 'revert' && method === 'POST') {
      const done = await store.revertProject(env.DB, slug, { file, actor });
      await invalidateStatus(env, ctx);
      return json({ reverted: done });
    }

    if (action === 'restore' && method === 'POST') {
      const { version } = await body(request);
      const entry = await store.restoreVersion(env.DB, slug, version, { actor });
      await invalidateStatus(env, ctx);
      return json({ project: entry });
    }

    if (isHistory) {
      const [versions, events] = await Promise.all([
        store.listVersions(env.DB, slug),
        store.listEvents(env.DB, slug),
      ]);
      return json({ versions, events });
    }

    return json({ error: 'Not found or action unavailable' }, 404);
  } catch (error) {
    return failed(error);
  }
}
