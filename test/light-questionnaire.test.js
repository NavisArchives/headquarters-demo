import { describe, it, expect } from 'vitest';
import { LIGHT_SECTIONS, fieldShown, progress, summarise } from '../src/public/assets/onboarding-form.js';
import { estimate, priceText, PRICES } from '../src/public/assets/pricing.js';
import { liveModel, livePage } from '../src/worker/live.js';

const fieldOf = (key) => LIGHT_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === key);

describe('the light questionnaire (Andy, F27)', () => {
  it('has its sections (Réseaux sociaux only when ticked), starts with "Un site" ticked, and asks what Andy reads aloud', () => {
    expect(LIGHT_SECTIONS.map((s) => s.fr)).toEqual(['La formule', 'Qui est concerné\u00a0?', 'Les langues', 'Les pages', 'Réseaux sociaux', 'Le contenu', 'Domaine et calendrier']);
    const needs = fieldOf('light.needs');
    expect(needs.fr).toBe('Quels sont vos besoins\u00a0?');
    expect(needs.preset).toEqual(['site']);
    expect(needs.options.map((o) => o.fr)).toEqual(['Un site', 'Un éditeur (vous modifiez vous-même)', 'Un portail pour vous', 'Un espace patients', 'Réseaux sociaux', 'Paquet photo']);
    expect(needs.options.every((o) => !/^Un site \+/.test(o.fr))).toBe(true);
    expect(fieldOf('light.content').options.map((o) => o.fr)).toEqual(['Photos (le cabinet et vous)', 'Vidéo du cabinet', 'Vidéo interview', 'Vidéo animation']);
  });

  it('asks the practice name only for a cabinet or clinic, the domain only when he has one', () => {
    const name = fieldOf('light.practice.name');
    expect(fieldShown(name, {})).toBe(false);
    expect(fieldShown(name, { 'light.practice': 'solo' })).toBe(false);
    expect(fieldShown(name, { 'light.practice': 'clinic' })).toBe(true);
    // A name typed before switching to "individuelle" is not in the summary.
    const lines = summarise({ 'light.practice': 'solo', 'light.practice.name': 'Clinique X' }, [], 'fr', LIGHT_SECTIONS).flatMap((g) => g.lines);
    expect(lines.map((l) => l.value)).not.toContain('Clinique X');
    expect(fieldShown(fieldOf('light.domain.name'), { 'light.domain': 'yes' })).toBe(true);
    expect(progress({ 'light.needs': ['site'] }, LIGHT_SECTIONS)).toEqual({ done: 1, total: 6 });
  });
});

describe('the budget estimate (HQ only)', () => {
  it('prices a site at €2,000 + €100/month and leaves unpriced options "à chiffrer"', () => {
    expect(PRICES.site).toMatchObject({ once: 2000, monthly: 100 });
    const site = estimate({ 'light.needs': ['site'] });
    expect(priceText(site)).toBe('€2,000 + €100/month');
    expect(site.pending).toBe(0);
    // « Le contenu »: photos bring the photo pack, each video its own line.
    const more = estimate({ 'light.needs': ['site', 'patients'], 'light.content': ['photos', 'video-interview'] });
    expect(more.lines.map((l) => l.id)).toEqual(['site', 'patients', 'photo', 'video-interview']);
    expect(more.pending).toBe(3);
    expect(priceText(more.lines[1])).toBe('à chiffrer');
    expect(estimate({}).lines).toEqual([]);
  });

  it('uses whatever Andy fills into the price table', () => {
    const prices = { ...PRICES, cms: { label: 'CMS', once: 400, monthly: 10 } };
    const est = estimate({ 'light.needs': ['site', 'cms'] }, prices);
    expect([est.once, est.monthly, est.pending]).toEqual([2400, 110, 0]);
  });

  it('never reaches the live mirror', () => {
    const model = liveModel({ name: 'Dr X', brand: 'realis', template: 'light', entities: [],
      answers: { 'light.needs': ['site', 'patients'], 'light.practice': 'solo', 'light.practice.name': 'Hidden Name' } });
    const html = livePage(model, 'n');
    expect(html).toContain('Vos patients échangent avec vous\u00a0');
    expect(html).not.toMatch(/€|2,000|Budget|à chiffrer/);
    expect(html).not.toContain('Hidden Name');
    expect(html).not.toContain('Quel est le nom du cabinet');
  });
});

