import { describe, it, expect, beforeEach } from 'vitest';
import { installDom, html } from './dom-shim.js';

installDom();

/** A fetch stub keyed on a url substring; records every request. */
function stubFetch(routes) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const value = key === undefined ? new Error(`no stub for ${url}`) : routes[key];
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return sent;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const { SECTIONS, progress, summarise, sectionAnswered, socialKeys } = await import('../src/public/assets/onboarding-form.js');
const { renderOnboarding } = await import('../src/public/assets/screens/onboarding.js');
const { renderPipeline, whenLabel } = await import('../src/public/assets/screens/pipeline.js');
const safe = await import('../src/public/assets/safe-view.js');

const ENTITIES = [
  { id: 'dr-marchal', name: 'Dr Marchal', kind: 'Personal brand' },
  { id: 'clinique', name: 'Clinique des Tilleuls', kind: 'Clinic' },
];
const FORM = {
  onboarding: {
    id: 7, name: 'Dr Hélène Marchal', organisation: 'Clinique des Tilleuls', brand: 'realis',
    entities: ENTITIES, answers: { 'web.state': 'refresh', activities: ['clinique'] }, updated_at: null,
  },
};

beforeEach(() => {
  installDom();
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
});

describe('the questionnaire', () => {
  it('asks the sections Nirmata listed, in French first', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'activities', 'web', 'video', 'photo', 'social', 'team', 'compliance', 'portal', 'academy', 'goals', 'practical', 'notes',
    ]);
    for (const section of SECTIONS) {
      expect(section.fr).toBeTruthy();
      expect(section.en).toBeTruthy();
      for (const field of section.fields) {
        expect(field.key).toMatch(/^[a-z0-9_.-]+$/);
        for (const option of field.options ?? []) expect(option.fr && option.en && option.id).toBeTruthy();
      }
    }
    const keys = SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers nothing a doctor’s public communication cannot carry in Belgium: no prices, testimonials or before/after', () => {
    const words = SECTIONS.flatMap((s) => s.fields.flatMap((f) => [f.fr, f.en, ...(f.options ?? []).flatMap((o) => [o.fr, o.en])]))
      .join(' | ').toLowerCase();
    for (const banned of ['tarif', 'prix', 'price', 'fee', 'témoign', 'testimonial', 'avant/après', 'before/after']) {
      expect(words).not.toContain(banned);
    }
  });

  it('counts a section as answered once any of its fields is, social media per business included', () => {
    expect(progress({})).toEqual({ done: 0, total: SECTIONS.length });
    const answers = { 'web.state': 'new', [socialKeys('clinique').networks]: ['instagram'] };
    expect(progress(answers).done).toBe(2);
    expect(sectionAnswered(SECTIONS.find((s) => s.id === 'social'), answers)).toBe(true);
  });

  it('reads the answers back as sentences, in either language', () => {
    const answers = {
      activities: ['clinique'], 'web.state': 'refresh', 'web.languages': ['fr', 'nl'],
      [socialKeys('clinique').networks]: ['instagram', 'linkedin'], [socialKeys('clinique').perWeek]: '2-3',
      notes: 'Wants it before the congress',
    };
    const fr = summarise(answers, ENTITIES, 'fr');
    expect(fr.find((g) => g.id === 'activities').lines[0]).toEqual({ key: 'activities', label: 'Activités concernées', value: 'Clinique des Tilleuls' });
    expect(fr.find((g) => g.id === 'web').lines).toContainEqual({ key: 'web.languages', label: 'Langues', value: 'Français, Néerlandais' });
    expect(fr.find((g) => g.id === 'social').lines[0]).toEqual({ label: 'Clinique des Tilleuls', value: 'Instagram, LinkedIn\u2002·\u20022–3 par semaine' });
    const en = summarise(answers, ENTITIES, 'en');
    expect(en.find((g) => g.id === 'web').lines).toContainEqual({ key: 'web.state', label: 'The current site', value: 'Needs a refresh' });
  });
});

