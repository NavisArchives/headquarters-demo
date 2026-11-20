import { apiFetch } from '../api.js';
import { toast } from '../leads-ui.js';
import { keepDraft } from '../drafts.js';
import { input, button, send, notice } from '../forms.js';
// Projects — the registry, grouped, with real status pills; and the project
// detail screen at /p/<slug>.
//
// The one question this screen exists to answer, for every project: if I press
// on it, where can I reach it? Live, Admin, Local, Tools — always four rows,
// and a missing fact is written out as a missing fact, never left blank.

import { relativeTime } from '../lib.js';
import { openLocal, labLinks, serviceFor, serviceState, lanUrl } from '../local-launch.js';
import { moneyBlock } from './finance.js';
import { orderCard } from './orders.js';
import { platformsPane } from './platforms.js';
import {
  el, clear, hero, emptyState, tag, phoneFrame,
} from '../dom.js';

const TAG_CLASS_FOR_KIND = {
  up: 't-live',
  running: 't-run',
  starting: 't-warn',
  stopping: 't-warn',
  stopped: 't-idle',
  failed: 't-bad',
  down: 't-bad',
  none: 't-none',
  unknown: 't-idle',
};

function tagFor(state) {
  const cls = TAG_CLASS_FOR_KIND[state?.kind] || TAG_CLASS_FOR_KIND.unknown;
  return [cls, state?.label || 'Unknown'];
}

/**
 * What a project is to the business, in display order. Three groups, no more:
 * there is no "Tools" group — Recall is a business, Archivio is a rebuild made
 * to win the work, and LEADS is part of HQ itself, not a project.
 */
export function kindOrder() {
  return [
    { key: 'business', title: 'Businesses' },
    { key: 'client', title: 'Clients' },
    { key: 'prospect', title: 'Potential client' },
  ];
}

export const KIND_LABEL = {
  business: 'Business',
  client: 'Client',
  prospect: 'Potential client',
};

/** Load projects.css once, from whichever screen renders first. */
export function ensureProjectStyles() {
  if (document.getElementById('projects-css')) return;
  const link = document.createElement('link');
  link.id = 'projects-css';
  link.rel = 'stylesheet';
  link.href = '/assets/projects.css';
  document.head.appendChild(link);
}

const isExternal = (url) => /^https?:\/\//.test(url);

const safeOrigin = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};

/** `links.admin` is one object or several (Recall has a family admin and an owner console). */
export function adminEntries(project) {
  const admin = project?.links?.admin;
  if (!admin) return [];
  return Array.isArray(admin) ? admin : [admin];
}

/**
 * An anchor that leaves HQ. Always a new tab, always rel=noopener — and never
 * an iframe anywhere in this file: andyssarchives' admin sets SameSite=Strict
 * cookies, so an embedded copy is permanently logged out.
 */
function extLink(href, text, className = 'rx-a') {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * A local address. A plain click starts its service when it is not running,
 * waits for the port, then opens it (local-launch.js); a middle-click or a
 * copied link is still the bare address.
 */
function localLink(project, href, text, className = 'rx-a') {
  const a = extLink(href, text, className);
  a.title = 'Starts it if it is not running, then opens it';
  a.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault?.();
    openLocal(project, href);
  });
  return a;
}

/** An anchor that stays inside HQ (the Leads screen, another project page). */
function inLink(href, text, navigate, className = 'rx-a') {
  const a = el('a', className, text);
  a.href = href;
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(href);
  });
  return a;
}

/** Compact links (Andy, 3 Nov): a word on screen, the full address on hover. */
function titled(node, ...lines) {
  node.setAttribute('title', lines.filter(Boolean).join('\n'));
  return node;
}

function anyLink(href, text, navigate, className) {
  return isExternal(href) || !navigate
    ? extLink(href, text, className)
    : inLink(href, text, navigate, className);
}

/** What is there when needed, not on screen: a small « ? » that opens a panel. */
function fold(...nodes) {
  const kept = nodes.flat().filter(Boolean);
  if (!kept.length) return null;
  const help = el('details', 'rx-help');
  help.appendChild(el('summary', null, '?'));
  const box = el('div', 'rx-helpbox');
  box.append(...kept);
  help.appendChild(box);
  return help;
}

const sub = (label, text) => {
  if (!text) return null;
  const p = el('p', 'rx-sub');
  if (label) p.appendChild(el('b', null, label));
  p.appendChild(document.createTextNode(text));
  return p;
};

/** A tool that is a command: its name on screen, one click copies the command. */
function copyChip(name, command, purpose) {
  const chip = el('button', 'rx-a rx-tchip', `${name} ⧉`);
  chip.type = 'button';
  titled(chip, purpose, command);
  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(command);
      toast('Command copied');
    } catch {
      toast(command);
    }
  });
  return chip;
}

