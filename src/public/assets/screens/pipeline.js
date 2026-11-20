import { signedAgreementCard } from '../signed-agreement.js';
// Pipeline: potential clients, from first contact to a signed contract.
// The board shows each prospect in its stage with what happens next and
// when; a prospect's own page holds the contact, the businesses it brings,
// the lead it came from, internal notes, and the onboarding questionnaire
// (screens/onboarding.js) with its Safe view button.

import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { openModal, toast } from '../leads-ui.js';
import { dueBadge, localDay } from '../todos.js';
import { progress, summarise, resolveSections, LIBRARY, t, INSPIRATION_KINDS, exampleKind } from '../onboarding-form.js';
import { openClientView } from '../safe-view.js';
import { estimate, priceText, PRICE_POINTS } from '../pricing.js';
import { identity } from '../identity.js';
import { zoneTimes, WORK_ZONES } from '../dates.js';
import { readDraft, writeDraft, clearDraft } from '../drafts.js';

/** Whose clock a meeting time is on (0030, audit C14): Brussels for Belgian clients by default. */
function zonePick(value) {
  const pick = el('select', 'text-input pl-zone');
  pick.setAttribute('aria-label', 'Whose clock');
  for (const [tz, name] of WORK_ZONES) { const o = el('option', null, `${name} time`); o.value = tz; pick.appendChild(o); }
  pick.value = value || 'Europe/Brussels';
  return pick;
}

export function ensurePipelineCss() {
  if (typeof document === 'undefined' || document.getElementById('pipeline-css')) return;
  const link = document.createElement('link');
  link.id = 'pipeline-css';
  link.rel = 'stylesheet';
  link.href = '/assets/pipeline.css';
  document.head.appendChild(link);
}

// Andy's names for the stages (F35, 19 Oct). The ids stay what the database
// stores: 'onboarding' is the step after the meeting, when the proposal is
// being written from the questionnaire's answers.
export const STAGES = [
  { id: 'lead', label: 'Meeting to plan', line: 'First contact', action: 'Plan the meeting' },
  { id: 'meeting', label: 'Meeting planned', line: 'A meeting is set', action: 'Open the questionnaire ↗' },
  { id: 'onboarding', label: 'Proposal in creation', line: 'Writing the proposal', action: 'Proposal sent →' },
  { id: 'proposal', label: 'Proposal sent', line: 'Waiting for an answer', action: 'Contract sent →' },
  { id: 'contract', label: 'Contract', line: 'Out for signing', action: 'Contract signed → Won' },
  { id: 'won', label: 'Won', line: 'Signed' },
  { id: 'lost', label: 'Lost', line: 'Not this time' },
];
const OPEN = ['lead', 'meeting', 'onboarding', 'proposal', 'contract'];
const BRANDS = () => [['realis', identity().brandWeb], ['archive', identity().brandUgc]];

const send = (url, method, body) => apiFetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** "Tomorrow 18:30", "3d late", "24 Oct": a next step's day, and its time when it has one. */
export function whenLabel(nextAt, today = localDay(), stage = null) {
  if (!nextAt) return { text: '', cls: '' };
  // A meeting whose day has passed is not late: it probably happened (F35).
  if (stage === 'meeting' && String(nextAt).slice(0, 10) < today) return { text: `Held? · ${shortDay(nextAt)}`, cls: 'ask' };
  const badge = dueBadge(String(nextAt).slice(0, 10), today);
  const time = /T(\d{2}:\d{2})/.exec(nextAt)?.[1];
  return { text: time && badge.cls !== 'late' ? `${badge.text} ${time}` : badge.text, cls: badge.cls };
}

