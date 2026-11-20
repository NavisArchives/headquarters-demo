// Andy (13 Nov): « respect the template ». The surgeon letter and follow-up
// must stay byte for byte what they were before audit part A (4469d23).
// One change since, Andy's own (16 Nov 2026): the follow-up subject lost its
// « Re: », because it goes out as a new email, never as a reply in the thread.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compose, SECTOR_REFUSAL } from '../src/shared/outreach.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/surgeon-letters-4469d23.json', import.meta.url), 'utf8'));

describe('the surgeon letter', () => {
  for (const [key, expected] of Object.entries(fixture.drafts)) {
    const [which, lang, mode] = key.split('|');
    it(`is byte-identical to 4469d23: ${which}, ${lang}, ${mode}`, () => {
      const out = compose(fixture.rows[which], { lang, mode });
      expect(out.subject).toBe(expected.subject);
      expect(out.body).toBe(expected.body);
    });
  }

  it('is not written to a surgeon in the Netherlands or Switzerland (agency rule)', () => {
    for (const country of ['Netherlands', 'Switzerland']) {
      for (const mode of ['email', 'followup']) {
        const out = compose({ ...fixture.rows.withSite, country, dataset: 'plastic-surgeons-netherlands' }, { lang: 'NL', mode });
        expect(out).toMatchObject({ subject: '', body: '', noDraft: SECTOR_REFUSAL.country });
      }
    }
  });
});
