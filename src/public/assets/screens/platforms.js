// Projects → Platforms (20 Nov): the work platforms Andy is signed up to. One
// list, nothing else. A platform is not a project: this pane reads and writes
// /api/platforms only, never the projects API, and nothing here feeds counts,
// the board, finance or the assistant. No field for a login, code or ID.
import { apiFetch } from '../api.js';
import { toast } from '../leads-ui.js';
import { el, clear, emptyState } from '../dom.js';
import { input, select, button, send, modal } from '../forms.js';
import { relativeTime } from '../lib.js';
import { PLATFORM_STATUSES, PLATFORM_STATUS_LABEL, sortPlatforms } from '../platform-statuses.js';

const STATUS_CLASS = {
  test_to_do: 'pf-s--now', to_sign_up: 'pf-s--now', signed_up: 'pf-s--mid',
  waiting: 'pf-s--mid', active: 'pf-s--live', closed: 'pf-s--off',
};

/** « app.outlier.ai » from https://app.outlier.ai/ — what the link shows. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function statusSelect(platform, onChange) {
  const wrap = el('label', `pf-status ${STATUS_CLASS[platform.status] ?? ''}`);
  const control = el('select', 'pf-status__select');
  control.setAttribute('aria-label', `Status of ${platform.name}`);
  for (const [key, label] of PLATFORM_STATUSES) {
    const option = el('option', null, label); option.value = key; control.append(option);
  }
  control.value = platform.status;
  control.addEventListener('change', () => onChange(control.value, control));
  wrap.append(control);
  return wrap;
}

export function platformRow(platform, { onStatus, onEdit, now = Date.now() } = {}) {
  // Compact (NIRMATA F1, 20 Nov): name, status and Edit on one line; link and
  // last change on the next; then only the facts it has. No footer band.
  const row = el('li', 'pf-row');
  row.dataset.status = platform.status;
  const edit = el('button', 'pf-edit', 'Edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit ${platform.name}`);
  edit.addEventListener('click', () => onEdit?.(platform));
  const head = el('div', 'pf-head');
  const controls = el('div', 'pf-controls');
  controls.append(statusSelect(platform, (status, control) => onStatus?.(platform, status, control)), edit);
  const title = el('strong', 'pf-title', platform.name);
  title.title = platform.name; // a long name ends in « … » on the card; the whole name is on hover and in Edit
  head.append(title, controls);
  row.append(head);

  const sub = el('div', 'pf-sub');
  const where = el('span', 'pf-where');
  if (platform.url) {
    const a = el('a', 'pf-link', `${hostOf(platform.url)} ↗`);
    a.href = platform.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.title = platform.url;
    where.append(a);
  }
  where.append(el('small', 'pf-when', `${platform.url ? ' · ' : ''}Changed ${relativeTime(platform.updated_at, now)}`));
  sub.append(where);
  row.append(sub);

  const facts = el('dl', 'pf-facts');
  const fact = (label, value) => {
    if (!value) return;
    facts.append(el('dt', null, label), el('dd', null, value));
  };
  fact('Next', platform.next_step);
  fact('Pay', platform.pay);
  fact('Note', platform.note);
  if (facts.children.length) row.append(facts);
  return row;
}

/** The add / edit form, in HQ's modal. Remove lives here, behind a confirm. */
function openEditor(platform, { saved, removed }) {
  const dialog = modal(platform ? `Edit ${platform.name}` : 'Add a platform');
  dialog.classList.add('pf-editor');
  const form = el('div', 'pf-form');
  const f = {
    name: input('Name', platform?.name ?? ''),
    url: input('Link', platform?.url ?? '', 'url'),
    status: select('Status', PLATFORM_STATUSES, platform?.status ?? 'to_sign_up'),
    next_step: input('Next step', platform?.next_step ?? ''),
    pay: input('Pay', platform?.pay ?? ''),
    note: input('Note', platform?.note ?? '', 'textarea'),
  };
  f.url.control.placeholder = 'e.g. micro1.ai';
  f.pay.control.placeholder = 'e.g. $25/h';
  f.note.control.rows = 2;
  // Two columns on a wide screen (F2): the whole form and its Save fit at 1366×640.
  for (const [key, field] of Object.entries(f)) {
    field.wrap.classList.add(`pf-f-${key}`);
    form.append(field.wrap);
  }
  const actions = el('div', 'pf-actions');
  actions.append(button(platform ? 'Save' : 'Add', async () => {
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.control.value]));
    const result = platform
      ? await send(`/api/platforms/${platform.id}`, 'PATCH', body)
      : await send('/api/platforms', 'POST', body);
    dialog.close();
    saved(result.platform, Boolean(platform));
  }, 'btn primary'));
  if (platform) {
    actions.append(button('Remove', async () => {
      if (!window.confirm(`Remove ${platform.name} from your platforms? This cannot be undone.`)) return;
      await apiFetch(`/api/platforms/${platform.id}`, { method: 'DELETE' });
      dialog.close();
      removed(platform);
    }, 'btn quiet pf-remove'));
  }
  form.append(actions);
  dialog.append(form);
  f.name.control.focus();
}

