// Talk while you click (Andy, 13 Nov): the pure parts of a review session.
import { describe, it, expect } from 'vitest';
import { clockText, spokenCode, sessionFile, sessionFileName, assignSegments } from '../src/public/assets/cull-session.js';

describe('a review session', () => {
  it('shows the clock and says the code letter by letter', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(75_000)).toBe('01:15');
    expect(clockText(3_725_000)).toBe('1:02:05');
    expect(spokenCode('b9')).toBe('B 9');
  });

  it('puts each piece of speech on the card that was open', () => {
    const events = [{ code: 'B1', uid: 'x/a', name: 'A', atMs: 1000 }, { code: 'B2', uid: 'x/b', name: 'B', atMs: 9000 }];
    const segments = [
      { fromMs: 0, text: 'starting now' },
      { fromMs: 1500, text: 'menu breaks on the phone' },
      { fromMs: 5000, text: 'copyright 2014' },
      { fromMs: 9000, text: 'B 2. looks fine' },
    ];
    expect(assignSegments(events, segments)).toEqual({
      before: 'starting now',
      cards: [
        { code: 'B1', uid: 'x/a', name: 'A', atMs: 1000, text: 'menu breaks on the phone copyright 2014' },
        { code: 'B2', uid: 'x/b', name: 'B', atMs: 9000, text: 'looks fine' },
      ],
    });
  });

  it('writes one file with the click times and the audio, and nothing else about the leads', () => {
    const f = sessionFile({ startedAt: 1, endedAt: 2, reviewer: 'Shara', events: [{ code: 'B1', uid: 'x/a', name: 'A', atMs: 5, email: 'no@x' }], mime: 'audio/webm', audioBase64: 'AA' });
    expect(f.events[0]).toEqual({ code: 'B1', uid: 'x/a', name: 'A', atMs: 5 });
    expect(f).toMatchObject({ kind: 'hq-review', reviewer: 'Shara', audio: { mime: 'audio/webm', base64: 'AA' } });
    expect(sessionFileName(new Date(2026, 10, 13, 15, 20).getTime(), [{ code: 'B1' }, { code: 'B40' }])).toBe('Review 2026-11-13 15h20 B1-B40.json');
  });
});