describe('the onboarding screen', () => {
  it('in safe view, reads only the questionnaire, shows the studio and a hold-to-leave, and no way into HQ', async () => {
    const sent = stubFetch({ '/onboarding': FORM });
    const root = await renderOnboarding({ navigate: () => {} }, 7, { safe: true });
    const markup = html(root);
    expect(sent.map((r) => r.url)).toEqual(['/api/prospects/7/onboarding']);
    expect(markup).toContain('REALIS STUDIO');
    expect(markup).toContain('Questionnaire de démarrage');
    expect(markup).toContain('<h1>Dr Hélène Marchal</h1>');
    expect(markup).toContain('<p>Clinique des Tilleuls</p>');
    expect(markup).toContain('class="hold ob-leave"');
    expect(markup).not.toContain('Safe view');
    expect(markup).not.toContain('← Prospect');
    const pressed = root.querySelectorAll('.ob-opt').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    expect(pressed).toEqual(['Clinique des Tilleuls\u2002·\u2002Clinic', 'À rafraîchir']);
  });

  it('inside HQ, has the Safe view button and the way back to the prospect', async () => {
    stubFetch({ '/onboarding': FORM });
    const markup = html(await renderOnboarding({ navigate: () => {} }, 7, { safe: false }));
    expect(markup).toContain('Safe view');
    expect(markup).toContain('← Prospect');
    expect(markup).not.toContain('ob-leave');
  });

  it('draws social media rows only for the businesses ticked in the first section', async () => {
    stubFetch({ '/onboarding': FORM });
    const root = await renderOnboarding({ navigate: () => {} }, 7, { safe: true });
    const names = root.querySelectorAll('.ob-social__name').map((n) => n.textContent);
    expect(names).toEqual(['Clinique des Tilleuls']);
  });

  it('asks which business comes first as a tap among the ticked ones', async () => {
    stubFetch({ '/onboarding': FORM });
    const root = await renderOnboarding({ navigate: () => {} }, 7, { safe: true });
    const field = root.querySelectorAll('.ob-field').find((f) => f.textContent.startsWith('Par laquelle commencer'));
    expect(field.querySelectorAll('.ob-opt').map((b) => b.textContent)).toEqual(['Clinique des Tilleuls']);
    expect(field.querySelector('input')).toBeNull();
  });

  it('saves a tapped answer to the questionnaire’s own address', async () => {
    const sent = stubFetch({ '/onboarding': FORM });
    const root = await renderOnboarding({ navigate: () => {} }, 7, { safe: true });
    const option = root.querySelectorAll('.ob-opt').find((b) => b.textContent === 'Chaque mois');
    option.dispatch('click');
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    const save = sent.find((r) => r.method === 'PATCH');
    expect(save.url).toBe('/api/prospects/7/onboarding');
    expect(JSON.parse(save.body)).toEqual({ answers: { 'web.news': 'monthly' } });
  });
});

describe('safe view', () => {
  it('is remembered in this tab until it is left on purpose, and a questionnaire address is always it', () => {
    expect(safe.onboardingIdIn('/onboarding/7')).toBe(7);
    expect(safe.onboardingIdIn('/pipeline/7')).toBeNull();
    expect(globalThis.localStorage.getItem('hq.safeView')).toBeNull();
    expect(safe.safeViewId()).toBeNull();
    safe.enterSafeView(7);
    expect(safe.safeViewId()).toBe(7);
    expect(document.documentElement.classList.contains('safe-view')).toBe(true);
    expect(safe.safePath(7)).toBe('/onboarding/7');
    safe.leaveSafeView();
    expect(safe.safeViewId()).toBeNull();
    expect(document.documentElement.classList.contains('safe-view')).toBe(false);
  });

  it('leaves only when held, never on a tap', async () => {
    let left = 0;
    const button = safe.holdButton({ label: 'Quitter', ms: 60, onDone: () => { left += 1; } });
    button.dispatch('pointerdown', { preventDefault() {} });
    button.dispatch('pointerup');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(left).toBe(0);
    button.dispatch('pointerdown', { preventDefault() {} });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(left).toBe(1);
  });
});

