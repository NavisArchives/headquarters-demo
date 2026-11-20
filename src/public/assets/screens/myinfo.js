// My info — the one page to copy from when a creator or partner form asks
// "tell us about yourself". Person, channels, and each brand's texts, every
// value with a Copy button; an Edit mode saves a changed copy to D1 behind
// PUT /api/settings/myinfo. Defaults come from src/shared/myinfo.js.

import { el, hero } from '../dom.js';
import { apiFetch } from '../api.js';
import { copyText, toast, openModal } from '../leads-ui.js';
import { DEFAULT_MYINFO, LANGS, mergeMyInfo } from '../myinfo-data.js';

const PATH = '/api/settings/myinfo';

async function load() {
  try {
    const body = await apiFetch(PATH);
    return mergeMyInfo(body?.myinfo);
  } catch {
    return mergeMyInfo(null);
  }
}

function copyBtn(getValue, what) {
  const b = el('button', 'btn small', 'Copy');
  b.type = 'button';
  b.addEventListener('click', () => copyText(getValue(), what));
  return b;
}

/** One labelled value: text with a Copy button, or a textarea in edit mode. */
function fieldRow(label, value, editing, onInput, { link = false } = {}) {
  const row = el('div', 'mi-row');
  row.appendChild(el('div', 'mi-k', label));
  const v = el('div', 'mi-v');
  if (editing) {
    const ta = el('textarea', 'mi-input');
    ta.value = value || '';
    ta.rows = value && value.length > 90 ? 4 : 1;
    ta.addEventListener('input', () => onInput(ta.value));
    v.appendChild(ta);
  } else {
    if (link && /^https?:\/\//.test(value || '')) {
      const a = el('a', 'mi-link', value);
      a.href = value; a.target = '_blank'; a.rel = 'noopener noreferrer';
      v.appendChild(a);
    } else {
      v.appendChild(el('p', 'mi-text', value || '—'));
    }
    v.appendChild(copyBtn(() => value || '', label));
  }
  row.appendChild(v);
  return row;
}

function personCard(info, editing) {
  const card = el('section', 'card');
  card.appendChild(el('h2', null, 'Who'));
  const p = info.person;
  for (const [key, label] of [['name', 'First name'], ['location', 'Location'], ['languages', 'Languages'], ['phone', 'Phone'], ['inbox', 'Inbox']]) {
    card.appendChild(fieldRow(label, p[key], editing, (val) => { p[key] = val; }));
  }
  card.appendChild(el('p', 'hint', 'Forms get the first name and a brand address, never the full name — clients deal with a studio.'));
  return card;
}

