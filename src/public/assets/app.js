// The shell: boot, routing, header, data loading. No framework — plain
// modules, plain DOM.

import { merge, macOnline } from './lib.js';
import { el, clear, emptyState } from './dom.js';
import { placeLens, watchBarScroll } from './tabbar.js';
import { registerServiceWorker, forgetOfflineData } from './sw-client.js';
import { apiFetch, enableApiCache } from './api.js';
import { watchLeadBatches } from './lead-batches-ui.js';
import { closeAllModals, toast } from './leads-ui.js';
import { setIdentity, identity } from './identity.js';
import { renderHQ } from './screens/hq.js';
import { renderProjectsList, renderProjectDetail } from './screens/projects.js';
import { renderMissions } from './screens/missions.js';
import { renderOutreach } from './screens/outreach.js';
import { startWarmAlerts } from './warm-alerts.js';
import { mountAssistant } from './assistant-panel.js';
import { renderLeads } from './screens/leads.js';
import { renderFinance, renderInvoicePage, invoiceFonts } from './screens/finance.js';
import { renderAdmin } from './screens/admin.js';
import { renderReports } from './screens/reports.js';
import { renderPipeline, renderProspect } from './screens/pipeline.js';
import { renderOnboarding } from './screens/onboarding.js';
import { safeViewId, safePath, enterSafeView, leaveSafeView, holdButton, onboardingIdIn } from './safe-view.js';

/* ---- palette: Forest (default) or Marine, remembered per browser ---- */
const THEMES = [['forest', '●', 'Forest', '#101613'], ['marine', '◆', 'Marine', '#0B1626']];
function currentTheme() { return document.documentElement.dataset.theme === 'marine' ? 'marine' : 'forest'; }
function applyTheme(name) {
  if (name === 'marine') document.documentElement.dataset.theme = 'marine';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES.find(([id]) => id === name)?.[3]);
  try { localStorage.setItem('hq-theme', name); } catch { /* private window */ }
}

