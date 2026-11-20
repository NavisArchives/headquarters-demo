// The phone tab bar (Liquid Glass, 14 Nov): when it shrinks and when it comes back.
import { describe, it, expect } from 'vitest';
import { compactAfter } from '../src/public/assets/tabbar.js';

describe('the tab bar while a list scrolls', () => {
  it('shrinks on a real scroll down, past the top', () => {
    expect(compactAfter(false, 300, 40)).toBe(true);
  });
  it('comes back on a scroll up, and always near the top', () => {
    expect(compactAfter(true, 300, -40)).toBe(false);
    expect(compactAfter(true, 10, 40)).toBe(false);
  });
  it('ignores a jitter of a few pixels either way', () => {
    expect(compactAfter(true, 300, 5)).toBe(true);
    expect(compactAfter(false, 300, -5)).toBe(false);
  });
});
