import { el, emptyState } from '../dom.js';
import { apiFetch } from '../api.js';
import { openModal, toast } from '../leads-ui.js';
import { holdLabel } from '../hold-reasons.js';

const request = (path, body, method = 'POST') => apiFetch(path, {
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
function field(parent, label, value, type = 'text') {
  const wrap = el('label', 'ow-field');
  wrap.append(el('span', null, label));
  const input = el(type === 'textarea' ? 'textarea' : 'input', 'text-input');
  if (type !== 'textarea') input.type = type;
  input.value = value;
  wrap.append(input);
  parent.append(wrap);
  return input;
}
function card(title, { fill = false, actions = [] } = {}) {
  const node = el('section', `card ow-card${fill ? ' ow-fill' : ''}`);
  const head = el('div', 'ow-head');
  head.append(el('h2', null, title), ...actions);
  node.append(head);
  return node;
}

const plainReason = holdLabel;

/** One email of a draft, edited in a pop-up; every change is saved at once. */
function editEmail(state, item, repaint) {
  const { modal, close } = openModal({ label: 'Edit this email', className: 'ow-modal' });
  modal.append(el('h2', null, item.name || item.recipient));
  modal.append(el('p', 'hint', `${item.recipient} · ${item.step === 1 ? 'First email' : `Email ${item.step}`} · ${item.lang}`));
  const subject = field(modal, 'Subject', item.subject);
  subject.readOnly = item.step > 1;
  const body = field(modal, 'Email', item.body, 'textarea');
  body.rows = 14;
  const persist = () => {
    state.pending = state.pending.then(async () => {
      const saved = await request(`/api/outreach/batches/${state.batch.id}`, {
        uid: item.uid, subject: subject.value, body: body.value, content_hash: state.batch.content_hash,
      }, 'PATCH');
      state.batch = saved.batch;
    }).catch((error) => toast(`Not saved: ${error.message}`));
  };
  subject.addEventListener('input', persist);
  body.addEventListener('input', persist);
  const actions = el('div', 'ow-actions');
  actions.append(button('Done', async () => { await state.pending; close(); repaint(); }, true), button('Remove from batch', async () => {
    await state.pending;
    const saved = await request(`/api/outreach/batches/${state.batch.id}`, {
      uid: item.uid, content_hash: state.batch.content_hash, remove: true,
    }, 'PATCH');
    state.batch = saved.batch;
    toast('Email removed');
    close();
    repaint();
  }));
  modal.append(actions);
}

function heldList(skipped) {
  const { modal, close } = openModal({ label: 'Held back', className: 'ow-modal' });
  modal.append(el('h2', null, `${skipped.length} held back`));
  const list = el('div', 'ow-review');
  for (const row of skipped) list.append(el('p', null, `${row.name || row.uid} · ${row.reasons.map(plainReason).join(', ')}`));
  modal.append(list, button('Close', close));
}

// A sender paused by a failed stop rule resumes only with a review note (the API refuses otherwise).
const STOP_HOLD = 'Stop rule failed';
function resumeAfterStop(account, refresh) {
  const { modal, close } = openModal({ label: 'Resume sender', className: 'ow-modal' });
  modal.append(el('h2', null, `Resume ${account.email}?`), el('p', 'hint', account.reason));
  const note = field(modal, 'What you reviewed', '', 'textarea');
  modal.append(button('Resume sender', async () => {
    await request('/api/outreach/senders', { ...account, paused: false, review_note: note.value }, 'PUT');
    toast('Sender resumed. Your review note is on record.');
    close();
    await refresh();
  }, true), button('Keep paused', close));
}

function senderEditor(refresh) {
  const { modal, close } = openModal({ label: 'Add a sender', className: 'ow-modal' });
  modal.append(el('h2', null, 'Add a sender'));
  const email = field(modal, 'Sender address', '', 'email');
  const limit = field(modal, 'Emails a day (0–280)', '20', 'number');
  modal.append(button('Save, paused', async () => {
    await request('/api/outreach/senders', { email: email.value, daily_limit: Number(limit.value), paused: true, reason: 'New sender' }, 'PUT');
    toast('Sender saved, paused. Your drafts are kept.');
    close();
    await refresh();
  }, true));
}

export async function renderDailyPlanner({ refresh, reviewBatch }) {
  const [{ senders }, { batches }, { day }] = await Promise.all([
    apiFetch('/api/outreach/senders'), apiFetch('/api/outreach/batches'), apiFetch('/api/outreach/cockpit'),
  ]);
  const root = el('div', 'ow-planner');
  const side = el('div', 'ow-side');

  const build = card('Build a batch');
  const sender = el('select', 'text-input');
  sender.setAttribute('aria-label', 'Sender');
  for (const account of senders) {
    const option = el('option', null, `${account.email} · ${account.daily_limit} a day${account.paused ? (String(account.reason || '').includes(STOP_HOLD) ? ' · stopped, review in Senders' : ' · paused') : ''}`);
    option.value = account.email;
    sender.append(option);
  }
  if (!senders.length) sender.append(el('option', null, 'Add a sender first'));
  build.append(sender);
  // The next day's batch is built the afternoon before (10:00 Brussels = 04:00 Lima).
  const tomorrow = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const chosenDay = field(build, 'For', tomorrow, 'date');
  build.append(button('Build the batch', async () => {
    if (!senders.length) { senderEditor(refresh); return; }
    const { batch } = await request('/api/outreach/batches/build', { day: chosenDay.value, sender: sender.value });
    toast(`${batch.items.length} emails in your draft`);
    await refresh();
  }, true));
  side.append(build);

  const accounts = card('Senders', { actions: [button('Add', () => senderEditor(refresh))] });
  accounts.classList.add('ow-senders');
  if (!senders.length) accounts.append(el('p', 'hint', 'No sender yet.'));
  for (const account of senders) {
    const row = el('div', 'ow-sender');
    const stopped = account.paused && String(account.reason || '').includes(STOP_HOLD);
    if (stopped) row.classList.add('is-stopped');
    row.append(el('span', null, `${account.email} · ${account.daily_limit} a day${stopped ? ' · stopped' : ''}`), button(account.paused ? (stopped ? 'Review' : 'Allow') : 'Pause', async () => {
      if (stopped) { resumeAfterStop(account, refresh); return; }
      await request('/api/outreach/senders', { ...account, paused: !account.paused }, 'PUT');
      toast(account.paused ? 'Sender allowed. Your drafts are kept.' : 'Sender paused. Your drafts are kept.');
      await refresh();
    }));
    accounts.append(row);
  }
  side.append(accounts);
  root.append(side);

  const drafts = batches.filter((batch) => batch.status === 'draft');
  const main = card(drafts.length ? 'Draft' : 'No draft yet', { fill: true });
  const list = el('div', 'ow-list');
  main.append(list);
  if (!drafts.length) list.append(emptyState('Nothing drafted', 'Build a batch: follow-ups first, then leads with no website, then the rest.'));
  for (const summary of drafts) {
    const state = { batch: (await apiFetch(`/api/outreach/batches/${summary.id}`)).batch, pending: Promise.resolve() };
    const section = el('div', 'ow-draft');
    section.dataset.batchId = state.batch.id;
    const head = el('div', 'ow-draft-head');
    const title = el('b');
    const skipped = JSON.parse(state.batch.skipped_json || '[]');
    const actions = el('div', 'ow-actions');
    if (skipped.length) actions.append(button(`${skipped.length} held back`, () => heldList(skipped)));
    actions.append(button('Review and approve', async () => { await state.pending; await reviewBatch(state.batch.id, refresh); }, true));
    head.append(title, actions);
    const rows = el('div');
    const repaint = () => {
      section.dataset.draftCount = String(state.batch.items.length);
      title.textContent = `${state.batch.day} · ${state.batch.items.length} emails · ${state.batch.sender}`;
      rows.replaceChildren();
      if (!state.batch.items.length) rows.append(el('p', 'hint', 'No email qualifies for this day.'));
      for (const item of state.batch.items) {
        rows.append(attention(`${item.name || item.recipient}`, `${item.step === 1 ? 'First email' : `Email ${item.step}`} · ${item.lang} · ${item.subject}`, () => editEmail(state, item, repaint)));
      }
    };
    repaint();
    section.append(head, rows);
    list.append(section);
  }
  root.append(main);
  return root;
}

function attention(who, sub, onClick) {
  const row = el('button', 'row');
  row.type = 'button';
  const text = el('div', 'who');
  text.append(document.createTextNode(who), el('small', null, sub));
  row.append(el('i', 'dot d-idle'), text, el('span', 'when', 'Edit'));
  row.addEventListener('click', onClick);
  return row;
}
