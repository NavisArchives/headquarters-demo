// Missions — the goals. Every mission is its own card, in one of three
// columns: what is in hand, what a reply proposed, what is finished. A card
// holds the mission's own to-dos (todos.js), ticked off where they stand.
//
// The card carries everything about the mission on its face — what it is, one
// line of what it means, the project or lead it belongs to, the kind of task,
// its due date, what blocks it — and one big button that does the obvious
// next thing. Nothing opens a modal: the editor unfolds inside the card it
// belongs to, and Escape closes it.
//
// Capabilities kept from the list this replaces: create, title/detail/
// project/due, pending -> in_progress -> done, blocked with a required
// reason, delete, and a proposal's Accept / Decline with the reply's own
// words attached.

import { el, fillViewport } from '../dom.js';
import { parseDay } from '../dates.js';
import { missionToProject } from './orders.js';
import { openMyInfo } from './myinfo.js';
import { apiFetch, ApiError } from '../api.js';
import { fetchReviews, scanReplies } from '../replies-ui.js';
import {
  ensureTodosCss, todosApi, checkBox, quickAdd, openTodoEditor, dueBadge, localDay,
} from '../todos.js';

/** Load missions.css once, the way replies.css is loaded: index.html stays
 *  the layout agents' file. */
export function ensureMissionsCss() {
  if (typeof document === 'undefined' || document.getElementById('missions-css')) return;
  const link = document.createElement('link');
  link.id = 'missions-css';
  link.rel = 'stylesheet';
  link.href = '/assets/missions.css';
  document.head.appendChild(link);
}

/** The three columns, and which statuses live in which. `blocked` is an open
 *  mission that has stalled, so it sits with the work in hand rather than
 *  in a column of its own — the BLOCKED pill is what singles it out. */
export const COLUMN_OF = Object.freeze({
  pending: 'open',
  in_progress: 'open',
  blocked: 'open',
  proposed: 'proposed',
  done: 'done',
});

const OPEN_STATUSES = ['pending', 'in_progress', 'blocked'];
const DONE_CAP = 12;

/** The kinds of work a mission can be, in the owner's words. */
const KIND_FOR_ASK = Object.freeze({
  answer_question: 'answer',
  send_portfolio: 'send',
  send_rate: 'send',
  provide_details: 'send',
  sign_up: 'sign up',
  book_call: 'call',
  follow_up_later: 'follow-up',
});

const KIND_FROM_TITLE = [
  [/^answer\b/i, 'answer'],
  [/^(send|invoice|write|draft)\b/i, 'send'],
  [/\bsign up\b/i, 'sign up'],
  [/^(call|book a call|ring)\b/i, 'call'],
  [/\bfollow up\b/i, 'follow-up'],
];

/**
 * What kind of task this is. A reply-born mission knows it from the ask the
 * model read; anything the owner typed is read off its own first word, and
 * "custom" is an honest answer, not a failure.
 */
export function taskKind(mission, review = null) {
  const ask = review?.asks?.[0];
  if (ask && KIND_FOR_ASK[ask.kind]) return KIND_FOR_ASK[ask.kind];
  const title = String(mission?.title ?? '');
  for (const [pattern, kind] of KIND_FROM_TITLE) if (pattern.test(title)) return kind;
  return 'custom';
}

function errorMessage(error) {
  return error instanceof ApiError ? error.message : 'something went wrong';
}

