// To-dos: the things Andy has to do himself, each with a deadline. Home lists
// them with everything else that is his to do (a lead waiting on his answer,
// an invoice to chase); the Missions screen shows each mission's own. Both
// use what is here: the date badge, the order, the edit pop-up and the
// Google Calendar pop-up.

import { el } from './dom.js';
import { keepDraft } from './drafts.js';
import { apiFetch } from './api.js';
import { copyText, openModal, toast } from './leads-ui.js';
import { zoneTimes } from './dates.js';

export function ensureTodosCss() {
  if (typeof document === 'undefined' || document.getElementById('todos-css')) return;
  const link = document.createElement('link');
  link.id = 'todos-css';
  link.rel = 'stylesheet';
  link.href = '/assets/todos.css';
  document.head.appendChild(link);
}

/** Today on Andy's own clock (Brussels now, Lima from November), YYYY-MM-DD. */
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86400000);

/**
 * How a date reads on a row, and how loud. `late` is red, `today` and `soon`
 * (the next three days) amber, anything later quiet. No date reads nothing.
 */
export function dueBadge(due, today = localDay()) {
  const day = String(due ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { text: '', cls: '' };
  const diff = dayNumber(day) - dayNumber(today);
  if (diff < 0) return { text: `${-diff}d late`, cls: 'late' };
  if (diff === 0) return { text: 'Today', cls: 'today' };
  if (diff === 1) return { text: 'Tomorrow', cls: 'soon' };
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { text: label, cls: diff <= 3 ? 'soon' : '' };
}

/** Soonest first, undated last, then by the order they were made. */
export function byDue(a, b) {
  const da = a.due ? String(a.due).slice(0, 10) : '9999-12-31';
  const dbb = b.due ? String(b.due).slice(0, 10) : '9999-12-31';
  if (da !== dbb) return da < dbb ? -1 : 1;
  return (a.order ?? 0) - (b.order ?? 0);
}

const OPEN_MISSION = ['pending', 'in_progress', 'blocked'];

/**
 * Everything on Home's list, in order: what could not be loaded and any site
 * that is down first, then one list by date — Andy's to-dos, a lead whose
 * turn it is (or whose follow-up day has come), an invoice to chase, the
 * proposals to read and the cold follow-ups as one row each.
 */
export function homeItems({
  todos = [], missions = [], overview = {}, overdue = [], failures = [], down = [], prospects = [], today = localDay(),
} = {}) {
  const alerts = [];
  for (const f of failures) alerts.push({ kind: 'alert', title: `${f.source} could not be loaded`, sub: f.message, to: '/admin' });
  for (const p of down) alerts.push({ kind: 'alert', title: p.name, sub: p.state?.label || 'Down', to: `/p/${p.slug}` });

  const list = [];
  let order = 0;
  for (const todo of todos) {
    if (todo.done_at) continue;
    const sub = [todo.mission_title, todo.lead_name, todo.note ? String(todo.note).split('\n')[0] : null].filter(Boolean).join(' · ');
    list.push({ kind: 'todo', id: todo.id, title: todo.title, sub, due: todo.due, todo, order: order++ });
  }
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  for (const m of missions) {
    if (!m.lead_uid || !OPEN_MISSION.includes(m.status)) continue;
    // They replied: Andy's turn, the hottest money on the page, so it is on
    // Home today whatever its due date (audit C11, M2). Only « waiting for
    // their answer » waits for its follow-up day.
    const yours = m.turn === 'yours';
    if (!yours && m.due && String(m.due).slice(0, 10) > tomorrow) continue;
    list.push({
      kind: 'lead', id: m.id, uid: m.lead_uid, title: m.title, sub: 'Lead · opens the lead', due: yours ? today : (m.due || today),
      status: m.status, blocked_on: m.blocked_on ?? null,
      to: `/leads?lead=${encodeURIComponent(m.lead_uid)}`, order: order++,
    });
  }
  // A prospect's next step (a meeting, a proposal to send) from a week out.
  const weekOut = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  for (const p of prospects) {
    if (!p.next_at || ['won', 'lost'].includes(p.stage)) continue;
    const day = String(p.next_at).slice(0, 10);
    if (day > weekOut) continue;
    // On both clocks when the deal says whose time it is (audit C14).
    const time = zoneTimes(p.next_at, p.next_tz) || null;
    list.push({
      kind: 'link', title: `${p.next_step || 'Next step'} · ${p.name}`,
      sub: ['Pipeline', p.organisation, time].filter(Boolean).join(' · '),
      due: day, to: `/pipeline/${p.id}`, order: order++,
    });
  }
  for (const inv of overdue) {
    // Chased and put aside for a few days (audit B7): back on the list after.
    if (inv.chase_snoozed_until && inv.chase_snoozed_until > today) continue;
    list.push({
      kind: 'link', title: `Chase ${inv.number}${inv.subject ? ` · ${inv.subject}` : ''}`, sub: 'Invoice not paid',
      // The invoice's own dialog on Finance (record a payment, copy a reminder,
      // snooze), not the A4 print view, which was a dead end (audit M3, P8).
      due: inv.due_on, to: Number.isInteger(inv.id) ? `/finance?invoice=${inv.id}` : '/finance', order: order++,
    });
  }
  const proposed = missions.filter((m) => m.status === 'proposed').length;
  if (proposed) {
    list.push({
      kind: 'link', title: `${proposed} proposal${proposed === 1 ? '' : 's'} from replies`, sub: 'Accept or decline each one',
      due: today, to: '/missions', order: order++,
    });
  }
  const followups = Number(overview.followups_due ?? overview.followups?.length ?? 0);
  if (followups) {
    list.push({
      kind: 'link', title: `Follow up ${followups} lead${followups === 1 ? '' : 's'}`, sub: 'No answer yet to your last email',
      due: today, to: '/leads?tile=due', order: order++,
    });
  }
  list.sort(byDue);
  return [...alerts, ...list];
}

/** Home's list without the lead rows whose reply already has its card in
 *  « Replies first », so a reply shows (and counts) once. */
export function withoutShownReplies(items, shownUids = []) {
  const shown = new Set(shownUids);
  return items.filter((item) => !(item.kind === 'lead' && shown.has(item.uid)));
}

/* ------------------------------------------------------------ API --- */

const send = (url, method, body) => apiFetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

export const todosApi = {
  list: (query = '') => apiFetch(`/api/todos${query}`).then((r) => r?.todos ?? []),
  create: (body) => send('/api/todos', 'POST', body).then((r) => r.todo),
  update: (id, body) => send(`/api/todos/${id}`, 'PATCH', body).then((r) => r.todo),
  remove: (id) => apiFetch(`/api/todos/${id}`, { method: 'DELETE' }),
  setMissionDone: (id) => send(`/api/missions/${id}`, 'PATCH', { status: 'done' }),
  /** Back to how it was before a tick: blocked keeps its reason. */
  setMissionStatus: (id, status = 'pending', blockedOn = null) => send(`/api/missions/${id}`, 'PATCH',
    status === 'blocked' ? { status, blocked_on: blockedOn || 'blocked' } : { status }),
};

/* ------------------------------------------------------ the tick box --- */

/**
 * The round box on a row. Ticking says so in a toast with Undo, so a stray
 * click costs nothing.
 */
export function checkBox({ label, checked = false, onTick, onUndo }) {
  const box = el('button', `td-check${checked ? ' is-on' : ''}`);
  box.type = 'button';
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', String(checked));
  box.setAttribute('aria-label', label);
  box.title = checked ? 'Put it back on the list' : 'Done';
  box.addEventListener('click', async () => {
    box.disabled = true;
    try {
      await onTick(!checked);
    } catch (error) {
      box.disabled = false;
      toast(error?.message || 'Could not save');
      return;
    }
    if (!checked && onUndo) undoToast(label.replace(/^Done: /, 'Done · '), onUndo);
  });
  return box;
}

let undoNode = null;
let undoTimer = null;
/** A toast with one button, gone after six seconds. */
export function undoToast(message, onUndo) {
  undoNode?.remove();
  clearTimeout(undoTimer);
  const node = el('div', 'td-toast');
  node.setAttribute('role', 'status');
  node.appendChild(el('span', null, message));
  const undo = el('button', null, 'Undo');
  undo.type = 'button';
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    node.remove();
    try { await onUndo(); } catch (error) { toast(error?.message || 'Could not undo'); }
  });
  node.appendChild(undo);
  document.body.appendChild(node);
  undoNode = node;
  undoTimer = setTimeout(() => node.remove(), 6000);
}

