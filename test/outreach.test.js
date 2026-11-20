import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as outreachModule from '../src/shared/outreach.js';
import { langsFor, segmentFor, SEGMENT_LABEL, DEFAULT_PROFILE, compose, hasSite, isSurgeonLead, NO_SECTOR_COPY } from '../src/shared/outreach.js';

function row(overrides) {
  return Object.assign({
    name: 'Test Brand',
    website: 'https://example.com',
    category: 'Beauty',
    country: 'Belgium',
    languages: ['NL', 'FR', 'EN'],
    business: 'UGC'
  }, overrides);
}

describe('langsFor', () => {
  it('puts NL first for a Dutch-speaking lead in Belgium', () => {
    expect(langsFor(row({ languages: ['NL', 'FR'], country: 'Belgium' }))[0]).toBe('NL');
  });

  it('puts NL first for a Dutch-speaking lead in the Netherlands', () => {
    expect(langsFor(row({ languages: ['NL', 'EN'], country: 'Netherlands' }))[0]).toBe('NL');
  });

  it('puts FR first for a French-speaking lead in France', () => {
    expect(langsFor(row({ languages: ['FR', 'EN'], country: 'France' }))[0]).toBe('FR');
  });

  it('puts FR first for a French-speaking lead in Belgium', () => {
    expect(langsFor(row({ languages: ['FR'], country: 'Belgium' }))[0]).toBe('FR');
  });

  it('falls back to EN when nothing matches', () => {
    expect(langsFor(row({ languages: ['DE'], country: 'Germany' }))).toEqual(['EN']);
  });

  it('falls back to EN when the lead has no languages at all', () => {
    expect(langsFor(row({ languages: [], country: 'Germany' }))).toEqual(['EN']);
  });

  it('encodes the exact ordering: write-language first, then EN, FR, NL in that fixed order', () => {
    // NL wins the "write it in" slot (Netherlands), then the fixed EN,FR,NL sweep
    // appends whatever else the lead has, skipping what's already placed.
    expect(langsFor(row({ languages: ['EN', 'NL', 'FR'], country: 'Netherlands' })))
      .toEqual(['NL', 'EN', 'FR']);
  });

  it('does not put FR first for a French speaker outside the FR countries', () => {
    // FR is spoken but the country isn't in the FR_COUNTRIES list, and it isn't
    // NL either — so the fixed EN,FR,NL sweep decides the order, EN first.
    expect(langsFor(row({ languages: ['FR', 'EN'], country: 'Germany' })))
      .toEqual(['EN', 'FR']);
  });

  it('places NL before FR when a lead in Belgium speaks both', () => {
    expect(langsFor(row({ languages: ['FR', 'NL'], country: 'Belgium' })))
      .toEqual(['NL', 'FR']);
  });
});

describe('segmentFor', () => {
  it('maps business "Web design" to webdesign regardless of category', () => {
    expect(segmentFor(row({ business: 'Web design', category: 'Anything' }))).toBe('webdesign');
  });

  it('maps a category containing "agency" to agency', () => {
    expect(segmentFor(row({ category: 'Talent Agency' }))).toBe('agency');
  });

  it('maps a category containing "platform" to agency', () => {
    expect(segmentFor(row({ category: 'Creator Platform' }))).toBe('agency');
  });

  it('maps a category containing "community" to source', () => {
    expect(segmentFor(row({ category: 'Online Community' }))).toBe('source');
  });

  it('maps a category containing "source" to source', () => {
    expect(segmentFor(row({ category: 'Resource / Source Hub' }))).toBe('source');
  });

  it('maps beauty, food and tech categories to their own segments', () => {
    expect(segmentFor(row({ category: 'Beauty Brand' }))).toBe('beauty');
    expect(segmentFor(row({ category: 'Food & Drink' }))).toBe('food');
    expect(segmentFor(row({ category: 'Tech Startup' }))).toBe('tech');
  });

  it('maps everything else to brand', () => {
    expect(segmentFor(row({ category: 'Fashion Retailer' }))).toBe('brand');
  });

  it('has a label for every segment SEGMENT_LABEL exposes', () => {
    expect(SEGMENT_LABEL.source).toMatch(/not an outreach target/i);
    expect(SEGMENT_LABEL.webdesign).toMatch(/web design/i);
  });
});

