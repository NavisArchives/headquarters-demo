// "Your details" — the outreach profile, as the old app's profile panel was.
// Name, studio, email, phone, portfolio, social, hero image: the seven
// fields every draft reads. It lived in localStorage; it lives in D1 now,
// behind GET/PUT /api/settings/profile.

import { el } from '../dom.js';
import { apiFetch, ApiError } from '../api.js';
import { openModal, toast } from '../leads-ui.js';
import { PROFILE_FIELDS, signaturePreview } from '../leads-lib.js';

export async function loadProfile() {
  try {
    const body = await apiFetch('/api/settings/profile');
    const profile = body?.profile;
    return profile && typeof profile === 'object' ? profile : {};
  } catch {
    // A missing profile is not an error: the worker composes with its own
    // defaults until one is saved.
    return {};
  }
}

/**
 * Open the editor. `onSaved` receives the saved profile so the caller can
 * keep its copy current — the popup's "add your portfolio link" warning
 * depends on it.
 */
export function openProfileEditor(profile = {}, onSaved) {
  const current = { ...profile };
  const { modal, close } = openModal({ className: 'narrow', label: 'Your details' });

  const head = el('div', 'modal-head');
  const heading = el('div');
  heading.appendChild(el('div', 'crumb', 'Leads · outreach'));
  heading.appendChild(el('h2', null, 'Your details'));
  head.appendChild(heading);

  const nav = el('div', 'navbtns');
  const closeBtn = el('button', 'x', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  nav.appendChild(closeBtn);
  head.appendChild(nav);
  modal.appendChild(head);

  const section = el('div', 'sec');
  section.appendChild(el('h6', null, 'Used in every outreach draft'));

  const inputs = new Map();
  for (const field of PROFILE_FIELDS) {
    const wrap = el('label', 'torow');
    wrap.style.gridTemplateColumns = '1fr';
    const label = el('span', 'lbl');
    label.textContent = field.label;
    label.style.textTransform = 'none';
    label.style.letterSpacing = '.04em';
    wrap.appendChild(label);
    const input = el('input', 'subjbox');
    input.type = 'text';
    input.value = current[field.key] || '';
    input.style.marginBottom = '0';
    wrap.appendChild(input);
    inputs.set(field.key, input);
    section.appendChild(wrap);
  }

  section.appendChild(el(
    'p',
    'sendhelp',
    'A field left empty falls back to the built-in default, so the drafts are never blank.',
  ));

  const actions = el('div', 'sendrow');
  const save = el('button', 'btn primary', 'Save');
  save.type = 'button';
  actions.appendChild(save);
  const state = el('span', 'saved-note');
  actions.appendChild(state);
  section.appendChild(actions);
  modal.appendChild(section);

  const preview = el('div', 'sec');
  preview.appendChild(el('h6', null, 'Signature preview'));
  const quote = el('div', 'angle');
  preview.appendChild(quote);
  modal.appendChild(preview);

  function readForm() {
    const next = {};
    for (const [key, input] of inputs) next[key] = input.value.trim();
    return next;
  }

  function paintPreview() {
    quote.textContent = signaturePreview(readForm()) || 'Fill the fields above to see your sign-off.';
  }
  paintPreview();
  for (const input of inputs.values()) input.addEventListener('input', paintPreview);

  save.addEventListener('click', async () => {
    const next = readForm();
    save.disabled = true;
    state.textContent = 'Saving…';
    try {
      const body = await apiFetch('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const saved = body?.profile ?? next;
      state.textContent = 'Saved';
      toast('Your details are saved');
      if (onSaved) onSaved(saved);
    } catch (error) {
      state.textContent = error instanceof ApiError ? error.message : 'could not save';
    } finally {
      save.disabled = false;
    }
  });

  queueMicrotask(() => inputs.get('name')?.focus());
  return close;
}
