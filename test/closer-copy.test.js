import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eligibility } from '../src/worker/outreach-policy.js';
import { compose } from '../src/shared/outreach.js';

// Snapshot copied from the approved Python source, never executed by this suite.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/closer-approved.json', import.meta.url), 'utf8'));
const history = { sends: 2, replied: false, lastSentAt: '2026-10-01T12:00:00Z', now: '2026-11-18T15:00:00Z' };
describe('approved closer-3rd copy', () => {
  for (const fixture of fixtures) {
    it(`keeps ${fixture.kind}/${fixture.lang} copy verbatim`, () => {
      const row = { business: fixture.kind === 'B2' ? 'Plastic surgeons' : 'Web design', name: 'Robin Example', country: 'Belgium', languages: [fixture.lang] };
      const result = compose(row, { mode: 'closer', lang: fixture.lang, originalSubject: 'Actual first subject', history });
      expect(result.body).toBe(fixture.body);
      expect(result.subject).toBe('Actual first subject');
      expect(result.template).toBe('closer-3rd');
    });
  }
  it('allows the approved closer after a sector second touch', () => {
    const result = eligibility({ uid: 'demo/a', dataset: 'architects-demo', business: 'Architects', name: 'Demo', email: 'robin@example.com', country: 'BE', languages: ['FR'], sends: 2, stage: 'sent', follow_up: '2026-11-18', last_sent_at: '2026-10-01T12:00:00Z' }, new Date(history.now));
    expect(result.eligible).toBe(true);
    expect(result.step).toBe(3);
  });

  it('holds missing language, missing original subject, replies and the wrong step', () => {
    const row = { business: 'Web design', country: 'Belgium', languages: ['DE'] };
    for (const options of [
      { lang: 'DE', originalSubject: 'Original', history },
      { lang: 'EN', history },
      { lang: 'EN', originalSubject: 'Re: Original', history },
      { lang: 'EN', originalSubject: 'Original', history: { ...history, replied: true } },
      { lang: 'EN', originalSubject: 'Original', history: { ...history, sends: 1 } },
    ]) expect(compose(row, { mode: 'closer', ...options }).noDraft).toBeTruthy();
  });
});
