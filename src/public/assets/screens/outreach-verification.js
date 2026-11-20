import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { openModal, toast } from '../leads-ui.js';

const write = (path, body) => apiFetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
function upload(parent, label, accept) {
  const wrap = el('label', 'ow-field');
  const input = el('input', 'text-input');
  input.type = 'file';
  input.accept = accept;
  wrap.append(el('span', null, label), input);
  parent.append(wrap);
  return input;
}

export async function showAfterSending(id, refresh) {
  const { batch } = await apiFetch(`/api/outreach/batches/${id}`);
  if (batch.status !== 'approved') { toast('After-sending checks need an approved batch'); return; }
  const { modal, close } = openModal({ label: 'After sending', className: 'ow-modal ow-verification-dialog' });
  const reload = async () => { close(); await refresh(); await showAfterSending(id, refresh); };
  modal.append(el('h2', null, 'After sending'), el('p', 'hint', `${batch.day} · ${batch.sender} · ${batch.items.length} approved emails`));
  const content = el('div', 'ow-verification');
  const verification = JSON.parse(batch.verification_json || '{}');
  const summary = verification.summary;
  if (summary) {
    const banner = el('p', 'ow-notice', summary.failed
      ? `STOP · ${summary.reasons.join(' · ').replaceAll('_', ' ')}`
      : `No stop rule triggered in the uploaded evidence. ${summary.pending} accepted messages still await delivery proof.`);
    banner.setAttribute('role', summary.failed ? 'alert' : 'note');
    content.append(banner);
    const counts = el('div', 'ow-stats');
    for (const [key, label] of [['delivered', 'Delivered'], ['soft_bounce', 'Soft bounce'], ['hard_bounce', 'Hard bounce'], ['spam', 'Spam complaint'], ['blocked', 'Blocked']]) {
      const card = el('section', 'card ow-card');
      card.append(el('h3', null, label), el('b', 'ow-number', String(summary.counts[key])));
      counts.append(card);
    }
    content.append(counts, el('p', 'hint', `${summary.total} provider-accepted messages · ${(summary.bounce_rate * 100).toFixed(2)}% bounced · ${summary.api_failed} API failures · ${summary.not_in_log} absent from the send log · ${summary.unmatched_events} unrelated events · ${summary.ignored_events} ignored events`));
  } else content.append(el('p', 'ow-notice', 'Upload the scheduling log and provider delivery events. Scheduling alone is not delivery proof.'));
  if (summary) content.append(el('p', 'hint', 'Saved uploads are kept. Choose files only to add or replace evidence; known delivery failures stay in this batch’s history.'));
  const sendLog = upload(content, 'Send log JSON', '.json,application/json');
  const events = upload(content, 'Brevo events CSV or JSON', '.csv,.json,text/csv,application/json');
  const subjectLabel = el('label', 'ow-field');
  const subjects = el('textarea', 'text-input');
  subjects.rows = 3;
  subjects.value = (verification.spam_subjects || []).join('\n');
  subjectLabel.append(el('span', null, 'Spam-tagged subjects (one per line)'), subjects);
  content.append(subjectLabel, button('Verify delivery', async () => {
    if ((!sendLog.files[0] && !verification.send_log) || (!events.files[0] && !verification.events)) { toast('Choose both the send log and events export'); return; }
    if ((sendLog.files[0]?.size || 0) + (events.files[0]?.size || 0) > 1200000) { toast('Use exports smaller than 1.2 MB combined'); return; }
    let log = verification.send_log;
    try { if (sendLog.files[0]) log = JSON.parse(await sendLog.files[0].text()); } catch { toast('The send log must be valid JSON'); return; }
    await write(`/api/outreach/batches/${id}/verify`, {
      content_hash: batch.content_hash, send_log: log, events: events.files[0] ? await events.files[0].text() : verification.events,
      spam_subjects: subjects.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    });
    toast('Delivery evidence saved');
    await reload();
  }, true));
  if (summary?.counts.delivered) content.append(button('Log delivered in HQ', async () => {
    const logging = { filed: 0, duplicates: 0, failed: [] };
    let offset = 0;
    do {
      const response = await write(`/api/outreach/batches/${id}/log-delivered`, { content_hash: batch.content_hash, offset, verification_id: verification.verification_id });
      logging.filed += response.logging.filed;
      logging.duplicates += response.logging.duplicates;
      logging.failed.push(...response.logging.failed);
      offset = response.logging.next_offset;
    } while (offset !== null);
    toast(`${logging.filed} logged · ${logging.duplicates} already recorded · ${logging.failed.length} need review`);
    if (logging.failed.length) {
      const errorModal = openModal({ label: 'Delivery logging needs review', className: 'ow-modal' });
      errorModal.modal.append(el('h2', null, 'Not logged'));
      for (const failure of logging.failed) errorModal.modal.append(el('p', null, `${failure.lead_uid}: ${failure.error}`));
      errorModal.modal.append(button('Close', errorModal.close));
    }
    await refresh();
  }, true));
  modal.append(content, button('Close', close));
}