/** "16 Oct" */
function shortDay(nextAt) {
  return new Date(`${String(nextAt).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------ board --- */

/**
 * One prospect on the board. The card drags to another column; "Move to…"
 * does the same from a keyboard, a phone or a screen reader; a click on the
 * name opens the prospect's page.
 */
function prospectCard(p, { navigate, onMove }) {
  const card = el('article', `pl-card${p.stage === 'won' ? ' is-won' : ''}${p.stage === 'lost' ? ' is-lost' : ''}`);
  card.draggable = true;
  card.dataset.id = String(p.id);
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer?.setData('text/plain', String(p.id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragged');
    card.closest('.pl-board')?.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('is-dragged');
    card.closest('.pl-board')?.classList.remove('is-dragging');
  });

  const openBtn = el('button', 'pl-card__open');
  openBtn.type = 'button';
  const head = el('div', 'pl-card__head');
  const name = el('b', null, p.name);
  name.title = p.name;
  head.appendChild(name);
  if (p.brand === 'archive') head.appendChild(el('span', 'pl-tag', identity().brandUgc));
  openBtn.appendChild(head);
  if (p.organisation) openBtn.appendChild(el('small', 'pl-card__org', p.organisation));
  if (p.next_step || p.next_at) {
    const next = el('div', 'pl-card__next');
    next.appendChild(el('span', null, p.next_step || 'Next step'));
    const when = whenLabel(p.next_at, localDay(), p.stage);
    if (when.text) next.appendChild(el('span', `td-due ${when.cls}`.trim(), when.text));
    openBtn.appendChild(next);
    if (p.next_tz && /T\d{2}:\d{2}/.test(String(p.next_at))) openBtn.appendChild(el('small', 'pl-card__clock', zoneTimes(p.next_at, p.next_tz)));
  }
  const facts = [];
  if (p.entities?.length) facts.push(`${p.entities.length} business${p.entities.length === 1 ? '' : 'es'}`);
  if (p.onboarding_answers) facts.push('onboarding started');
  if (facts.length) openBtn.appendChild(el('small', 'pl-card__facts', facts.join(' · ')));
  openBtn.addEventListener('click', () => navigate?.(`/pipeline/${p.id}`));
  card.appendChild(openBtn);

  // The way to move without dragging: a native menu, right for touch and screen readers.
  const move = el('select', 'pl-card__move');
  move.setAttribute('aria-label', `Move ${p.name} to…`);
  move.title = 'Move to…';
  const placeholder = el('option', null, 'Move to…');
  placeholder.value = '';
  move.appendChild(placeholder);
  for (const stage of STAGES) {
    if (stage.id === p.stage) continue;
    const option = el('option', null, stage.label);
    option.value = stage.id;
    move.appendChild(option);
  }
  move.addEventListener('change', () => {
    const to = move.value;
    move.value = '';
    if (to) onMove(p.id, to);
  });
  card.appendChild(move);
  return card;
}

/** Moving a deal from its page: one line to confirm (won and lost say why it matters). */
function confirmClose(p, stage) {
  return new Promise((resolve) => {
    let answered = false;
    const { modal, close } = openModal({
      className: 'narrow pl-modal', label: `Move to ${stage.label}`,
      onClose: () => { if (!answered) resolve(false); },
    });
    modal.appendChild(el('h2', null, ['won', 'lost'].includes(stage.id) ? `Mark ${p.name} as ${stage.label.toLowerCase()}?` : `Move to “${stage.label}”?`));
    modal.appendChild(el('p', 'pl-sub', stage.id === 'won'
      ? 'It counts as a signed client in the funnel and finance.'
      : stage.id === 'lost' ? 'It leaves the open pipeline.' : `${p.name} moves to “${stage.label}”.`));
    const acts = el('div', 'pl-acts');
    const yes = el('button', 'btn primary', `Move to ${stage.label}`);
    yes.type = 'button';
    yes.addEventListener('click', () => { answered = true; close(); resolve(true); });
    const no = el('button', 'btn quiet', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', () => { answered = true; close(); resolve(false); });
    acts.append(yes, no);
    modal.appendChild(acts);
    queueMicrotask(() => yes.focus());
  });
}

function newProspectModal(onDone) {
  const { modal, close } = openModal({ className: 'narrow pl-modal', label: 'New prospect' });
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.appendChild(el('div', 'crumb', 'Pipeline'));
  heading.appendChild(el('h2', null, 'New prospect'));
  head.appendChild(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', close);
  nav.appendChild(x);
  head.appendChild(nav);
  modal.appendChild(head);

  const input = (label, type = 'text') => {
    const wrap = el('label', 'field');
    wrap.appendChild(el('span', 'label', label));
    const control = el('input', 'text-input');
    control.type = type;
    wrap.appendChild(control);
    modal.appendChild(wrap);
    return control;
  };
  const select = (label, choices, value) => {
    const wrap = el('label', 'field');
    wrap.appendChild(el('span', 'label', label));
    const control = el('select', 'text-input');
    for (const [id, text] of choices) {
      const option = el('option', null, text);
      option.value = id;
      control.appendChild(option);
    }
    control.value = value;
    wrap.appendChild(control);
    modal.appendChild(wrap);
    return control;
  };
  const name = input('Name');
  const organisation = input('Organisation');
  const email = input('Email', 'email');
  const brand = select('Brand', BRANDS(), 'realis');
  const stage = select('Stage', STAGES.map((s) => [s.id, s.label]), 'lead');
  const nextStep = input('Next step');
  const nextAt = input('When', 'datetime-local');
  const nextTz = select('Whose clock', WORK_ZONES.map(([tz, n]) => [tz, `${n} time`]), 'Europe/Brussels');

  const acts = el('div', 'pl-acts');
  const save = el('button', 'btn primary', 'Add to the pipeline');
  save.type = 'button';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { prospect } = await send('/api/prospects', 'POST', {
        name: name.value, organisation: organisation.value, email: email.value || null, brand: brand.value,
        stage: stage.value, next_step: nextStep.value, next_at: nextAt.value || null,
        next_tz: nextAt.value ? nextTz.value : null,
      });
      close();
      toast(`Added · ${prospect.name}`);
      onDone?.(prospect);
    } catch (error) {
      save.disabled = false;
      toast(error?.message || 'Could not add it');
    }
  });
  const cancel = el('button', 'btn quiet', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  acts.append(save, cancel);
  modal.appendChild(acts);
  queueMicrotask(() => name.focus());
}

export async function renderPipeline(ctx = {}) {
  ensurePipelineCss();
  const navigate = ctx.navigate;
  // The deals only: a client's onboarding lives on the client's project page (0021).
  const { prospects } = await apiFetch('/api/prospects?for=pipeline');

  // On a phone (P6 block 5): one stage at a time, picked in a native picker that
  // carries each stage's count; that column's list is the one region that scrolls.
  const root = el('div', 'pl phone-frame pl-screen');
  const head = el('div', 'pl-head');
  const left = el('div');
  left.appendChild(el('h1', null, 'Onboarding'));
  const sub = el('p', 'pl-sub');
  left.appendChild(sub);
  head.appendChild(left);
  const add = el('button', 'btn primary', '+ New prospect');
  add.type = 'button';
  add.addEventListener('click', () => newProspectModal((p) => navigate?.(`/pipeline/${p.id}`)));
  head.appendChild(add);
  root.appendChild(head);

  const stagePick = el('select', 'sortsel pl-stagepick');
  stagePick.setAttribute('aria-label', 'Stage');
  let shownStage = null;
  stagePick.addEventListener('change', () => { shownStage = stagePick.value; showStage(); });
  root.appendChild(stagePick);
  function showStage() {
    for (const col of board.children) {
      const on = col.dataset.stage === shownStage;
      col.classList.toggle('is-on', on);
      col.querySelector('.pl-col__list')?.classList.toggle('scroll-region', on);
    }
  }

  // The board: every stage, in order, as a column that takes a dropped card.
  const board = el('div', 'pl-board');
  root.appendChild(board);
  const stageOf = (id) => STAGES.find((s) => s.id === id);

  function paint() {
    board.replaceChildren();
    for (const stage of STAGES) {
      const mine = prospects.filter((p) => p.stage === stage.id);
      const col = el('section', `pl-col${OPEN.includes(stage.id) ? '' : ' is-closed'}`);
      col.dataset.stage = stage.id;
      col.setAttribute('aria-label', `${stage.label}, ${mine.length}`);
      const eyebrow = el('p', 'pl-col__head');
      eyebrow.appendChild(el('b', null, stage.label));
      eyebrow.appendChild(el('span', 'pl-col__count', String(mine.length)));
      col.appendChild(eyebrow);
      const line = el('p', 'pl-col__line', stage.line);
      line.title = stage.line;
      col.appendChild(line);
      const list = el('div', 'pl-col__list');
      for (const p of mine) list.appendChild(prospectCard(p, { navigate, onMove: move }));
      col.appendChild(list);
      col.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        col.classList.add('is-over');
      });
      col.addEventListener('dragleave', (event) => {
        if (!col.contains(event.relatedTarget)) col.classList.remove('is-over');
      });
      col.addEventListener('drop', (event) => {
        event.preventDefault();
        col.classList.remove('is-over');
        board.classList.remove('is-dragging');
        const id = Number(event.dataTransfer?.getData('text/plain'));
        if (id) move(id, stage.id);
      });
      board.appendChild(col);
    }
    sub.textContent = `Potential clients, from first contact to a signed contract · ${prospects.filter((p) => OPEN.includes(p.stage)).length} open`;
    // The phone's picker: each stage with the count its column shows.
    shownStage ??= (STAGES.find((st) => prospects.some((p) => p.stage === st.id)) ?? STAGES[0]).id;
    stagePick.replaceChildren();
    for (const stage of STAGES) {
      const option = el('option', null, `${stage.label} · ${prospects.filter((p) => p.stage === stage.id).length}`);
      option.value = stage.id;
      if (stage.id === shownStage) option.selected = true;
      stagePick.appendChild(option);
    }
    showStage();
  }

  // Move at once on screen, then save; put it back if the save fails.
  async function move(id, to, { undo = false } = {}) {
    const p = prospects.find((x) => x.id === id);
    if (!p || p.stage === to) return;
    const target = stageOf(to);
    if (!undo && (to === 'won' || to === 'lost') && !(await confirmClose(p, target))) return;
    const from = p.stage;
    p.stage = to;
    paint();
    try {
      await send(`/api/prospects/${id}`, 'PATCH', { stage: to });
    } catch (error) {
      p.stage = from;
      paint();
      toast(error?.message ? `Not moved: ${error.message}` : `Could not move ${p.name}`);
      return;
    }
    if (undo) toast(`${p.name} is back in ${target.label}`);
    else toast(`Moved ${p.name} to ${target.label}`, { action: { label: 'Undo', onClick: () => move(id, from, { undo: true }) } });
  }

  paint();
  // No page scroll on a desktop (Andy's rule): the board takes the rest of the
  // screen, every column the same height, and only a column's cards scroll.
  if (typeof window !== 'undefined' && window.matchMedia) {
    const desktop = window.matchMedia('(min-width: 1100px) and (min-height: 640px)');
    const fit = () => {
      if (!board.isConnected) { window.removeEventListener('resize', fit); return; }
      board.style.height = desktop.matches
        ? `${Math.max(360, window.innerHeight - board.getBoundingClientRect().top - window.scrollY - 24)}px` : '';
    };
    window.addEventListener('resize', fit);
    requestAnimationFrame(() => requestAnimationFrame(fit));
  }
  if (!prospects.length) {
    root.appendChild(el('p', 'pl-empty', 'No prospects yet. A lead who wants to talk goes here: add them with "+ New prospect".'));
  }
  return root;
}

/* --------------------------------------------------------- prospect --- */

function card(title, extra = '') {
  const c = el('section', `card pl-box ${extra}`.trim());
  c.appendChild(el('p', 'eyebrow', title));
  return c;
}

function row(label, value, href) {
  const r = el('div', 'pl-row');
  r.appendChild(el('span', 'pl-row__k', label));
  if (href) {
    const a = el('a', 'pl-row__v', value);
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    r.appendChild(a);
  } else {
    r.appendChild(el('span', 'pl-row__v', value || '—'));
  }
  return r;
}

/* ------------------------------------------------- questionnaire setup --- */

/**
 * Which questionnaire this prospect gets (F31): a template to start from, and
 * per prospect the sections and questions on or off, Andy's own questions,
 * and example videos. "Save as template" keeps the current setup by name.
 */
let setupOpen = false; // the "Tailor" panel stays open across saves

/** The questionnaire templates; the setup still works without the list. */
const readTemplates = () => apiFetch('/api/onboarding-templates').then((b) => b?.templates ?? []).catch(() => []);

async function questionnaireSetup(p, save, templatesRead = readTemplates()) {
  const config = structuredClone(p.config);
  const box = el('div', 'pl-setup');
  const top = el('div', 'pl-setup__top');
  const templates = await templatesRead;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const pick = el('select', 'text-input pl-setup__pick');
  pick.setAttribute('aria-label', 'Questionnaire template');
  const current = templates.find((tpl) => same(tpl.config, config));
  const custom = el('option', null, current ? 'Template…' : 'Tailored for this prospect');
  custom.value = '';
  pick.appendChild(custom);
  for (const tpl of templates) {
    const option = el('option', null, tpl.builtin ? tpl.name : `${tpl.name} (saved)`);
    option.value = tpl.id;
    pick.appendChild(option);
  }
  pick.value = current?.id ?? '';
  pick.addEventListener('change', () => {
    const tpl = templates.find((x) => x.id === pick.value);
    if (tpl) save(structuredClone(tpl.config), `Questionnaire · ${tpl.name}`);
  });
  const saveAs = el('button', 'btn small', 'Save as template');
  saveAs.type = 'button';
  saveAs.addEventListener('click', () => {
    const { modal, close } = openModal({ className: 'narrow pl-modal', label: 'Save as template' });
    modal.appendChild(el('h2', null, 'Save this questionnaire as a template'));
    const name = el('input', 'text-input');
    name.placeholder = 'Name, e.g. Chirurgien · site + réseaux';
    name.maxLength = 80;
    name.setAttribute('aria-label', 'Template name');
    modal.appendChild(name);
    const acts = el('div', 'pl-acts');
    const ok = el('button', 'btn primary', 'Save template');
    ok.type = 'button';
    ok.addEventListener('click', async () => {
      try {
        const { template } = await send('/api/onboarding-templates', 'POST', { name: name.value, config });
        close();
        toast(`Template saved · ${template.name}`);
      } catch (error) { toast(error?.message || 'Could not save the template'); }
    });
    const no = el('button', 'btn quiet', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', close);
    acts.append(ok, no);
    modal.appendChild(acts);
    queueMicrotask(() => name.focus());
  });
  top.append(pick, saveAs);
  // How the client gets it (22 Oct): on his own phone, one question per screen; « tu » or « vous ».
  const mode = el('div', 'pl-setup__mode');
  for (const [field, label, title] of [
    ['clientAnswers', 'The client answers on his phone', 'His onboarding link shows one question per screen, and he answers the choices too.'],
    ['tu', 'Say « tu »', 'The screens around the questions speak to him with « tu ».'],
  ]) {
    const row = el('label', 'pl-check is-small');
    row.title = title;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = Boolean(config[field]);
    box.addEventListener('change', () => {
      if (box.checked) config[field] = true; else delete config[field];
      save(config, `${label}: ${box.checked ? 'on' : 'off'}`);
    });
    row.append(box, el('span', null, label));
    mode.appendChild(row);
  }
  box.appendChild(top);
  box.appendChild(mode);

  // Tailor it: every section the library has, the ones in use first.
  const more = el('details', 'pl-setup__more');
  more.appendChild(el('summary', null, `Tailor the questions · ${config.sections.length} sections`));
  // Built only while open: a closed panel holds nothing (a folded form still
  // reports boxes in some browsers, which the layout gates read as overlaps).
  const body = el('div', 'pl-setup__body');
  const build = () => { body.replaceChildren(...tailorBlocks(config, save)); };
  more.addEventListener('toggle', () => {
    setupOpen = more.open;
    if (more.open) build(); else body.replaceChildren();
  });
  more.appendChild(body);
  if (setupOpen) { more.open = true; build(); }
  box.appendChild(more);
  return box;
}

/** One block per section of the library: on/off, its questions, Andy's own, the videos. */
function tailorBlocks(config, save) {
  const blocks = [];
  // Andy's own sections (c-…) sit beside the library's.
  const ownSections = Object.fromEntries((config.customSections ?? []).map((x) => [x.id, { id: x.id, fr: x.title, fields: [] }]));
  const all = { ...LIBRARY, ...ownSections };
  const order = [...config.sections, ...Object.keys(all).filter((id) => !config.sections.includes(id))];
  for (const sectionId of order) {
    const section = all[sectionId];
    if (!section) continue;
    const on = config.sections.includes(sectionId);
    const block = el('div', `pl-setup__sec${on ? '' : ' is-off'}`);
    const head = el('label', 'pl-check');
    const box1 = el('input');
    box1.type = 'checkbox';
    box1.checked = on;
    box1.addEventListener('change', () => {
      config.sections = box1.checked ? [...config.sections, sectionId] : config.sections.filter((x) => x !== sectionId);
      if (!config.sections.length) { box1.checked = true; toast('A questionnaire needs at least one section'); return; }
      save(config, `${box1.checked ? 'Added' : 'Removed'} · ${t(section, 'fr')}`);
    });
    head.append(box1, el('b', null, t(section, 'fr')));
    block.appendChild(head);
    if (on && sectionId !== 'inspiration') {
      const list = el('div', 'pl-setup__fields');
      for (const field of section.fields) {
        const label = t(field.short ?? field, 'fr') || t(field, 'fr');
        if (!label) continue;
        const row = el('label', 'pl-check is-small');
        const box2 = el('input');
        box2.type = 'checkbox';
        box2.checked = !config.off.includes(field.key);
        box2.addEventListener('change', () => {
          config.off = box2.checked ? config.off.filter((k) => k !== field.key) : [...config.off, field.key];
          save(config, `${box2.checked ? 'Shown' : 'Hidden'} · ${label}`);
        });
        row.append(box2, el('span', null, label));
        list.appendChild(row);
      }
      for (const own of config.custom.filter((q) => q.section === sectionId)) {
        const row = el('div', 'pl-check is-small is-own');
        const kind = { text: 'short text', long: 'long text', choice: 'one choice', chips: `several choices${own.max ? `, max ${own.max}` : ''}`, approve: 'to approve' }[own.type ?? 'long'];
        row.appendChild(el('span', null, `${own.label} · ${kind}${own.optional ? ' · optional' : ''}`));
        const drop = el('button', 'pl-text', 'Remove');
        drop.type = 'button';
        drop.addEventListener('click', () => { config.custom = config.custom.filter((q) => q.key !== own.key); save(config, 'Question removed'); });
        row.appendChild(drop);
        list.appendChild(row);
      }
      const add = el('form', 'pl-setup__add');
      const input = el('input', 'text-input');
      input.placeholder = 'Add your own question (free text)';
      input.maxLength = 300;
      input.setAttribute('aria-label', `Own question in ${t(section, 'fr')}`);
      const kind = el('select', 'text-input');
      kind.setAttribute('aria-label', 'Answer type');
      for (const [id, label] of [['long', 'Long text'], ['text', 'Short text']]) { const o = el('option', null, label); o.value = id; kind.appendChild(o); }
      const optional = el('label', 'pl-check is-small');
      const optBox = el('input');
      optBox.type = 'checkbox';
      optional.append(optBox, el('span', null, 'Optional'));
      const go = el('button', 'btn small', 'Add');
      go.type = 'submit';
      add.append(input, kind, optional, go);
      add.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!input.value.trim()) return;
        const key = `custom.${Date.now().toString(36).slice(-8)}`;
        config.custom = [...config.custom, { key, section: sectionId, label: input.value.trim(), type: kind.value, ...(optBox.checked ? { optional: true } : {}) }];
        save(config, 'Question added');
      });
      list.appendChild(add);
      block.appendChild(list);
    }
    if (on && sectionId === 'inspiration') {
      const list = el('div', 'pl-setup__fields');
      for (const [index, item] of config.media.entries()) {
        const row = el('div', 'pl-check is-small is-own');
        const tabName = INSPIRATION_KINDS.find(([id]) => id === exampleKind(item))?.[1] ?? '';
        row.appendChild(el('span', null, `${tabName} · ${item.title || item.url}`));
        const drop = el('button', 'pl-text', 'Remove');
        drop.type = 'button';
        drop.addEventListener('click', () => { config.media = config.media.filter((_, i) => i !== index); save(config, 'Example removed'); });
        row.appendChild(drop);
        list.appendChild(row);
      }
      list.appendChild(el('p', 'pl-sub', 'Each example shows as « Voir l’inspiration » next to its video option, and opens in a pop-up.'));
      const add = el('form', 'pl-setup__add is-media');
      const tab = el('select', 'text-input');
      tab.setAttribute('aria-label', 'Tab');
      for (const [id, label] of INSPIRATION_KINDS) { const o = el('option', null, label); o.value = id; tab.appendChild(o); }
      const url = el('input', 'text-input');
      url.placeholder = 'Link (YouTube, https://…mp4, Instagram…)';
      url.setAttribute('aria-label', 'Video link');
      const poster = el('input', 'text-input');
      poster.placeholder = 'Poster image link (optional)';
      poster.setAttribute('aria-label', 'Poster image link');
      const title = el('input', 'text-input');
      title.placeholder = 'Caption (optional)';
      title.maxLength = 120;
      title.setAttribute('aria-label', 'Caption');
      const go = el('button', 'btn small', 'Add example');
      go.type = 'submit';
      add.append(tab, url, poster, title, go);
      add.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!url.value.trim()) return;
        const item = { tab: tab.value, url: url.value.trim() };
        if (poster.value.trim()) item.poster = poster.value.trim();
        if (title.value.trim()) item.title = title.value.trim();
        config.media = [...config.media, item];
        save(config, 'Example added');
      });
      list.appendChild(add);
      block.appendChild(list);
    }
    blocks.push(block);
  }
  return blocks;
}

const tabOf = new Map(); // the tab each prospect page was last on

export async function renderProspect(ctx = {}, id) {
  ensurePipelineCss();
  const navigate = ctx.navigate;
  const root = el('div', 'pl pl-one');

  // Notes typed but not saved survive any redraw (audit 14): a stage move or
  // any other save used to rebuild the box from the server and drop them.
  let notesDraft = null;

  async function paint() {
    // The three reads go out together (audit 14); they used to run one after
    // the other, about 1.5 s from Lima.
    const clientsRead = apiFetch('/api/finance/clients').then((b) => b?.clients ?? []).catch(() => []);
    const templatesRead = readTemplates();
    const { prospect: p } = await apiFetch(`/api/prospects/${id}`);
    const patch = async (body, message = 'Saved') => {
      try {
        await send(`/api/prospects/${id}`, 'PATCH', body);
      } catch (error) {
        toast(error?.message || 'Could not save');
        return false;
      }
      if (body.notes !== undefined && notesDraft === body.notes) { notesDraft = null; clearDraft(`prospect-notes:${id}`); } // saved: the server's copy is the truth again
      toast(message);
      try { await paint(); } catch (error) { toast(error?.message || 'Could not reload'); }
      return true;
    };
    root.replaceChildren();

    // A client's onboarding goes back to the client's project; a deal to the pipeline.
    const isClient = Boolean(p.client_id);
    // A client is never a prospect (F1): the top menu marks Projects, where his project lives.
    if (typeof document !== 'undefined') {
      for (const b of document.querySelectorAll('button[data-path]')) {
        if (b.dataset.path === '/projects' || b.dataset.path === '/pipeline') {
          b.setAttribute('aria-current', String(b.dataset.path === (isClient ? '/projects' : '/pipeline')));
        }
      }
    }
    const back = el('button', 'back-link', isClient ? `← ${p.client_name}` : '← Pipeline');
    back.type = 'button';
    back.addEventListener('click', () => navigate?.(isClient && p.client_slug ? `/p/${p.client_slug}` : '/pipeline'));
    root.appendChild(back);

    const head = el('div', 'pl-head');
    const left = el('div');
    left.appendChild(el('h1', null, p.name));
    left.appendChild(el('p', 'pl-sub', [isClient ? `Client · ${p.client_name}` : p.organisation, p.brand === 'archive' ? identity().brandUgc : identity().brandWeb].filter(Boolean).join(' · ')));
    head.appendChild(left);
    root.appendChild(head);

    // Where the deal stands (F35): the stages in order, the current one lit,
    // and its one obvious next action beside it. Any step moves after a confirm.
    const moveTo = async (stageId) => {
      const target = STAGES.find((x) => x.id === stageId);
      if (await confirmClose(p, target)) patch({ stage: stageId }, `Moved to ${target.label}`);
    };
    const flowBox = el('section', 'pl-flow');
    const flow = el('ol', 'pl-flow__steps');
    flow.setAttribute('aria-label', 'Stage');
    const order = STAGES.filter((x) => x.id !== 'lost');
    const at = order.findIndex((x) => x.id === p.stage);
    order.forEach((stage, index) => {
      const li = el('li', `pl-flow__step${index < at ? ' is-done' : ''}${index === at ? ' is-current' : ''}`);
      const b = el('button');
      b.type = 'button';
      b.append(el('span', 'pl-flow__num', index < at ? '✓' : String(index + 1)), el('span', null, stage.label));
      if (index === at) b.setAttribute('aria-current', 'step');
      b.addEventListener('click', () => { if (stage.id !== p.stage) moveTo(stage.id); });
      li.appendChild(b);
      flow.appendChild(li);
    });
    flowBox.appendChild(flow);
    const flowActs = el('div', 'pl-flow__acts');
    const current = STAGES.find((x) => x.id === p.stage);
    if (p.stage === 'lost') flowActs.appendChild(el('span', 'pl-flow__lost', 'Lost · not this time'));
    if (current?.action) {
      const go = el('button', 'btn primary', current.action);
      go.type = 'button';
      go.addEventListener('click', () => {
        if (p.stage === 'lead') { showTab('info'); queueMicrotask(() => root.querySelector('.pl-next input[type="datetime-local"]')?.focus()); return; }
        if (p.stage === 'meeting') { openClientView(p.id, navigate); return; }
        moveTo(order[at + 1].id);
      });
      flowActs.appendChild(go);
    }
    if (p.stage !== 'lost' && p.stage !== 'won') {
      const lose = el('button', 'pl-text is-danger', 'Mark as lost');
      lose.type = 'button';
      lose.addEventListener('click', () => moveTo('lost'));
      flowActs.appendChild(lose);
    } else {
      const reopen = el('button', 'pl-text', 'Reopen');
      reopen.type = 'button';
      reopen.addEventListener('click', () => moveTo('lead'));
      flowActs.appendChild(reopen);
    }
    flowBox.appendChild(flowActs);
    // A client is not a deal: no stages, no « meeting held ? ».
    if (!isClient) root.appendChild(flowBox);

    // A meeting whose day has passed: ask, don't call it late (F35).
    if (!isClient && p.stage === 'meeting' && p.next_at && String(p.next_at).slice(0, 10) < localDay()) {
      const ask = el('section', 'pl-ask');
      ask.appendChild(el('p', null, `Meeting held on ${shortDay(p.next_at)}?`));
      const yes = el('button', 'btn primary small', 'Yes → Proposal in creation');
      yes.type = 'button';
      yes.addEventListener('click', () => patch({ stage: 'onboarding', next_step: 'Write the proposal', next_at: null }, 'Moved to Proposal in creation'));
      const later = el('button', 'btn small', 'Reschedule');
      later.type = 'button';
      later.addEventListener('click', () => { showTab('info'); queueMicrotask(() => root.querySelector('.pl-next input[type="datetime-local"]')?.focus()); });
      ask.append(yes, later);
      root.appendChild(ask);
    }

    // Two tabs (F35): the general info, and the onboarding.
    const tabs = el('div', 'pl-tabs');
    tabs.setAttribute('role', 'tablist');
    const panes = {};
    const showTab = (name) => {
      tabOf.set(id, name);
      for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.tab === name));
      for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== name;
    };
    for (const [key, label] of [['info', 'Info'], ['onboarding', 'Onboarding']]) {
      const b = el('button', 'pl-tab', label);
      b.type = 'button';
      b.dataset.tab = key;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => showTab(key));
      tabs.appendChild(b);
    }
    root.appendChild(tabs);

    const grid = el('div', 'pl-grid pl-grid--info');
    const left2 = el('div', 'pl-stack');
    const right = el('div', 'pl-stack pl-stack--end');

    /* next step */
    const next = card('Next step');
    const nextForm = el('div', 'pl-next');
    const step = el('input', 'text-input');
    step.value = p.next_step || '';
    step.placeholder = 'What happens next';
    step.setAttribute('aria-label', 'Next step');
    const when = el('input', 'text-input');
    when.type = 'datetime-local';
    when.value = p.next_at ? (p.next_at.length === 10 ? `${p.next_at}T09:00` : p.next_at) : '';
    when.setAttribute('aria-label', 'When');
    const zone = zonePick(p.next_tz);
    const saveNext = el('button', 'btn small', 'Save');
    saveNext.type = 'button';
    saveNext.addEventListener('click', () => patch({ next_step: step.value, next_at: when.value || null, next_tz: when.value ? zone.value : null }));
    nextForm.append(step, when, zone, saveNext);
    next.appendChild(nextForm);
    const label = whenLabel(p.next_at, localDay(), p.stage);
    if (label.text) next.appendChild(el('p', `pl-when td-due ${label.cls}`.trim(), label.text));
    // On both clocks, so 18:30 is never a guess (audit C14).
    if (p.next_tz && /T\d{2}:\d{2}/.test(String(p.next_at))) next.appendChild(el('p', 'pl-when pl-clock', zoneTimes(p.next_at, p.next_tz)));
    left2.appendChild(next);

    /* what the deal is worth (0031, audit E18): the pipeline's value on Reports */
    const worth = card('Value · €');
    const worthForm = el('div', 'pl-next pl-worth');
    const amount = el('input', 'text-input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '1';
    amount.inputMode = 'decimal';
    amount.placeholder = 'What the deal is worth (€)';
    amount.setAttribute('aria-label', 'Deal value in euros');
    amount.value = p.value_cents == null ? '' : String(Math.round(p.value_cents / 100));
    const saveWorth = el('button', 'btn small', 'Save');
    saveWorth.type = 'button';
    saveWorth.addEventListener('click', () => {
      const raw = amount.value.trim();
      const euros = raw === '' ? null : Number(raw);
      if (euros !== null && (!Number.isFinite(euros) || euros < 0)) { toast('The value is a positive amount in euros'); return; }
      patch({ value_cents: euros === null ? null : Math.round(euros * 100) }, euros === null ? 'Value cleared' : 'Value saved');
    });
    worthForm.append(amount, saveWorth);
    worth.appendChild(worthForm);
    left2.appendChild(worth);
    if(p.stage==='won')left2.appendChild(signedAgreementCard(p));

    /* the client this onboarding is for (0021): linked, it leaves the pipeline */
    const forClient = card('Client');
    const pick = el('select', 'text-input');
    pick.setAttribute('aria-label', 'Client');
    const none = el('option', null, 'Not a client yet (a prospect in the pipeline)');
    none.value = '';
    pick.appendChild(none);
    const clientList = await clientsRead;
    for (const c of clientList) { const o = el('option', null, c.name); o.value = String(c.id); pick.appendChild(o); }
    pick.value = p.client_id ? String(p.client_id) : '';
    pick.addEventListener('change', () => {
      const id = pick.value ? Number(pick.value) : null;
      const name = clientList.find((c) => c.id === id)?.name;
      patch({ client_id: id }, id ? `Now with the client ${name}: off the pipeline` : 'Back in the pipeline');
    });
    forClient.appendChild(pick);
    forClient.appendChild(el('p', 'pl-sub', 'A client’s onboarding shows on the client’s project page, not in the pipeline. The link and the answers stay the same.'));
    left2.appendChild(forClient);

    /* contact */
    const contact = card('Contact');
    contact.appendChild(row('Email', p.email || '—', p.email ? `mailto:${p.email}` : null));
    contact.appendChild(row('Phone', p.phone || '—', p.phone ? `tel:${p.phone.replace(/\s+/g, '')}` : null));
    contact.appendChild(row('Address', p.address || '—'));
    if (p.gmail_thread) contact.appendChild(row('Email thread', 'Open in Gmail', `https://mail.google.com/mail/u/0/#all/${p.gmail_thread}`));
    left2.appendChild(contact);

    /* the businesses this prospect brings */
    const biz = card('Businesses', 'pl-biz');
    const list = el('div', 'pl-entities');
    for (const entity of p.entities) {
      const item = el('div', 'pl-entity');
      const text = el('div');
      text.appendChild(el('b', null, entity.name));
      if (entity.kind) text.appendChild(el('small', null, entity.kind));
      if (entity.links?.length) {
        const links = el('div', 'pl-entity__links');
        for (const href of entity.links) {
          const a = el('a', null, href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          links.appendChild(a);
        }
        text.appendChild(links);
      }
      item.appendChild(text);
      const remove = el('button', 'pl-text', 'Remove');
      remove.type = 'button';
      let armed = false;
      remove.addEventListener('click', () => {
        if (!armed) { armed = true; remove.textContent = 'Really?'; return; }
        patch({ entities: p.entities.filter((e) => e.id !== entity.id) }, `Removed · ${entity.name}`);
      });
      item.appendChild(remove);
      list.appendChild(item);
    }
    if (!p.entities.length) list.appendChild(el('p', 'hint', 'One prospect can bring several businesses: a practice, a clinic, an academy. The questionnaire asks about each.'));
    biz.appendChild(list);
    const addForm = el('form', 'pl-add');
    const addName = el('input', 'text-input');
    addName.placeholder = 'Business name';
    addName.setAttribute('aria-label', 'Business name');
    const addKind = el('input', 'text-input');
    addKind.placeholder = 'What it is';
    addKind.setAttribute('aria-label', 'What it is');
    const addBtn = el('button', 'btn small', 'Add');
    addBtn.type = 'submit';
    addForm.append(addName, addKind, addBtn);
    addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!addName.value.trim()) { addName.focus(); return; }
      patch({ entities: [...p.entities, { name: addName.value, kind: addKind.value }] }, `Added · ${addName.value.trim()}`);
    });
    biz.appendChild(addForm);
    // A prospect's businesses (F2): not shown for a client, whose businesses are his project.
    if (!isClient) left2.appendChild(biz);

    /* onboarding */
    const ob = card('Onboarding', 'pl-ob');
    let priceBox = null;
    const sections = resolveSections(p.config);
    ob.appendChild(await questionnaireSetup(p, (config, message) => patch({ form_config: config }, message), templatesRead));
    const { done, total } = progress(p.onboarding, sections);
    const meter = el('div', 'pl-meter');
    const fill = el('i');
    fill.style.width = `${Math.round((done / total) * 100)}%`;
    meter.appendChild(fill);
    ob.appendChild(meter);
    ob.appendChild(el('p', 'pl-sub', `${done} of ${total} sections answered`));
    const obActs = el('div', 'pl-acts');
    const openForm = el('button', 'btn primary', 'Open the questionnaire ↗');
    openForm.type = 'button';
    openForm.title = 'The client’s page: white, full page, in its own window. To leave it, hold “Quitter” for 2 seconds.';
    openForm.addEventListener('click', () => openClientView(p.id, navigate));
    obActs.append(openForm);

    // The live mirror: a read-only page the client follows on his own screen
    // during a video call (/live/<token>, 7 days, no notes, no contact details).
    const liveOn = p.live_token && p.live_expires_at && p.live_expires_at > new Date().toISOString();
    const copyLive = el('button', 'btn', 'Copy onboarding link');
    copyLive.type = 'button';
    copyLive.title = 'A read-only page that follows this questionnaire as you fill it in. Works 7 days, no login.';
    copyLive.addEventListener('click', async () => {
      try {
        const { live } = await apiFetch(`/api/prospects/${id}/live`, { method: 'POST' });
        const until = new Date(live.expires_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        try {
          await navigator.clipboard.writeText(live.url);
          toast(`Onboarding link copied · works until ${until}`);
        } catch {
          // No clipboard (an older browser, no focus): show it to copy by hand.
          const { modal } = openModal({ className: 'narrow pl-modal', label: 'Onboarding link' });
          const field = el('input', 'text-input');
          field.readOnly = true;
          field.value = live.url;
          modal.append(el('h2', null, 'Onboarding link'), field, el('p', 'pl-sub', `Works until ${until}. Copy it, then paste it to the client.`));
          field.select();
        }
        if (!liveOn) paint();
      } catch (error) { toast(error?.message || 'Could not make the onboarding link'); }
    });
    obActs.append(copyLive);
    if (liveOn) {
      const stop = el('button', 'pl-text is-danger', 'Stop onboarding link');
      stop.type = 'button';
      stop.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/prospects/${id}/live`, { method: 'DELETE' });
          toast('Onboarding link stopped');
          paint();
        } catch (error) { toast(error?.message || 'Could not stop the onboarding link'); }
      });
      obActs.append(stop);
      const until = new Date(p.live_expires_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      ob.appendChild(obActs);
      ob.appendChild(el('p', 'pl-sub', `Onboarding link on · until ${until}`));
    } else {
      ob.appendChild(obActs);
    }
    // The budget, for Andy only: from what was ticked in "La formule" (pricing.js).
    if (p.config.sections.includes('format')) {
      const est = estimate(p.onboarding);
      const box = el('div', 'pl-budget');
      // The price points to read from during the call: with this, without that.
      box.appendChild(el('h3', null, 'Price points · for you only'));
      const tiers = el('dl', 'pl-tiers');
      for (const tier of PRICE_POINTS.tiers) {
        const dt = el('dt');
        dt.append(el('b', null, tier.label), el('small', null, tier.includes));
        tiers.append(dt, el('dd', null, priceText({ once: tier.once })));
      }
      tiers.append(el('dt', null, 'Hébergement et suivi'), el('dd', null, priceText({ monthly: PRICE_POINTS.monthly })));
      box.appendChild(tiers);
      // What this prospect was already told by email, so the meeting matches it.
      box.appendChild(el('h3', 'pl-budget__sub', 'From what is ticked'));
      if (!est.lines.length) box.appendChild(el('p', 'pl-sub', 'Nothing ticked in “La formule” yet.'));
      else {
        const dl = el('dl');
        for (const line of est.lines) { dl.appendChild(el('dt', null, line.label)); dl.appendChild(el('dd', line.pending ? 'is-pending' : null, priceText(line))); }
        box.appendChild(dl);
        const total = priceText(est);
        const priced = est.once || est.monthly;
        box.appendChild(el('p', 'pl-budget__total', `Total: ${[priced ? total : null, est.pending ? `${est.pending} à chiffrer` : null].filter(Boolean).join(' + ')}`));
      }
      box.appendChild(el('p', 'pl-sub', 'Never shown to the client. Prices: src/public/assets/pricing.js'));
      priceBox = box;
    }
    const groups = summarise(p.onboarding, p.entities, 'en', sections);
    if (groups.length) {
      const sum = el('div', 'pl-sum');
      // Each answer with when it came in: « reçu le » when the client answered it himself.
      const meta = p.onboarding_meta ?? {};
      const when = (at) => new Date(at).toLocaleString('fr-BE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      for (const group of groups) {
        sum.appendChild(el('h3', null, group.title));
        const dl = el('dl');
        for (const line of group.lines) {
          dl.appendChild(el('dt', null, line.label));
          const dd = el('dd', null, line.value);
          const m = line.key ? meta[line.key] : null;
          if (m?.at) dd.appendChild(el('small', `pl-sum__at${m.by === 'client' ? ' is-client' : ''}`, m.by === 'client' ? `reçu le ${when(m.at)}` : `noté le ${when(m.at)}`));
          dl.appendChild(dd);
        }
        sum.appendChild(dl);
      }
      ob.appendChild(sum);
    }
    const asked = sections.filter((x) => !x.info).flatMap((x) => x.fields).filter((f) => f.key && !['entities', 'entity', 'social', 'media'].includes(f.type));
    const open = asked.filter((f) => p.onboarding?.[f.key] === undefined).length;
    if (open) ob.appendChild(el('p', 'pl-sub', `${open} question${open > 1 ? 's' : ''} without an answer yet`));

    /* the lead it came from, and its missions */
    if (p.lead_uid) {
      const lead = card('From the leads');
      lead.appendChild(row('Lead', p.lead_name || p.lead_uid, `/leads?lead=${encodeURIComponent(p.lead_uid)}`));
      for (const m of p.missions) {
        lead.appendChild(row(m.status === 'done' ? 'Mission · done' : 'Mission', m.title, '/missions'));
      }
      right.appendChild(lead);
    }

    /* internal notes: never shown in safe view */
    const notes = card('Internal notes');
    const area = el('textarea', 'text-input pl-notes');
    // Also kept on this device, so a reload or a dropped connection loses nothing (audit D15).
    if (notesDraft === null) {
      const kept = readDraft(`prospect-notes:${id}`);
      if (kept && kept !== (p.notes || '')) notesDraft = kept; else if (kept) clearDraft(`prospect-notes:${id}`);
    }
    area.value = notesDraft ?? (p.notes || '');
    area.addEventListener('input', () => {
      notesDraft = area.value === (p.notes || '') ? null : area.value;
      writeDraft(`prospect-notes:${id}`, notesDraft ?? '');
    });
    area.rows = 6;
    area.setAttribute('aria-label', 'Internal notes');
    const saveNotes = el('button', 'btn small', 'Save notes');
    saveNotes.type = 'button';
    saveNotes.addEventListener('click', () => patch({ notes: area.value }, 'Notes saved'));
    notes.append(area, saveNotes);
    right.appendChild(notes);

    const danger = el('div', 'pl-danger');
    const del = el('button', 'pl-text is-danger', isClient ? 'Remove this onboarding' : 'Delete this prospect');
    del.type = 'button';
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = isClient ? 'Really remove? The answers go too.' : 'Really delete? The answers go too.'; return; }
      try {
        await apiFetch(`/api/prospects/${id}`, { method: 'DELETE' });
        toast(`${isClient ? 'Removed' : 'Deleted'} · ${p.name}`);
        navigate?.('/pipeline');
      } catch (error) { toast(error?.message || 'Could not delete'); }
    });
    danger.appendChild(del);
    right.appendChild(danger);

    grid.append(left2, right);
    panes.info = grid;
    const obGrid = el('div', 'pl-grid pl-grid--ob');
    const obSide = el('div', 'pl-stack');
    if (priceBox) { const prices = card('Prices'); prices.appendChild(priceBox); obSide.appendChild(prices); }
    obGrid.append(ob, obSide);
    panes.onboarding = obGrid;
    root.append(grid, obGrid);
    showTab(tabOf.get(id) ?? 'info');
  }

  await paint();
  return root;
}