describe('DEFAULT_PROFILE', () => {
  it('carries Andy\'s real details as the fallback profile', () => {
    expect(DEFAULT_PROFILE.name).toBe('Andy');
    expect(DEFAULT_PROFILE.portfolio).toMatch(/^https:\/\//);
    expect(DEFAULT_PROFILE.email).toContain('@');
  });
});

describe('compose', () => {
  // A surgeon: the only website lead with a letter of its own (audit A2).
  const webRow = row({
    business: 'Web design',
    dataset: 'plastic-surgeons-belgium',
    category: 'Own practice site',
    country: 'Belgium',
    languages: ['NL', 'FR', 'EN'],
    evidence: 'saw their open creator programme accepting applications'
  });

  // The `{{hook}}` machinery (hookFor) is private and only the older generated
  // website templates ever carried the slot; Realis leads no longer do, and the
  // UGC "soft" templates never did. So the guarantee that survives, and the one
  // these two tests were really protecting, is that a lead's email is written
  // in one language only: no sentence from another language leaks in, and the
  // hook lines (which are sentences in their own language) never appear in a
  // UGC email at all.
  const ugcRow = row({
    business: 'UGC',
    category: 'Beauty Brand',
    country: 'Belgium',
    languages: ['NL', 'FR', 'EN'],
    evidence: 'saw their open creator programme accepting applications'
  });
  const HOOKS = [
    'I came across your creator programme',
    'Ik kwam jullie creator-programma tegen',
    'Je suis tombé sur votre programme créateurs'
  ];

  it('produces an NL UGC body in Dutch only, with no hook sentence from any language', () => {
    const nl = compose(ugcRow, { lang: 'NL', mode: 'email' });
    expect(nl.body).toContain('Ik wil me even kort voorstellen');
    expect(nl.body).not.toContain('I’d like to briefly introduce myself');
    expect(nl.body).not.toContain('Je me permets de me présenter');
    for (const h of HOOKS) expect(nl.body).not.toContain(h);
  });

  it('produces an FR UGC body in French only, with no hook sentence from any language', () => {
    const fr = compose(ugcRow, { lang: 'FR', mode: 'email' });
    expect(fr.body).toContain('Je me permets de me présenter');
    expect(fr.body).not.toContain('I’d like to briefly introduce myself');
    expect(fr.body).not.toContain('Ik wil me even kort voorstellen');
    for (const h of HOOKS) expect(fr.body).not.toContain(h);
  });

  // O2 (audit, 13 Nov): the « why them » line has its own paragraph in Andy's letter.
  it('puts the line typed for this lead in its own paragraph, after the introduction', () => {
    const out = compose(webRow, { lang: 'EN', mode: 'email', hook: 'Your rhinoplasty page reads beautifully.' });
    const paras = out.body.split('\n\n');
    const at = paras.indexOf('Your rhinoplasty page reads beautifully.');
    expect(at).toBeGreaterThan(0);
    expect(paras[at - 1]).toContain('Realis Studio');
    expect(paras[at + 1]).toContain('Marc Aubin');
  });

  it('uses only the line Andy typed: never the lead\'s openingLine, never a generic hook', () => {
    const research = compose({ ...webRow, openingLine: { fr: 'Votre page sur la rhinoplastie est très claire.' } }, { lang: 'FR', mode: 'email' });
    expect(research.body).not.toContain('Votre page sur la rhinoplastie');
    const none = compose(webRow, { lang: 'EN', mode: 'email' });
    expect(none.body).not.toMatch(/creator programme|\{\{|\n\n\n/);
    expect(none.body.split('\n\n').every((p) => p.trim())).toBe(true);
    // With an openingLine and no typed line, the letter is the same as with neither.
    expect(compose({ ...webRow, openingLine: { en: 'A research line.' } }, { lang: 'EN', mode: 'email' })).toEqual(none);
  });

  it('produces subject and body in the requested language', () => {
    const nl = compose(webRow, { lang: 'NL', mode: 'email' });
    expect(nl.subject).toContain('Ter attentie van Dr');
    const fr = compose(webRow, { lang: 'FR', mode: 'email' });
    expect(fr.subject).toContain('attention du Dr');
  });

  it('dm mode is shorter than email mode for the same lead', () => {
    const email = compose(webRow, { lang: 'EN', mode: 'email' });
    const dm = compose(webRow, { lang: 'EN', mode: 'dm' });
    expect(dm.body.length).toBeLessThan(email.body.length);
  });

  it('dm mode has no subject', () => {
    const dm = compose(webRow, { lang: 'EN', mode: 'dm' });
    expect(dm.subject).toBe('');
  });

  it('followup mode produces different text from email mode', () => {
    const email = compose(webRow, { lang: 'EN', mode: 'email' });
    const followup = compose(webRow, { lang: 'EN', mode: 'followup' });
    expect(followup.body).not.toBe(email.body);
    // Same subject as the first email, never a fake « Re: » (Andy, 16 Nov 2026):
    // HQ's follow-ups go out as new emails, not as replies in the first thread.
    expect(followup.subject).toBe(email.subject);
    expect(followup.subject).not.toMatch(/^\s*re\s*:/i);
  });

  it('returns a saved draft rather than the template', () => {
    const savedDraft = { subject: 'Hand-edited subject', body: 'Hi there,\n\nThis is my own hand-written note.\n\nBest,\nAndy', toName: '' };
    const result = compose(webRow, { lang: 'EN', mode: 'email', draft: savedDraft });
    expect(result.subject).toBe('Hand-edited subject');
    expect(result.body).toContain('This is my own hand-written note.');
    // must not have recomputed the template body
    const template = compose(webRow, { lang: 'EN', mode: 'email' });
    expect(result.body).not.toBe(template.body);
  });

  it('upgrades a bare greeting in a saved draft when a name is now known, without touching the rest', () => {
    const savedDraft = { subject: 'Subj', body: 'Hi there,\n\nBody text unchanged.', toName: 'Jamie' };
    const result = compose(webRow, { lang: 'EN', mode: 'email', draft: savedDraft });
    expect(result.body).toContain('Hi Jamie');
    expect(result.body).toContain('Body text unchanged.');
    expect(result.toName).toBe('Jamie');
  });

  it('falls back to the lead\'s own name when no draft name was set', () => {
    const result = compose(webRow, { lang: 'EN', mode: 'email' });
    expect(result.toName).toBe(webRow.name);
  });

  it('accepts a partial profile and fills the rest from DEFAULT_PROFILE (UGC, where the profile signs the mail)', () => {
    const ugcLead = row({ business: 'UGC', category: 'Beauty Brand', languages: ['EN'] });
    const result = compose(ugcLead, { lang: 'EN', mode: 'email', profile: { name: 'Someone Else' } });
    expect(result.body).toContain(DEFAULT_PROFILE.phone);
    // The UGC sign-off uses the first name only.
    expect(result.body.endsWith('Someone\nandyssarchives\n' + DEFAULT_PROFILE.phone + '\nNL \u00b7 FR \u00b7 EN')).toBe(true);
    expect(result.body).not.toContain('Andy\nandyssarchives');
  });

  it('never lets the profile reach a Realis body: it carries the studio, not the person\'s name', () => {
    const result = compose(webRow, { lang: 'EN', mode: 'email', profile: { name: 'Someone Else', phone: '+99 999' } });
    expect(result.body).not.toContain('Someone Else');
    expect(result.body).not.toContain('+99 999');
    expect(result.body).not.toContain('+32 400 00 00 00');
  });

  it('defaults to the first language langsFor would pick when none is given', () => {
    const noLang = compose(webRow, { mode: 'email' });
    const explicit = compose(webRow, { lang: langsFor(webRow)[0], mode: 'email' });
    expect(noLang.subject).toBe(explicit.subject);
  });
});

describe('French typographic non-breaking spaces', () => {
  // French convention puts U+00A0 (NBSP) before : ; ? ! and inside « » quotes.
  // The owner's original leads/assets/outreach.js has 17 of them across the FR
  // template strings (HOOK.FR.blank, INTRO.FR, CLOSE.FR, CLOSE_AGENCY.FR,
  // CLOSE_WEB.FR, WHY.FR.{beauty,tech,food,agency,webdesign}, DM.FR). A plain
  // space there is a silent edit to the owner's tuned French prose, even though
  // it reads the same to a skim. Pin the count so a future "helpful" formatter
  // normalising whitespace fails loudly instead of silently.
  const ORIGINAL_PATH = new URL('../../leads/assets/outreach.js', import.meta.url);
  // 17 — counted directly from leads/assets/outreach.js (see ORIGINAL_PATH above)
  // at the time this port was made. Hardcoded here so the test still pins the
  // rule when that sibling checkout isn't present (e.g. in CI).
  const FALLBACK_COUNT = 17;

  it('has as many NBSP characters as the original template source', () => {
    const portSrc = readFileSync(new URL('../src/shared/outreach.js', import.meta.url), 'utf8');
    const portCount = (portSrc.match(/ /g) || []).length;

    let expectedCount = FALLBACK_COUNT;
    if (existsSync(ORIGINAL_PATH)) {
      const originalSrc = readFileSync(ORIGINAL_PATH, 'utf8');
      expectedCount = (originalSrc.match(/ /g) || []).length;
    }

    expect(portCount).toBe(expectedCount);
  });
});

describe('two brands, never mixed', () => {
  const { BRANDS, brandFor, profileFor } = outreachModule;
  const web = row({ business: 'Web design', dataset: 'plastic-surgeons-belgium', name: 'Studio X', country: 'Belgium', languages: ['FR', 'NL', 'EN'] });
  const ugc = row({ business: 'UGC', name: 'Glow Co', category: 'Beauty Brand', country: 'Belgium', languages: ['NL', 'EN'] });

  it('routes website leads to Realis Studio and UGC to andyssarchives', () => {
    expect(brandFor(web)).toBe(BRANDS.realis);
    expect(brandFor(ugc)).toBe(BRANDS.archive);
    // The plastic-surgeon and architect lists are website prospects too.
    expect(brandFor(row({ business: 'Plastic surgeons', name: 'Dr X' }))).toBe(BRANDS.realis);
    expect(segmentFor(row({ business: 'Plastic surgeons', name: 'Dr X', category: 'Clinics' }))).toBe('webdesign');
    expect(compose(row({ business: 'Plastic surgeons', name: 'Dr X', country: 'Luxembourg', languages: ['FR'] }), { lang: 'FR' }).body).toContain('Realis Studio');
    expect(compose(row({ business: 'Plastic surgeons', name: 'Dr X', country: 'Luxembourg', languages: ['FR'] }), { lang: 'FR' }).body).not.toMatch(/UGC|Fieldnote/);
    expect(BRANDS.realis.email).toBe('hello@realisstudio.com');
    expect(BRANDS.archive.email).toBe('contact@andyssarchives.com');
  });

  it('a saved profile cannot override the brand identity, only the person', () => {
    const p = profileFor(web, { name: 'Andy', phone: '+32 1', studio: 'Wrong', email: 'wrong@x', portfolio: 'https://wrong' });
    expect(p.studio).toBe('Realis Studio');
    expect(p.email).toBe('hello@realisstudio.com');
    expect(p.portfolio).toBe('https://realisstudio.com');
    expect(p.phone).toBe('+32 1');
  });

  const PERSONAL = /andyssarchives|contact@andyssarchives\.com|@fieldnote.studio|fieldnote.studio|creator|travel|voyag|gereisd|reis(?:de|d)?\b|UGC|Huizenga/i;
  const PHONE = '+32 400 00 00 00';
  const CITY = { EN: 'Brussels', FR: 'Bruxelles', NL: 'Brussel' };
  // Andy's French and Dutch first emails end with his full four-line sign-off;
  // English, and every follow-up, keep the three-line one.
  const LETTER_END = { EN: 'Kind regards,\n\nAndy\nRealis Studio, Brussels\nhttps://realisstudio.com', FR: 'Bien cordialement,\n\nAndy\nRealis Studio, Bruxelles\nhttps://realisstudio.com', NL: 'Met vriendelijke groeten,\n\nAndy\nRealis Studio, Brussel\nhttps://realisstudio.com' };

  for (const lang of ['EN', 'FR', 'NL']) {
    for (const mode of ['email', 'dm', 'followup']) {
      it(`Realis ${mode} in ${lang} carries the studio and nothing personal`, () => {
        const out = compose(web, { lang, mode });
        const text = `${out.subject}\n${out.body}`;
        expect(text).toContain('Realis Studio');
        expect(text).not.toMatch(PERSONAL);
        if (mode === 'email' || mode === 'followup') {
          // Andy's own voice for both the first email and the nudge: hardcoded
          // studio, city sign-off, no phone. The studio address is deliberately
          // absent; the mail is sent from it.
          expect(out.body.endsWith((mode === 'email' || mode === 'followup') && LETTER_END[lang]
            ? LETTER_END[lang] : `Andy\nRealis Studio\n${CITY[lang]}`)).toBe(true);
          expect(out.body).not.toContain(PHONE);
          expect(out.body).not.toContain('hello@realisstudio.com');
        }
        expect(text).not.toMatch(/Belgium|Belgique|Belgi\u00eb/);
      });
    }
  }

  // The templates now hardcode the brand, so the guarantee is stronger than
  // "the profile is overridden": whatever profile, list or evidence a lead
  // carries, and whichever variant it gets, the personal brand cannot appear.
  for (const lang of ['EN', 'FR', 'NL']) {
    for (const variant of ['no site', 'has site']) {
      it(`Realis ${variant} email in ${lang} never carries the personal brand, whatever the profile`, () => {
        const lead = row({
          business: 'Plastic surgeons', name: 'Dr X', country: 'Belgium', languages: [lang],
          category: variant === 'no site' ? 'No site' : 'Clinics',
          evidence: 'saw their open creator programme accepting applications',
        });
        const profile = { name: 'Andy', studio: 'andyssarchives', email: 'contact@andyssarchives.com',
          portfolio: 'https://andyssarchives.com', social: '@fieldnote.studio', phone: PHONE };
        for (const p of [undefined, profile, DEFAULT_PROFILE]) {
          const out = compose(lead, { lang, mode: 'email', profile: p });
          const text = `${out.subject}\n${out.body}`;
          expect(text).not.toMatch(PERSONAL);
          expect(text).toContain('Realis Studio');
          expect(text).not.toContain(PHONE);
          expect(out.body.endsWith(LETTER_END[lang] || `Andy\nRealis Studio\n${CITY[lang]}`)).toBe(true);
        }
      });
    }
  }

  it('Realis email says what the studio is for', () => {
    const en = compose(web, { lang: 'EN' }).body;
    expect(en).toMatch(/websites and digital tools for plastic surgeons and aesthetic medicine professionals/);
    expect(en).not.toMatch(/architects and plastic surgeons/);
  });

  it('UGC email stays andyssarchives, signed with the contact@ address', () => {
    const out = compose(ugc, { lang: 'EN' });
    expect(out.body).toContain('andyssarchives');
    expect(out.body).toContain('https://ugc.andyssarchives.com');
    expect(out.body).not.toContain('Realis');
  });
});

/* 238 of the 326 plastic surgeons on the list have no website at all — the
   register entry is the only thing online. Until this suite existed, every
   one of them was told "I came across your website". */
describe('a website prospect who has no website', () => {
  const noSite = (overrides) => row(Object.assign({
    business: 'Plastic surgeons',
    name: 'Dr A',
    category: 'No site',
    city: 'LA LOUVIERE',
    country: 'Belgium',
    languages: ['FR'],
    extra: { Need: 'no website' },
  }, overrides));

  it('knows the difference between having a site and not', () => {
    expect(hasSite(noSite())).toBe(false);
    expect(hasSite(noSite({ category: 'Clinics', extra: { Need: 'no website' } }))).toBe(false);
    expect(hasSite(noSite({ category: 'Clinics', extra: { Need: 'dated site' } }))).toBe(true);
    expect(hasSite(row({ business: 'Web design', category: 'Professional', extra: {} }))).toBe(true);
  });

  for (const lang of ['EN', 'FR', 'NL']) {
    it(`never claims to have seen their site, in ${lang}`, () => {
      const out = compose(noSite({ languages: [lang === 'EN' ? 'EN' : lang] }), { lang });
      const text = `${out.subject}\n${out.body}`;
      expect(text).not.toMatch(/came across your website|tomb\u00e9 sur votre site|kwam uw website tegen|kwam jullie website tegen/i);
      expect(text).not.toMatch(/rebuilt|reconstruite|opnieuw opgebouwd/i);
      expect(text).toContain('Realis Studio');
      expect(text).not.toMatch(/andyssarchives|Belgium|Belgique|Belgi\u00eb|travel|voyag|UGC/i);
    });
  }

  it('never prints the register\'s capitals for the town', () => {
    // The template no longer mentions the town at all; what matters is that
    // the register's upper-case spelling can never reach the recipient.
    for (const lang of ['FR', 'EN', 'NL']) {
      const out = compose(noSite({ languages: [lang] }), { lang });
      expect(`${out.subject}\n${out.body}`).not.toContain('LA LOUVIERE');
    }
  });

  it('says nothing about a town when the register gave none', () => {
    const body = compose(noSite({ city: '' }), { lang: 'FR' }).body;
    expect(body).not.toMatch(/Quelqu'un \u00e0\s/);
    expect(body).not.toContain('{{town}}');
    expect(body).toContain('Realis Studio');
  });

  it('offers a first site rather than a redesign', () => {
    expect(compose(noSite(), { lang: 'EN' }).subject).toBe('For the attention of Dr A');
    expect(compose(noSite({ languages: ['NL'] }), { lang: 'NL' }).subject).toBe('Ter attentie van Dr A');
    expect(compose(noSite(), { lang: 'FR' }).subject).toBe('\u00c0 l\u2019attention du Dr A');
  });

  it('quotes the real subject in a follow-up, never the person\u2019s name', () => {
    const first = compose(noSite(), { lang: 'FR' });
    const nudge = compose(noSite(), { lang: 'FR', mode: 'followup' });
    expect(nudge.subject).toBe(first.subject);
    // The French subject names the doctor on purpose; the nudge just quotes it.
  });

  it('a prospect who does have a site keeps the rebuild pitch', () => {
    const dated = noSite({ category: 'Clinics', extra: { Need: 'dated site' }, languages: ['NL'] });
    expect(compose(dated, { lang: 'NL' }).subject).toBe('Ter attentie van Dr A');
    expect(compose(dated, { lang: 'NL' }).body).toMatch(/bestaande website te vernieuwen/);
  });
});

/* Andy's own Realis templates (30 September 2026): two variants x three
   languages, sent verbatim. */
describe('Realis templates: subject, opening and sign-off per language and variant', () => {
  const LEAD = { business: 'Plastic surgeons', name: 'Dr Y', country: 'Belgium' };
  const noSiteLead = (lang) => row({ ...LEAD, languages: [lang], category: 'No site' });
  const hasSiteLead = (lang) => row({ ...LEAD, languages: [lang], category: 'Clinics' });

  const SUBJECT = {
    FR: { no: '\u00c0 l\u2019attention du Dr Y', has: '\u00c0 l\u2019attention du Dr Y' },
    NL: { no: 'Ter attentie van Dr Y', has: 'Ter attentie van Dr Y' },
    EN: { no: 'For the attention of Dr Y', has: 'For the attention of Dr Y' },
  };
  const OPENING = {
    // FR and NL are one letter for both cases; only the subject tells them apart.
    FR: { no: /^Bonjour Docteur Y,/, has: /^Bonjour Docteur Y,/ },
    NL: { no: /^Beste dokter Y,/, has: /^Beste dokter Y,/ },
    EN: { no: /^Dear Dr Y,/, has: /^Dear Dr Y,/ },
  };
  const SIGNOFF = {
    FR: 'Bien \u00e0 vous,\nAndy\nRealis Studio\nBruxelles',
    NL: 'Met vriendelijke groet,\nAndy\nRealis Studio\nBrussel',
    EN: 'Kind regards,\nAndy\nRealis Studio\nBrussels',
  };

  for (const lang of ['FR', 'NL', 'EN']) {
    for (const variant of ['no', 'has']) {
      const lead = variant === 'no' ? noSiteLead(lang) : hasSiteLead(lang);

      it(`${lang} / ${variant === 'no' ? 'no website' : 'has website'}: subject and opening`, () => {
        const out = compose(lead, { lang, mode: 'email' });
        expect(out.subject).toBe(SUBJECT[lang][variant]);
        expect(out.body).toMatch(OPENING[lang][variant]);
        // and never the other variant's opening
      });

      it(`${lang} / ${variant === 'no' ? 'no website' : 'has website'}: ends with the sign-off, carries the example and no phone, no stray tokens`, () => {
        const out = compose(lead, { lang, mode: 'email' });
        const signoff = { EN: 'Kind regards,\n\nAndy\nRealis Studio, Brussels\nhttps://realisstudio.com', FR: 'Bien cordialement,\n\nAndy\nRealis Studio, Bruxelles\nhttps://realisstudio.com', NL: 'Met vriendelijke groeten,\n\nAndy\nRealis Studio, Brussel\nhttps://realisstudio.com' }[lang] || SIGNOFF[lang];
        expect(out.body.endsWith(signoff)).toBe(true);
        expect(out.body).toContain('https://www.docteuraubin.example');
        expect(out.body).not.toContain('+32 400 00 00 00');
        expect(out.body).toContain('Realis Studio');
        expect(`${out.subject}\n${out.body}`).not.toContain('{{');
        expect(out.body).not.toMatch(/\[[^\]]{10,}\]/);
      });
    }
  }

  it('picks the variant from the Need field as well as the category', () => {
    const lead = row({ ...LEAD, languages: ['EN'], category: 'Clinics', extra: { Need: 'no website' } });
    expect(compose(lead, { lang: 'EN' }).subject).toBe(SUBJECT.EN.no);
  });

  it('greets by the lead\'s name', () => {
    expect(compose(hasSiteLead('EN'), { lang: 'EN' }).body.startsWith('Dear Dr Y,')).toBe(true);
    expect(compose(hasSiteLead('FR'), { lang: 'FR' }).body.startsWith('Bonjour Docteur Y,')).toBe(true);
    expect(compose(hasSiteLead('NL'), { lang: 'NL' }).body.startsWith('Beste dokter Y,')).toBe(true);
  });
});

describe('the Dr letter goes to surgeons only (audit A2)', () => {
  // Architects and local businesses have their own copy since 13 Nov (test/sector-copy.test.js); a clinic still has none.
  const architect = row({ business: 'Clinics', dataset: 'clinics-belgium', name: 'Centre Médical Nord', category: 'Medical centre', languages: ['FR', 'NL', 'EN'] });
  const lawFirm = row({ business: 'Web design', dataset: 'law-firms-be', name: 'Cabinet X', category: 'Law firm', languages: ['FR'] });

  it('knows a surgeon by the list or the business', () => {
    expect(isSurgeonLead(row({ business: 'Web design', dataset: 'plastic-surgeons-belgium' }))).toBe(true);
    expect(isSurgeonLead(row({ business: 'Plastic surgeons' }))).toBe(true);
    expect(isSurgeonLead(architect)).toBe(false);
    expect(isSurgeonLead(row({ business: 'Web design', dataset: 'plastic-surgeons-fake-prefix-x' }))).toBe(true);
    expect(isSurgeonLead(row({ business: 'Web design', dataset: 'not-plastic-surgeons' }))).toBe(false);
  });

  for (const lead of [architect, lawFirm]) {
    for (const mode of ['email', 'followup']) {
      it(`gives ${lead.name} no ${mode} draft, and says why`, () => {
        for (const lang of ['FR', 'NL', 'EN']) {
          const out = compose(lead, { lang, mode });
          expect(out.subject).toBe('');
          expect(out.body).toBe('');
          expect(out.noDraft).toBe(NO_SECTOR_COPY);
          expect(`${out.subject}${out.body}`).not.toMatch(/\bDr\b|Docteur|dokter/);
        }
      });
    }
  }

  it('keeps a saved draft: Andy\'s own words for that lead', () => {
    const out = compose(architect, { lang: 'FR', mode: 'email', draft: { subject: 'Votre site', body: 'Bonjour,\n\nMon texte.' } });
    expect(out.body).toContain('Mon texte.');
    expect(out.noDraft).toBeUndefined();
  });

  it('still writes the surgeon letter to a surgeon', () => {
    const out = compose(row({ business: 'Plastic surgeons', name: 'Dr Jan Peeters', languages: ['NL'] }), { lang: 'NL', mode: 'email' });
    expect(out.subject).toContain('Ter attentie van Dr');
    expect(out.noDraft).toBeUndefined();
  });
});

describe('no fake « Re: » subjects (Andy, 16 Nov 2026)', () => {
  it('no template subject starts with « Re: »: HQ never sends inside the first thread', () => {
    const source = readFileSync(new URL('../src/shared/outreach.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/subject:\s*["'`]\s*re\s*:/i);
  });
});
