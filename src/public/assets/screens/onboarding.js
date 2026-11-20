// The onboarding questionnaire for one prospect, filled in at the meeting,
// often with the client beside Andy. It looks like the studio, not like HQ:
// white, square, mono (realisstudio.com), so it can be shown as it is.
//
// Inside HQ it has a "Safe view" button; in safe view (safe-view.js) the
// same page is all there is, with a hold-to-leave button in a corner. It
// reads only /api/prospects/:id/onboarding, which carries the questionnaire
// and nothing internal. Every answer saves itself, key by key.

import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { toast } from '../leads-ui.js';
import {
  SOCIAL, SEP, t, socialKeys, sectionAnswered, progress, summarise, fieldShown, resolveSections, clientWritable, configFor,
  examplesOf, youtube, youtubeEmbed,
} from '../onboarding-form.js';
import { enterSafeView, holdButton, safePath, leaveClientView } from '../safe-view.js';
import { identity } from '../identity.js';

export function ensureOnboardingCss() {
  if (typeof document === 'undefined' || document.getElementById('onboarding-css')) return;
  const link = document.createElement('link');
  link.id = 'onboarding-css';
  link.rel = 'stylesheet';
  link.href = '/assets/onboarding.css';
  document.head.appendChild(link);
}

/** The studio the client sees: Realis Studio, or andyssarchives (the demo has its own names). */
const brandName = (brand) => (brand === 'archive' ? identity().brandUgc : identity().brandWeb).toUpperCase();

const UI = {
  title: { fr: 'Questionnaire de démarrage', en: 'Onboarding questionnaire' },
  summary: { fr: 'Récapitulatif', en: 'Summary' },
  summaryEmpty: { fr: 'Les réponses apparaîtront ici.', en: 'Answers will appear here.' },
  saved: { fr: 'Enregistré', en: 'Saved' },
  saving: { fr: 'Enregistrement…', en: 'Saving…' },
  unsaved: { fr: 'Pas encore enregistré', en: 'Not saved yet' },
  leave: { fr: 'Quitter', en: 'Leave' },
  hold: { fr: 'maintenir 2 secondes', en: 'hold for 2 seconds' },
  noEntities: { fr: 'Aucune activité renseignée.', en: 'No business listed.' },
  done: { fr: 'sections remplies', en: 'sections answered' },
  networks: { fr: 'Réseaux à gérer', en: 'Networks to run' },
  today: { fr: 'Aujourd’hui', en: 'Today' },
  perWeek: { fr: 'Publications par semaine', en: 'Posts a week' },
};

/* ------------------------------------------------------------ saving --- */

