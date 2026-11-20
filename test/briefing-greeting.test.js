// The briefing greets by the clock and says which day it speaks for (audit C12, M5).
import { describe, it, expect } from 'vitest';
import { installDom } from './dom-shim.js';

installDom();
const { greetingFor, briefingDateLine } = await import('../src/public/assets/briefing.js');

describe('the briefing greeting', () => {
  it('follows the hour on the device', () => {
    expect(greetingFor(new Date(2026, 10, 13, 7, 0))).toBe('Good morning');
    expect(greetingFor(new Date(2026, 10, 13, 14, 0))).toBe('Good afternoon');
    expect(greetingFor(new Date(2026, 10, 13, 20, 40))).toBe('Good evening'); // the audit's 20:40 in Lima
  });

  it('names today, and says so when the written notes are older', () => {
    const now = new Date(2026, 10, 13, 9, 0);
    expect(briefingDateLine('2026-11-13', now)).toBe('Friday 13 November');
    expect(briefingDateLine(null, now)).toBe('Friday 13 November');
    expect(briefingDateLine('2026-10-23', now)).toBe('Friday 13 November · the written notes are from 23 October');
  });
});