function channelsCard(info, editing) {
  const card = el('section', 'card');
  card.appendChild(el('h2', null, 'Channels'));
  info.channels.forEach((c, i) => {
    const row = el('div', 'mi-row');
    row.appendChild(el('div', 'mi-k', c.label || `Channel ${i + 1}`));
    const v = el('div', 'mi-v');
    if (editing) {
      for (const [key, ph] of [['label', 'Label'], ['handle', 'Handle'], ['url', 'https://…'], ['audience', 'Audience (e.g. 12k followers, 60% women 25–34, BE/NL/FR)']]) {
        const inp = el('input', 'mi-input');
        inp.type = 'text'; inp.placeholder = ph; inp.value = c[key] || '';
        inp.addEventListener('input', () => { c[key] = inp.value; });
        v.appendChild(inp);
      }
      const rm = el('button', 'btn small quiet', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', () => { info.channels.splice(i, 1); rerender(); });
      v.appendChild(rm);
    } else {
      const a = el('a', 'mi-link', c.url || '—');
      if (c.url) { a.href = c.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      v.appendChild(a);
      const meta = [c.handle, c.audience].filter(Boolean).join(' · ');
      if (meta) v.appendChild(el('p', 'meta', meta));
      const btns = el('div', 'mi-btns');
      btns.appendChild(copyBtn(() => c.url, c.label));
      if (c.handle) btns.appendChild(copyBtn(() => c.handle, `${c.label} handle`));
      v.appendChild(btns);
    }
    row.appendChild(v);
    card.appendChild(row);
  });
  if (editing) {
    const add = el('button', 'btn small', 'Add a channel');
    add.type = 'button';
    add.addEventListener('click', () => { info.channels.push({ label: '', handle: '', url: '', audience: '' }); rerender(); });
    card.appendChild(add);
  } else {
    const all = el('button', 'btn small', 'Copy all links');
    all.type = 'button';
    all.addEventListener('click', () => copyText(info.channels.map((c) => `${c.label}: ${c.url}`).join('\n'), 'Links'));
    card.appendChild(all);
  }
  return card;
}

function brandCard(key, b, editing) {
  const card = el('section', 'card');
  card.appendChild(el('h2', null, b.name));
  card.appendChild(el('p', 'meta', key === 'realis' ? 'Websites and social media · architects and plastic surgeons' : 'UGC and influencer work'));
  card.appendChild(fieldRow('Email on forms', b.email, editing, (v) => { b.email = v; }));
  card.appendChild(fieldRow('Website', b.site, editing, (v) => { b.site = v; }, { link: true }));
  card.appendChild(fieldRow('What I offer', b.offer, editing, (v) => { b.offer = v; }));
  card.appendChild(fieldRow('Categories', b.categories, editing, (v) => { b.categories = v; }));
  card.appendChild(fieldRow('Track record', b.history, editing, (v) => { b.history = v; }));
  for (const lang of LANGS) card.appendChild(fieldRow(`Short bio · ${lang}`, b.short[lang], editing, (v) => { b.short[lang] = v; }));
  for (const lang of LANGS) card.appendChild(fieldRow(`Tell us about yourself · ${lang}`, b.about[lang], editing, (v) => { b.about[lang] = v; }));
  return card;
}

let state = null;   // { info, editing, root }

function rerender() {
  if (!state) return;
  const { root } = state;
  root.replaceChildren(...build());
}

function build() {
  const { info, editing } = state;
  const nodes = [];
  const head = hero('My', 'info', 'What forms ask for: who you are, where to find you, and "tell us about yourself" in each brand’s voice');
  const actions = el('div', 'hero-actions');
  if (editing) {
    const save = el('button', 'btn primary', 'Save');
    save.type = 'button';
    save.addEventListener('click', async () => {
      try {
        await apiFetch(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
        state.editing = false; toast('My info saved'); rerender();
      } catch (e) { toast(e?.message || 'Could not save'); }
    });
    const cancel = el('button', 'btn quiet', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => { state.info = await load(); state.editing = false; rerender(); });
    const reset = el('button', 'btn quiet', 'Reset to defaults');
    reset.type = 'button';
    reset.addEventListener('click', () => { state.info = mergeMyInfo(null); rerender(); });
    actions.append(save, cancel, reset);
  } else {
    const edit = el('button', 'btn', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => { state.editing = true; rerender(); });
    actions.appendChild(edit);
  }
  head.appendChild(actions);
  nodes.push(head);

  const grid = el('div', 'grid g-2');
  grid.appendChild(personCard(info, editing));
  grid.appendChild(channelsCard(info, editing));
  nodes.push(grid);
  const brands = el('div', 'grid g-2');
  brands.appendChild(brandCard('archive', info.brands.archive, editing));
  brands.appendChild(brandCard('realis', info.brands.realis, editing));
  nodes.push(brands);
  return nodes;
}

export async function renderMyInfo() {
  const root = el('div', 'myinfo');
  state = { info: await load(), editing: false, root };
  root.replaceChildren(...build());
  return root;
}

/** The pop-up the Missions screen opens: everything, with a close button. */
export async function openMyInfo() {
  const { modal, close } = openModal({ className: 'wide', label: 'My information' });
  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.appendChild(el('div', 'crumb', 'Missions'));
  heading.appendChild(el('h2', null, 'My information'));
  head.appendChild(heading);
  const nav = el('div', 'navbtns');
  const x = el('button', 'x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', close);
  nav.appendChild(x);
  head.appendChild(nav);
  modal.appendChild(head);
  modal.appendChild(await renderMyInfo());
}

export { DEFAULT_MYINFO };
