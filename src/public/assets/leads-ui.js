// The bits of browser plumbing the leads screen needs and the rest of HQ
// does not: a toast, a modal shell, the two kinds of clipboard write, and a
// file download. Kept out of dom.js so that file stays what it says it is —
// small DOM builders shared by every screen.

import { el } from './dom.js';

/* ---------------------------------------------------------------- *
 * Toast
 * ---------------------------------------------------------------- */

let toastNode = null;
let toastTimer = null;

export function toast(message, { action } = {}) {
  if (!toastNode || !toastNode.isConnected) {
    toastNode = el('div', 'toast');
    toastNode.setAttribute('role', 'status');
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = message;
  // An action ("Undo"): a button in the toast, which then stays a little longer.
  toastNode.classList.toggle('has-action', Boolean(action));
  if (action) {
    const button = el('button', 'toast__action', action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      clearTimeout(toastTimer);
      toastNode.classList.remove('show');
      action.onClick();
    }, { once: true });
    toastNode.append(' · ', button);
  }
  // Let the node land before the class, so the transition actually runs.
  requestAnimationFrame(() => toastNode.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), action ? 6000 : 2400);
}

/* ---------------------------------------------------------------- *
 * Clipboard
 * ---------------------------------------------------------------- */

function copyByExecCommand(text) {
  const area = el('textarea');
  area.value = text;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:-10000px;opacity:0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(area);
  return ok;
}

/** Plain text. Reports through a toast, as the old app did. */
export function copyText(text, what = 'Text') {
  const value = String(text ?? '');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(
      () => toast(`${what} copied`),
      () => toast(copyByExecCommand(value) ? `${what} copied` : 'Could not copy'),
    );
    return true;
  }
  const ok = copyByExecCommand(value);
  toast(ok ? `${what} copied` : 'Could not copy');
  return ok;
}

/**
 * The designed email, as rich text, so pasting it into Gmail keeps the
 * layout. Written into a same-document iframe and copied from there, which
 * keeps the whole thing synchronous — browsers only allow a clipboard write
 * during the gesture that asked for it, and an await would lose it.
 * Ported from the old app's `copyRendered`.
 */
export function copyRichHtml(html) {
  const frame = el('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;height:1200px;border:0;opacity:0';
  document.body.appendChild(frame);

  let ok = false;
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    const selection = frame.contentWindow.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    ok = doc.execCommand('copy');
    selection.removeAllRanges();
  } catch {
    ok = false;
  }
  document.body.removeChild(frame);

  if (!ok && navigator.clipboard && window.ClipboardItem) {
    try {
      navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([html.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }),
      })]);
      ok = true;
    } catch { /* the plain-text route below is the caller's fallback */ }
  }
  return ok;
}

/* ---------------------------------------------------------------- *
 * Files and windows
 * ---------------------------------------------------------------- */

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/**
 * Opens a tab and severs the opener, so the new page cannot reach back into
 * HQ. The `noopener` *feature* is deliberately not used: it makes some
 * browsers return null, and the caller needs the handle to tell a blocked
 * pop-up from a successful one.
 */
export function openTab(url) {
  const win = window.open(url, '_blank');
  if (win) win.opener = null;
  else toast('Allow pop-ups for this page to open that');
  return win;
}

/** The designed email in its own tab, from a blob so nothing is uploaded. */
export function openHtmlTab(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = openTab(url);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return win;
}

/* ---------------------------------------------------------------- *
 * Modal shell
 * ---------------------------------------------------------------- */

const stack = [];

function onGlobalKeydown(event) {
  if (event.key !== 'Escape' || !stack.length) return;
  const target = event.target;
  const tag = (target?.tagName || '').toLowerCase();
  const top = stack[stack.length - 1];
  // A pop-up with a guard (unsaved edits) closes from a field too, after
  // asking when there is something to lose (audit D15, M9). Without one,
  // Escape leaves the field first and the pop-up second — the old app's rule.
  if (top.guarded) { top.requestClose(); return; }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') { target.blur(); return; }
  top.close();
}

function onPopState() {
  while (stack.length) stack[stack.length - 1].close();
}

/**
 * Put a modal on screen. Returns `{ modal, close }` — `modal` is the card to
 * fill, `close` tears it down, restores focus and unhooks the listeners.
 * Clicking the backdrop closes it; Escape closes the topmost one.
 */
export function openModal({ className = '', label = '', onClose, guard = null } = {}) {
  if (!stack.length) {
    document.addEventListener('keydown', onGlobalKeydown);
    window.addEventListener('popstate', onPopState);
  }

  const returnFocusTo = document.activeElement;
  const scrim = el('div', 'scrim');
  const modal = el('div', `modal${className ? ` ${className}` : ''}`);
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  if (label) modal.setAttribute('aria-label', label);
  scrim.appendChild(modal);

  let closed = false;
  const entry = {
    close() {
      if (closed) return;
      closed = true;
      const index = stack.indexOf(entry);
      if (index !== -1) stack.splice(index, 1);
      scrim.remove();
      if (!stack.length) {
        document.removeEventListener('keydown', onGlobalKeydown);
        window.removeEventListener('popstate', onPopState);
      }
      if (returnFocusTo && typeof returnFocusTo.focus === 'function' && returnFocusTo.isConnected) {
        returnFocusTo.focus();
      }
      if (onClose) onClose();
    },
  };

  // `guard()` answers whether it may close: a pop-up holding unsaved edits asks
  // first, instead of a stray click on the backdrop dropping them (audit D15).
  entry.guarded = typeof guard === 'function';
  entry.requestClose = () => { if (!entry.guarded || guard()) entry.close(); };
  scrim.addEventListener('mousedown', (event) => {
    if (event.target === scrim) entry.requestClose();
  });

  stack.push(entry);
  document.body.appendChild(scrim);
  return { modal, scrim, close: entry.close, requestClose: entry.requestClose };
}

/** Shut every modal — used when the screen itself goes away. */
export function closeAllModals() {
  while (stack.length) stack[stack.length - 1].close();
}
