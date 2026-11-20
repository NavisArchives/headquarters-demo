// A bare YYYY-MM-DD is a calendar day in every zone (Andy in Lima, Nov 2026:
// « DUE · 30 September » for a 1 October due date). The same checks run under
// Lima, Brussels and Auckland; nothing pins the zone.
import { describe, it, expect, afterAll } from 'vitest';
import { parseDay, dayOf, daysBetween, addDays } from '../src/public/assets/dates.js';
import { daysSince, relTime, dueReason, formatDay, dayPlus } from '../src/public/assets/leads-lib.js';
import { hqToday, setHqTimeZone, recordMailTimes, patchLeadState } from '../src/worker/db.js';
import { freshDatabase } from './helpers/d1.js';
import { nextWorkingDay } from '../src/worker/intake.js';

const ORIGINAL = process.env.TZ;
afterAll(() => { process.env.TZ = ORIGINAL; setHqTimeZone('Europe/Brussels'); });

const ZONES = ['America/Lima', 'Europe/Brussels', 'Pacific/Auckland'];

describe.each(ZONES)('dates under %s', (zone) => {
  const local = (h) => { process.env.TZ = zone; return new Date(2026, 8, 20, h, 0).getTime(); };

  it('a bare day stays that day, and reads « today » at any local hour', () => {
    for (const hour of [0, 7, 12, 19, 23]) {
      const now = local(hour);
      expect(parseDay('2026-10-01').getDate()).toBe(1);
      expect(dayOf(parseDay('2026-10-01'))).toBe('2026-10-01');
      expect(daysSince('2026-09-20', now)).toBe(0);
      expect(relTime('2026-09-20', now)).toBe('today');
      expect(relTime('2026-09-19', now)).toBe('yesterday');
      expect(dueReason({ stage: 'contacted', followUp: '2026-09-20' }, now)).toBe('follow-up today');
      expect(dueReason({ stage: 'contacted', followUp: '2026-09-21' }, now)).toBe('');
      expect(dayPlus(4, now)).toBe('2026-09-24');
    }
    expect(formatDay('2026-10-01')).toBe('1 Oct');
  });

  it('calendar arithmetic does not move with the zone or DST', () => {
    process.env.TZ = zone;
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2); // across Brussels' DST end
    expect(addDays('2026-09-26', 2)).toBe('2026-09-28');     // across Auckland's DST start
  });
});

describe('the Worker\'s « today » is Andy\'s calendar day', () => {
  it('in Lima the day does not turn at 19:00 (UTC midnight)', () => {
    const utcMidnightPlusOne = new Date(Date.UTC(2026, 10, 4, 1, 0)); // 3 Nov, 20:00 in Lima
    setHqTimeZone('America/Lima');
    expect(hqToday(utcMidnightPlusOne)).toBe('2026-11-03');
    setHqTimeZone('Europe/Brussels');
    expect(hqToday(utcMidnightPlusOne)).toBe('2026-11-04');
    setHqTimeZone('Not/AZone'); // ignored: the last good zone stays
    expect(hqToday(utcMidnightPlusOne)).toBe('2026-11-04');
  });

  it('intake: a new mission at 19:00 and 23:00 in Lima is due the next working day of Lima\'s calendar', () => {
    setHqTimeZone('America/Lima');
    // Tue 3 Nov 19:00 Lima = Wed 00:00 UTC; 23:00 Lima = Wed 04:00 UTC. Due Wednesday 4 Nov, not Thursday.
    expect(nextWorkingDay(new Date(Date.UTC(2026, 10, 4, 0, 0)))).toBe('2026-11-04');
    expect(nextWorkingDay(new Date(Date.UTC(2026, 10, 4, 4, 0)))).toBe('2026-11-04');
    // Fri 6 Nov 19:00 and 23:00 Lima (Saturday in UTC): due Monday 9 Nov, not Tuesday.
    expect(nextWorkingDay(new Date(Date.UTC(2026, 10, 7, 0, 0)))).toBe('2026-11-09');
    expect(nextWorkingDay(new Date(Date.UTC(2026, 10, 7, 4, 0)))).toBe('2026-11-09');
    setHqTimeZone('Europe/Brussels');
  });

  it('a mission made on Thursday 20:00 in Lima is due Friday, not Monday', () => {
    const thursdayEveningLima = new Date(Date.UTC(2026, 10, 6, 1, 0)); // Fri 01:00 UTC = Thu 5 Nov, 20:00 Lima
    setHqTimeZone('America/Lima');
    expect(nextWorkingDay(thursdayEveningLima)).toBe('2026-11-06');
    setHqTimeZone('Europe/Brussels'); // Fri 02:00 in Brussels: due the next Monday
    expect(nextWorkingDay(thursdayEveningLima)).toBe('2026-11-09');
  });

  it('A5 cadence: Tue 3 Nov 20:00 in Lima → follow-up 10 Nov; a second email adds 14 from its own Lima day; Brussels counts from 4 Nov', async () => {
    const tueEveningLima = '2026-11-04T01:00:00Z';   // Tue 3 Nov, 20:00 Lima = Wed 4 Nov, 02:00 Brussels
    const friEveningLima = '2026-11-07T01:00:00Z';   // Fri 6 Nov, 20:00 Lima
    const followUp = async (zone, sends) => {
      const { database, dispose } = await freshDatabase();
      try {
        setHqTimeZone(zone);
        await database.prepare(`INSERT INTO datasets (key, business, title, tier_hot, tier_warm, imported_at)
          VALUES ('d', 'Web design', 'D', 70, 50, '2026-10-01T00:00:00Z')`).run();
        await database.prepare(`INSERT INTO leads (uid, dataset, id, business, name, website, category, country, email, score, tier, payload, imported_at)
          VALUES ('d/a', 'd', 'a', 'Web design', 'A', 'https://example.com', 'Studio', 'BE', 'a@example.com', 80, 'Hot', '{}', '2026-10-01T00:00:00Z')`).run();
        await patchLeadState(database, 'd/a', { stage: 'sent' }, '2026-10-01T09:00:00.000Z');
        const out = [];
        for (const at of sends) {
          // outreach_sent logs one « sent » event per email; the cadence counts them.
          await database.prepare("INSERT INTO lead_events (uid, kind, detail, at) VALUES ('d/a', 'sent', '', ?)").bind(at).run();
          await recordMailTimes(database, 'd/a', { sentAt: at }, hqToday(new Date(at)));
          out.push((await database.prepare("SELECT follow_up FROM lead_state WHERE uid = 'd/a'").first()).follow_up);
        }
        return out;
      } finally { await dispose(); setHqTimeZone('Europe/Brussels'); }
    };
    expect(await followUp('America/Lima', [tueEveningLima, friEveningLima])).toEqual(['2026-11-10', '2026-11-20']);
    expect(await followUp('Europe/Brussels', [tueEveningLima])).toEqual(['2026-11-11']);
  }, 30000);

  it('nextWorkingDay: Fri 6 Nov 20:00 in Lima → Monday 9 Nov, not Tuesday 10 Nov', () => {
    setHqTimeZone('America/Lima');
    expect(nextWorkingDay(new Date('2026-11-07T01:00:00Z'))).toBe('2026-11-09');
    setHqTimeZone('Europe/Brussels');
  });
});