const DAY = { day: 'numeric', month: 'long' };
function prettyDate(value) {
  if (!value) return '';
  const date = parseDay(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return new Intl.DateTimeFormat('en-GB', DAY).format(date);
}

/** Where a mission came from (missions.source); 'hq' — typed here — shows nothing. */
export const SOURCE_LABEL = Object.freeze({
  warm_lead: 'warm lead',
  reply: 'a reply',
  nirmata: 'NIRMATA',
  shortcut: 'Shortcut',
  email: 'email',
});

/** The month a mission was finished in, as YYYY-MM. */
const monthOf = (value) => String(value ?? '').slice(0, 7);

/** The first URL a mission carries in its own detail. A link read out of an
 *  email is shown and opened only when the owner asks for it. */
export function linkIn(text) {
  return /(https?:\/\/[^\s<>"']+)/.exec(String(text ?? ''))?.[1] ?? null;
}

/* ------------------------------------------------------------ editor --- */

function field(label, control) {
  const wrap = el('label', 'ms-field');
  wrap.appendChild(el('span', null, label));
  wrap.appendChild(control);
  return wrap;
}

function input(value, placeholder, type = 'text') {
  const node = el('input', 'ms-input');
  node.type = type;
  node.value = value ?? '';
  if (placeholder) node.placeholder = placeholder;
  node.setAttribute('aria-label', placeholder || 'field');
  return node;
}

function select(options, value) {
  const node = el('select', 'ms-input');
  for (const [optionValue, label] of options) {
    const option = el('option', null, label);
    option.value = optionValue;
    if (optionValue === value) option.setAttribute('selected', 'selected');
    node.appendChild(option);
  }
  node.value = value ?? '';
  return node;
}

const STATUS_OPTIONS = [
  ['pending', 'Ready to start'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];

/**
 * The one editor, used both for "Change" on an existing mission and for a new
 * mission at the top of the first column. Nothing here is a dialog: it is the
 * card, in edit mode.
 */
function missionEditor({ mission, projects, onDone, onCancel }) {
  const isNew = !mission;
  const wrap = el('div', 'ms-edit');

  const title = input(mission?.title, 'Mission title');
  const detail = input(mission?.detail, 'One line of what it means');
  const project = select(
    [['', 'No project'], ...projects.map((p) => [p.slug, p.name || p.slug])],
    mission?.slug ?? '',
  );
  const due = input(mission?.due ? String(mission.due).slice(0, 10) : '', 'Due date', 'date');
  const status = select(STATUS_OPTIONS, mission?.status && mission.status !== 'proposed' ? mission.status : 'pending');
  const blocked = input(mission?.blocked_on, 'What blocks it?');

  const blockedField = field('Blocked because', blocked);
  blockedField.hidden = !(mission?.status === 'blocked');
  status.addEventListener('change', () => { blockedField.hidden = status.value !== 'blocked'; });

  wrap.appendChild(field('Title', title));
  wrap.appendChild(field('Description', detail));
  wrap.appendChild(field('Project', project));
  wrap.appendChild(field('Due', due));
  if (!isNew) {
    wrap.appendChild(field('Status', status));
    wrap.appendChild(blockedField);
  }

  const err = el('p', 'ms-err');
  err.hidden = true;

  const acts = el('div', 'ms-edit-acts');
  const save = el('button', 'btn primary', isNew ? 'Create mission' : 'Save');
  save.type = 'button';
  const cancel = el('button', 'btn quiet', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  acts.appendChild(save);
  acts.appendChild(cancel);

  const fail = (message) => { err.textContent = message; err.hidden = false; };

  async function submit() {
    const name = String(title.value ?? '').trim();
    if (!name) { fail('title is required'); return; }

    const body = {
      title: name,
      detail: String(detail.value ?? '').trim(),
      slug: project.value ? project.value : null,
      due: due.value ? due.value : null,
    };

    if (!isNew) {
      const next = status.value;
      if (next !== mission.status) {
        // The same rule the database enforces, said before the request so the
        // owner reads it where they typed it.
        if (next === 'blocked' && !String(blocked.value ?? '').trim()) {
          fail('a blocked mission must say what blocks it');
          return;
        }
        body.status = next;
        if (next === 'blocked') body.blocked_on = String(blocked.value).trim();
      } else if (next === 'blocked') {
        const reason = String(blocked.value ?? '').trim();
        if (!reason) { fail('a blocked mission must say what blocks it'); return; }
        body.status = 'blocked';
        body.blocked_on = reason;
      }
    }

    save.disabled = true;
    err.hidden = true;
    try {
      await apiFetch(isNew ? '/api/missions' : `/api/missions/${mission.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await onDone();
    } catch (error) {
      save.disabled = false;
      fail(errorMessage(error));
    }
  }

  save.addEventListener('click', submit);

  // Escape closes the editor, wherever the cursor is inside it.
  const keys = (event) => {
    if (event.key === 'Escape') { onCancel(); return; }
    if (event.key === 'Enter' && event.target !== detail) {
      if (event.preventDefault) event.preventDefault();
      submit();
    }
  };
  for (const node of [title, detail, project, due, status, blocked]) node.addEventListener('keydown', keys);
  wrap.addEventListener('keydown', keys);

  wrap.appendChild(err);
  wrap.appendChild(acts);
  if (title.focus) queueMicrotask(() => title.focus());
  return wrap;
}

/* ----------------------------------------------------------- to-dos --- */

/** A mission's own to-dos, open first, and one line to add the next. */
function missionTodos(todos, mission, api) {
  const wrap = el('div', 'ms-todos');
  const done = todos.filter((t) => t.done_at).length;
  if (todos.length) wrap.appendChild(el('p', 'ms-todos__head', `To do · ${done} of ${todos.length} done`));
  const today = localDay();
  for (const todo of todos) {
    const row = el('div', `td-row is-todo${todo.done_at ? ' is-done' : ''}`);
    row.appendChild(checkBox({
      label: `Done: ${todo.title}`,
      checked: Boolean(todo.done_at),
      onTick: (now) => todosApi.update(todo.id, { done: now }).then(api.refresh),
      onUndo: () => todosApi.update(todo.id, { done: false }).then(api.refresh),
    }));
    const text = el('button', 'td-text');
    text.type = 'button';
    const title = el('b', null, todo.title);
    title.title = todo.title;
    text.appendChild(title);
    const sub = [todo.lead_name, todo.note ? String(todo.note).split('\n')[0] : null].filter(Boolean).join(' · ');
    if (sub) text.appendChild(el('small', null, sub));
    text.addEventListener('click', () => openTodoEditor(todo, { missions: api.missions(), onSaved: api.refresh }));
    row.appendChild(text);
    const badge = todo.done_at ? { text: '' } : dueBadge(todo.due, today);
    if (badge.text) row.appendChild(el('span', `td-due ${badge.cls}`.trim(), badge.text));
    wrap.appendChild(row);
  }
  // One small button until it is wanted, so a card stays a card.
  if (mission.status !== 'done') {
    const open = el('button', 'ms-text', '+ Add a to-do');
    open.type = 'button';
    open.addEventListener('click', () => {
      const form = quickAdd({
        missionId: mission.id, compact: true, placeholder: 'Add a to-do to this mission…', onAdded: api.refresh,
      });
      open.replaceWith(form);
      form.querySelector('input')?.focus();
    });
    wrap.appendChild(open);
  }
  return wrap;
}

/* -------------------------------------------------------------- card --- */

/**
 * One mission, whole. `view` is the mission plus the reply it came out of,
 * when it came out of one.
 */
function missionCard(view, api) {
  const { mission, review, projects } = view;
  const { status } = mission;
  const done = status === 'done';
  const proposed = status === 'proposed';

  const card = el('article', `ms-card${status === 'in_progress' ? ' is-doing' : ''}`
    + `${status === 'blocked' ? ' is-blocked' : ''}${done ? ' is-done' : ''}`);

  const err = el('p', 'ms-err');
  err.hidden = true;
  const fail = (error) => { err.textContent = errorMessage(error); err.hidden = false; };

  const editHost = el('div');
  let editing = false;
  const closeEditor = () => {
    editing = false;
    card.className = card.className.replace(' is-editing', '');
    editHost.replaceChildren();
  };
  api.registerEditor(closeEditor);

  const openEditor = () => {
    if (editing) { closeEditor(); return; }
    api.closeEditors();
    editing = true;
    card.className += ' is-editing';
    editHost.appendChild(missionEditor({
      mission, projects, onDone: api.refresh, onCancel: closeEditor,
    }));
  };

  // One person uses this, so the card carries no name and no assignee row.
  // The title is the way into the editor.
  const title = el('h3', 'ms-title');
  const titleBtn = el('button', 'ms-titlebtn', mission.title);
  titleBtn.type = 'button';
  titleBtn.title = 'Edit this mission';
  titleBtn.addEventListener('click', openEditor);
  title.appendChild(titleBtn);
  let doneHead = null;
  if (done) {
    const head = el('div', 'ms-head-done');
    doneHead = head;
    const check = el('span', 'ms-check', '✓');
    check.setAttribute('aria-hidden', 'true');
    head.appendChild(check);
    head.appendChild(title);
    card.appendChild(head);
  } else {
    card.appendChild(title);
  }

  // A lead's « your turn » mission leads with what they asked, not its stock detail.
  const description = (mission.lead_uid && review?.summary) || mission.detail || review?.summary || '';
  if (description) card.appendChild(el('p', 'ms-desc', description.split('\n')[0]));

  /* ---- chips (is-key: the ones a compact phone card keeps) ---- */
  const chips = el('div', 'ms-chips');
  if (mission.slug) {
    const project = projects.find((p) => p.slug === mission.slug);
    const chip = el('a', 'ms-chip is-key', `PROJECT · ${project?.name || mission.slug}`);
    chip.href = `/p/${mission.slug}`;
    chip.addEventListener('click', (event) => {
      if (!api.navigate) return;
      if (event?.preventDefault) event.preventDefault();
      api.navigate(`/p/${mission.slug}`);
    });
    chips.appendChild(chip);
  } else if (review) {
    chips.appendChild(el('span', 'ms-chip is-key', `LEAD · ${review.lead_name || review.from_email || 'Someone'}`));
  }
  chips.appendChild(el('span', 'ms-chip', `TASK · ${taskKind(mission, review)}`));
  // Where it came from, unless Andy typed it here himself.
  if (SOURCE_LABEL[mission.source]) chips.appendChild(el('span', 'ms-chip', `FROM · ${SOURCE_LABEL[mission.source]}`));
  if (mission.due) chips.appendChild(el('span', 'ms-chip is-key', `DUE · ${prettyDate(mission.due)}`));
  if (done && (mission.done_at || mission.updated_at)) {
    chips.appendChild(el('span', 'ms-chip', `COMPLETED · ${prettyDate(mission.done_at || mission.updated_at)}`));
  }
  if (status === 'blocked' && mission.blocked_on) {
    chips.appendChild(el('span', 'ms-chip ms-warn is-key', `BLOCKED · ${mission.blocked_on}`));
  }
  card.appendChild(chips);

  /* ---- its to-dos (a warm lead's mission gets them only when it has some) ---- */
  const todos = view.todos ?? [];
  if (!proposed && (todos.length || (!done && !mission.lead_uid))) card.appendChild(missionTodos(todos, mission, api));

  /* ---- their own words, folded away ---- */
  if (review?.body_excerpt) {
    const details = el('details');
    // Their turn is over and Andy must answer: their words are open, not folded away.
    if (mission.lead_uid && mission.turn === 'yours') details.open = true;
    details.appendChild(el('summary', null, 'What they wrote'));
    details.appendChild(el('p', null, review.body_excerpt));
    card.appendChild(details);
  }

  card.appendChild(editHost);

  /* ---- the actions ---- */
  const acts = el('div', 'ms-acts');

  const patch = async (button, body) => {
    button.disabled = true;
    err.hidden = true;
    try {
      await apiFetch(`/api/missions/${mission.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await api.refresh();
    } catch (error) {
      button.disabled = false;
      fail(error);
    }
  };

  if (proposed) {
    const accept = el('button', 'btn primary ms-go', 'Accept');
    accept.type = 'button';
    accept.addEventListener('click', () => patch(accept, { status: 'pending' }));
    acts.appendChild(accept);
  } else if (status === 'pending' || status === 'blocked') {
    const start = el('button', 'btn primary ms-go', 'Start mission');
    start.type = 'button';
    start.addEventListener('click', () => patch(start, { status: 'in_progress' }));
    acts.appendChild(start);
  } else if (status === 'in_progress') {
    const go = el('button', 'btn primary ms-go', 'Continue mission');
    go.type = 'button';
    go.addEventListener('click', () => {
      // A warm-lead mission opens its lead here, in this HQ — the local app
      // keeps the Gmail bridge; the link in the detail is for the phone.
      if (mission.lead_uid && api.navigate) { api.navigate(`/leads?lead=${encodeURIComponent(mission.lead_uid)}`); return; }
      const url = linkIn(mission.detail);
      if (url && api.openUrl) { api.openUrl(url); return; }
      if (mission.slug && api.navigate) { api.navigate(`/p/${mission.slug}`); return; }
      if (review && api.navigate) { api.navigate('/leads'); return; }
      // Nothing to open: the mission is the work, so the card takes focus.
      card.setAttribute('tabindex', '-1');
      if (card.focus) card.focus();
    });
    acts.appendChild(go);

    const markDone = el('button', 'btn ms-second', 'Mark done');
    markDone.type = 'button';
    markDone.addEventListener('click', () => patch(markDone, { status: 'done' }));
    acts.appendChild(markDone);
  }

  // Delete, in two steps: a mission is gone for good, so it is never one
  // stray click away.
  const dismiss = el('button', 'ms-text', proposed ? 'Decline' : 'Dismiss');
  dismiss.type = 'button';
  let armed = false;
  dismiss.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      dismiss.textContent = 'Really delete?';
      return;
    }
    dismiss.disabled = true;
    err.hidden = true;
    try {
      await apiFetch(`/api/missions/${mission.id}`, { method: 'DELETE' });
      await api.refresh();
    } catch (error) {
      dismiss.disabled = false;
      armed = false;
      dismiss.textContent = proposed ? 'Decline' : 'Dismiss';
      fail(error);
    }
  });
  acts.appendChild(dismiss);
  // A mission that turned out to be paid work: the client and the order are
  // opened from it, so the money and the work stay attached.
  if (!done && status !== 'proposed') {
    const toProject = el('button', 'ms-text', 'Make it a project');
    toProject.type = 'button';
    toProject.title = 'Open a client order from this mission';
    toProject.addEventListener('click', () => missionToProject(mission, { navigate: api.navigate, onChange: api.refresh }));
    acts.appendChild(toProject);
  }

  // On a phone the card is compact: title, chips, the next step. « Details »
  // unfolds the rest (description, to-dos, their words, the other actions).
  // Hidden on a desktop, where the card shows everything (P6).
  const more = el('button', 'ms-more', 'Details');
  more.type = 'button';
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    const open = !card.classList.contains('is-expanded');
    card.classList.toggle('is-expanded', open);
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Less' : 'Details';
  });
  // A finished card has no next step: its Details sits on the title's row.
  (doneHead ?? acts).appendChild(more);

  card.appendChild(acts);
  card.appendChild(err);
  return card;
}

/* ------------------------------------------------------------ screen --- */

function column(key, label, count, nodes, emptyLine, extra = null) {
  const col = el('div', `ms-col ms-col-${key}`);
  const eyebrow = el('p', 'ms-eyebrow', `${label} · ${count}`);
  col.appendChild(eyebrow);
  if (extra) col.appendChild(extra);
  // Only the cards scroll; the column's title and action stay put (Andy, 23 Oct).
  const list = el('div', 'ms-list scroll-region');
  if (!nodes.length) list.appendChild(el('p', 'ms-empty', emptyLine));
  for (const node of nodes) list.appendChild(node);
  col.appendChild(list);
  return col;
}

export async function renderMissions(ctx = {}) {
  ensureMissionsCss();
  ensureTodosCss();

  const fragment = document.createDocumentFragment();
  // The phone frame (P6): the page stays put, one list scrolls.
  const host = el('div', 'grid phone-frame ms-screen');
  fragment.appendChild(host);

  const navigate = typeof ctx.navigate === 'function' ? ctx.navigate : null;
  const projects = (ctx.store?.merged ?? []).map((p) => ({ slug: p.slug, name: p.name }));

  let filter = 'open';
  // On a phone one column shows at a time (P6). null until the first paint picks one.
  let segment = null;
  let showAllDone = false;
  let creating = false;

  const editors = [];
  const closeEditors = () => { for (const close of editors.splice(0)) close(); };

  const api = {
    navigate,
    refresh: () => refresh(),
    registerEditor: (close) => editors.push(close),
    closeEditors,
    missions: () => state.missions,
    openUrl: (url) => {
      if (typeof window !== 'undefined' && window.open) window.open(url, '_blank', 'noopener,noreferrer');
    },
  };

  function head(missions, doneThisMonth) {
    const wrap = el('div', 'ms-head');
    const left = el('div');
    left.appendChild(el('h1', null, 'Missions'));
    left.appendChild(el(
      'p',
      'ms-sub',
      `Goals, with the to-dos that get them done · ${doneThisMonth} done this month`,
    ));
    wrap.appendChild(left);

    const acts = el('div', 'ms-head-acts');
    const month = el('div', 'ms-month');
    month.appendChild(el('p', 'ms-eyebrow', 'This month'));
    const open = missions.filter((m) => OPEN_STATUSES.includes(m.status)).length;
    const target = doneThisMonth + open;
    const meter = el('div', 'ms-meter');
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', `${doneThisMonth} of ${target} done this month`);
    const fill = el('i');
    fill.style.width = `${target ? Math.round((doneThisMonth / target) * 100) : 0}%`;
    meter.appendChild(fill);
    meter.appendChild(el('span', null, `${doneThisMonth} of ${target} done`));
    month.appendChild(meter);
    acts.appendChild(month);

    const me = el('button', 'btn');
    me.append(el('span', 'lbl-long', 'My information'), el('span', 'lbl-short', 'My info'));
    me.setAttribute('aria-label', 'My information');
    me.type = 'button';
    me.title = 'Everything a creator or partner form asks for, ready to copy';
    me.addEventListener('click', () => { openMyInfo(); });
    acts.appendChild(me);

    const add = el('button', 'btn primary');
    add.append(el('span', 'lbl-long', '+ New mission'), el('span', 'lbl-short', '+ New'));
    add.setAttribute('aria-label', 'New mission');
    add.type = 'button';
    add.addEventListener('click', () => { creating = true; segment = 'open'; paint(); });
    acts.appendChild(add);
    wrap.appendChild(acts);
    return wrap;
  }

  function pills(missions) {
    const wrap = el('nav', 'ms-filters');
    wrap.setAttribute('aria-label', 'Filter missions');
    const counts = {
      open: missions.filter((m) => OPEN_STATUSES.includes(m.status)).length,
      blocked: missions.filter((m) => m.status === 'blocked').length,
    };
    for (const [key, label] of [['open', 'All open'], ['blocked', 'Blocked']]) {
      const pill = el('button', 'ms-filter', `${label} · ${counts[key]}`);
      pill.type = 'button';
      pill.setAttribute('aria-pressed', String(filter === key));
      pill.addEventListener('click', () => { filter = key; paint(); });
      wrap.appendChild(pill);
    }
    return wrap;
  }

  let state = {
    missions: [], reviewFor: new Map(), todosFor: new Map(), loadError: null, canRead: false, readNote: '', scanNote: '',
  };

  /** "Scan replies", kept from the tray this screen replaces: the proposals
   *  column is where a reading lands, so the button that starts one lives
   *  there. Disabled with the Worker's own reason, never with an error. */
  function scanBar() {
    const bar = el('div', 'ms-scan');
    const button = el('button', 'btn quiet small mac-only', 'Scan replies'); // needs the Mac: hidden on a phone (audit D17)
    button.type = 'button';
    const note = el('p', 'ms-empty', state.scanNote || (state.canRead ? '' : state.readNote));
    note.hidden = !note.textContent;
    if (!state.canRead) {
      button.disabled = true;
      button.title = `Reading replies ${state.readNote}`;
    } else {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const result = await scanReplies();
        state.scanNote = result.note;
        await refresh();
      });
    }
    bar.appendChild(button);
    bar.appendChild(note);
    return bar;
  }

  function paint() {
    const { missions, reviewFor, todosFor, loadError } = state;
    const stack = el('div', 'grid');

    const month = new Date().toISOString().slice(0, 7);
    const doneMissions = missions
      .filter((m) => m.status === 'done')
      .sort((a, b) => String(b.done_at || b.updated_at || '').localeCompare(String(a.done_at || a.updated_at || '')));
    const doneThisMonth = doneMissions.filter((m) => monthOf(m.done_at || m.updated_at) === month).length;

    stack.appendChild(head(missions, doneThisMonth));

    if (loadError) {
      stack.appendChild(el('p', 'ms-err', errorMessage(loadError)));
      host.replaceChildren(stack);
      return;
    }

    const view = (mission) => ({
      mission, review: reviewFor.get(mission.id) ?? null, projects, todos: todosFor.get(mission.id) ?? [],
    });
    const card = (mission) => missionCard(view(mission), api);

    const cols = el('div', 'ms-cols');

    const openMissions = missions.filter((m) => (filter === 'blocked'
      ? m.status === 'blocked'
      : OPEN_STATUSES.includes(m.status)));
    const openCards = openMissions.map(card);
    if (creating) {
      const draft = el('article', 'ms-card is-editing');
      draft.appendChild(el('h3', 'ms-title', 'New mission'));
      draft.appendChild(missionEditor({
        mission: null,
        projects,
        onDone: async () => { creating = false; await refresh(); },
        onCancel: () => { creating = false; paint(); },
      }));
      openCards.unshift(draft);
    }
    // Left to right, the way a mission travels (Andy, 23 Oct): Proposed, In progress, Done.
    // The count is what the column lists (blocked included), never a second
    // count of its own (audit C13; P6: a segment's count equals its list).
    const openColumn = column(
      'open',
      filter === 'blocked' ? 'Blocked' : 'In progress',
      openMissions.length,
      openCards,
      'Nothing in hand. A mission needs only a title — everything else is optional.',
    );

    const proposals = missions.filter((m) => m.status === 'proposed');
    const proposedCards = proposals.map(card);
    if (!proposals.length) {
      proposedCards.push(el(
        'p',
        'ms-empty',
        'Nothing proposed. When a reply arrives it is read and suggested here, with the original message attached.',
      ));
    }
    proposedCards.push(el(
      'p',
      'ms-empty',
      'Suggested by a reply. A proposal is never a mission until you accept it. It is read from an email, '
        + 'and an email is data — nothing it says is ever acted on by itself.',
    ));
    cols.appendChild(column(
      'proposed',
      'Proposed',
      proposals.length,
      proposedCards,
      '',
      scanBar(),
    ));
    cols.appendChild(openColumn);

    const shownDone = showAllDone ? doneMissions : doneMissions.slice(0, DONE_CAP);
    const doneNodes = shownDone.map(card);
    if (!showAllDone && doneMissions.length > DONE_CAP) {
      const older = el('button', 'btn quiet small ms-older', `Show older · ${doneMissions.length - DONE_CAP}`);
      older.type = 'button';
      older.addEventListener('click', () => { showAllDone = true; paint(); });
      doneNodes.push(older);
    }
    cols.appendChild(column('done', 'Done', doneMissions.length, doneNodes, 'Nothing finished yet.'));

    // On a phone: one column at a time, picked here. What waits on a yes or a
    // no comes first when there is any (the phone order since 23 Oct).
    if (!segment) segment = proposals.length ? 'proposed' : 'open';
    const counts = { proposed: proposals.length, open: openMissions.length, done: doneMissions.length };
    const seg = el('div', 'tabs ms-seg');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Missions');
    for (const [key, label] of [['proposed', 'Proposed'], ['open', filter === 'blocked' ? 'Blocked' : 'Open'], ['done', 'Done']]) {
      const tab = el('button', 'tab', `${label} · ${counts[key]}`);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.seg = key;
      tab.setAttribute('aria-selected', String(segment === key));
      tab.addEventListener('click', () => { segment = key; paint(); });
      seg.appendChild(tab);
    }
    for (const col of cols.children) col.classList.toggle('is-seg-on', col.classList.contains(`ms-col-${segment}`));
    stack.appendChild(seg);
    stack.appendChild(pills(missions));

    host.dataset.seg = segment;
    stack.appendChild(cols);
    host.replaceChildren(stack);
    // Each column's cards scroll on their own; the page and the titles stay put.
    for (const list of cols.querySelectorAll('.ms-list')) fillViewport(list);
  }

  async function refresh() {
    editors.length = 0;
    let missions = [];
    let loadError = null;
    try {
      const body = await apiFetch('/api/missions');
      missions = body?.missions ?? [];
    } catch (error) {
      loadError = error;
    }

    // A proposal is a mission row with `status: 'proposed'`; the reply it was
    // read out of lives on the replies route. One fetch joins them, so the
    // card can say who wrote and show their own words — quoted, never obeyed.
    const reviewFor = new Map();
    const { reviews, canRead, readNote } = await fetchReviews('open');
    for (const review of reviews) {
      for (const proposal of review.proposals ?? []) reviewFor.set(proposal.id, review);
    }
    // « They replied, your turn to answer » belongs to the lead, not to one reply:
    // give it that lead's newest real reply, so Andy reads it right there (19 Nov).
    const newestByLead = new Map();
    for (const review of reviews) {
      if (!review.uid || review.intent === 'auto_reply') continue;
      const at = review.received_at || review.reviewed_at || '';
      const seen = newestByLead.get(review.uid);
      if (!seen || at > (seen.received_at || seen.reviewed_at || '')) newestByLead.set(review.uid, review);
    }
    for (const mission of missions) {
      if (mission.lead_uid && !reviewFor.has(mission.id) && newestByLead.has(mission.lead_uid)) {
        reviewFor.set(mission.id, newestByLead.get(mission.lead_uid));
      }
    }

    // Each mission's to-dos. A list that cannot be read leaves the cards
    // without theirs; the missions themselves still show.
    const todosFor = new Map();
    try {
      for (const todo of await todosApi.list()) {
        if (!todo.mission_id) continue;
        if (!todosFor.has(todo.mission_id)) todosFor.set(todo.mission_id, []);
        todosFor.get(todo.mission_id).push(todo);
      }
    } catch { /* the cards show without their to-dos */ }

    state = { missions, reviewFor, todosFor, loadError, canRead, readNote, scanNote: state.scanNote };
    paint();
  }

  await refresh();
  return fragment;
}
