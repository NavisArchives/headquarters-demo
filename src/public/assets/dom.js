// Tiny DOM-building helpers shared by app.js and the screens. Deliberately
// not in lib.js: lib.js is unit-tested under plain Node with no DOM, and
// these need one.

/** Create an element, optionally with a class and text content. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Append every argument (nodes or falsy-skippable) to a parent, return it. */
export function append(parent, ...children) {
  for (const child of children) {
    if (child) parent.appendChild(child);
  }
  return parent;
}

/** Remove all children of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** The mockup's two-part hero heading: "<title> <em>italic</em>", plus a sub line. */
export function hero(title, italic, sub) {
  const wrap = el('div', 'hero');
  const left = el('div');
  const h1 = el('h1');
  h1.appendChild(document.createTextNode(`${title} `));
  h1.appendChild(el('em', null, italic));
  left.appendChild(h1);
  if (sub) left.appendChild(el('p', 'sub', sub));
  wrap.appendChild(left);
  return wrap;
}

/** The mockup's centred empty-state block. */
export function emptyState(title, line, extra) {
  const wrap = el('div', 'empty-state');
  wrap.appendChild(el('h3', null, title));
  wrap.appendChild(el('p', null, line));
  if (extra) wrap.appendChild(extra);
  return wrap;
}

const DOT_FOR_TAG = {
  't-live': 'd-ok', 't-run': 'd-ok', 't-warn': 'd-warn', 't-bad': 'd-bad',
};

/** A status pill: [class, label] -> <span class="tag t-…"><i class="dot …"/>label</span> */
export function tag([cls, label]) {
  const t = el('span', `tag ${cls}`);
  t.appendChild(el('i', `dot ${DOT_FOR_TAG[cls] || 'd-idle'}`));
  t.appendChild(document.createTextNode(label));
  return t;
}

/** One row in an "attention" list: a dot, a title (+ optional small sub), and a right-aligned "when". */
export function attentionRow({ dot, who, sub, when, onClick }) {
  const row = el('button', 'row');
  row.type = 'button';
  row.appendChild(el('i', `dot ${dot}`));
  const whoNode = el('div', 'who');
  whoNode.appendChild(document.createTextNode(who));
  if (sub) whoNode.appendChild(el('small', null, sub));
  row.appendChild(whoNode);
  row.appendChild(el('span', 'when', when || ''));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}

const TICK_CLASS = { done: 'done', in_progress: 'doing', blocked: 'blocked' };

/** One word for each status, shared by the Missions cards and the home panel
 *  so the two screens call the same thing by the same name. */
export const MISSION_STATUS_LABEL = Object.freeze({
  proposed: 'proposed by a reply',
  pending: 'ready to start',
  in_progress: 'in progress',
  blocked: 'blocked',
  done: 'done',
});

/**
 * A read-only mission row, as used on the Headquarters panel: the same
 * language as a mission card on /missions, in one compact line — the status,
 * then the project or the due date, or what blocks it.
 */
export function missionRow(mission) {
  const row = el('div', `mission${mission.status === 'done' ? ' is-done' : ''}`);
  const tickClass = TICK_CLASS[mission.status];
  const tick = el('span', `tick${tickClass ? ` ${tickClass}` : ''}`, mission.status === 'done' ? '✓' : '');
  row.appendChild(tick);

  const body = el('div', 'body');
  body.appendChild(document.createTextNode(mission.title));
  const parts = [MISSION_STATUS_LABEL[mission.status] || mission.status];
  if (mission.status === 'blocked' && mission.blocked_on) parts.push(mission.blocked_on);
  else if (mission.slug) parts.push(mission.slug);
  else if (mission.due) parts.push(`due ${String(mission.due).slice(0, 10)}`);
  body.appendChild(el('small', null, parts.join(' · ')));
  row.appendChild(body);

  return row;
}

/**
 * On a desktop screen, cap a box at the space left below its top, so the page
 * itself never scrolls and the box scrolls inside (Andy, 16 Oct). Measured
 * after layout and on resize; smaller screens keep the ordinary page scroll.
 */
export function fillViewport(node, { bottom = 24, min = 220 } = {}) {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const desktop = window.matchMedia('(min-width: 1100px) and (min-height: 700px)');
  const fit = () => {
    if (!node.isConnected) { window.removeEventListener('resize', fit); return; }
    if (!desktop.matches) { node.style.maxHeight = ''; node.style.overflowY = ''; return; }
    const top = node.getBoundingClientRect().top + window.scrollY;
    node.style.maxHeight = `${Math.max(min, window.innerHeight - top - bottom)}px`;
    node.style.overflowY = 'auto';
  };
  window.addEventListener('resize', fit);
  requestAnimationFrame(() => requestAnimationFrame(fit));
}

/** The phone frame for a page of cards (P6 block 5): its first `keep` blocks
 *  (the title) stay on top and the rest go into one body, the one region that
 *  scrolls on a phone. On a desktop both wrappers are display: contents
 *  (phone.css), so the page lays out exactly as before. */
export function phoneFrame(root, keep = 1, { wrapper = false } = {}) {
  root.classList.add('phone-frame', 'page-frame');
  // A wrapper added only for the frame vanishes on a desktop; a real root (a grid) stays.
  if (wrapper) root.classList.add('page-frame--plain');
  const body = el('div', 'page-body scroll-region');
  // A region that scrolls is reachable from the keyboard, even with nothing to focus inside (axe).
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', root.querySelector('h1')?.textContent?.trim() || 'Content');
  for (const node of [...root.children].slice(keep)) body.appendChild(node);
  root.appendChild(body);
  return root;
}