/** A button that copies a command. The command is visible either way. */
function commandChip(command) {
  const chip = el('button', 'rx-chip');
  chip.type = 'button';
  const body = el('span', 'rx-cmd', command);
  const hint = el('span', 'rx-copy', 'Copy');
  chip.append(body, hint);
  chip.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(command);
      hint.textContent = 'Copied';
    } catch {
      hint.textContent = 'Select it';
    }
    setTimeout(() => { hint.textContent = 'Copy'; }, 1400);
  });
  return chip;
}

/** `cd "<path>" && PORT=3017 python3 server.py` — env included, or it starts elsewhere. */
function serviceCommand(project, service) {
  const env = service.env
    ? `${Object.entries(service.env).map(([k, v]) => `${k}=${v}`).join(' ')} `
    : '';
  return `cd "${project.local.path}" && ${env}${service.run.join(' ')}`;
}

/** The command that starts `links.local`, wherever the registry keeps it. */
export function localCommand(project) {
  const local = project?.links?.local;
  if (!local) return null;
  if (local.command) {
    return local.cwd ? `cd "${local.cwd}" && ${local.command}` : local.command;
  }
  const service = project.local?.services?.find((s) => s.id === local.service);
  return service ? serviceCommand(project, service) : null;
}

/**
 * Which secondary probe belongs to a given door, matched by origin rather
 * than by a hardcoded id: Recall's `backend` probe must not decorate its
 * `/admin` row, and an admin probe named anything at all still finds its row.
 */
export function extraFor(project, url) {
  const origin = safeOrigin(url);
  if (!origin) return null;
  const spec = (project?.status?.extra ?? []).find((x) => safeOrigin(x.url) === origin);
  if (!spec) return null;
  return (project?.state?.extra ?? []).find((x) => x.id === spec.id) ?? null;
}

/**
 * What the Local row can say about its address. The port's service comes
 * from projects.json and its state from the Mac (/api/services), not from the
 * status probe, which only ever reads the live site; that is why Aubin's
 * row used to say "HQ does not watch this port". `live` is the /api/services
 * reading, or null before it has arrived.
 */
export function localHint(project, live = null) {
  const url = project?.links?.local?.url;
  const service = url ? serviceFor(project, url) : null;
  if (!service) return { state: 'none', title: 'HQ opens this address; nothing in projects.json starts it' };
  if (service.manual) return { state: 'manual', title: 'Started by hand or by launchd, not by HQ' };
  const state = serviceState(project, service, live);
  if (state === 'running') return { state, title: 'Running: a click opens it' };
  if (state === 'stopped') return { state, title: 'Not running: a click starts it, then opens it' };
  return { state, title: 'A click starts it if needed, then opens it (needs HQ on the Mac)' };
}

const HINT_DOT = { running: 'd-ok', stopped: 'd-idle', unknown: 'd-idle', manual: 'd-warn', none: 'd-idle' };

/* ---------------------------------------------------------------- pills --- */

/**
 * The compact row used on cards and on the Headquarters home: Live · Admin ·
 * Local, only the ones that exist, each one a real link out.
 */
export function reachPills(project, navigate) {
  const wrap = el('div', 'rx-pills');
  const { links = {} } = project;

  if (links.live?.url) wrap.appendChild(extLink(links.live.url, 'Live', 'rx-pill'));
  for (const admin of adminEntries(project)) {
    const label = adminEntries(project).length > 1 && admin.label ? admin.label : 'Admin';
    wrap.appendChild(anyLink(admin.url, label, navigate, 'rx-pill'));
  }
  // Mac-only: a phone hides it (audit D17, P12).
  if (links.local?.url) { const l = localLink(project, links.local.url, 'Local', 'rx-pill'); l.className = `${l.className} mac-only`; wrap.appendChild(l); }

  if (!wrap.childElementCount) {
    wrap.appendChild(el('span', 'rx-pill rx-ghost', project.stage === 'not_started' ? 'Not started' : 'Nothing to open yet'));
  }
  // A card is itself a click target; a real link inside it must not navigate.
  wrap.addEventListener('click', (e) => e.stopPropagation());
  return wrap;
}

/* ------------------------------------------------------- projects list --- */

function plural(n, singular, pluralWord = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}

function projectsSub(projects) {
  const counts = { business: 0, client: 0, prospect: 0 };
  for (const p of projects) if (counts[p.kind] !== undefined) counts[p.kind] += 1;
  return [
    plural(projects.length, 'project'),
    plural(counts.business, 'business', 'businesses'),
    plural(counts.client, 'client'),
    `${counts.prospect} potential`,
  ].join(' · ');
}