/** The initials open a small menu: who is signed in, the palette, sign out. */
function renderUserMenu() {
  const avatar = document.getElementById('avatar');
  const list = document.getElementById('usermenu-list');
  if (!avatar || !list) return;
  const paint = () => {
    list.replaceChildren();
    const who = el('div', 'umenu__who');
    who.appendChild(el('b', null, 'Headquarters'));
    who.appendChild(el('small', null, store.email || 'local'));
    list.appendChild(who);
    const current = currentTheme();
    for (const [id, glyph, label] of THEMES) {
      const b = el('button', `umenu__item${id === current ? ' is-on' : ''}`, `${glyph}  ${label}`);
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(id === current));
      b.addEventListener('click', () => { applyTheme(id); paint(); });
      list.appendChild(b);
    }
    list.appendChild(el('hr', 'umenu__rule'));
    // On a phone the bar holds four tabs (Andy, 21 Nov: « only four elements shown »);
    // the other sections live here, behind the initials, with Admin (CSS shows them on phones only).
    for (const item of NAV.filter((i) => i.more)) {
      const go = el('button', 'umenu__item umenu__phone', item.label);
      go.type = 'button';
      go.setAttribute('role', 'menuitem');
      go.addEventListener('click', () => { toggle(false); navigate(item.path); });
      list.appendChild(go);
    }
    // Admin lives here, behind the initials, not in the top menu (Andy, 16 Oct).
    const admin = el('button', 'umenu__item', 'Admin');
    admin.type = 'button';
    admin.setAttribute('role', 'menuitem');
    admin.addEventListener('click', () => { toggle(false); navigate('/admin'); });
    list.appendChild(admin);
    const out = el('a', 'umenu__item', 'Sign out');
    // Behind Access the session is Access's; locally it is the password cookie.
    out.href = store.email ? '/cdn-cgi/access/logout' : '/logout';
    out.setAttribute('role', 'menuitem');
    // Signing out empties the offline copy of Home's data on this device first.
    out.addEventListener('click', (event) => {
      event.preventDefault();
      forgetOfflineData().finally(() => { window.location.href = out.href; });
    });
    list.appendChild(out);
  };
  const toggle = (open) => { list.hidden = !open; avatar.setAttribute('aria-expanded', String(open)); };
  avatar.addEventListener('click', (e) => { e.stopPropagation(); paint(); toggle(list.hidden); });
  document.addEventListener('click', (e) => { if (!list.contains(e.target) && e.target !== avatar) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
}
applyTheme(currentTheme());

// `more`: on a phone the bar holds five tabs at most (Apple's and Material's
// limit), so the two least used on the go live behind « More » (Andy, 23 Oct).
const NAV = [
  { path: '/', label: 'Headquarters', short: 'Home', icon: 'home', match: (r) => r.name === 'hq' },
  { path: '/projects', label: 'Projects', short: 'Projects', icon: 'projects', more: true, match: (r) => ['projects','project-detail'].includes(r.name) },
  { path: '/missions', label: 'Missions', short: 'Missions', icon: 'missions', match: (r) => r.name === 'missions' },
  { path: '/outreach', label: 'Outreach', short: 'Outreach', icon: 'leads', match: (r) => ['outreach','leads'].includes(r.name) },
  { path: '/pipeline', label: 'Onboarding', short: 'Onboarding', icon: 'pipeline', more: true, match: (r) => ['pipeline','prospect','onboarding'].includes(r.name) },
  { path: '/finance', label: 'Finance', short: 'Finance', icon: 'finance', match: (r) => ['finance','invoice'].includes(r.name) },
  // The numbers (audit E18): funnel, pipeline value, money by month. In the avatar menu on a phone.
  { path: '/reports', label: 'Reports', short: 'Reports', icon: 'reports', more: true, match: (r) => r.name === 'reports' },
];

// 24px line icons for the phone bar (stroke = currentColor), as [tag, attributes].
const P = (d) => ['path', { d }];
const DOT = (cx, r = 1.4) => ['circle', { cx, cy: 12, r, fill: 'currentColor' }];
const NAV_ICONS = {
  home: [P('M3.5 10.5 12 3.5l8.5 7'), P('M5.5 9v11.5h13V9'), P('M10 20.5v-6h4v6')],
  projects: [P('M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5z')],
  missions: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['circle', { cx: 12, cy: 12, r: 4.5 }], DOT(12, 0.9)],
  leads: [['circle', { cx: 9, cy: 8, r: 3.5 }], P('M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5'), P('M15.5 4.7a3.5 3.5 0 0 1 0 6.6'), P('M18 14.8c1.9.8 3.1 2.5 3.5 5.2')],
  pipeline: [['rect', { x: 3.5, y: 4, width: 4.5, height: 16, rx: 1.5 }], ['rect', { x: 9.75, y: 4, width: 4.5, height: 11, rx: 1.5 }], ['rect', { x: 16, y: 4, width: 4.5, height: 7, rx: 1.5 }]],
  finance: [P('M17.5 6.6A7 7 0 1 0 17.5 17.4'), P('M4.5 10.5h8.5M4.5 13.5h8.5')],
  more: [DOT(5.5), DOT(12), DOT(18.5)],
  reports: [P('M4 20V10'), P('M10 20V4'), P('M16 20v-7'), P('M3 20.5h18')],
};

const SVG_NS = 'http://www.w3.org/2000/svg';
function navIcon(name) {
  const span = el('span', 'i');
  span.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, at] of NAV_ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(at)) node.setAttribute(k, String(v));
    svg.appendChild(node);
  }
  span.appendChild(svg);
  return span;
}