/* ---------------------------------------------------- the quick add --- */

const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * One line to add a to-do: what, and by when. The date is a small button that
 * opens the system's date picker, so the words keep the room. Enter adds it.
 */
export function quickAdd({ missionId = null, placeholder = 'Add a to-do…', onAdded, compact = false }) {
  const form = el('form', `td-add${compact ? ' is-compact' : ''}`);
  const title = el('input', 'td-add__title');
  title.type = 'text';
  title.placeholder = placeholder;
  title.maxLength = 200;
  title.setAttribute('aria-label', 'New to-do');
  const due = el('input', 'td-add__due');
  due.type = 'date';
  due.tabIndex = -1;
  due.setAttribute('aria-hidden', 'true');
  const pick = el('button', 'td-add__pick', 'Date');
  pick.type = 'button';
  pick.title = 'Deadline (optional)';
  pick.setAttribute('aria-label', 'Deadline (optional)');
  const showDate = () => {
    pick.textContent = due.value ? shortDay(due.value) : 'Date';
    pick.classList.toggle('is-set', Boolean(due.value));
    pick.setAttribute('aria-label', due.value ? `Deadline ${shortDay(due.value)}` : 'Deadline (optional)');
  };
  pick.addEventListener('click', () => {
    try {
      if (typeof due.showPicker === 'function') { due.showPicker(); return; }
    } catch { /* not allowed here: fall back to the field itself */ }
    due.classList.add('is-shown');
    due.focus();
  });
  due.addEventListener('change', showDate);
  const add = el('button', 'btn primary small', 'Add');
  add.type = 'submit';
  form.append(title, pick, due, add);
  // A half-typed to-do survives a screen change, a reload or a failed save (audit D15, M9).
  const draft = keepDraft(title, `todo-add:${missionId ?? 'home'}`);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    add.disabled = true;
    try {
      const todo = await todosApi.create({ title: text, due: due.value || null, mission_id: missionId });
      title.value = '';
      draft.saved('');
      due.value = '';
      due.classList.remove('is-shown');
      showDate();
      toast(`Added · ${todo.title}`);
      await onAdded?.(todo);
    } catch (error) {
      toast(error?.message || 'Could not add it');
    } finally {
      add.disabled = false;
    }
  });
  return form;
}