function metaLine(project) {
  const bits = [project.stack];
  if (project.state?.deployed) {
    bits.push(`deployed ${relativeTime(project.state.deployed)}`);
  } else if (project.local?.services?.length) {
    bits.push(project.local.services.map((s) => `${s.label.toLowerCase()} ${s.port}`).join(' · '));
  }
  return bits.filter(Boolean).join(' · ') || '—';
}

function projectCard(project, navigate) {
  // The title is the link (keyboard and screen readers); the whole card still
  // opens it for a pointer. A card that was itself a « button » held the Live /
  // Admin links inside it: nested controls (axe, 14 Nov).
  const card = el('div', `pcard${project.state?.kind === 'none' ? ' empty' : ''}`);

  const top = el('div', 'top');
  const title = el('h3');
  const open = el('a', 'pcard__open', project.name);
  open.href = `/p/${project.slug}`;
  open.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); navigate(`/p/${project.slug}`); });
  title.appendChild(open);
  top.appendChild(title);
  const tags = el('div', 'rx-line');
  tags.appendChild(tag(tagFor(project.state)));
  for (const extra of project.state?.extra ?? []) tags.appendChild(tag(tagFor(extra)));
  top.appendChild(tags);
  card.appendChild(top);

  card.appendChild(el('p', null, project.description));
  card.appendChild(el('div', 'meta', metaLine(project)));

  const links = el('div', 'links');
  links.appendChild(reachPills(project, navigate));
  card.appendChild(links);

  card.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    navigate(`/p/${project.slug}`);
  });

  return card;
}

/**
 * The same projects, as compact rows: name, status dot, and the link pills.
 * Used by the Headquarters home so one click from there reaches any site.
 */
export function projectRowsSection(merged, navigate) {
  ensureProjectStyles();
  const section = el('section', 'card');
  section.appendChild(el('p', 'eyebrow', 'Projects'));

  if (!merged.length) {
    section.appendChild(emptyState('No projects yet', 'The registry in projects.json is empty.'));
    return section;
  }

  for (const group of kindOrder()) {
    const inGroup = merged.filter((p) => p.kind === group.key);
    if (!inGroup.length) continue;
    const block = el('div', 'rx-group');
    block.appendChild(el('p', 'rx-gtitle', group.title));
    const rows = el('div', 'rx-prows');
    for (const project of inGroup) {
      const row = el('div', 'rx-prow');
      const dotKind = TAG_CLASS_FOR_KIND[project.state?.kind] || 't-idle';
      const dot = el('i', `dot ${{
        't-live': 'd-ok', 't-run': 'd-ok', 't-warn': 'd-warn', 't-bad': 'd-bad',
      }[dotKind] || 'd-idle'}`);
      row.appendChild(dot);

      const name = el('div', 'rx-pname');
      const open = el('button', null, project.name);
      open.type = 'button';
      open.addEventListener('click', () => navigate(`/p/${project.slug}`));
      name.appendChild(open);
      const sub = [project.state?.label, ...(project.state?.extra ?? []).map((x) => x.label)]
        .filter(Boolean).join(' · ');
      if (sub) name.appendChild(el('small', null, sub));
      row.appendChild(name);

      row.appendChild(reachPills(project, navigate));
      rows.appendChild(row);
    }
    block.appendChild(rows);
    section.appendChild(block);
  }
  return section;
}

/** Which tab of Projects is open: « Projects » (default) or « Platforms » (?tab=platforms). */
export function projectsTab(search = (typeof location === 'undefined' ? '' : location.search)) {
  return new URLSearchParams(search).get('tab') === 'platforms' ? 'platforms' : 'projects';
}

