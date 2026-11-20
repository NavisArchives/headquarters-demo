import {
  listTodos, getTodo, createTodo, updateTodo, deleteTodo, calendarToken, ValidationError,
} from '../db.js';
import { feedUrl } from '../calendar.js';
import { isReadLimit, readLimitResponse } from '../d1-limit.js';

const COLLECTION = '/api/todos';
const ITEM = /^\/api\/todos\/([^/]+)$/;
const CALENDAR = '/api/calendar/link';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** A database error can carry fragments of the query. That is for the logs. */
function serverError(error) {
  if (isReadLimit(error)) return readLimitResponse();
  console.error('todos api:', error);
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

/** The address Google Calendar subscribes to, with its links ready. */
function calendarLinks(token, url, demo) {
  const feed = feedUrl(token, url.origin, { demo });
  const webcal = feed.replace(/^https?:/, 'webcal:');
  return {
    url: feed,
    google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
  };
}

/**
 * /api/todos, /api/todos/:id and /api/calendar/link. Returns null when the
 * path belongs to someone else, so the Worker can carry on matching.
 */
export async function handleTodos(request, env, url, { demo = false } = {}) {
  const isCollection = url.pathname === COLLECTION;
  const item = ITEM.exec(url.pathname);
  const isCalendar = url.pathname === CALENDAR;
  if (!isCollection && !item && !isCalendar) return null;

  try {
    if (isCalendar) {
      // GET makes the address on first use; POST makes a new one, and the
      // old address stops working.
      if (request.method === 'GET') return json(calendarLinks(await calendarToken(env.DB), url, demo));
      if (request.method === 'POST') return json(calendarLinks(await calendarToken(env.DB, { reset: true }), url, demo));
      return json({ error: 'method not allowed' }, 405);
    }

    if (isCollection) {
      if (request.method === 'GET') {
        const filter = {};
        if (url.searchParams.get('open') === '1') filter.open = true;
        if (url.searchParams.has('mission')) {
          const mission = Number(url.searchParams.get('mission'));
          if (!Number.isInteger(mission) || mission < 1) return json({ error: 'mission must be a mission id', field: 'mission' }, 400);
          filter.mission_id = mission;
        }
        return json({ todos: await listTodos(env.DB, filter) });
      }
      if (request.method === 'POST') {
        return json({ todo: await createTodo(env.DB, await readJsonObject(request)) }, 201);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    const id = Number(item[1]);
    if (!Number.isInteger(id) || id < 1) return json({ error: 'no such to-do' }, 404);

    if (request.method === 'GET') {
      const todo = await getTodo(env.DB, id);
      return todo ? json({ todo }) : json({ error: 'no such to-do' }, 404);
    }
    if (request.method === 'PATCH') {
      const todo = await updateTodo(env.DB, id, await readJsonObject(request));
      return todo ? json({ todo }) : json({ error: 'no such to-do' }, 404);
    }
    if (request.method === 'DELETE') {
      const gone = await deleteTodo(env.DB, id);
      return gone
        ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        : json({ error: 'no such to-do' }, 404);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    if (error instanceof ValidationError) return json({ error: error.message, field: error.field ?? null }, 400);
    return serverError(error);
  }
}