/** The Platforms pane. Loads on first show; every change re-sorts in place. */
export function platformsPane() {
  const pane = el('section', 'pf-pane');
  pane.dataset.pane = 'platforms';
  const bar = el('div', 'pf-bar');
  const count = el('p', 'pf-count');
  const add = el('button', 'btn small', '+ Add platform');
  add.type = 'button';
  bar.append(count, add);
  const list = el('ul', 'pf-list');
  list.setAttribute('aria-label', 'Platforms');
  pane.append(bar, list);

  let rows = [];
  let loaded = false;

  const paint = () => {
    clear(list);
    const open = rows.filter((r) => r.status === 'test_to_do' || r.status === 'to_sign_up').length;
    count.textContent = rows.length
      ? `${rows.length} platform${rows.length === 1 ? '' : 's'}${open ? ` · ${open} need${open === 1 ? 's' : ''} you` : ''}`
      : '';
    if (!rows.length) {
      const empty = el('li', 'pf-empty');
      empty.append(emptyState('No platforms yet', 'Add the platforms you work through: a link, where you stand, and the next step.'));
      list.append(empty);
      return;
    }
    for (const p of sortPlatforms(rows)) list.append(platformRow(p, { onStatus, onEdit }));
  };

  const replace = (platform) => { rows = rows.map((r) => (r.id === platform.id ? platform : r)); paint(); };
  const handlers = {
    saved: (platform, existed) => {
      if (existed) replace(platform); else { rows = [...rows, platform]; paint(); }
      toast(existed ? `${platform.name} saved` : `${platform.name} added`);
    },
    removed: (platform) => { rows = rows.filter((r) => r.id !== platform.id); paint(); toast(`${platform.name} removed`); },
  };
  async function onStatus(platform, status, control) {
    control.disabled = true;
    try {
      const { platform: next } = await send(`/api/platforms/${platform.id}`, 'PATCH', { status });
      replace(next);
      toast(`${next.name} · ${PLATFORM_STATUS_LABEL[next.status]}`);
    } catch (error) {
      control.value = platform.status; control.disabled = false;
      toast(`Could not change the status: ${error.message}`);
    }
  }
  function onEdit(platform) { openEditor(platform, handlers); }
  add.addEventListener('click', () => openEditor(null, handlers));

  pane.load = async () => {
    if (loaded) return;
    loaded = true;
    clear(list);
    list.append(el('li', 'pf-empty', 'Loading…'));
    try {
      rows = (await apiFetch('/api/platforms')).platforms ?? [];
      paint();
    } catch (error) {
      loaded = false;
      clear(list);
      const li = el('li', 'pf-empty');
      li.append(emptyState('Could not load platforms', error.message || 'Reload to try again.'));
      list.append(li);
    }
  };
  return pane;
}