export function renderProjectsList(ctx) {
  ensureProjectStyles();
  const { store, navigate } = ctx;
  const root = el('div', 'projects-list');
  root.appendChild(hero('Every', 'project', projectsSub(store.projects)));

  // Two tabs (Andy, 19 Nov): the projects, and the work platforms he is signed
  // up to. Platforms are not projects; they live in their own pane and store.
  const seg = el('div', 'tabs pj-seg');
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', 'Projects');
  root.appendChild(seg);

  const projectsPane = el('div', 'pj-pane');
  projectsPane.dataset.pane = 'projects';
  for (const group of kindOrder()) {
    const inGroup = store.merged.filter((p) => p.kind === group.key);
    if (!inGroup.length) continue;
    projectsPane.appendChild(el('h2', 'section', group.title));
    const grid = el('div', 'grid g-cards');
    for (const project of inGroup) grid.appendChild(projectCard(project, navigate));
    projectsPane.appendChild(grid);
  }
  const platforms = platformsPane();
  // One fragment, as before: phoneFrame() moves what follows the title and tabs into its body.
  const panes = document.createDocumentFragment();
  panes.append(projectsPane, platforms);
  root.appendChild(panes);

  const tabs = {};
  const show = (key, { remember = true } = {}) => {
    root.dataset.seg = key;
    for (const [k, t] of Object.entries(tabs)) t.setAttribute('aria-selected', String(k === key));
    if (key === 'platforms') platforms.load();
    if (remember && typeof history !== 'undefined') {
      const url = new URL(location.href);
      if (key === 'platforms') url.searchParams.set('tab', 'platforms'); else url.searchParams.delete('tab');
      history.replaceState(history.state, '', url);
    }
  };
  for (const [key, label] of [['projects', 'Projects'], ['platforms', 'Platforms']]) {
    const t = el('button', 'tab', label);
    t.type = 'button';
    t.setAttribute('role', 'tab');
    t.addEventListener('click', () => show(key));
    tabs[key] = t;
    seg.appendChild(t);
  }
  show(projectsTab(), { remember: false });

  // On a phone the page stays still and the cards scroll (P6 block 5).
  return phoneFrame(root, 2, { wrapper: true });
}

/* ------------------------------------------------- where to reach it --- */

/** A labelled row. `value` is already an `.rx-v` built by one of the four below. */
function reachRow(label, value) {
  const row = el('div', 'rx-row');
  row.appendChild(el('div', 'rx-k', label));
  row.appendChild(value);
  return row;
}

function lineWith(node, ...extras) {
  const line = el('div', 'rx-line');
  line.appendChild(node);
  for (const extra of extras) if (extra) line.appendChild(extra);
  return line;
}

function liveValue(project) {
  const live = project.links?.live;
  const value = el('div', 'rx-v');
  if (!live?.url) return value;
  value.appendChild(lineWith(titled(extLink(live.url, 'Live ↗'), live.url, live.label)));
  return value;
}

function adminValue(project, navigate) {
  const admins = adminEntries(project);
  const value = el('div', 'rx-v');
  for (const admin of admins) {
    const pill = extraFor(project, admin.url);
    // The one thing worth having at the moment the door is shut.
    const down = admin.restart && pill && (pill.kind === 'down' || pill.kind === 'unknown');
    value.appendChild(lineWith(
      titled(anyLink(admin.url, `${admin.label || 'Admin'}${isExternal(admin.url) ? ' ↗' : ''}`, navigate), admin.url),
      admin.local_only ? el('span', 'rx-out', 'Local only') : null,
      pill ? tag(tagFor(pill)) : null,
      fold(
        sub('How: ', admin.how), sub('Sign in: ', admin.auth), sub('', admin.note),
        down ? sub('Bring it back: ', ' ') : null, down ? commandChip(admin.restart.command) : null,
        down ? sub('', admin.restart.note) : null,
      ),
    ));
  }
  return value;
}

function localValue(project, live = null) {
  const local = project.links?.local;
  const value = el('div', 'rx-v');
  if (!local?.url) return value;
  const hint = localHint(project, live);
  const dot = el('i', `dot ${HINT_DOT[hint.state] ?? 'd-idle'}`);
  dot.title = hint.title;
  dot.setAttribute('role', 'img'); // a label needs a role (axe, 14 Nov)
  dot.setAttribute('aria-label', hint.title);
  const localA = localLink(project, local.url, 'Local');
  localA.className = `${localA.className} mac-only`;
  titled(localA, local.url, localA.title);
  // The command stays where HQ cannot start it itself: no service for this
  // port, or no Mac to ask. It folds behind « ? » with the note.
  const command = localCommand(project);
  value.appendChild(lineWith(localA, dot, fold(
    command && (hint.state === 'none' || hint.state === 'unknown') ? commandChip(command) : null,
    sub('', local.note),
  )));
  // On the phone, over the same Wi-Fi: the Mac's own address for this port.
  const phone = lanUrl(project, local.url, live);
  if (phone) {
    const row = el('div', 'rx-lab');
    row.appendChild(titled(extLink(phone, 'Phone ↗'), phone, 'Same Wi-Fi'));
    value.appendChild(row);
  }
  // The lab versions live on the same server, one path each.
  const labs = labLinks(project);
  if (labs.length) {
    const list = el('div', 'rx-labs');
    for (const lab of labs) {
      const row = el('div', 'rx-lab');
      const labA = localLink(project, lab.url, `Lab ${lab.label}`);
      row.appendChild(titled(labA, lab.url, labA.title));
      const labPhone = lanUrl(project, lab.url, live);
      if (labPhone) {
        const p = extLink(labPhone, 'phone', 'rx-a rx-phone');
        p.title = labPhone;
        row.appendChild(p);
      }
      list.appendChild(row);
    }
    value.appendChild(list);
  }
  return value;
}

