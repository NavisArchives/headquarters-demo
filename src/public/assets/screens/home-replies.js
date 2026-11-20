import { el } from '../dom.js';
import { apiFetch } from '../api.js';
import { toast } from '../leads-ui.js';
import { openTimeline } from './outreach.js';

function button(label, action) {
  const node = el('button', 'btn small', label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { toast(error.message); } finally { node.disabled = false; }
  });
  return node;
}

/** How fresh the list is, in plain words (U2/S1: no engineer text). Only what HQ
 *  recorded (src/worker/freshness.js); nothing at all when no read is on record. */
export function freshnessLine(freshness, now = Date.now()) {
  const m = freshness?.mailbox;
  if (!m || m.state === 'unknown') return null;
  if (m.state === 'failed') return { state: 'failed', text: 'Could not check replies' };
  const at = Date.parse(m.last_success_at);
  if (!Number.isFinite(at)) return null;
  if (new Date(at).toDateString() !== new Date(now).toDateString()) return { state: 'stale', text: 'Replies not checked today' };
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return { state: m.state, text: `Replies checked ${ago}` };
}

export async function homeRepliesPanel() {
  const panel = el('section', 'home-replies');
  panel.setAttribute('aria-label', 'Replies first');
  const count = (value, uids = []) => {
    panel.dataset.attentionCount = String(value);
    panel.dataset.replyUids = JSON.stringify(uids);
    panel.dispatchEvent(new CustomEvent('hq:reply-count'));
  };
  let loading = false;
  let queued = false;
  const paint = async () => {
    if (loading) { queued = true; return; }
    loading = true;
    try {
      const inbox = await apiFetch('/api/outreach/replies');
      // Whose turn, from the same read model as the Outreach queue: only what needs Andy counts.
      const check = inbox.check || [];
      const mine = [...inbox.warm, ...check];
      count(mine.length + inbox.declined.length, [...mine, ...inbox.declined].map((row) => row.uid).filter(Boolean));
      const heading = el('h3', null, 'Replies');
      heading.title = inbox.mail_sync;
      panel.replaceChildren();
      // An empty list is only shown as « nothing » when the mailbox was read recently.
      const fresh = freshnessLine(inbox.freshness);
      const unsure = fresh && (fresh.state === 'failed' || fresh.state === 'stale');
      panel.hidden = !mine.length && !inbox.declined.length && !unsure;
      if (!panel.hidden) {
        panel.append(heading);
        if (fresh) {
          const line = el('p', `home-replies-fresh is-${fresh.state}`, fresh.text);
          line.title = 'Warm-reply alerts run only while HQ is open.';
          panel.append(line);
        }
        if (!mine.length && !inbox.declined.length) panel.append(el('p', 'home-replies-note', 'No replies on record.'));
      }
      const append = (row) => {
        const item = el('article', 'home-reply');
        const when = row.reply_at ? new Date(row.reply_at).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const who = el('div', 'home-reply-who');
        who.append(el('b', null, row.name), el('small', null, [row.can_pass ? 'Said no' : row.label, when].filter(Boolean).join(' · ')));
        item.append(who);
        if (row.summary) item.append(el('p', null, row.summary));
        const actions = el('div', 'ow-actions');
        if (row.thread_href) actions.append(button('Open thread', () => window.open(row.thread_href, '_blank', 'noopener,noreferrer')));
        if (row.uid) actions.append(button('History', () => openTimeline(row.uid)));
        if (row.can_pass) actions.append(button('Pass', async () => {
          await apiFetch(`/api/leads/${row.uid}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'passed', follow_up: null }) });
          toast(`${row.name} passed. No future follow-up.`);
          await paint();
        }));
        item.append(actions);
        panel.append(item);
      };
      mine.forEach(append);
      if (inbox.declined.length) {
        panel.append(el('h3', null, 'Said no'));
        inbox.declined.forEach(append);
      }
      // Waiting for them is not Andy's turn: one quiet line, never a count that asks for action.
      const waiting = inbox.waiting || [];
      if (!panel.hidden && waiting.length) {
        const due = waiting.filter((row) => row.turn === 'follow_up_due').length;
        panel.append(el('p', 'home-replies-waiting', `${waiting.length} waiting for their answer${due ? ` · ${due} follow-up due` : ''}`));
      }
    } catch (error) {
      count(1);
      panel.replaceChildren(el('h3', null, 'Replies could not be loaded'),
        el('p', 'hint', 'Your recorded conversations are unavailable. This does not mean there are no replies.'), button('Try replies again', paint));
      toast(error.message);
    } finally {
      loading = false;
      if (queued) { queued = false; void paint(); }
    }
  };
  await paint();
  const timer = setInterval(() => {
    if (!panel.isConnected) { clearInterval(timer); return; }
    if (!document.hidden && !document.querySelector('.scrim')
      && !document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) void paint();
  }, 60000);
  return panel;
}
