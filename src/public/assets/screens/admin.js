// Admin — the connected-tools board, driven entirely by /api/status.

import { relativeTime } from '../lib.js';
import { el, hero, phoneFrame } from '../dom.js';

function dotFor(kind) {
  if (kind === 'up' || kind === 'running') return 'd-ok';
  if (kind === 'starting' || kind === 'stopping') return 'd-warn';
  if (kind === 'down' || kind === 'failed') return 'd-bad';
  return 'd-idle';
}

function toolCard(title, dotClass, valueText, metaText) {
  const card = el('section', 'card');
  const top = el('div');
  top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px';
  top.appendChild(el('h3', null, title));
  top.appendChild(el('i', `dot ${dotClass}`));
  card.appendChild(top);

  const value = el('p', null, valueText);
  value.style.cssText = 'margin:10px 0 0;font-size:14px';
  card.appendChild(value);

  card.appendChild(el('div', 'meta', metaText));
  return card;
}

export function renderAdmin(ctx) {
  const { store } = ctx;
  const fragment = document.createDocumentFragment();
  fragment.appendChild(hero('Connected', 'tools', 'Read-only pulls · HQ never writes to another product'));

  const checked = store.status?.checkedAt ? `checked ${relativeTime(store.status.checkedAt)}` : 'not yet checked';

  if (!store.status) {
    const notice = el('section', 'card soft');
    notice.appendChild(el(
      'p',
      null,
      'Status could not be checked just now — showing the registry with every project\'s state unknown.',
    ));
    fragment.appendChild(notice);
  }

  const grid = el('div', 'grid g-cards');

  for (const project of store.merged) {
    const label = project.state?.label || 'Unknown';
    const detail = project.state?.detail ? ` · ${project.state.detail}` : '';
    grid.appendChild(toolCard(project.name, dotFor(project.state?.kind), `${label}${detail}`, checked));
  }

  if (store.status?.leads) {
    const { total, hot, withEmail, liveChecked } = store.status.leads;
    grid.appendChild(toolCard(
      'LEADS pipeline',
      'd-ok',
      `${total} leads · ${hot} hot · ${withEmail} with email · ${liveChecked} live-checked`,
      checked,
    ));
  }

  fragment.appendChild(grid);
  fragment.appendChild(el(
    'p',
    'hint',
    'Every integration pulls, never pushes, and returns counts rather than records. Each number carries the '
      + 'time it was fetched, because a number with no timestamp is a number you cannot trust.',
  ));

  // On a phone the page stays still and the tools scroll (P6 block 5).
  const root = el('div');
  root.appendChild(fragment);
  return phoneFrame(root, 1, { wrapper: true });
}
