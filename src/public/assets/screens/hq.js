import { homeRepliesPanel } from './home-replies.js';
// Headquarters — the landing screen. Andy's to-do list (his own to-dos and
// everything else that is his to do, by date), the missions ring, money and
// leads; "recent activity" stays an honest empty state because there is no
// activity source yet.

import { autoSyncMailbox } from '../leads-gmail.js';
import { relativeTime } from '../lib.js';
import {
  el, hero, emptyState, attentionRow,
} from '../dom.js';
import { apiFetch } from '../api.js';
import { identity } from '../identity.js';
import { openBriefing, firstVisitToday, ensureBriefingCss } from '../briefing.js';
import { reachPills, ensureProjectStyles } from './projects.js';
import { shortMoney } from '../finance-lib.js';
import {
  ensureTodosCss, homeItems, withoutShownReplies, dueBadge, localDay, checkBox, quickAdd, openTodoEditor, openCalendarLink, todosApi,
} from '../todos.js';


function heroSub(status) {
  const day = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  if (status?.checkedAt) return `${day} · status checked ${relativeTime(status.checkedAt)}`;
  return `${day} · not yet synced`;
}

function firstNameFromEmail(email) {
  if (!email) return null;
  const local = email.split('@')[0];
  const token = local.split(/[._+-]+/)[0];
  return token ? token[0].toUpperCase() + token.slice(1) : null;
}

/**
 * Everything home needs, each source settled on its own.
 *
 * A rejected fetch is NOT an empty one. Every source that fails comes back as
 * a `failures` entry and is rendered as the first row of the to-do list —
 * fixing it is the first thing to do — instead of being folded into `[]` and
 * disappearing behind "Nothing to do" (final review B4).
 *
 * An overdue invoice is a to-do (chase it); "part 2 not yet invoiced" is NOT —
 * nobody is late, it is the owner's own choice when to send it, so it belongs
 * in the summary card instead.
 */
export async function loadHome(store) {
  const [missions, overview, financeOverview, overdue, todos, prospects] = await Promise.allSettled([
    apiFetch('/api/missions'),
    apiFetch('/api/overview'),
    apiFetch('/api/finance/overview'),
    apiFetch('/api/finance/invoices?status=overdue'),
    apiFetch('/api/todos?open=1'),
    apiFetch('/api/prospects'),
  ]);

  const failures = [];
  const note = (source, result) => {
    if (result.status !== 'rejected') return true;
    failures.push({ source, message: result.reason?.message || 'the request failed' });
    return false;
  };

  const todosOk = note('To-dos', todos);
  const prospectsOk = note('Pipeline', prospects);
  const missionsOk = note('Missions', missions);
  const overviewOk = note('Leads & follow-ups', overview);
  // Finance is two fetches but one source as far as the owner is concerned:
  // one row, not two, when the whole screen is down.
  if (financeOverview.status === 'rejected' && overdue.status === 'rejected') {
    note('Finance', financeOverview);
  } else {
    note('Finance overview', financeOverview);
    note('Overdue invoices', overdue);
  }
  // Shell data, fetched at boot: null means /api/status was not reached.
  if (!store?.status) failures.push({ source: 'Project status', message: 'status was not reached' });

  return {
    missions: missionsOk ? (missions.value?.missions ?? []) : [],
    missionsOk,
    overview: overviewOk ? overview.value : {},
    overviewOk,
    financeOverview: financeOverview.status === 'fulfilled' ? financeOverview.value : null,
    overdue: overdue.status === 'fulfilled' ? (overdue.value.invoices ?? []) : [],
    todos: todosOk ? (todos.value?.todos ?? []) : [],
    prospects: prospectsOk ? (prospects.value?.prospects ?? []) : [],
    failures,
  };
}

function activitySection(activity) {
  const section = el('section', 'card');
  section.appendChild(el('p', 'eyebrow', 'Recent activity'));
  if (!activity.length) section.appendChild(emptyState('No activity yet', 'Mission updates and lead activity will appear here.'));
  for (const item of activity) section.appendChild(attentionRow({ dot: 'd-idle', who: item.title, sub: item.kind, when: relativeTime(item.at) }));
  return section;
}