describe('the pipeline board', () => {
  it('puts each prospect in its stage with its next step and when', async () => {
    stubFetch({
      '/api/prospects': {
        prospects: [
          { id: 1, name: 'Dr Hélène Marchal', organisation: 'Clinique des Tilleuls', stage: 'meeting', brand: 'realis',
            next_step: 'Meeting at the clinic', next_at: '2099-01-01T18:30', entities: ENTITIES, onboarding_answers: 0 },
          { id: 2, name: 'Atelier Nord', organisation: '', stage: 'won', brand: 'realis', entities: [], onboarding_answers: 3 },
        ],
      },
    });
    const markup = html(await renderPipeline({ navigate: () => {} }));
    expect(markup).toContain('Onboarding');
    expect(markup).toContain('Meeting at the clinic');
    expect(markup).toContain('1 Jan 18:30');
    expect(markup).toContain('2 businesses');
    expect(markup).toContain('Atelier Nord');
  });

  it('reads a next step with a time as a day and an hour', () => {
    expect(whenLabel('2026-10-16T18:30', '2026-10-15')).toEqual({ text: 'Tomorrow 18:30', cls: 'soon' });
    expect(whenLabel('2026-10-16', '2026-10-16')).toEqual({ text: 'Today', cls: 'today' });
    expect(whenLabel('2026-10-10T09:00', '2026-10-16')).toEqual({ text: '6d late', cls: 'late' });
    expect(whenLabel(null)).toEqual({ text: '', cls: '' });
  });
});

describe('the pipeline board, drag and drop (Andy, 18 Oct)', () => {
  it('shows all seven stages in order, each with its count and a "Move to…" on every card', async () => {
    stubFetch({
      '/api/prospects': {
        prospects: [
          { id: 1, name: 'Dr A', organisation: '', stage: 'meeting', brand: 'realis', entities: [], onboarding_answers: 0 },
          { id: 2, name: 'Dr B', organisation: '', stage: 'meeting', brand: 'realis', entities: [], onboarding_answers: 0 },
          { id: 3, name: 'Atelier C', organisation: '', stage: 'lost', brand: 'realis', entities: [], onboarding_answers: 0 },
        ],
      },
    });
    const root = await renderPipeline({ navigate: () => {} });
    const cols = [...root.querySelectorAll('.pl-col')];
    expect(cols.map((c) => c.dataset.stage)).toEqual(['lead', 'meeting', 'onboarding', 'proposal', 'contract', 'won', 'lost']);
    expect(cols.map((c) => c.querySelector('.pl-col__count').textContent)).toEqual(['0', '2', '0', '0', '0', '0', '1']);
    const card = root.querySelector('.pl-card');
    expect(card.draggable).toBe(true);
    const move = card.querySelector('select.pl-card__move');
    expect(move.getAttribute('aria-label')).toBe('Move Dr A to…');
    // Every stage but its own.
    expect([...move.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'lead', 'onboarding', 'proposal', 'contract', 'won', 'lost']);
  });
});

describe('F35: a meeting that has passed asks instead of saying late', () => {
  it('reads "Held? · 16 Oct" for a past meeting, still "late" for what Andy owes', () => {
    expect(whenLabel('2026-10-16T18:30', '2026-10-19', 'meeting')).toEqual({ text: 'Held? · 16 Oct', cls: 'ask' });
    expect(whenLabel('2026-10-16', '2026-10-19', 'onboarding').cls).toBe('late');
    expect(whenLabel('2026-10-20T11:00', '2026-10-19', 'meeting')).toEqual({ text: 'Tomorrow 11:00', cls: 'soon' });
  });
});
