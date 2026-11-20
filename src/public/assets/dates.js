// Calendar dates, one way for the whole of HQ (browser and Worker alike).
//
// A bare `YYYY-MM-DD` (a due date, a follow-up, an invoice date) is a day on
// the calendar, not an instant. `new Date('2026-10-01')` reads it as UTC
// midnight, and shown in local time west of UTC that is 30 September: the bug
// Andy met in Lima (Nov 2026). Everything here keeps a bare date a calendar day.

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

/** True for a bare `YYYY-MM-DD`. */
export const isBareDay = (value) => BARE_DAY.test(String(value ?? ''));

/** A Date for a value: a bare day is local midnight of that day; anything else
 *  (a full ISO timestamp, a Date, milliseconds) is that instant. */
export function parseDay(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const text = String(value ?? '');
  if (BARE_DAY.test(text)) {
    const [y, m, d] = text.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(text);
}

/** The calendar day of an instant, as `YYYY-MM-DD`: in `timeZone` when given,
 *  otherwise in the zone this code runs in. A bare day is returned as it is. */
export function dayOf(value = new Date(), timeZone) {
  if (isBareDay(value)) return String(value);
  const date = parseDay(value);
  if (timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole calendar days from day `a` to day `b` (both `YYYY-MM-DD`): positive
 *  when `b` is later. Counted on the calendar, so no zone or DST shifts it. */
export function daysBetween(a, b) {
  const n = (day) => {
    const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 864e5;
  };
  return Math.round(n(b) - n(a));
}

/** A day `n` calendar days after `day` (`YYYY-MM-DD`). */
export function addDays(day, n) {
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + n));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/* ---------- a meeting time on two clocks (audit C14, M7, P5) ---------- */

/** The zones Andy works across: Belgian clients, himself in Lima. */
export const WORK_ZONES = Object.freeze([['Europe/Brussels', 'Brussels'], ['America/Lima', 'Lima']]);
const zoneName = (tz) => WORK_ZONES.find(([z]) => z === tz)?.[1] ?? tz.split('/').pop().replace(/_/g, ' ');

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(utcMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return Math.round((asUtc - utcMs) / 60000);
}

/** « 2026-11-16T18:30 » on `tz`'s clock -> the instant, in ms. */
export function instantOf(wall, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(wall ?? ''));
  if (!m || !tz) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - offsetMinutes(guess, tz) * 60000;
  t = guess - offsetMinutes(t, tz) * 60000; // once more, across a DST change
  return t;
}

/** « 18:30 Brussels · 12:30 Lima » for a time set on `tz`'s clock; the bare
 *  « 18:30 » when no zone was recorded (deals from before 0030). */
export function zoneTimes(wall, tz) {
  const time = /T(\d{2}:\d{2})/.exec(String(wall ?? ''))?.[1];
  if (!time) return '';
  const t = tz ? instantOf(String(wall).slice(0, 16), tz) : null;
  if (t === null) return time;
  const at = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  const zones = [tz, ...WORK_ZONES.map(([z]) => z).filter((z) => z !== tz)];
  return zones.map((z) => `${at(z)} ${zoneName(z)}`).join(' · ');
}
