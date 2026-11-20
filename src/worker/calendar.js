// The private calendar feed: every open to-do and mission with a deadline, as
// an iCalendar file that Google Calendar subscribes to ("From URL").
//
// Like the Brevo hook, this runs before authenticate(): Google fetches it with
// no cookie. The secret in the path (settings.calendar_feed_token, made from
// HQ's to-do card) is its only gate, so a missing or wrong token answers 404
// like any unknown path. If Cloudflare Access is ever put in front of
// hq.example.com, /cal/* needs a bypass rule there too.
//
// One way only: ticking a to-do off in HQ removes it from the feed. Google
// re-reads a subscribed feed every few hours, so a change can take that long
// to show.

import { calendarItems, storedCalendarToken } from './db.js';

const PATH = /^\/cal\/([0-9a-f]{32,128})\.ics$/;
export const PUBLIC_ORIGIN = 'https://hq.example.com';

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Constant-time string compare, so the token can't be guessed byte by byte. */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 5545 text: backslash, semicolon, comma and newlines escaped. */
export function icsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Lines longer than 75 octets are folded: CRLF and one space, never inside
 *  a UTF-8 character. */
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    // The first line holds 75 octets; each continuation holds 74 after its space.
    if (size + bytes > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const compactDay = (day) => day.replace(/-/g, '');
function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').slice(0, 10))
  && !Number.isNaN(Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`));

/** One all-day event per deadline. */
function event({ uid, day, summary, description, now }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDay(day)}`,
    `DTEND;VALUE=DATE:${compactDay(nextDay(day))}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    `URL:${PUBLIC_ORIGIN}/`,
    // A deadline, not a meeting: the day stays free for booking.
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
}

/** The whole calendar, from what calendarItems() returns. */
export function buildCalendar({ todos = [], missions = [] }, now = Date.now()) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Headquarters//To-dos//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:HQ to-dos',
    'X-WR-CALDESC:Deadlines from Headquarters. Tick them off in HQ.',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const todo of todos) {
    if (!isDay(todo.due)) continue;
    const about = [
      todo.mission_title ? `Mission: ${todo.mission_title}` : null,
      todo.lead_name ? `Lead: ${todo.lead_name}` : null,
      todo.note || null,
      `Tick it off in HQ: ${PUBLIC_ORIGIN}/`,
    ].filter(Boolean).join('\n');
    lines.push(...event({
      uid: `todo-${todo.id}@hq.example.com`, day: String(todo.due).slice(0, 10), summary: todo.title, description: about, now,
    }));
  }
  for (const mission of missions) {
    if (!isDay(mission.due)) continue;
    const about = [mission.detail ? String(mission.detail).split('\n')[0] : null, `In HQ: ${PUBLIC_ORIGIN}/missions`]
      .filter(Boolean).join('\n');
    lines.push(...event({
      uid: `mission-${mission.id}@hq.example.com`, day: String(mission.due).slice(0, 10), summary: `Mission due: ${mission.title}`, description: about, now,
    }));
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** GET /cal/<token>.ics, or null when the path is someone else's. */
export async function handleCalendarFeed(request, env, url) {
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  if (!env.DB) return notFound();
  const token = await storedCalendarToken(env.DB);
  if (!token || !sameToken(match[1], token)) return notFound();
  const body = buildCalendar(await calendarItems(env.DB));
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="hq-todos.ics"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

/** The feed's address for a token. The local HQ hands out the online one:
 *  Google can only fetch what is on the internet. The demo keeps its own. */
export function feedUrl(token, origin, { demo = false } = {}) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return `${local && !demo ? PUBLIC_ORIGIN : origin}/cal/${token}.ics`;
}