function toolsValue(project, navigate) {
  const tools = project.links?.tools ?? [];
  const value = el('div', 'rx-v');
  if (!tools.length) return value;
  const list = el('div', 'rx-tools');
  for (const tool of tools) {
    // One chip per tool: its name, its purpose and address on hover.
    if (tool.url) {
      list.appendChild(titled(anyLink(tool.url, `${tool.name}${isExternal(tool.url) ? ' ↗' : ''}`, navigate, 'rx-a rx-tchip'), tool.purpose, tool.url));
    } else if (tool.command) {
      list.appendChild(copyChip(tool.name, tool.command, tool.purpose));
    } else {
      list.appendChild(titled(el('span', 'rx-tchip', tool.name), tool.purpose));
    }
  }
  value.appendChild(list);
  return value;
}

/** The row the project page opens with: where to reach this project. */
export function reachBlock(project, navigate, projects = []) {
  if (project.stage === 'not_started') {
    const card = el('section', 'card');
    const block = el('div', 'rx-notstarted');
    block.appendChild(el('h4', null, 'Not started'));
    block.appendChild(el('p', null, project.note || 'Nothing exists for this project yet.'));
    // A case study waits inside its brand's site; a client's project does not.
    if (project.parent && project.kind !== 'client') {
      const parent = projects.find((p) => p.slug === project.parent);
      const line = el('p', 'rx-sub');
      line.appendChild(document.createTextNode('Lives inside '));
      line.appendChild(inLink(`/p/${project.parent}`, parent?.name || project.parent, navigate));
      line.appendChild(document.createTextNode(' for now — a case study card in its src/data/projects.ts.'));
      block.appendChild(line);
    }
    card.appendChild(block);
    return card;
  }

  // One compact row under the title (Andy, 3 Nov: « too much happening »): only
  // the destinations this project has, each one word.
  const bar = el('section', 'rx-bar');
  const local = localValue(project);
  for (const part of [liveValue(project), adminValue(project, navigate), local, toolsValue(project, navigate)]) {
    if (part.children.length) bar.appendChild(part);
  }
  if (!bar.children.length) bar.appendChild(el('span', 'rx-none', 'Nothing to open yet'));
  // The Mac's reading of the services arrives after the page, and a start
  // or a stop below changes it, so the row hands back the one way to
  // repaint Local without rebuilding the page.
  bar.refreshLocal = (fresh, live = null) => local.replaceChildren(...[...localValue(fresh, live).children]);
  return bar;
}

/* ------------------------------------------------------ local services --- */

/**
 * One row per registry service: what it is, whether it is running, and the
 * buttons that act on it. Every button goes through /api/services, which is
 * the only thing that knows how to reach this Mac — a 409 or a 503 from it is
 * printed in the row it belongs to, never only in a toast.
 *
 * `api` is injected so a test can drive every state without a network.
 */
function setDisabled(node, on) {
  node.disabled = on;
  if (on) node.setAttribute('disabled', '');
  else delete node.attributes?.disabled;
}