/* ----------------------------------------------------- the pop-ups --- */

function modalHead(crumb, title, close) {
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.appendChild(el('div', 'crumb', crumb));
  heading.appendChild(el('h2', null, title));
  head.appendChild(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', close);
  nav.appendChild(x);
  head.appendChild(nav);
  return head;
}

function labelled(label, control) {
  const wrap = el('label', 'field');
  wrap.appendChild(el('span', 'label', label));
  wrap.appendChild(control);
  return wrap;
}

/**
 * Change a to-do: what, by when, which mission, a note. Delete is two steps.
 * `missions` is the list to choose from (open ones, and its own).
 */
export function openTodoEditor(todo, { missions = [], onSaved } = {}) {
  ensureTodosCss();
  // Unsaved edits are never dropped by a stray tap on the backdrop or Escape:
  // it asks first (audit D15, M9).
  let fields = null;
  const dirty = () => Boolean(fields) && (fields.title.value !== todo.title
    || fields.due.value !== (todo.due ? String(todo.due).slice(0, 10) : '')
    || fields.mission.value !== (todo.mission_id ? String(todo.mission_id) : '')
    || fields.note.value !== (todo.note || ''));
  const { modal, close, requestClose } = openModal({
    className: 'narrow td-modal', label: 'Change to-do',
    guard: () => !dirty() || window.confirm('Discard your changes to this to-do?'),
  });
  modal.appendChild(modalHead('To do', 'Change to-do', () => requestClose()));

  const title = el('input', 'text-input');
  title.type = 'text';
  title.value = todo.title;
  title.maxLength = 200;
  const due = el('input', 'text-input');
  due.type = 'date';
  due.value = todo.due ? String(todo.due).slice(0, 10) : '';
  const mission = el('select', 'text-input');
  const choices = missions.filter((m) => m.status !== 'proposed' && (m.status !== 'done' || m.id === todo.mission_id));
  for (const [value, text] of [['', 'No mission'], ...choices.map((m) => [String(m.id), m.title])]) {
    const option = el('option', null, text);
    option.value = value;
    mission.appendChild(option);
  }
  mission.value = todo.mission_id ? String(todo.mission_id) : '';
  const note = el('textarea', 'text-input');
  note.rows = 4;
  note.value = todo.note || '';
  fields = { title, due, mission, note };

  const form = el('div', 'td-form');
  form.appendChild(labelled('What', title));
  const row = el('div', 'td-form__row');
  row.appendChild(labelled('Deadline', due));
  row.appendChild(labelled('Mission', mission));
  form.appendChild(row);
  if (todo.lead_name) form.appendChild(el('p', 'td-form__lead', `About the lead ${todo.lead_name}`));
  form.appendChild(labelled('Note', note));
  modal.appendChild(form);

  const acts = el('div', 'td-form__acts');
  const save = el('button', 'btn primary', 'Save');
  save.type = 'button';
  const cancel = el('button', 'btn quiet', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => requestClose());
  const del = el('button', 'btn quiet td-del', 'Delete');
  del.type = 'button';
  let armed = false;
  del.addEventListener('click', async () => {
    if (!armed) { armed = true; del.textContent = 'Really delete?'; return; }
    del.disabled = true;
    try {
      await todosApi.remove(todo.id);
      close();
      toast(`Deleted · ${todo.title}`);
      await onSaved?.();
    } catch (error) {
      del.disabled = false;
      toast(error?.message || 'Could not delete it');
    }
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await todosApi.update(todo.id, {
        title: title.value,
        due: due.value || null,
        mission_id: mission.value ? Number(mission.value) : null,
        note: note.value,
      });
      close();
      toast('Saved');
      await onSaved?.();
    } catch (error) {
      save.disabled = false;
      toast(error?.message || 'Could not save');
    }
  });
  acts.append(save, cancel, del);
  modal.appendChild(acts);
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target !== note && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      save.click();
    }
  });
  queueMicrotask(() => title.focus());
}

