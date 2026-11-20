// MARKETING's sector copy, approved by NIRMATA on 13 Nov with four changes
// (REPORTS/2026-11-13-LEADS-sector-copy.md): surgeons keep the Dr letter,
// architects get A, local businesses (web wave) get B, under their guards.
import { describe, it, expect } from 'vitest';
import { compose, sectorOf, SECTOR_REFUSAL, isGenericAddress } from '../src/shared/outreach.js';

const NOW = '2026-11-20T12:00:00.000Z';
const fresh = { replied: false, sends: 0, lastSentAt: null, now: NOW };
const architect = (extra = {}) => ({
  business: 'Architects', dataset: 'architects-belgium', name: 'Atelier Nord', country: 'Belgium',
  email: 'marie.dupont@ateliernord.example', languages: ['FR', 'NL', 'EN'], category: 'Architecture practice', extra: {}, ...extra,
});
const local = (extra = {}) => ({
  business: 'Web design', dataset: 'web-wave-be-lu-fr', name: 'Auto-école Lumière', country: 'France',
  email: 'jean@autoecole-lumiere.example', languages: ['FR', 'NL', 'EN'], category: 'Driving school', extra: { emailType: 'personal' }, ...extra,
});
const HOOK = { FR: "j'ai vu qu'il affiche encore 2015 en bas de page.", NL: 'viel me op dat jullie projecten niet goed naar voren komen.', EN: 'I noticed the contact page shows an error.' };

describe('which copy a lead gets', () => {
  it('sorts the sectors', () => {
    expect(sectorOf(architect())).toBe('architect');
    expect(sectorOf(local())).toBe('local');
    expect(sectorOf({ business: 'Plastic surgeons', dataset: 'plastic-surgeons-belgium' })).toBe('surgeon');
    expect(sectorOf({ business: 'Clinics', dataset: 'clinics-belgium' })).toBeNull();
  });
});

