import { el } from './dom.js';
import { apiFetch } from './api.js';
export const send = (url, method, body) => apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function input(label, value = '', type = 'text') {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'label', label));
  const control = el(type === 'textarea' ? 'textarea' : 'input', 'text-input');
  if (type !== 'textarea') control.type = type;
  control.value = value ?? '';
  if (type === 'textarea') control.rows = 5;
  wrap.append(control);
  return { wrap, control };
}
export function select(label, choices, value = '') {
  const wrap = el('label', 'field');
  wrap.append(el('span', 'label', label));
  const control = el('select', 'text-input');
  for (const [key, text] of choices) {
    const option = el('option', null, text); option.value = key; control.append(option);
  }
  control.value = value;
  wrap.append(control);
  return { wrap, control };
}
export function button(text, run, cls = 'btn') {
  const node = el('button', cls, text); node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await run(); } catch (error) { notice(node.closest('dialog') || node.parentElement, error.message, true); }
    finally { node.disabled = false; }
  });
  return node;
}
export function notice(parent, text, error = false) {
  let node = parent.querySelector(':scope > .feedback');
  if (!node) { node = el('p', 'feedback'); parent.append(node); }
  node.setAttribute('role', error ? 'alert' : 'status'); node.textContent = text;
}
export function modal(title) {
  const dialog = el('dialog', 'editor');
  const header = el('div', 'editor-head');
  header.append(el('h2', null, title), button('Close', () => dialog.close(), 'btn quiet'));
  dialog.append(header);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
  return dialog;
}
export const money = (cents, currency = 'EUR') => new Intl.NumberFormat('en-BE', { style: 'currency', currency }).format((cents ?? 0) / 100);