/**
 * The private link Google Calendar subscribes to, with the one-click way in
 * and the by-hand way, and a button that replaces the link.
 */
export async function openCalendarLink() {
  ensureTodosCss();
  const { modal, close } = openModal({ className: 'narrow td-modal', label: 'Deadlines in Google Calendar' });
  modal.appendChild(modalHead('To do', 'Deadlines in Google Calendar', close));
  const body = el('div', 'td-cal');
  modal.appendChild(body);

  const paint = (links) => {
    body.replaceChildren();
    body.appendChild(el('p', null,
      'Add this private link to Google Calendar once. Every to-do and mission with a deadline shows up there as an '
      + 'all-day event, and disappears when you tick it off here. Google reads the link again every few hours, so a '
      + 'change can take that long to show.'));
    const field = el('input', 'text-input td-cal__url');
    field.type = 'text';
    field.readOnly = true;
    field.value = links.url;
    field.setAttribute('aria-label', 'Private calendar link');
    field.addEventListener('focus', () => field.select());
    body.appendChild(field);

    const acts = el('div', 'td-form__acts');
    const google = el('a', 'btn primary', 'Add to Google Calendar');
    google.href = links.google;
    google.target = '_blank';
    google.rel = 'noopener noreferrer';
    const copy = el('button', 'btn', 'Copy link');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(links.url, 'Calendar link'));
    const reset = el('button', 'btn quiet td-del', 'Make a new link');
    reset.type = 'button';
    reset.title = 'The old link stops working';
    let armed = false;
    reset.addEventListener('click', async () => {
      if (!armed) { armed = true; reset.textContent = 'The old link stops working. Sure?'; return; }
      reset.disabled = true;
      try {
        paint(await apiFetch('/api/calendar/link', { method: 'POST' }));
        toast('New link made. Add it to Google Calendar again.');
      } catch (error) {
        reset.disabled = false;
        toast(error?.message || 'Could not make a new link');
      }
    });
    acts.append(google, copy, reset);
    body.appendChild(acts);
    body.appendChild(el('p', 'td-cal__hint',
      'By hand: Google Calendar → Other calendars → + → From URL, then paste the link. Keep it to yourself: '
      + 'anyone with it can read your deadlines.'));
  };

  body.appendChild(el('p', null, 'Getting your link…'));
  try {
    paint(await apiFetch('/api/calendar/link'));
  } catch (error) {
    body.replaceChildren(el('p', null, 'The link could not be made.'));
    toast(error?.message || 'Could not load the calendar link');
  }
}