const monthOf = (value) => String(value ?? '').slice(0, 7);
const SHOT_KEY = 'hq.home.site';
const OPEN = ['in_progress', 'blocked', 'pending'];

function dotFor(kind) {
  if (kind === 'up' || kind === 'running') return 'd-ok';
  if (kind === 'down' || kind === 'failed') return 'd-bad';
  return kind ? 'd-warn' : 'd-idle';
}

/** A card with an eyebrow (and an optional link in it) and a body. */
function card(title, { link, linkTo, navigate, right, extraClass = '' } = {}) {
  const c = el('section', `card tight box ${extraClass}`.trim());
  const eyebrow = el('p', 'eyebrow');
  eyebrow.appendChild(document.createTextNode(title));
  if (link) {
    const a = el('a', null, link);
    a.href = linkTo;
    a.addEventListener('click', (e) => { e.preventDefault(); navigate?.(linkTo); });
    eyebrow.appendChild(a);
  } else if (right) {
    eyebrow.appendChild(el('span', 'n', right));
  }
  c.appendChild(eyebrow);
  return c;
}

/* ---------- the big figures beside the greeting ---------- */
function counts(home, todo, navigate) {
  const wrap = el('div', 'counts');
  const add = (value, label, to, warn = false) => {
    const b = el('button', `count${warn ? ' is-warn' : ''}`);
    b.type = 'button';
    b.appendChild(el('b', null, value));
    b.appendChild(el('i', null, label));
    b.addEventListener('click', () => navigate(to));
    wrap.appendChild(b);
    return b;
  };
  const open = home.missions.filter((m) => OPEN.includes(m.status)).length;
  // The to-do figure follows the list as things are ticked off.
  const todoButton = add(String(todo.count), 'to do', '/missions', todo.late > 0);
  todo.onCount = (count, late) => {
    todoButton.querySelector('b').textContent = String(count);
    todoButton.classList.toggle('is-warn', late > 0);
  };
  add(String(open), 'missions open', '/missions');
  add(home.overviewOk ? String(home.overview?.leads?.total ?? 0) : '—', 'leads', '/leads');
  return wrap;
}