/** The phone's « More » sheet: the sections that are not in the bar. */
function openNavSheet(route) {
  document.querySelector('.navsheet')?.remove();
  const sheet = el('div', 'navsheet');
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const backdrop = el('div', 'navsheet__backdrop');
  backdrop.addEventListener('click', close);
  const panel = el('div', 'navsheet__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'More sections');
  panel.appendChild(el('span', 'navsheet__grip'));
  for (const item of NAV.filter((i) => i.more)) {
    const b = el('button', 'navsheet__item');
    b.type = 'button';
    if (item.match(route)) b.setAttribute('aria-current', 'page');
    b.append(navIcon(item.icon), el('span', null, item.label));
    b.addEventListener('click', () => { close(); navigate(item.path); });
    panel.appendChild(b);
  }
  // The assistant runs only on the Mac (assistant-panel.js); on the phone it is named here, not floated over the page.
  const assistant = el('button', 'navsheet__item');
  assistant.type = 'button';
  assistant.disabled = true;
  assistant.append(el('span', 'navsheet__glyph', '✦'), el('span', null, 'Assistant · on the Mac'));
  panel.appendChild(assistant);
  sheet.append(backdrop, panel);
  document.body.appendChild(sheet);
  document.addEventListener('keydown', onKey);
  panel.querySelector('button')?.focus();
}

/** Shared, mutable app state. Screens read it via `ctx.store`. */
const store = {
  projects: [],
  email: null,
  status: null,
  merged: [],
  projectsError: null,
};

let sessionEnded = false;
let renderVersion = 0;

function parseRoute(pathname) {
  if (pathname === '/') return { name: 'hq' };
  if (pathname === '/projects') return { name: 'projects' };
  const detail = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (detail) return { name: 'project-detail', slug: decodeURIComponent(detail[1]) };
  if (pathname === '/missions') return { name: 'missions' };
  if (pathname === '/outreach') return { name: 'outreach' };
  if (pathname === '/leads') return { name: 'leads' };
  if (pathname === '/pipeline') return { name: 'pipeline' };
  const prospect = pathname.match(/^\/pipeline\/(\d+)$/);
  if (prospect) return { name: 'prospect', id: Number(prospect[1]) };
  const onboarding = pathname.match(/^\/onboarding\/(\d+)$/);
  if (onboarding) return { name: 'onboarding', id: Number(onboarding[1]) };
  if (pathname === '/finance') return { name: 'finance' };
  // /finance/<id> is the printed invoice. The Worker serves the shell for
  // exactly this shape (SHELL_PREFIXES), so it survives a reload and a
  // bookmark — and the two agree on the shape, trailing slash included: a URL
  // the Worker will not serve is not a route the app pretends to have.
  const invoice = pathname.match(/^\/finance\/(\d+)$/);
  if (invoice) return { name: 'invoice', id: invoice[1] };
  if (pathname === '/admin') return { name: 'admin' };
  if (pathname === '/reports') return { name: 'reports' };
  return { name: 'hq' };
}

function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
  renderRoute();
}

/** Passed to every screen: navigation, the shared store, and a way to reload it. */
const ctx = {
  navigate,
  store,
  reloadShellData: loadShellData,
};