describe('F32: the Fontaine dry run', () => {
  it('shows Réseaux sociaux only when ticked, and counts it only then', async () => {
    const { resolveSections, builtinConfig, shownSections } = await import('../src/public/assets/onboarding-form.js');
    const all = resolveSections(builtinConfig('base'), '2026-10-19');
    expect(shownSections(all, { 'light.needs': ['site'] }).map((s) => s.id)).not.toContain('socials');
    expect(shownSections(all, { 'light.needs': ['site', 'social'] }).map((s) => s.id)).toContain('socials');
    expect(progress({ 'light.needs': ['site'] }, all).total).toBe(6);
    expect(progress({ 'light.needs': ['site', 'social'] }, all).total).toBe(7);
  });

  it('offers start slots from schedule.js: next Monday and 14 November, start and end shown', async () => {
    const { slotOptions, nextMonday } = await import('../src/public/assets/schedule.js');
    expect(nextMonday('2026-10-19')).toBe('2026-10-26'); // a Monday gives the next one
    expect(nextMonday('2026-10-21')).toBe('2026-10-26');
    const opts = slotOptions('site', '2026-10-21');
    expect(opts.map((o) => o.id)).toEqual(['2026-10-26', '2026-11-14']);
    expect(opts[0].desc.fr).toBe('Début lun. 26 oct. · fin à confirmer');
    const timed = slotOptions('site', '2026-10-21', { slots: [{ id: 'x', label: 'X', start: '2026-11-02' }], weeks: { site: 4 } });
    expect(timed[0].desc.fr).toBe('Début lun. 2 nov. · fin prévue lun. 30 nov.');
    // A slot already past is not offered.
    expect(slotOptions('site', '2026-11-20').map((o) => o.fr)).toEqual(['Lundi prochain']);
  });

  it('opens the interview from 0:34 in a pop-up player, only on a click, with no inline player', async () => {
    const { youtube, youtubeEmbed, DEFAULT_MEDIA } = await import('../src/public/assets/onboarding-form.js');
    expect(DEFAULT_MEDIA[0]).toMatchObject({ tab: 'interview' });
    expect(youtubeEmbed(youtube(DEFAULT_MEDIA[0].url))).toBe('https://www.youtube-nocookie.com/embed/Z5nzpaH6ebw?autoplay=1&rel=0&start=34');
    const model = liveModel({ name: 'Dr X', brand: 'realis', template: 'light', entities: [], answers: { 'light.needs': ['site', 'social'] } });
    const html = livePage(model, 'n');
    // « Voir l'inspiration » beside "Vidéo interview" (in Le contenu and Réseaux sociaux); only those with an example.
    expect(html).toContain('data-embed="https://www.youtube-nocookie.com/embed/Z5nzpaH6ebw?autoplay=1&amp;rel=0&amp;start=34"');
    expect(html).toContain('▶ Vidéo interview');
    expect(html).not.toContain('▶ Vidéo du cabinet');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('id="s-inspiration"');
    expect(html).toContain('id="s-recap"');
  });

  it('asks the domain both ways, and lets the client type the wished name', () => {
    const wish = LIGHT_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'light.domain.wish');
    expect(fieldShown(wish, { 'light.domain': 'no' })).toBe(true);
    expect(fieldShown(wish, { 'light.domain': 'yes' })).toBe(false);
  });
});

describe('F32: price points for Andy', () => {
  it('lists the site at €2,000 and €100 a month (Andy, 19 Oct), the bigger tiers waiting for his price', async () => {
    const { PRICE_POINTS } = await import('../src/public/assets/pricing.js');
    expect(PRICE_POINTS.tiers.map((x) => x.once)).toEqual([2000, null, null]);
    expect(PRICE_POINTS.monthly).toBe(100);
  });

  it('lets the page load the player and its poster from YouTube only, nothing broader', async () => {
    const { handleLive } = await import('../src/worker/live.js');
    expect(typeof handleLive).toBe('function');
    const src = (await import('node:fs')).readFileSync(new URL('../src/worker/live.js', import.meta.url), 'utf8');
    expect(src).toContain("img-src https://i.ytimg.com; media-src https:; frame-src https://www.youtube-nocookie.com;");
  });
});