describe('A — architects, first email', () => {
  const expected = {
    FR: { subject: 'Votre site, Atelier Nord', opens: 'Bonjour,\n\nEn parcourant votre site, ', has: "je crée des sites pour les bureaux d'architecture", ends: 'Bien à vous,\nAndy\nRealis Studio' },
    NL: { subject: 'Jullie website, Atelier Nord', opens: 'Beste,\n\nBij een bezoek aan jullie website ', has: 'en dan schrijf ik jullie niet meer.', ends: 'Groeten,\nAndy\nRealis Studio' },
    EN: { subject: 'Your website, Atelier Nord', opens: 'Hello,\n\nLooking at your website, ', has: 'I build websites for architecture offices.', ends: 'Kind regards,\nAndy\nRealis Studio' },
  };
  for (const lang of ['FR', 'NL', 'EN']) {
    it(`writes it in ${lang}, with Andy's line in place`, () => {
      const out = compose(architect(), { lang, mode: 'email', hook: HOOK[lang], history: fresh });
      expect(out.noDraft).toBeUndefined();
      expect(out.subject).toBe(expected[lang].subject);
      expect(out.body.startsWith(expected[lang].opens + HOOK[lang])).toBe(true);
      expect(out.body).toContain(expected[lang].has);
      expect(out.body.endsWith(expected[lang].ends)).toBe(true);
      expect(out.body).not.toMatch(/https?:|\{\{|€|\bDr\b|Docteur|\bAI\b/);
    });
  }
});

describe('A — architects, follow-up', () => {
  const sentLongAgo = { replied: false, sends: 1, lastSentAt: '2026-11-10T09:00:00.000Z', now: NOW };
  for (const [lang, line] of [
    ['FR', 'Je me permets de remonter ce message une seule fois, au cas où il vous aurait échappé.'],
    ['NL', 'Is dat nu een onderwerp voor jullie?'],
    ['EN', 'Just bringing this back up once in case it got buried. No pressure either way.'],
  ]) {
    it(`answers the first email in ${lang}`, () => {
      const first = compose(architect(), { lang, mode: 'email', hook: HOOK[lang], history: fresh });
      const out = compose(architect(), { lang, mode: 'followup', history: sentLongAgo });
      expect(out.subject).toBe(first.subject);
      expect(out.body).toContain(line);
    });
  }
});

describe('B — local businesses, first email', () => {
  const subject = 'Votre site affiche 2015';
  for (const [lang, opens, proof, ends] of [
    ['FR', "Bonjour,\n\nEn parcourant votre site, j'ai remarqué un point : ", "le site d'un bureau d'architectes et celui d'un cabinet médical à Bruxelles", 'Bien à vous,\nAndy\nRealis Studio'],
    ['NL', 'Beste,\n\nBij het doorlopen van uw website viel me iets op: ', 'van een architectenbureau en van een medische praktijk in Brussel', 'Met vriendelijke groet,\nAndy\nRealis Studio'],
    ['EN', 'Hello,\n\nLooking through your website, I noticed one thing: ', 'the site of an architecture office and of a medical practice in Brussels', 'Kind regards,\nAndy\nRealis Studio'],
  ]) {
    it(`writes it in ${lang}, with Andy's subject and line`, () => {
      const out = compose(local(), { lang, mode: 'email', hook: HOOK[lang], subject, history: fresh });
      expect(out.noDraft).toBeUndefined();
      expect(out.subject).toBe(subject);
      expect(out.body.startsWith(opens + HOOK[lang])).toBe(true);
      expect(out.body).toContain(proof);
      expect(out.body.endsWith(ends)).toBe(true);
      expect(out.body).not.toMatch(/https?:|\{\{|€|\bDr\b|\bAI\b/);
    });
  }

  it('names only the architecture office to an osteopath or a spa', () => {
    const out = compose(local({ category: 'Ostéopathe' }), { lang: 'FR', mode: 'email', hook: HOOK.FR, subject, history: fresh });
    expect(out.body).toContain("le site d'un bureau d'architectes à Bruxelles.");
    expect(out.body).not.toContain('cabinet médical');
  });

  it('uses « u » in its Dutch follow-up', () => {
    const out = compose(local(), { lang: 'NL', mode: 'followup', subject: 'Uw site toont 2015', history: { replied: false, sends: 1, lastSentAt: '2026-11-10T09:00:00.000Z', now: NOW } });
    expect(out.subject).toBe('Uw site toont 2015');
    expect(out.body).toContain('Is dat nog een onderwerp voor u?');
    expect(out.body).toContain('en dan schrijf ik u niet meer.');
  });
});

describe('the guards', () => {
  it('writes nothing while Andy\'s line is empty (A and B), and says why', () => {
    for (const lead of [architect(), local()]) {
      const out = compose(lead, { lang: 'FR', mode: 'email', subject: 'x', history: fresh });
      expect(out).toMatchObject({ subject: '', body: '', noDraft: SECTOR_REFUSAL.hook });
    }
  });

  it('writes nothing for a local business without its subject', () => {
    expect(compose(local(), { lang: 'FR', mode: 'email', hook: HOOK.FR, history: fresh }).noDraft).toBe(SECTOR_REFUSAL.subject);
  });

  it('never writes to the Netherlands or Switzerland', () => {
    for (const country of ['Netherlands', 'NL', 'Switzerland', 'CH']) {
      expect(compose(architect({ country }), { lang: 'NL', mode: 'email', hook: HOOK.NL, history: fresh }).noDraft).toBe(SECTOR_REFUSAL.country);
    }
  });

  it('never writes to a generic address', () => {
    expect(isGenericAddress({ email: 'info@ateliernord.example' })).toBe(true);
    expect(isGenericAddress({ email: 'contact2@x.fr' })).toBe(true);
    expect(isGenericAddress({ email: 'marie.dupont@x.be' })).toBe(false);
    expect(isGenericAddress({ email: 'jean@x.fr', extra: { emailType: 'generic' } })).toBe(true);
    expect(compose(local({ extra: { emailType: 'generic' } }), { lang: 'FR', mode: 'email', hook: HOOK.FR, subject: 's', history: fresh }).noDraft).toBe(SECTOR_REFUSAL.generic);
    expect(compose(architect({ email: 'info@ateliernord.example' }), { lang: 'FR', mode: 'email', hook: HOOK.FR, history: fresh }).noDraft).toBe(SECTOR_REFUSAL.generic);
  });

  it('follows up once, at least 7 days on, never after a reply', () => {
    const at = (h) => compose(architect(), { lang: 'FR', mode: 'followup', history: { now: NOW, ...h } }).noDraft;
    expect(at({ replied: true, sends: 1, lastSentAt: '2026-11-01T09:00:00.000Z' })).toBe(SECTOR_REFUSAL.replied);
    expect(at({ replied: false, sends: 2, lastSentAt: '2026-11-01T09:00:00.000Z' })).toBe(SECTOR_REFUSAL.twice);
    expect(at({ replied: false, sends: 1, lastSentAt: '2026-11-15T09:00:00.000Z' })).toBe(SECTOR_REFUSAL.early);
    expect(at({ replied: false, sends: 0, lastSentAt: null })).toBe(SECTOR_REFUSAL.early);
    expect(at({ replied: false, sends: 1, lastSentAt: '2026-11-13T09:00:00.000Z' })).toBeUndefined();
  });

  it('asks a local business follow-up for the first subject', () => {
    const out = compose(local(), { lang: 'FR', mode: 'followup', history: { replied: false, sends: 1, lastSentAt: '2026-11-01T09:00:00.000Z', now: NOW } });
    expect(out.noDraft).toBe(SECTOR_REFUSAL.subjectRef);
  });

  it('keeps the Dr letter for surgeons, and nothing for the other sectors', () => {
    const surgeon = compose({ business: 'Plastic surgeons', dataset: 'plastic-surgeons-belgium', name: 'Dr Jan Peeters', languages: ['FR'], country: 'Belgium' }, { lang: 'FR', mode: 'email' });
    expect(surgeon.subject).toContain('Dr');
    const clinic = compose({ business: 'Clinics', dataset: 'clinics-belgium', name: 'Centre X', languages: ['FR'], country: 'Belgium', email: 'a.b@x.be' }, { lang: 'FR', mode: 'email', hook: HOOK.FR });
    expect(clinic.body).toBe('');
    expect(clinic.noDraft).toBeTruthy();
  });
});

describe('C — aesthetic clinics (approved 13 Nov; Andy cut the method sentences)', () => {
  const clinic = (extra = {}) => ({
    business: 'Clinics', dataset: 'aesthetic-clinics-be-lu-fr', name: 'Clinique Lys', country: 'Belgium',
    email: 'sophie.martin@cliniquelys.example', languages: ['FR', 'NL', 'EN'], category: 'Aesthetic', extra: {}, ...extra,
  });
  const subject = 'Vos traitements sur mobile';

  it('knows an aesthetic clinic, and leaves dental and eye care without copy', () => {
    expect(sectorOf(clinic())).toBe('clinic');
    expect(sectorOf({ business: 'Clinics', dataset: 'clinics-belgium', category: 'Aesthetic clinic' })).toBe('clinic');
    expect(sectorOf({ business: 'Clinics', dataset: 'clinics-belgium', category: 'Dental' })).toBeNull();
    expect(sectorOf({ business: 'Clinics', dataset: 'eye-care-belgium', category: 'Optician' })).toBeNull();
  });

  for (const [lang, opens, intro, ends] of [
    ['FR', "Bonjour,\n\nEn parcourant le site de Clinique Lys, j'ai remarqué un point : ", 'Je suis Andy, de Realis Studio, un studio bruxellois qui crée des sites sur mesure.\n\nEnvisagez-vous', 'Bien à vous,\nAndy\nRealis Studio'],
    ['NL', 'Beste,\n\nBij het doorlopen van de website van Clinique Lys viel me iets op: ', 'Ik ben Andy van Realis Studio, een Brusselse studio die websites op maat maakt.\n\nDenkt u er', 'Met vriendelijke groet,\nAndy\nRealis Studio'],
    ['EN', "Hello,\n\nLooking through Clinique Lys's website, I noticed one thing: ", "I'm Andy, from Realis Studio, a Brussels studio that builds custom websites.\n\nAre you thinking", 'Kind regards,\nAndy\nRealis Studio'],
  ]) {
    it(`writes the first email in ${lang}, without the method sentences`, () => {
      const out = compose(clinic(), { lang, mode: 'email', hook: HOOK[lang], subject, history: fresh });
      expect(out.noDraft).toBeUndefined();
      expect(out.subject).toBe(subject);
      expect(out.body.startsWith(opens + HOOK[lang])).toBe(true);
      expect(out.body).toContain(intro);
      expect(out.body.endsWith(ends)).toBe(true);
      expect(out.body).not.toMatch(/Pour une clinique|Voor een kliniek|For a clinic|photos|foto's|https?:|\{\{|Aubin|cabinet médical/);
    });
  }

  for (const [lang, line] of [
    ['FR', 'Je me permets de remonter ce message une seule fois, au cas où il vous aurait échappé.'],
    ['NL', 'Is dat nu een onderwerp voor u?'],
    ['EN', 'Is this something you\'d like to look at right now?'],
  ]) {
    it(`follows up in ${lang}, quoting the first subject`, () => {
      const out = compose(clinic(), { lang, mode: 'followup', subject, history: { replied: false, sends: 1, lastSentAt: '2026-11-10T09:00:00.000Z', now: NOW } });
      expect(out.subject).toBe(subject);
      expect(out.body).toContain(line);
    });
  }

  it('writes nothing without Andy\'s line or the subject', () => {
    expect(compose(clinic(), { lang: 'FR', mode: 'email', subject, history: fresh }).noDraft).toBe(SECTOR_REFUSAL.hook);
    expect(compose(clinic(), { lang: 'FR', mode: 'email', hook: HOOK.FR, history: fresh }).noDraft).toBe(SECTOR_REFUSAL.subject);
  });
});