function initials(email) {
  if (!email) return 'HQ';
  const local = email.split('@')[0];
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

watchBarScroll();
document.getElementById('home-link')?.addEventListener('click',(event)=>{event.preventDefault();navigate('/');});
// Offline reloads (design approved 14 Nov): on the live HQ only, after the first paint.
if (typeof window !== 'undefined') window.addEventListener('load', () => { registerServiceWorker({ toast }); });

function renderNav(route) {
  const nav = document.getElementById('nav');
  clear(nav);
  for (const item of NAV) {
    // Two spellings: the full word on a desktop, the short one in the phone's
    // bottom bar. CSS shows one of them; both are hidden from the
    // accessibility tree so the button's name is the one label, once.
    const button = el('button');
    button.type = 'button';
    button.dataset.path = item.path;
    if (item.more) button.classList.add('in-more');
    button.setAttribute('aria-label', item.label);
    const long = el('span', 'l', item.label);
    const short = el('span', 's', item.short);
    long.setAttribute('aria-hidden', 'true');
    short.setAttribute('aria-hidden', 'true');
    button.append(navIcon(item.icon), long, short);
    if (item.match(route)) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => navigate(item.path));
    nav.appendChild(button);
  }
  // Phone only (CSS hides it on wider screens): the fifth tab opens the rest.
  const more = el('button', 'more');
  more.type = 'button';
  more.setAttribute('aria-label', 'More');
  more.setAttribute('aria-haspopup', 'dialog');
  if (NAV.some((i) => i.more && i.match(route))) more.setAttribute('aria-current', 'page');
  const moreLabel = el('span', 's', 'More');
  moreLabel.setAttribute('aria-hidden', 'true');
  more.append(navIcon('more'), moreLabel);
  more.addEventListener('click', () => openNavSheet(route));
  nav.appendChild(more);
  document.querySelector('.navsheet')?.remove();
  // The phone tab bar's lens slides from the tab you left to the one you are on;
  // a new screen always starts with the bar at full size.
  nav.classList.remove('is-compact');
  placeLens(nav);

  // On a phone the strip is narrower than its six sections and scrolls inside
  // itself, so the section you are actually on can start out past the right
  // edge — you land on Missions and the strip shows Headquarters. Bring the
  // current one into view. `block: 'nearest'` keeps the page itself still.
  const current = nav.querySelector('button[aria-current="page"]');
  if (current && nav.scrollWidth > nav.clientWidth + 1) {
    current.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function renderHeader() {
  const macBtn = document.getElementById('macbtn');
  // Offline, nothing is known about the Mac: the chip says so instead of a
  // green « online » from before the drop (audit D16, P2).
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const online = !offline && macOnline(store.merged);
  clear(macBtn);
  const macText = offline ? 'Offline' : online ? 'Mac online' : 'Mac not connected';
  macBtn.appendChild(el('i', `dot ${online ? 'd-ok' : 'd-bad'}`));
  // The words hide on the smallest phones (CSS); the title keeps them on hand.
  macBtn.appendChild(el('span', 'mac-label', macText));
  macBtn.title = macText;

  const emailChip = document.getElementById('email-chip');
  if (store.email) {
    emailChip.textContent = store.email;
    emailChip.hidden = false;
  } else {
    emailChip.hidden = true;
  }

  const domain = document.querySelector('.brand i');
  if (domain) domain.textContent = identity().domain;

  document.getElementById('avatar').textContent = initials(store.email);
  if (!renderUserMenu.done) { renderUserMenu(); renderUserMenu.done = true; }
}


function showSessionEndedBanner() {
  sessionEnded = true;
  const main = document.getElementById('main');
  clear(main);
  const reload = el('button', 'btn primary', 'Reload');
  reload.type = 'button';
  reload.addEventListener('click', () => location.reload());
  main.appendChild(el('div', 'card', null));
  main.lastElementChild.appendChild(
    emptyState('Your session ended', 'Reload the page to sign in again.', reload),
  );
}

window.addEventListener('hq:session-ended', showSessionEndedBanner);
window.addEventListener('popstate', () => renderRoute());

/* Start-up (audit 12): the projects and status reads no longer hold every screen
 * back. Only the screens that show them wait; the others start their own reads
 * at once, and the header is drawn again when the two land. */
// The screens that read nothing from it (store, merged, status); every other
// route, the unknown ones included (they draw Home), waits for it.
const OWN_DATA = new Set(['leads', 'pipeline', 'prospect', 'onboarding', 'finance', 'invoice', 'reports']);
let shellReady = Promise.resolve();

/** A screen still loading, after a short wait: bars, no words. */
function loadingState() {
  const node = el('div', 'screen-loading');
  node.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) node.appendChild(el('span'));
  return node;
}

async function loadShellData() {
  const [projectsResult, statusResult] = await Promise.allSettled([
    apiFetch('/api/projects'),
    apiFetch('/api/status'),
  ]);

  if (projectsResult.status === 'fulfilled') {
    setIdentity(projectsResult.value?.identity);
    store.projects = projectsResult.value?.projects ?? [];
    store.email = projectsResult.value?.email ?? null;
    store.projectsError = null;
  } else {
    store.projects = [];
    store.email = null;
    store.projectsError = projectsResult.reason;
  }

  // /api/status is allowed to fail: the registry (above) is enough to render
  // Projects and Headquarters, just with every project's state defaulted.
  store.status = statusResult.status === 'fulfilled' ? statusResult.value : null;
  store.merged = merge(store.projects, store.status?.projects);
  store.shellLoaded = true;
}

function renderScreenError(error) {
  const card = el('section', 'card screen-error');
  // A way back that is not « reload the page » (audit D16, P2): it also
  // happens by itself when the connection returns.
  const again = el('button', 'btn primary', 'Try again');
  again.type = 'button';
  again.addEventListener('click', () => renderRoute());
  card.appendChild(emptyState(
    'This screen could not load',
    error?.message || 'Something went wrong. Try again in a moment.',
    again,
  ));
  return card;
}

/* Online and offline (audit D16, P2): say it once, keep the Mac chip honest,
 * and bring back a screen that failed while the connection was gone. */
window.addEventListener('offline', () => {
  document.documentElement.classList.add('is-offline');
  toast('No connection: what you type is kept on this device. HQ picks up again when you are back.');
  if (store.shellLoaded && !safeViewId()) renderHeader();
});
window.addEventListener('online', () => {
  document.documentElement.classList.remove('is-offline');
  toast('Back online');
  if (store.shellLoaded && !safeViewId()) renderHeader();
  if (document.querySelector('#main .screen-error')) renderRoute();
});

async function renderRoute() {
  if (sessionEnded) {
    showSessionEndedBanner();
    return;
  }

  // A popup belongs to the screen that opened it. In-app navigation replaces
  // #main but a scrim lives on <body>, so without this the leads popup's dim
  // layer outlives its screen: it covers the page that just rendered and
  // swallows every click on it. Browser back already did this (onPopState);
  // the nav pills and every in-app button did not.
  closeAllModals();

  const version = ++renderVersion;
  // Safe view: a client is looking. Every address leads back to the one
  // questionnaire, the back button included, and HQ's chrome stays empty.
  // A questionnaire page is always the client's page (Andy, 16 Oct: "the
  // save mode needs to be the basic mode"), so opening one turns this tab
  // into safe view.
  const askedFor = onboardingIdIn(location.pathname);
  if (askedFor && safeViewId() !== askedFor && !safeViewId()) enterSafeView(askedFor);
  const safeId = safeViewId();
  document.documentElement.classList.toggle('safe-view', Boolean(safeId));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', safeId ? '#ffffff' : THEMES.find(([id]) => id === currentTheme())[3]);
  if (safeId && location.pathname !== safePath(safeId)) history.replaceState(null, '', safePath(safeId));
  const route = parseRoute(location.pathname);
  if (safeId) {
    clear(document.getElementById('nav'));
  } else {
    renderNav(route);
    // Mac online, the address: only once they are known, never a guess first.
    if (store.shellLoaded) renderHeader();
  }

  const main = document.getElementById('main');
  clear(main);
  main.setAttribute('aria-busy', 'true');
  const waiting = setTimeout(() => {
    if (version === renderVersion && !main.firstChild) main.appendChild(loadingState());
  }, 200);
  const settle = () => { clearTimeout(waiting); if (version === renderVersion) { clear(main); main.removeAttribute('aria-busy'); } };

  // The invoice's own fonts belong to the invoice: they are added when that
  // route renders and taken off again by the next route that does not.
  invoiceFonts(route.name === 'invoice');

  try {
    if (!OWN_DATA.has(route.name)) await shellReady;
    if (version !== renderVersion || sessionEnded) return;
    let content;
    switch (route.name) {
      case 'projects': content = renderProjectsList(ctx); break;
      case 'project-detail': content = await renderProjectDetail(ctx, route.slug); break;
      case 'missions': content = await renderMissions(ctx); break;
      case 'outreach': content = await renderOutreach(ctx); break;
      case 'leads': content = await renderLeads(ctx); break;
      case 'finance': content = await renderFinance(ctx); break;
      case 'invoice': content = await renderInvoicePage(ctx, route.id); break;
      case 'admin': content = renderAdmin(ctx); break;
      case 'reports': content = await renderReports(ctx); break;
      case 'pipeline': content = await renderPipeline(ctx); break;
      case 'prospect': content = await renderProspect(ctx, route.id); break;
      case 'onboarding': content = await renderOnboarding(ctx, route.id, { safe: Boolean(safeId) }); break;
      case 'hq':
      default: content = await renderHQ(ctx); break;
    }
    if (version !== renderVersion || sessionEnded) return;
    settle();
    main.appendChild(content);
  } catch (error) {
    if (version !== renderVersion || sessionEnded) return; // the banner already replaced #main
    settle();
    main.appendChild(renderScreenError(error));
    // A questionnaire that cannot load must not trap HQ in safe view: the
    // one way out is drawn here too.
    if (safeId) {
      main.appendChild(holdButton({
        label: 'Leave', title: 'hold for 2 seconds', className: 'ob-leave',
        onDone: () => { leaveSafeView(); navigate('/pipeline', { replace: true }); },
      }));
    }
  }

  // The footer only speaks when the registry failed to load; otherwise the
  // page ends with its content.
  if (store.projectsError && !safeId) {
    const footer = el('footer', 'nb');
    footer.textContent = 'Some data could not load — showing what HQ has. Reload to try again.';
    main.appendChild(footer);
  }
  window.scrollTo(0, 0);
}

(async function boot() {
  // The small « Ask or tell HQ » window (⌥Space on the Mac): only the assistant, nothing else.
  if (location.pathname === '/ask') {
    const open = (path) => (window.webkit?.messageHandlers?.hqOpen ? window.webkit.messageHandlers.hqOpen.postMessage(path) : window.open(path, '_blank'));
    mountAssistant(open, { standalone: true });
    return;
  }
  enableApiCache();
  shellReady = loadShellData().then(() => {
    if (!safeViewId() && !sessionEnded) { renderNav(parseRoute(location.pathname)); renderHeader(); }
  });
  await renderRoute();
  watchLeadBatches();
  // The assistant: Mac only (greyed « On the Mac » online and on the phone).
  if (!safeViewId()) mountAssistant(navigate);
})();

// Read-only polling, no mail scans or sends.
startWarmAlerts();
