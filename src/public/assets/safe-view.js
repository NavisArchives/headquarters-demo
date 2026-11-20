// Safe view: HQ shown to a client. One prospect's onboarding questionnaire,
// in the studio's own colours, and nothing else — no navigation, no other
// clients, no money, no notes, no to-dos.
//
// Andy, 16 Oct: "the save mode needs to be the basic mode". The
// questionnaire has no other mode: every /onboarding/<id> page is safe view,
// and HQ opens it in a window of its own, so HQ stays as it was in the
// first one. The mode belongs to that one tab (sessionStorage): a reload
// keeps it, every other address in that tab leads back to the questionnaire
// (app.js), and HQ's own tabs are never touched. Leaving takes a deliberate
// hold, and closes the window.

const KEY = 'hq.safeView';
let memory = null; // when the browser keeps no storage (a private window)

/** The prospect being shown in this tab, or null when this tab is HQ. */
export function safeViewId() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (Number.isInteger(stored?.prospect) && stored.prospect > 0) return stored.prospect;
    return memory;
  } catch {
    return memory;
  }
}

export function enterSafeView(id) {
  memory = id;
  try { sessionStorage.setItem(KEY, JSON.stringify({ prospect: id })); } catch { /* memory only */ }
  document.documentElement.classList.add('safe-view');
}

export function leaveSafeView() {
  memory = null;
  try { sessionStorage.removeItem(KEY); } catch { /* nothing stored */ }
  document.documentElement.classList.remove('safe-view');
}

/** The only address safe view allows. */
export const safePath = (id) => `/onboarding/${id}`;

/** The questionnaire address in a pathname, or null. */
export function onboardingIdIn(pathname) {
  const match = /^\/onboarding\/(\d+)$/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * Open the client's questionnaire in a window of its own. When the browser
 * refuses a new window, this tab becomes the client's page instead.
 */
export function openClientView(id, navigate) {
  const win = typeof window !== 'undefined' && window.open ? window.open(safePath(id), '_blank') : null;
  if (win) {
    try { win.opener = null; } catch { /* already cut */ }
    return true;
  }
  enterSafeView(id);
  navigate?.(safePath(id), { replace: false });
  return false;
}

/**
 * Leave safe view: close the window HQ opened for it, or, when it is not a
 * window that can be closed (the first tab), come back to HQ in it.
 */
export function leaveClientView(id, navigate) {
  leaveSafeView();
  try { window.close(); } catch { /* not ours to close */ }
  setTimeout(() => {
    if (!window.closed) {
      document.title = 'Headquarters';
      navigate?.(`/pipeline/${id}`, { replace: true });
    }
  }, 200);
}

/**
 * A button that does its job only when held: the ring fills over `ms`, and
 * letting go before the end cancels. Pointer and keyboard (Space or Enter
 * held down) both work; a tap does nothing.
 */
export function holdButton({ label, title, ms = 2000, onDone, className = '' }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `hold ${className}`.trim();
  button.title = title || label;
  button.setAttribute('aria-label', `${label} (${title || 'hold'})`);
  const fill = document.createElement('i');
  fill.className = 'hold__fill';
  const text = document.createElement('span');
  text.textContent = label;
  button.append(fill, text);

  let timer = null;
  const start = () => {
    if (timer) return;
    button.classList.add('is-holding');
    fill.style.transitionDuration = `${ms}ms`;
    timer = setTimeout(() => { timer = null; button.classList.remove('is-holding'); onDone(); }, ms);
  };
  const stop = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    button.classList.remove('is-holding');
  };
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); start(); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) button.addEventListener(type, stop);
  button.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); start(); }
  });
  button.addEventListener('keyup', (event) => { if (event.key === ' ' || event.key === 'Enter') stop(); });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  return button;
}