/* ---------- the site card: one business at a time, a real screenshot ---------- */
function siteCard(store, navigate) {
  // Only a business with a live site has something to show here.
  const businesses = store.merged.filter((p) => p.kind === 'business' && p.links?.live?.url);
  const c = el('section', 'card tight sitecard');
  let current = businesses[0];
  try {
    const saved = localStorage.getItem(SHOT_KEY);
    current = businesses.find((p) => p.slug === saved) || current;
  } catch { /* private window */ }

  const frame = el('div', 'frame');
  const bar = el('div', 'frame__bar');
  const dots = el('span', 'frame__dots');
  dots.append(el('i'), el('i'), el('i'));
  bar.appendChild(dots);
  const url = el('span', 'frame__url');
  bar.appendChild(url);
  const tabs = el('div', 'frame__tabs');
  tabs.setAttribute('role', 'tablist');
  c.appendChild(tabs); // floating circles beside the card, not inside the window
  frame.appendChild(bar);
  const shot = el('div', 'frame__shot');
  frame.appendChild(shot);
  c.appendChild(frame);

  const row = el('div', 'site-row');
  const text = el('div');
  const h2 = el('h2');
  const desc = el('p');
  text.append(h2, desc);
  row.appendChild(text);
  const openBtn = el('button', 'btn primary', 'Open site');
  openBtn.type = 'button';
  row.appendChild(openBtn);
  c.appendChild(row);

  const facts = el('div', 'facts');
  c.appendChild(facts);

  function fact(dot, big, small, onClick) {
    const f = el(onClick ? 'button' : 'div', `fact${onClick ? ' is-link' : ''}`);
    if (onClick) { f.type = 'button'; f.addEventListener('click', onClick); }
    f.appendChild(el('i', dot));
    f.appendChild(el('b', null, big));
    f.appendChild(el('span', null, small));
    return f;
  }

  function paint() {
    if (!current) return;
    const live = current.links?.live?.url || '';
    url.textContent = live.replace(/^https?:\/\//, '').replace(/\/$/, '') || current.name;
    tabs.replaceChildren();
    for (const p of businesses) {
      // A floating circle: the initials, the name on hover.
      const initials = p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      const t = el('button', null, initials);
      t.type = 'button';
      t.title = p.name;
      t.setAttribute('aria-label', p.name);
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(p === current));
      t.addEventListener('click', () => { current = p; try { localStorage.setItem(SHOT_KEY, p.slug); } catch { /* */ } paint(); });
      tabs.appendChild(t);
    }
    shot.replaceChildren();
    shot.classList.remove('none');
    if (live) {
      const img = el('img');
      img.alt = `${current.name} — the live site`;
      img.src = `/assets/shots/${current.slug}.jpg`;
      img.addEventListener('error', () => { shot.classList.add('none'); shot.replaceChildren(el('span', null, 'No screenshot yet — run npm run shots')); });
      shot.appendChild(img);
    } else {
      shot.classList.add('none');
      shot.appendChild(el('span', null, 'Not live yet'));
    }
    h2.textContent = current.name;
    desc.textContent = current.description || '';
    openBtn.onclick = () => { if (live) window.open(live, '_blank', 'noopener'); };
    openBtn.disabled = !live;

    facts.replaceChildren();
    const state = current.state;
    facts.appendChild(fact(dotFor(state?.kind), state?.label || 'Unknown', state?.detail || (store.status ? 'status checked' : 'not checked'), () => navigate(`/p/${current.slug}`)));
    const admins = [current.links?.admin].flat().filter(Boolean);
    if (admins.length) {
      const a = admins[0];
      facts.appendChild(fact('d-ok', admins.length > 1 ? `${admins.length} admins` : 'Admin', a.how || a.url, () => window.open(a.url, '_blank', 'noopener')));
    } else {
      facts.appendChild(fact('d-idle', 'No admin', 'content lives in the repo'));
    }
    const local = current.links?.local;
    // Mac-only (audit D17, P12): a phone hides it.
    if (local?.url) {
      const localFact = fact('d-idle', 'Local', local.url.replace(/^https?:\/\//, ''), () => navigate(`/p/${current.slug}`));
      localFact.className = `${localFact.className} mac-only`;
      facts.appendChild(localFact);
    }
    else facts.appendChild(fact('d-idle', 'Hosted', current.hosted ? String(current.hosted).split(' — ')[0] : 'no local server'));
  }
  paint();
  return c;
}

/* ---------- clients: one row each, with the ways to reach them ---------- */
function clientsCard(store, navigate) {
  ensureProjectStyles();
  // Clients only: potential clients live on Projects and Pipeline, not here.
  const clients = store.merged.filter((p) => p.kind === 'client');
  const c = card('Clients', { right: `${clients.length}` });
  const scroll = el('div', 'scroll');
  const list = el('div', 'cl-list');
  for (const p of clients) {
    const row = el('div', 'cl-row');
    const open = el('button', 'cl-open');
    open.type = 'button';
    open.appendChild(el('i', `dot ${dotFor(p.state?.kind)}`));
    const text = el('span', 'cl-text');
    text.appendChild(el('b', null, p.name));
    text.appendChild(el('small', null, [p.kind === 'prospect' ? 'Potential client' : null, p.state?.label].filter(Boolean).join(' · ') || 'Client'));
    open.appendChild(text);
    open.addEventListener('click', () => navigate(`/p/${p.slug}`));
    row.appendChild(open);
    row.appendChild(reachPills(p, navigate));
    list.appendChild(row);
  }
  scroll.appendChild(list);
  c.appendChild(scroll);
  return c;
}

/* ---------- the missions ring ---------- */
function ringCard(missions, ok, navigate) {
  const c = card('Missions', { link: 'All →', linkTo: '/missions', navigate });
  const thisMonth = monthOf(new Date().toISOString());
  const done = missions.filter((m) => m.status === 'done' && monthOf(m.done_at) === thisMonth).length;
  const active = missions.filter((m) => m.status === 'in_progress').length;
  const blocked = missions.filter((m) => m.status === 'blocked').length;
  const ready = missions.filter((m) => m.status === 'pending').length;
  const proposed = missions.filter((m) => m.status === 'proposed').length;
  const target = done + active + blocked + ready;
  const pct = target ? Math.round((done / target) * 100) : 0;

  const ring = el('div', 'ring');
  const r = 45; const circ = 2 * Math.PI * r;
  ring.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring__track" cx="50" cy="50" r="${r}"></circle><circle class="ring__fill" cx="50" cy="50" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - pct / 100)).toFixed(1)}"></circle></svg>`;
  const centre = el('div', 'ring__centre');
  centre.appendChild(el('b', null, ok ? `${pct}%` : '—'));
  centre.appendChild(el('span', null, 'done'));
  ring.appendChild(centre);
  c.appendChild(ring);

  const legend = el('div', 'ring__legend');
  const line = (cls, n, label) => { const d = el('div'); d.append(el('i', cls), el('b', null, String(n)), document.createTextNode(label)); return d; };
  legend.appendChild(line('l-in', active, 'in progress'));
  legend.appendChild(line('l-blocked', blocked, 'blocked'));
  legend.appendChild(line('l-ready', ready, 'ready to start'));
  if (proposed) legend.appendChild(line('l-proposed', proposed, 'proposals to read'));
  c.appendChild(legend);
  c.title = `${done} of ${target} done this month`;
  return c;
}

/* ---------- to do: Andy's own list, by date ---------- */

/** One row: a tick box (or a dot for what is ticked off elsewhere), the
 *  words, and the date. */
function todoRow(item, { navigate, refresh, missions, today }) {
  const row = el('div', `td-row is-${item.kind}`);
  if (item.kind === 'todo') {
    row.appendChild(checkBox({
      label: `Done: ${item.title}`,
      onTick: (done) => todosApi.update(item.id, { done }).then(refresh),
      onUndo: () => todosApi.update(item.id, { done: false }).then(refresh),
    }));
  } else if (item.kind === 'lead') {
    // A lead's turn is a mission; ticking it finishes the mission, and Undo
    // puts it back exactly as it was.
    row.appendChild(checkBox({
      label: `Done: ${item.title}`,
      onTick: () => todosApi.setMissionDone(item.id).then(refresh),
      onUndo: () => todosApi.setMissionStatus(item.id, item.status, item.blocked_on).then(refresh),
    }));
  } else {
    row.appendChild(el('i', `td-dot${item.kind === 'alert' ? ' is-bad' : ''}`));
  }
  const text = el('button', 'td-text');
  text.type = 'button';
  const title = el('b', null, item.title);
  title.title = item.title;
  text.appendChild(title);
  if (item.sub) {
    const sub = el('small', null, item.sub);
    sub.title = item.sub;
    text.appendChild(sub);
  }
  text.addEventListener('click', () => {
    if (item.kind === 'todo') openTodoEditor(item.todo, { missions, onSaved: refresh });
    else navigate?.(item.to);
  });
  row.appendChild(text);
  if (item.kind === 'alert') {
    row.appendChild(el('span', 'td-due late', '!'));
  } else {
    const badge = dueBadge(item.due, today);
    if (badge.text) row.appendChild(el('span', `td-due ${badge.cls}`.trim(), badge.text));
  }
  return row;
}

/** The list, or the empty state. Exported for the tests. */
export function todoSection(items, { navigate, refresh = async () => {}, missions = [], today = localDay() } = {}) {
  if (!items.length) {
    return emptyState('Nothing to do', 'Add what you have to do above. Anything with a deadline also shows up in your Google Calendar.');
  }
  const list = el('div', 'td-list');
  for (const item of items) list.appendChild(todoRow(item, { navigate, refresh, missions, today }));
  return list;
}

function todoCard(store, home, navigate, replies) {
  ensureTodosCss();
  const c = card('To do', { right: '0', extraClass: 'td-card' });
  const countNode = c.querySelector('.eyebrow .n');
  const down = store.merged.filter((p) => p.state?.kind === 'down' || p.state?.kind === 'failed');
  const body = el('div', 'scroll');
  const state = { count: 0, late: 0, onCount: null };

  function paint() {
    const today = localDay();
    let shown = [];
    try { shown = JSON.parse(replies.dataset.replyUids || '[]'); } catch { /* none shown */ }
    const items = withoutShownReplies(homeItems({
      todos: home.todos, missions: home.missions, overview: home.overview,
      overdue: home.overdue, failures: home.failures, down, prospects: home.prospects, today,
    }), shown);
    const replyCount = Number(replies.dataset.attentionCount || 0);
    state.count = items.length + replyCount;
    state.late = items.filter((i) => i.kind === 'alert' || dueBadge(i.due, today).cls === 'late').length;
    countNode.textContent = state.count ? String(state.count) : 'clear';
    body.replaceChildren(replies, !items.length && replyCount
      ? el('p', 'hint', 'No other to-dos.')
      : todoSection(items, { navigate, refresh, missions: home.missions, today }));
    state.onCount?.(state.count, state.late);
  }

  // A tick or an edit redraws this card only; the rest of Home stays put.
  async function refresh() {
    const [todos, missions] = await Promise.allSettled([todosApi.list('?open=1'), apiFetch('/api/missions')]);
    if (todos.status === 'fulfilled') home.todos = todos.value;
    if (missions.status === 'fulfilled') home.missions = missions.value?.missions ?? home.missions;
    paint();
  }

  replies.addEventListener('hq:reply-count', paint);
  c.appendChild(quickAdd({ onAdded: refresh }));
  c.appendChild(body);
  const cta = el('div', 'cta');
  const calendar = el('button', 'btn quiet', 'Calendar');
  calendar.type = 'button';
  calendar.title = 'Your deadlines in Google Calendar';
  calendar.addEventListener('click', () => { openCalendarLink(); });
  const btn = el('button', 'btn primary', 'Open missions');
  btn.type = 'button';
  btn.addEventListener('click', () => navigate('/missions'));
  cta.append(calendar, btn);
  c.appendChild(cta);
  paint();
  return { card: c, state, body };
}

/* ---------- money: the three figures and the last six months ---------- */
function statButton(value, label, to, navigate, cls = '') {
  const b = el('button', `stat ${cls}`.trim());
  b.type = 'button';
  b.appendChild(el('b', null, value));
  b.appendChild(el('span', null, label));
  b.addEventListener('click', () => navigate(to));
  return b;
}

function moneyCard(home, navigate) {
  const c = card('Money', { link: 'Finance →', linkTo: '/finance', navigate });
  const f = home.financeOverview;
  if (!f) { c.appendChild(el('p', 'hint', 'Finance could not be loaded.')); return c; }
  const stats = el('div', 'stats');
  stats.appendChild(statButton(shortMoney(f.paid_this_year_cents || 0), 'paid this year', '/finance', navigate, 's-live'));
  stats.appendChild(statButton(shortMoney(f.outstanding_cents || 0), 'outstanding', '/finance', navigate, f.outstanding_cents > 0 ? 's-warn' : ''));
  if (f.not_yet_requested_cents > 0) stats.appendChild(statButton(shortMoney(f.not_yet_requested_cents), 'not yet invoiced', '/finance', navigate, 'wide'));
  c.appendChild(stats);

  // Six months of what was invoiced (by issue date), the current month last.
  // Cash received by month is part E of the audit (F9); this says what it is.
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const byMonth = new Map((f.by_month || []).map((m) => [m.month, m.cents]));
  const max = Math.max(1, ...months.map((m) => byMonth.get(m) || 0));
  const wrap = el('div', 'bars__wrap');
  const bars = el('div', 'bars');
  months.forEach((m, i) => {
    const cents = byMonth.get(m) || 0;
    const bar = el('i', i === months.length - 1 ? 'is-now' : '');
    bar.style.height = `${Math.max(6, Math.round((cents / max) * 100))}%`;
    bar.title = `${shortMoney(cents)} · ${new Date(`${m}-01T00:00:00`).toLocaleDateString('en', { month: 'short', year: 'numeric' })}`;
    bars.appendChild(bar);
  });
  wrap.appendChild(bars);
  const labels = el('div', 'bars__labels');
  // This month's figure printed, not only in a hover tooltip a phone never
  // shows (audit D17, P9).
  const thisMonth = byMonth.get(months[months.length - 1]) || 0;
  labels.append(el('span', null, new Date(`${months[0]}-01T00:00:00`).toLocaleDateString('en', { month: 'short' })), el('span', null, `this month · ${shortMoney(thisMonth)} invoiced`));
  wrap.appendChild(labels);
  c.appendChild(wrap);
  return c;
}

/* ---------- leads: the pipeline figures and what happened last ---------- */
function leadsCard(home, navigate) {
  // It opens Leads, so it says Leads; « Pipeline » is the deals board (audit M10).
  const c = card('Leads', { link: 'Leads →', linkTo: '/leads', navigate });
  const leads = home.overview?.leads;
  const stats = el('div', 'stats');
  if (home.overviewOk) {
    stats.appendChild(statButton(String(leads?.total ?? 0), 'in the pipeline', '/leads', navigate));
    stats.appendChild(statButton(String(leads?.conversations ?? 0), 'conversations', '/leads', navigate, 's-live'));
    stats.appendChild(statButton(String(leads?.won ?? 0), 'accepted', '/leads', navigate, 'wide'));
  } else {
    stats.appendChild(statButton('—', 'leads not loaded', '/leads', navigate, 'wide s-warn'));
  }
  c.appendChild(stats);
  const scroll = el('div', 'scroll');
  const activity = home.overview?.activity ?? [];
  const rows = el('div', 'rows');
  for (const item of activity.slice(0, 5)) rows.appendChild(attentionRow({ dot: 'd-idle', who: item.title, sub: item.kind, when: relativeTime(item.at) }));
  if (activity.length) scroll.appendChild(rows);
  c.appendChild(scroll);
  return c;
}

export async function renderHQ(ctx) {
  const { store } = ctx;
  const root = el('div', 'home');

  // Behind the password gate there is no email to read a name from; this
  // is a one-owner dashboard, so the owner's first name is the fallback.
  const name = firstNameFromEmail(store.email) || identity().owner;
  const home = await loadHome(store);

  const todo = todoCard(store, home, ctx.navigate, await homeRepliesPanel());

  const top = el('div', 'home-hero');
  const heroNode = hero('Welcome back,', name, heroSub(store.status));
  // The morning briefing: by itself on the first visit of the day, and here on demand.
  const again = el('button', 'home-briefing', 'Briefing');
  again.type = 'button';
  again.title = "Today's money first, then the pipeline, the leads, the emails and the changes since yesterday";
  again.addEventListener('click', () => openBriefing(ctx, { name }));
  const subLine = heroNode.querySelector('.sub');
  if (subLine) subLine.append(' · ', again); else heroNode.appendChild(again);
  const outreach=el('button','home-briefing','Outreach');
  outreach.type = 'button';
  outreach.addEventListener('click', () => ctx.navigate('/outreach?view=today'));
  // Beside Briefing on the date line; on a phone Outreach is in the bottom bar.
  if (subLine) subLine.append(' · ', outreach); else heroNode.appendChild(outreach);
  top.appendChild(heroNode);
  // On a phone the date line is folded away (P6); the briefing keeps its button beside the greeting.
  const againPhone = el('button', 'home-briefing home-briefing--phone', 'Briefing');
  againPhone.type = 'button';
  againPhone.addEventListener('click', () => openBriefing(ctx, { name }));
  top.appendChild(againPhone);
  // On a phone it never opens by itself: a splash and a panel to close before
  // Home can be touched cost Andy every first visit (audit D17, P4). The
  // Briefing button above opens it when he wants it.
  const phone = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !phone && firstVisitToday()) {
    ensureBriefingCss();
    setTimeout(() => { if (root.isConnected) openBriefing(ctx, { name }); }, 300);
  }
  top.appendChild(counts(home, todo.state, ctx.navigate));
  root.appendChild(top);

  // On a phone (P6) the big figures become segments: one pane at a time, the
  // page still, one list scrolling. Each count is the one its pane shows.
  const panes = el('div', 'tabs home-seg');
  panes.setAttribute('role', 'tablist');
  panes.setAttribute('aria-label', 'Home');
  root.appendChild(panes);

  const main = el('div', 'home-main');
  const pane = (node, key, order = 0) => { node.dataset.pane = key; if (order) node.dataset.paneOrder = String(order); return node; };
  const left = el('div', 'home-left');
  left.appendChild(pane(siteCard(store, ctx.navigate), 'money', 3));
  left.appendChild(pane(clientsCard(store, ctx.navigate), 'money', 2));
  main.appendChild(left);
  const right = el('div', 'home-right');
  right.appendChild(pane(ringCard(home.missions, home.missionsOk, ctx.navigate), 'missions'));
  right.appendChild(pane(todo.card, 'todo'));
  right.appendChild(pane(moneyCard(home, ctx.navigate), 'money', 1));
  right.appendChild(pane(leadsCard(home, ctx.navigate), 'leads'));
  main.appendChild(right);
  root.appendChild(main);

  root.classList.add('phone-frame');
  const openCount = home.missions.filter((m) => OPEN.includes(m.status)).length;
  const leadsCount = home.overviewOk ? String(home.overview?.leads?.total ?? 0) : '—';
  let seg = 'todo';
  const tabs = {};
  const showPane = (key) => {
    seg = key;
    root.dataset.seg = key;
    for (const [k, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(k === key));
    // The one region that scrolls: the to-do list itself (the quick-add stays
    // on top), or the pane area for the others.
    todo.body.classList.toggle('scroll-region', key === 'todo');
    main.classList.toggle('scroll-region', key !== 'todo');
  };
  for (const [key, label] of [['todo', 'To do'], ['missions', 'Missions'], ['leads', 'Leads'], ['money', 'Money']]) {
    const tab = el('button', 'tab');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.dataset.seg = key;
    tab.appendChild(el('span', 'l', label));
    const n = { todo: String(todo.state.count), missions: String(openCount), leads: leadsCount }[key];
    if (n !== undefined) tab.appendChild(el('span', 'n', n));
    tab.addEventListener('click', () => showPane(key));
    tabs[key] = tab;
    panes.appendChild(tab);
  }
  // The to-do figure follows the list as things are ticked off, here as in the counts.
  const countsOnCount = todo.state.onCount;
  todo.state.onCount = (count, late) => {
    countsOnCount?.(count, late);
    tabs.todo.querySelector('.n').textContent = String(count);
  };
  showPane(seg);

  // The no-scroll contract needs the real distance to the top of the page
  // and whatever is drawn under the dashboard, known once the header has
  // laid out. Measured after mount and on resize; CSS has a fallback.
  const measure = () => {
    if (!root.isConnected) { window.removeEventListener('resize', measure); return; }
    const rect = root.getBoundingClientRect();
    const top = Math.round(rect.top + window.scrollY);
    const below = Math.max(0, Math.round(document.documentElement.scrollHeight - (top + rect.height)));
    root.style.setProperty('--home-top', `${top}px`);
    root.style.setProperty('--home-below', `${below}px`);
  };
  window.addEventListener('resize', measure);
  requestAnimationFrame(measure);

  // Read the mailbox in the background; if it moved anything, draw Home again
  // so the to-do list and the missions show who wrote last. Never while Andy
  // is in the middle of something (audit 13): a redraw closed open dialogs and
  // wiped what he was typing. It waits until he is done, then redraws.
  autoSyncMailbox().then((result) => {
    if (!result || !(result.applied || result.updated)) return;
    const redraw = () => {
      if (!root.isConnected) return;
      if (homeIsBusy(root)) { setTimeout(redraw, 1500); return; }
      ctx.navigate?.(window.location.pathname, { replace: true });
    };
    redraw();
  }).catch(() => {});
  return root;
}

/** True while a redraw would lose something: a dialog or pop-up is open, the
 *  cursor is in a field, or a field on Home holds text that was not saved. */
export function homeIsBusy(root, doc = document) {
  if (doc.querySelector('.scrim, dialog[open], [role="dialog"]')) return true;
  const active = doc.activeElement;
  if (active && active !== doc.body && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return true;
  for (const field of root.querySelectorAll('input, textarea')) {
    if (field.type === 'checkbox' || field.type === 'radio') continue;
    if (field.value !== field.defaultValue) return true;
  }
  return false;
}