/** Answers wait here a moment, then go together in one request. */
function saver(id, onState) {
  let pending = {};
  let timer = null;
  let inFlight = null;

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!Object.keys(pending).length) return;
    if (inFlight) { await inFlight; return flush(); }
    const batch = pending;
    pending = {};
    onState('saving');
    inFlight = apiFetch(`/api/prospects/${id}/onboarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: batch }),
    }).then(() => {
      onState(Object.keys(pending).length ? 'unsaved' : 'saved');
    }).catch((error) => {
      // Keep what failed; the next change (or leaving the page) sends it again.
      pending = { ...batch, ...pending };
      onState('failed');
      toast(error?.message || 'Pas enregistré. Vérifiez la connexion. / Not saved. Check the connection.');
    }).finally(() => { inFlight = null; });
    await inFlight;
  }

  function queue(key, value, wait) {
    pending[key] = value;
    onState('unsaved');
    clearTimeout(timer);
    timer = setTimeout(flush, wait);
  }

  // Leaving the page with something unsent: send it anyway.
  const onHide = () => {
    if (!Object.keys(pending).length) return;
    try {
      fetch(`/api/prospects/${id}/onboarding`, {
        method: 'PATCH', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: pending }),
      });
      pending = {};
    } catch { /* nothing more to do */ }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', onHide);

  return { queue, flush };
}

/* ---------------------------------------------------------- controls --- */

function optionButtons({ options, selected, multi, lang, onChange, small = false, max = null }) {
  const wrap = el('div', `ob-opts${small ? ' is-small' : ''}`);
  wrap.setAttribute('role', 'group');
  const current = new Set(multi ? (selected ?? []) : (selected ? [selected] : []));
  for (const option of options) {
    const button = el('button', option.desc ? 'ob-opt has-desc' : 'ob-opt');
    button.type = 'button';
    // A label, and for some options a line saying what it is.
    if (option.desc) button.append(el('b', null, t(option, lang)), el('small', null, t(option.desc, lang)));
    else button.textContent = t(option, lang);
    button.setAttribute('aria-pressed', String(current.has(option.id)));
    button.addEventListener('click', () => {
      if (multi) {
        if (current.has(option.id)) current.delete(option.id);
        else if (max && current.size >= max) { toast(`${max} choix maximum`); return; }
        else current.add(option.id);
      } else {
        const was = current.has(option.id);
        current.clear();
        if (!was) current.add(option.id);
      }
      for (const b of wrap.children) b.setAttribute('aria-pressed', String(current.has(options[[...wrap.children].indexOf(b)].id)));
      const value = multi ? [...current] : ([...current][0] ?? null);
      onChange(multi && !value.length ? null : value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function textControl({ value, long, label, onChange }) {
  const input = el(long ? 'textarea' : 'input', 'ob-input');
  if (!long) input.type = 'text';
  else input.rows = 4;
  input.value = value ?? '';
  input.maxLength = 4000;
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => onChange(input.value.trim() ? input.value : null));
  return input;
}

/**
 * An example video in a pop-up (19 Oct): centred, full screen on a phone. The
 * player loads only now; ✕, Esc or a click outside closes it and stops it.
 * Safari still asks for one tap on the player itself to start with sound.
 * Opening it here never opens it on the client's live page.
 */
export function openExample(item, doc = document) {
  const yt = youtube(item.url);
  if (!yt && !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(item.url)) {
    window.open(item.url, '_blank', 'noopener');
    return null;
  }
  const back = doc.activeElement;
  const scrim = el('div', 'ob-pop');
  scrim.setAttribute('role', 'dialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-label', item.title || 'Exemple');
  const box = el('div', 'ob-pop__box');
  const close = el('button', 'ob-pop__x', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer');
  let player;
  if (yt) {
    player = el('iframe');
    player.src = youtubeEmbed(yt);
    player.title = item.title || 'Vidéo';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
  } else {
    player = el('video');
    player.controls = true;
    player.autoplay = true;
    player.playsInline = true;
    player.src = item.url;
  }
  box.append(close, player);
  if (item.title) box.appendChild(el('p', 'ob-pop__title', item.title));
  scrim.appendChild(box);
  const shut = () => {
    doc.removeEventListener('keydown', onKey);
    scrim.remove(); // the player goes with it, so the sound stops
    back?.focus?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') shut(); };
  close.addEventListener('click', shut);
  scrim.addEventListener('click', (event) => { if (event.target === scrim) shut(); });
  doc.addEventListener('keydown', onKey);
  doc.body.appendChild(scrim);
  close.focus();
  return { close: shut, node: scrim };
}

/* ------------------------------------------------------------- screen --- */

/**
 * `safe`: drawn as the whole page, with the hold-to-leave button and no way
 * back into HQ but that one.
 */
export async function renderOnboarding(ctx, id, { safe = false } = {}) {
  ensureOnboardingCss();
  const { onboarding: form } = await apiFetch(`/api/prospects/${id}/onboarding`);
  const answers = { ...(form.answers ?? {}) };
  const entities = form.entities ?? [];
  // French only (Andy, 16 Oct): no language switch on the client's screen.
  const lang = 'fr';
  // The prospect's own questionnaire (F31): its sections, questions and videos.
  const config = form.config ?? configFor(form);
  const SECTIONS = resolveSections(config);

  const root = el('div', `ob${safe ? ' is-safe' : ''}`);
  root.dataset.prospect = String(id);
  if (safe && typeof document !== 'undefined') document.title = `${brandName(form.brand)}${SEP}${t(UI.title, 'fr')}`;

  // Saving says so in words: "Enregistré" for two seconds after each save,
  // and "Pas encore enregistré" for as long as a save has failed.
  let saveState = 'idle';
  let saveTimer = null;
  const saveDot = el('span', 'ob-save');
  saveDot.setAttribute('role', 'status');
  const paintSave = () => {
    clearTimeout(saveTimer);
    saveDot.className = `ob-save is-${saveState}`;
    saveDot.textContent = saveState === 'saved' ? `${t(UI.saved, lang)} ✓` : saveState === 'failed' ? t(UI.unsaved, lang) : '';
    if (saveState === 'saved') saveTimer = setTimeout(() => { saveDot.className = 'ob-save is-idle'; }, 2000);
  };
  const store = saver(id, (state) => {
    // Typing and sending are quiet; only the outcome is said.
    if (state === 'saved' || state === 'failed') { saveState = state; paintSave(); }
  });

  // When Andy last typed in each answer: the client's words never overwrite it mid-sentence.
  const typedAt = {};
  const textInputs = {};
  const set = (key, value, wait = 250) => {
    typedAt[key] = Date.now();
    if (value === null) delete answers[key]; else answers[key] = value;
    store.queue(key, value, wait);
    for (const toggle of conditionals) toggle();
    refreshProgress();
    paintSummary();
  };
  // Fields asked only after a given answer (their `when`), shown or hidden as it changes.
  const conditionals = [];

  // A light-questionnaire field that starts with an answer ("Un site") gets
  // it saved now, so the live mirror and the summary show it too.
  for (const section of SECTIONS) {
    for (const field of section.fields) {
      if (field.preset !== undefined && answers[field.key] === undefined) {
        answers[field.key] = field.preset;
        store.queue(field.key, field.preset, 0);
      }
    }
  }

  /* ---- the top bar: the studio, who it is for, saving ---- */
  const top = el('header', 'ob-top');
  // The studio, with what this is underneath; then who it is for.
  const brand = el('div', 'ob-brand');
  brand.appendChild(el('b', null, brandName(form.brand)));
  const kicker = el('small');
  brand.appendChild(kicker);
  top.appendChild(brand);
  top.appendChild(el('div', 'ob-heading'));
  const tools = el('div', 'ob-tools');
  tools.append(saveDot);
  if (!safe) {
    const back = el('button', 'ob-ghost', '← Prospect');
    back.type = 'button';
    back.addEventListener('click', async () => { await store.flush(); ctx.navigate?.(`/pipeline/${id}`); });
    const present = el('button', 'ob-present', 'Safe view');
    present.type = 'button';
    present.title = 'Show only this questionnaire, for the client. Leaving takes a 2-second hold.';
    present.addEventListener('click', async () => {
      await store.flush();
      enterSafeView(id);
      ctx.navigate?.(safePath(id), { replace: true });
    });
    tools.append(back, present);
  }
  top.appendChild(tools);
  root.appendChild(top);

  /* ---- the body: the steps on the side, the sections, the summary ---- */
  const body = el('div', 'ob-body');
  const steps = el('nav', 'ob-steps');
  steps.setAttribute('aria-label', 'Sections');
  const main = el('div', 'ob-form');
  body.append(steps, main);
  root.appendChild(body);

  const meter = el('div', 'ob-meter');
  function refreshProgress() {
    const { done, total } = progress(answers, SECTIONS);
    meter.textContent = `${done} / ${total} ${t(UI.done, lang)}`;
    for (const link of steps.querySelectorAll('a[data-section]')) {
      const section = SECTIONS.find((s) => s.id === link.dataset.section);
      link.classList.toggle('is-done', sectionAnswered(section, answers));
    }
  }

  const summaryHost = el('div', 'ob-summary');
  function paintSummary() {
    summaryHost.replaceChildren();
    const groups = summarise(answers, entities, lang, SECTIONS);
    if (!groups.length) { summaryHost.appendChild(el('p', 'ob-muted', t(UI.summaryEmpty, lang))); return; }
    for (const group of groups) {
      const block = el('div', 'ob-sum-group');
      block.appendChild(el('h3', null, group.title));
      const list = el('dl');
      for (const line of group.lines) {
        list.appendChild(el('dt', null, line.label));
        list.appendChild(el('dd', null, line.value));
      }
      block.appendChild(list);
      summaryHost.appendChild(block);
    }
  }

  function socialRows(host) {
    host.replaceChildren();
    const chosen = Array.isArray(answers.activities) && answers.activities.length
      ? entities.filter((e) => answers.activities.includes(e.id))
      : entities;
    if (!chosen.length) { host.appendChild(el('p', 'ob-muted', t(UI.noEntities, lang))); return; }
    for (const entity of chosen) {
      const keys = socialKeys(entity.id);
      // One business: three short questions, each with its label beside it.
      const row = el('div', 'ob-social');
      row.appendChild(el('b', 'ob-social__name', entity.name));
      const line = (label, control) => {
        const r = el('div', 'ob-social__line');
        r.appendChild(el('span', 'ob-social__label', label));
        r.appendChild(control);
        row.appendChild(r);
      };
      line(t(UI.networks, lang), optionButtons({
        options: SOCIAL.networks, selected: answers[keys.networks], multi: true, lang, small: true,
        onChange: (v) => set(keys.networks, v),
      }));
      line(t(UI.today, lang), optionButtons({ options: SOCIAL.state, selected: answers[keys.state], lang, small: true, onChange: (v) => set(keys.state, v) }));
      line(t(UI.perWeek, lang), optionButtons({ options: SOCIAL.perWeek, selected: answers[keys.perWeek], lang, small: true, onChange: (v) => set(keys.perWeek, v) }));
      host.appendChild(row);
    }
  }

  function fieldNode(field, socialHosts, entityHosts) {
    const wrap = el('div', 'ob-field');
    if (t(field, lang)) {
      const label = el('p', 'ob-label', t(field, lang));
      if (field.optional) label.appendChild(el('span', 'ob-optional', ' · facultatif'));
      wrap.appendChild(label);
    }
    if (field.hint) wrap.appendChild(el('p', 'ob-hint', t(field.hint, lang)));
    // « Voir l'inspiration »: the options that have an example open it in a pop-up.
    const examples = (field.options ?? []).filter((o) => o.inspire)
      .map((o) => ({ label: t(o, lang), item: examplesOf(config, o.inspire)[0] })).filter((x) => x.item);
    if (field.when) {
      const toggle = () => { wrap.hidden = !fieldShown(field, answers); };
      conditionals.push(toggle);
      toggle();
    }
    // An approval: the prepared content, then Approuvé / À modifier (and what the client wrote).
    if (field.type === 'approve') {
      wrap.appendChild(el('p', 'ob-approve', field.content));
      const noteText = answers[`${field.key}.note`];
      if (noteText) wrap.appendChild(el('p', 'ob-hint', `Le client : ${noteText}`));
    }
    if (field.type === 'choice' || field.type === 'chips' || field.type === 'approve') {
      wrap.appendChild(optionButtons({
        options: field.options, selected: answers[field.key], multi: field.type === 'chips', lang, max: field.max ?? null,
        onChange: (v) => set(field.key, v),
      }));
      if (examples.length) {
        const links = el('p', 'ob-insp__links');
        links.appendChild(document.createTextNode('Voir l’inspiration\u00a0: '));
        examples.forEach(({ label, item }, index) => {
          if (index) links.appendChild(document.createTextNode(' · '));
          const a = el('button', 'ob-insp__link', `▶ ${label}`);
          a.type = 'button';
          a.addEventListener('click', () => openExample(item));
          links.appendChild(a);
        });
        wrap.appendChild(links);
      }
    } else if (field.type === 'entities') {
      if (!entities.length) wrap.appendChild(el('p', 'ob-muted', t(UI.noEntities, lang)));
      else {
        wrap.appendChild(optionButtons({
          options: entities.map((e) => ({ id: e.id, fr: e.kind ? `${e.name}${SEP}${e.kind}` : e.name })),
          selected: answers[field.key], multi: true, lang,
          onChange: (v) => {
            set(field.key, v);
            for (const host of socialHosts) socialRows(host);
            for (const paint of entityHosts) paint();
          },
        }));
      }
    } else if (field.type === 'entity') {
      const host = el('div');
      const paint = () => {
        const chosen = Array.isArray(answers.activities) && answers.activities.length
          ? entities.filter((e) => answers.activities.includes(e.id)) : entities;
        host.replaceChildren(chosen.length
          ? optionButtons({ options: chosen.map((e) => ({ id: e.id, fr: e.name })), selected: answers[field.key], lang, onChange: (v) => set(field.key, v) })
          : el('p', 'ob-muted', t(UI.noEntities, lang)));
      };
      entityHosts.push(paint);
      paint();
      wrap.appendChild(host);
    } else if (field.type === 'social') {
      const host = el('div', 'ob-social-list');
      socialHosts.push(host);
      socialRows(host);
      wrap.appendChild(host);
    } else {
      const input = textControl({
        value: answers[field.key], long: field.type === 'long', label: t(field, lang),
        onChange: (v) => set(field.key, v, 900),
      });
      if (clientWritable(field)) textInputs[field.key] = input;
      wrap.appendChild(input);
    }
    return wrap;
  }

  function paintAll() {
    kicker.textContent = t(UI.title, lang);
    paintSave();

    steps.replaceChildren();
    main.replaceChildren();
    // Who this is for, as the page's title, above the first section.
    const title = el('header', 'ob-title');
    title.appendChild(el('h1', null, form.name));
    if (form.organisation) title.appendChild(el('p', null, form.organisation));
    main.appendChild(title);
    const socialHosts = [];
    const entityHosts = [];
    conditionals.length = 0;

    for (const key of Object.keys(textInputs)) delete textInputs[key];
    SECTIONS.forEach((section, index) => {
      const link = el('a');
      link.appendChild(el('span', 'ob-step__num', String(index + 1).padStart(2, '0')));
      link.appendChild(document.createTextNode(t(section, lang)));
      link.href = `#ob-${section.id}`;
      link.dataset.section = section.id;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        main.querySelector(`#ob-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      steps.appendChild(link);

      const node = el('section', 'ob-sec');
      node.id = `ob-${section.id}`;
      // A section asked only after a given answer (Réseaux sociaux): shown and hidden with it.
      if (section.when) {
        const toggle = () => { const on = fieldShown(section, answers); node.hidden = !on; link.hidden = !on; };
        conditionals.push(toggle);
        toggle();
      }
      // The number lives in the list of steps; the heading is just the subject.
      const head = el('div', 'ob-sec__head');
      head.appendChild(el('h2', null, t(section, lang)));
      node.appendChild(head);
      if (section.intro) node.appendChild(el('p', 'ob-intro', t(section.intro, lang)));
      for (const field of section.fields) node.appendChild(fieldNode(field, socialHosts, entityHosts));
      main.appendChild(node);
    });
    const sumLink = el('a', 'ob-steps__sum', t(UI.summary, lang));
    sumLink.href = '#ob-summary';
    sumLink.addEventListener('click', (event) => {
      event.preventDefault();
      main.querySelector('#ob-summary')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    steps.appendChild(sumLink);
    steps.appendChild(meter);

    const sum = el('section', 'ob-sec ob-sec--summary');
    sum.id = 'ob-summary';
    const head = el('div', 'ob-sec__head');
    head.appendChild(el('h2', null, t(UI.summary, lang)));
    sum.appendChild(head);
    sum.appendChild(summaryHost);
    main.appendChild(sum);

    refreshProgress();
    paintSummary();
    followSections();
    if (safe) leaveNode.querySelector('span').textContent = t(UI.leave, lang);
  }

  // The step of the section being read is marked: the first one at the
  // start, then whichever section crosses the upper third of the screen.
  let spy = null;
  function followSections() {
    const links = [...steps.querySelectorAll('a')];
    const mark = (targetId) => {
      for (const link of links) link.classList.toggle('is-current', link.getAttribute('href') === `#${targetId}`);
    };
    mark(main.querySelector('.ob-sec')?.id);
    spy?.disconnect();
    if (typeof IntersectionObserver !== 'function') return;
    spy = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target);
      if (seen.length) mark(seen[0].id);
    }, { rootMargin: '-25% 0px -70% 0px' });
    for (const node of main.querySelectorAll('.ob-sec')) spy.observe(node);
  }

  let leaveNode = null;
  if (safe) {
    leaveNode = holdButton({
      label: t(UI.leave, lang),
      title: t(UI.hold, lang),
      className: 'ob-leave',
      onDone: async () => {
        await store.flush();
        leaveClientView(id, ctx.navigate);
      },
    });
    // In the top bar's corner: never on top of an answer, on an iPad or a laptop.
    tools.appendChild(leaveNode);
  }

  paintAll();

  // What the client types on his live page shows here within ~2 seconds (F31).
  // Only the open text answers come in, and never one Andy is typing or just typed.
  const poll = setInterval(async () => {
    if (!root.isConnected) { clearInterval(poll); return; }
    let fresh;
    try { fresh = (await apiFetch(`/api/prospects/${id}/onboarding`)).onboarding.answers; } catch { return; }
    let changed = false;
    for (const [key, input] of Object.entries(textInputs)) {
      const theirs = fresh[key] ?? null;
      const ours = answers[key] ?? null;
      if (theirs === ours || document.activeElement === input || Date.now() - (typedAt[key] ?? 0) < 5000) continue;
      if (theirs === null) delete answers[key]; else answers[key] = theirs;
      input.value = theirs ?? '';
      changed = true;
    }
    if (changed) { for (const toggle of conditionals) toggle(); refreshProgress(); paintSummary(); }
  }, 2000);

  // The steps strip sits right under the bar, whatever height the bar has.
  if (safe && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { root.style.setProperty('--ob-top-h', `${top.getBoundingClientRect().height}px`); });
  }
  return root;
}
