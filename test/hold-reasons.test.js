import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOLD_LABELS, holdLabel } from '../src/public/assets/hold-reasons.js';

// Every reason the planner can give has one plain label, in full, naming no session or team (NIRMATA H5).
describe('hold reasons', () => {
  const src = ['outreach-policy.js', 'outreach-draft-plan.js', 'outreach-drafts.js'].map((f) => readFileSync(new URL(`../src/worker/${f}`, import.meta.url), 'utf8')).join('\n');
  const codes = [...new Set([...src.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)].map((m) => m[1]))]
    .filter((c) => /^(already|conversation|excluded|history|language|missing|nl|not|personal|recipient|reply|sequence|shared|suppressed|sender|no)_/.test(c) || c === 'suppressed');
  it('labels every code the planner produces', () => {
    for (const code of codes) expect(HOLD_LABELS[code], code).toBeTruthy();
  });
  it('labels are plain words: no underscores, no session names, not cut off', () => {
    for (const label of Object.values(HOLD_LABELS)) {
      expect(label).not.toMatch(/_|MARKETING|NIRMATA|HEADQUARTERS|LEADS|…$/);
      expect(label.length).toBeLessThanOrEqual(60);
    }
    expect(holdLabel('something_new')).toBe('Something new');
  });
});