function actionButton(text, onClick) {
  const btn = el('button', 'btn small', text);
  btn.type = 'button';
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function serviceRow(project, service, { live, bridge, onRefresh, api }) {
  const manual = service.manual === true || live?.manual === true;
  const url = live?.url || (project.links?.local?.service === service.id && project.links.local.url)
    || `http://localhost:${service.port}`;
  const state = {
    running: Boolean(live?.running),
    pid: live?.pid ?? null,
    pending: false,
  };

  const block = el('div', 'service-block');
  const head = el('div', 'service-head');
  head.appendChild(el('h4', null, `${service.label} · localhost:${service.port}`));
  const word = el('span', 'svc-state');
  head.appendChild(word);
  block.appendChild(head);

  const actions = el('div', 'svc-actions');
  const message = el('p', 'svc-msg');
  const logsHost = el('div', 'svc-logs');
  block.append(actions, message, logsHost);

  const setMessage = (text) => { message.textContent = text || ''; };
  const path = `/api/services/${encodeURIComponent(project.slug)}/${encodeURIComponent(service.id)}`;

  async function loadLogs() {
    clear(logsHost);
    const pre = el('pre', 'box mono', 'Reading the log…');
    logsHost.append(actionButton('Refresh', loadLogs), pre);
    try {
      const data = await api(`${path}/logs?lines=80`);
      const lines = data?.lines ?? [];
      pre.textContent = lines.length ? lines.join('\n') : 'The log is empty.';
    } catch (error) {
      pre.textContent = error?.message || 'the log could not be read';
    }
  }

  function toggleLogs() {
    if (logsHost.childElementCount) clear(logsHost);
    else loadLogs();
  }

  async function act(verb) {
    state.pending = verb === 'start';
    setMessage('');
    paint();
    try {
      const result = await api(`${path}/${verb}`, { method: 'POST' });
      state.running = Boolean(result?.running);
      state.pid = result?.pid ?? null;
      if (verb === 'start' && !state.running) {
        setMessage('It was spawned but the port never answered — open the log below.');
      }
    } catch (error) {
      // The API's own words: "already running — not started by HQ",
      // "HQ did not start this", "needs the Mac".
      setMessage(error?.message || `the ${verb} failed`);
    }
    state.pending = false;
    paint();
    if (onRefresh) {
      try { await onRefresh(); } catch { /* the row is already right */ }
    }
  }

  function openLink() {
    const a = el('a', 'btn small', 'Open');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function paint() {
    clear(actions);
    if (manual) {
      word.textContent = 'Manual';
      setMessage('Managed by launchd — start with ./tools/admin.sh');
      return;
    }
    if (!bridge) {
      word.textContent = 'Unknown';
      const btn = actionButton('Start', () => toast('Starting a local server needs HQ running on the Mac'));
      actions.appendChild(btn);
      return;
    }
    if (state.pending) {
      word.textContent = 'Starting… (waits for the port)';
      const btn = actionButton('Starting…', null);
      setDisabled(btn, true);
      actions.appendChild(btn);
      return;
    }
    word.textContent = state.running
      ? (state.pid ? 'Running' : 'Running, not started by HQ')
      : 'Not running';
    if (!state.running) actions.appendChild(actionButton('Start', () => act('start')));
    if (state.running && state.pid) actions.appendChild(actionButton('Stop', () => act('stop')));
    if (state.running) actions.appendChild(openLink());
    actions.appendChild(actionButton('Logs', toggleLogs));
  }

  paint();

  // The command stays, whatever the buttons can do: it is the fallback when
  // the Mac is not there, and the truth about what a start actually runs.
  if (!manual) {
    block.appendChild(el('p', 'rx-sub', 'or run it yourself'));
    block.appendChild(commandChip(serviceCommand(project, service)));
  }
  return block;
}

/**
 * The Local services card. `services` is the /api/services payload's list;
 * `bridge` is false when that call answered 503 — the Mac is not reachable,
 * so every button says so and the copy chip is the way through.
 */
export function servicesBlock(project, {
  services = [], bridge = true, onRefresh = null, api = apiFetch,
} = {}) {
  const card = el('section', 'card');
  card.appendChild(el('p', 'eyebrow', 'Local services'));
  if (!bridge) {
    card.appendChild(el('p', 'hint', 'HQ cannot reach this Mac — copy a command and run it there.'));
  }
  for (const service of project.local?.services ?? []) {
    const live = services.find((s) => s.slug === project.slug && s.name === service.id) ?? null;
    card.appendChild(serviceRow(project, service, { live, bridge, onRefresh, api }));
  }
  if (project.local?.note) {
    card.appendChild(fieldBlock('Note', el('p', 'value', project.local.note)));
  }
  return card;
}

/** The /api/services list, and whether the Mac answered at all. */
export async function loadServices(api = apiFetch) {
  try {
    const data = await api('/api/services');
    return { services: data?.services ?? [], bridge: true };
  } catch {
    return { services: [], bridge: false };
  }
}

/* ------------------------------------------------------ detail screen --- */

function fieldBlock(labelText, node) {
  const field = el('div', 'field');
  field.appendChild(el('p', 'label', labelText));
  field.appendChild(node);
  return field;
}

/** The project's invoices, or null. Finance is a separate screen's data: if
 *  it cannot be read, the project page still renders everything else. */
/** The onboardings worth a card: a link was sent, or he answered or approved
 *  something. A deal row with none of that (Alexis, 3 Nov) is not an onboarding. */
export function realOnboardings(rows = []) {
  return rows.filter((o) => o.live_token || Number(o.onboarding_answers) > 0
    || Number(o.onboarding_approved) > 0 || o.onboarding_updated_at);
}

async function financeFor(slug) {
  try {
    return await apiFetch(`/api/finance/projects/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

export async function renderProjectDetail(ctx, slug) {
  ensureProjectStyles();
  const { store, navigate } = ctx;
  const fragment = document.createDocumentFragment();

  // Everything on this page is one stack, so it rides the shell's --gap like
  // every other screen. Before this wrapper the blocks were appended straight
  // to #main as plain siblings with no margins at all, which is why the Money
  // card sat flush against the row below it — 0px where every other card
  // pair on the page has 16.
  const page = el('div', 'grid rx-detail');
  fragment.appendChild(page);

  // The back link and the title belong together: one row of the stack, so
  // the gap lands between the title block and the first card, not inside it.
  const head = el('div', 'rx-head');
  const back = el('button', 'back-link', '← All projects');
  back.type = 'button';
  back.addEventListener('click', () => navigate('/projects'));
  head.appendChild(back);

  const project = store.merged.find((p) => p.slug === slug);
  if (!project) {
    page.appendChild(head);
    const card = el('section', 'card');
    card.appendChild(emptyState('No such project', `There is no project with the slug "${slug}" in the registry.`));
    page.appendChild(card);
    return fragment;
  }

  head.appendChild(hero(project.name, '', project.description));
  const kind = KIND_LABEL[project.kind] || '';
  if (kind) head.appendChild(el('p', 'rx-kind', kind));
  page.appendChild(head);

  // Every read starts now and they run together: from Lima, one after another
  // would cost a transatlantic round trip each (3 Nov).
  const financeRead = financeFor(slug);
  const clientsRead = apiFetch('/api/finance/clients').then((b) => b?.clients ?? []).catch(() => []);
  const orderRead = clientsRead.then((clients) => orderCard(slug, { navigate, clients, compactEmpty: true }));
  const prospectsRead = apiFetch(`/api/prospects?slug=${encodeURIComponent(slug)}`).catch(() => ({}));
  const pageRead = Promise.all([
    apiFetch(`/api/projects/${slug}/meta`), apiFetch(`/api/missions?slug=${encodeURIComponent(slug)}`),
  ]);
  pageRead.catch(() => {});

  // Where to reach it: one compact row right under the title.
  const reach = reachBlock(project, navigate, store.merged);
  page.appendChild(reach);

  // Then the money (Andy, 3 Nov), for a project that has any: a project with
  // no invoices gets no block rather than an empty one.
  const finance = await financeRead;
  const money = finance && moneyBlock(finance, navigate);
  if (money) page.appendChild(money);

  // What this client is charged for here — one-off, monthly, per day — and the
  // charges that have accrued since the last invoice.
  // No order yet: one small button in the Money card, not a card of its own.
  const orderPart = await orderRead;
  if (money && orderPart.classList?.contains('ord-start')) money.appendChild(orderPart);
  else page.appendChild(orderPart);

  // The client's onboarding: his questionnaire or approvals, sent with his link (0021).
  const { prospects: rows = [] } = await prospectsRead;
  const onboardings = realOnboardings(rows);
  if (onboardings.length) {
    const card = el('section', 'card rx-onboarding');
    card.appendChild(el('p', 'eyebrow', 'Onboarding'));
    for (const o of onboardings) {
      const row = el('div', 'rx-onb');
      const text = el('div');
      text.appendChild(el('b', null, o.name));
      const live = o.live_token && o.live_expires_at > new Date().toISOString();
      text.appendChild(el('small', null, [`${o.onboarding_answers} answered`, `${o.onboarding_approved} approved`, o.onboarding_updated_at ? `last ${relativeTime(o.onboarding_updated_at)}` : null, live ? 'link on' : 'no link'].filter(Boolean).join(' · ')));
      const acts = el('div', 'rx-onb__acts');
      // Copy his link (the one already sent, while it works; else a new one for 7 days).
      const copy = el('button', 'btn small', 'Copy link');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          const { live: link } = await apiFetch(`/api/prospects/${o.id}/live`, { method: 'POST' });
          await navigator.clipboard.writeText(link.url);
          toast('Onboarding link copied');
        } catch (error) { toast(error?.message || 'Could not copy the link'); }
      });
      const open = el('button', 'btn small', 'Open');
      open.type = 'button';
      open.addEventListener('click', () => navigate(`/pipeline/${o.id}`));
      acts.append(copy, open);
      row.append(text, acts);
      card.appendChild(row);
    }
    page.appendChild(card);
  }

  const [{ meta }, { missions }] = await pageRead;

  const grid = el('div', 'grid g-2 rx-columns');
  const left = el('div', 'grid');

  // Status: one row of facts, not a list of labelled lines.
  const statusCard = el('section', 'card');
  statusCard.appendChild(el('p', 'eyebrow', 'Status'));
  const facts = el('div', 'rx-facts');
  const fact = (k, node) => { const f = el('div', 'rx-fact'); f.appendChild(el('span', 'rx-k', k)); f.appendChild(node); return f; };
  facts.appendChild(fact('State', tag(tagFor(project.state))));
  for (const extra of project.state?.extra ?? []) facts.appendChild(fact(extra.name || extra.id, tag(tagFor(extra))));
  if (store.status?.checkedAt) facts.appendChild(fact('Checked', el('p', 'value', relativeTime(store.status.checkedAt))));
  if (project.state?.deployed) facts.appendChild(fact('Deployed', el('p', 'value', relativeTime(project.state.deployed))));
  statusCard.appendChild(facts);
  if (project.state?.detail) statusCard.appendChild(el('p', 'rx-sub', project.state.detail));
  const others = ['reference', 'repo'].filter((key) => project.links?.[key]?.url);
  for (const key of others) {
    const entry = project.links[key];
    const line = el('p', 'rx-sub');
    line.appendChild(el('b', null, key === 'repo' ? 'Repository: ' : 'Reference: '));
    line.appendChild(extLink(entry.url, entry.label ? `${entry.label} — ${entry.url}` : entry.url));
    statusCard.appendChild(line);
  }
  // Status and Your notes share a row, at one height (Andy's rule).
  const pair = el('div', 'grid g-2 rx-pair');
  pair.appendChild(statusCard);
  page.appendChild(pair);

  if (project.local) {
    const { services, bridge } = await loadServices();
    if (reach.refreshLocal) reach.refreshLocal(project, { services, bridge });
    left.appendChild(servicesBlock(project, {
      services,
      bridge,
      // A start or a stop here re-reads the Mac and repaints the Local row.
      onRefresh: async () => {
        await ctx.reloadShellData?.();
        const fresh = ctx.store.merged.find((p) => p.slug === slug) ?? project;
        if (reach.refreshLocal) reach.refreshLocal(fresh, await loadServices());
      },
    }));
  }
  grid.appendChild(left);

  const right = el('div', 'grid');

  // Your notes and the project's missions: the two things you act on.
  const notesCard = el('section', 'card');
  notesCard.appendChild(el('p', 'eyebrow', 'Your notes'));
  const notes = input('', meta.notes, 'textarea');
  notes.control.setAttribute('aria-label', 'Your notes'); // the card's eyebrow says it; the field needs it too (axe)
  // Notes not yet saved stay on this device (offline, a failed save, another
  // screen) and come back here (audit D15, P1).
  const notesDraft = keepDraft(notes.control, `project-notes:${slug}`, { serverValue: meta.notes || '' });
  if (notesDraft.restored) queueMicrotask(() => toast('Your unsaved notes are back: Save notes to keep them'));
  notesCard.append(notes.wrap, button('Save notes', async () => {
    await send(`/api/projects/${slug}/meta`, 'PUT', { notes: notes.control.value, pinned: meta.pinned });
    notesDraft.saved();
    toast('Notes saved');
  }, 'btn primary small'));
  pair.appendChild(notesCard);

  const missionCard = el('section', 'card');
  const eyebrow = el('p', 'eyebrow');
  eyebrow.appendChild(document.createTextNode('Missions'));
  const manage = el('a', null, missions.length ? `${missions.length} →` : 'Missions →');
  manage.href = '/missions';
  manage.addEventListener('click', (e) => { e.preventDefault(); navigate('/missions'); });
  eyebrow.appendChild(manage);
  missionCard.appendChild(eyebrow);
  if (!missions.length) missionCard.append(el('p', 'hint', 'No missions linked to this project yet.'));
  const mlist = el('div', 'rx-missions');
  for (const mission of missions) {
    const row = el('div', 'rx-mission');
    row.appendChild(el('span', null, mission.title));
    row.appendChild(el('i', `rx-mstatus s-${mission.status}`, mission.status.replaceAll('_', ' ')));
    mlist.appendChild(row);
  }
  missionCard.append(mlist);
  right.append(missionCard);

  // What the repository says about the project, read-only: dated notes and
  // the registry note, together in one quiet card.
  if (project.notes?.length || (project.note && project.stage !== 'not_started')) {
    const repoCard = el('section', 'card soft');
    repoCard.appendChild(el('p', 'eyebrow', 'From the project · read-only'));
    if (project.note && project.stage !== 'not_started') repoCard.appendChild(el('p', 'rx-sub', project.note));
    if (project.notes?.length) {
      const list = el('div', 'rx-notes');
      for (const note of project.notes) {
        const row = el('div', 'rx-note');
        const when = el('time', null, note.date);
        when.dateTime = note.date;
        row.appendChild(when);
        row.appendChild(el('span', null, note.text));
        list.appendChild(row);
      }
      repoCard.appendChild(list);
    }
    right.appendChild(repoCard);
  }

  // No services on this Mac: Missions takes the left column, so it is never empty.
  if (!left.children.length) left.appendChild(missionCard);
  grid.appendChild(right);
  page.appendChild(grid);
  // On a phone the title stays and the rest scrolls (P6 block 5).
  phoneFrame(page);

  return fragment;
}
