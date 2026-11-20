import { showAfterSending } from './outreach-verification.js';
import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { download, openModal, toast } from '../leads-ui.js';

const write = (path, body, method = 'POST') => apiFetch(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
function button(label, action, primary = false) {
  const node = el('button', `btn small${primary ? ' primary' : ''}`, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { toast(error.message); } finally { node.disabled = false; }
  });
  return node;
}
function fingerprint(label, value) {
  const line = el('p', 'ow-fingerprint', `${label}: ${value}`);
  line.style.overflowWrap = 'anywhere';
  return line;
}
function editRow(batch, item, done) {
  const { modal, close } = openModal({ label: 'Edit this email', className: 'ow-modal' });
  modal.append(el('h2', null, 'Edit and approve again'));
  if (batch.status === 'approved') modal.append(el('p', 'ow-notice', 'Saving this edit clears approval and reserved capacity. The changed batch needs your approval again.'));
  const subjectLabel = el('label', 'ow-field');
  const subject = el('input', 'text-input');
  subject.value = item.subject;
  subject.readOnly = item.step > 1;
  subjectLabel.append(el('span', null, 'Subject'), subject);
  const bodyLabel = el('label', 'ow-field');
  const body = el('textarea', 'text-input');
  body.value = item.body;
  body.rows = 14;
  bodyLabel.append(el('span', null, 'Full email'), body);
  modal.append(subjectLabel, bodyLabel, button('Save edit', async () => {
    await write(`/api/outreach/batches/${batch.id}`, { uid: item.uid, subject: subject.value, body: body.value, content_hash: batch.content_hash }, 'PATCH');
    toast('Edit saved. Approval is required again.');
    close();
    await done();
  }, true), button('Close', close));
}

export async function reviewBatch(id, refresh) {
  const { batch } = await apiFetch(`/api/outreach/batches/${id}`);
  const { modal, close } = openModal({ label: 'Review exact emails', className: 'ow-modal ow-review-dialog' });
  const reload = async () => { close(); await refresh(); await reviewBatch(id, refresh); };
  const stepCounts = new Map();
  const languageCounts = new Map();
  for (const item of batch.items) {
    stepCounts.set(item.step, (stepCounts.get(item.step) || 0) + 1);
    languageCounts.set(item.lang, (languageCounts.get(item.lang) || 0) + 1);
  }
  modal.append(el('h2', null, 'Review every email'));
  const content = el('div', 'ow-review-body');
  modal.append(content);
  content.append(
    el('p', 'hint', `${batch.day} · From ${batch.sender} · ${batch.items.length} emails · ${batch.status}`),
    el('p', 'hint', [...stepCounts].map(([step, count]) => `Step ${step}: ${count}`).join(' · ')),
    el('p', 'hint', [...languageCounts].map(([lang, count]) => `${lang}: ${count}`).join(' · ')),
    fingerprint('Review sha256', batch.content_hash),
    el('p', 'ow-notice', 'Approval freezes these exact messages. HQ does not send emails. External scheduling happens after approval.'));
  const list = el('div', 'ow-messages');
  for (const item of batch.items) {
    const row = el('article', 'ow-message');
    row.append(el('h3', null, `${item.recipient} · Step ${item.step} · ${item.lang}`),
      el('b', null, item.subject), el('pre', null, item.body));
    if (item.step > 1) row.append(el('p', 'hint', `Original message: ${item.in_reply_to || 'unknown — this row will be held from export'}`));
    if (batch.status !== 'cancelled') row.append(button('Edit email', () => editRow(batch, item, reload)));
    list.append(row);
  }
  content.append(list);
  if (batch.status === 'approved') {
    content.append(button('After sending', () => showAfterSending(id, refresh)));
    const exported = await apiFetch(`/api/outreach/batches/${id}/export`).catch((error) => {
      toast(error.message);
      return null;
    });
    if (exported) {
      const exports = el('section', 'ow-exports');
      exports.append(el('h3', null, 'Export for Brevo'));
      for (const file of exported.files) {
        exports.append(fingerprint(`${file.kind} file sha256`, file.sha256),
          button(`Download ${file.kind} · ${file.count} emails`, () => download(file.filename, file.content, 'application/json')));
      }
      for (const held of exported.held) exports.append(el('p', 'ow-notice', `${held.uid} held: ${held.reasons.join(' · ').replaceAll('_', ' ')}`));
      const hashes = el('details');
      hashes.append(el('summary', null, 'Row fingerprints'));
      for (const [uid, hash] of Object.entries(exported.row_hashes)) hashes.append(fingerprint(uid, hash));
      exports.append(hashes);
      content.append(exports);
    }
  }
  const actions = el('div', 'ow-actions');
  if (batch.status === 'draft') actions.append(button('Approve', async () => {
    await write(`/api/outreach/batches/${id}/approve`, { content_hash: batch.content_hash });
    toast('Approved with this fingerprint. No emails sent.');
    await reload();
  }, true));
  if (batch.status !== 'cancelled') actions.append(button('Cancel batch', async () => {
    await write(`/api/outreach/batches/${id}/cancel`, {});
    toast('Batch cancelled');
    close();
    await refresh();
  }));
  actions.append(button('Close', close));
  modal.append(actions);
}
