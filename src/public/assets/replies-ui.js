// The browser's side of the reply funnel.
//
// One module because the same three things are drawn in two places: the
// proposal tray on Missions and the "What they said" block in a lead's popup.
// Action proposals still require the owner. Clear refusals are handled by
// the backend automatically and appear in history, without a mission.
// Links from email are displayed; never followed automatically.

import { el } from './dom.js';
import { apiFetch, ApiError } from './api.js';

/** Load replies.css once, from whichever screen draws a proposal first. */
export function ensureRepliesCss() {
  if (typeof document === 'undefined' || document.getElementById('replies-css')) return;
  const link = document.createElement('link');
  link.id = 'replies-css';
  link.rel = 'stylesheet';
  link.href = '/assets/replies.css';
  document.head.appendChild(link);
}

export const INTENT_LABEL = Object.freeze({
  interested: 'Interested',
  wants_info: 'Wants information',
  wants_call: 'Wants a call',
  asks_rate: 'Asks your rate',
  sign_up_elsewhere: 'Sign up elsewhere',
  not_now: 'Not now',
  not_interested: 'Not interested',
  auto_reply: 'Away message',
  unclear: 'Unclear',
});

const INTENT_TONE = Object.freeze({
  interested: 'rp-warm',
  wants_info: 'rp-warm',
  wants_call: 'rp-warm',
  asks_rate: 'rp-warm',
  sign_up_elsewhere: 'rp-cold',
  not_interested: 'rp-cold',
});

export const ASK_LABEL = Object.freeze({
  answer_question: 'Answer a question',
  send_portfolio: 'Send your portfolio',
  send_rate: 'Send your rate',
  sign_up: 'Sign up somewhere',
  book_call: 'Book a call',
  provide_details: 'Provide details',
  follow_up_later: 'Follow up later',
});

function errorText(error) {
  return error instanceof ApiError ? error.message : 'something went wrong';
}

export function intentPill(intent) {
  return el('span', `rp-pill ${INTENT_TONE[intent] || 'rp-flat'}`, INTENT_LABEL[intent] || intent);
}

/** The asks, as a list. A URL is a link the owner may click — nothing else opens it. */
export function asksList(asks = []) {
  if (!asks.length) return null;
  const list = el('ul', 'rp-asks');
  for (const ask of asks) {
    const item = el('li');
    item.appendChild(document.createTextNode(`${ASK_LABEL[ask.kind] || ask.kind}: ${ask.detail || ''}`));
    if (ask.due_hint) item.appendChild(document.createTextNode(` (${ask.due_hint})`));
    if (ask.url) {
      item.appendChild(document.createTextNode(' — '));
      const link = el('a', null, ask.url);
      link.href = ask.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      item.appendChild(link);
    }
    list.appendChild(item);
  }
  return list;
}

/** What they actually wrote, folded away. Their words, quoted, never obeyed. */
export function excerptBlock(review) {
  if (!review.body_excerpt) return null;
  const details = el('details', 'rp-excerpt');
  details.appendChild(el('summary', null, 'What they wrote'));
  details.appendChild(el('p', null, review.body_excerpt));
  return details;
}

export const reviewWho = (review) => review.lead_name || review.from_email || 'Someone';

/**
 * One review: who, what it was read as, what they asked, the original, and
 * each proposal with Accept / Decline. `onChange` re-reads the server.
 */
export function reviewCard(review, onChange, { showHead = true } = {}) {
  ensureRepliesCss();
  const card = el('article', 'rp-review');

  if (showHead) {
    const head = el('div', 'rp-head');
    head.appendChild(el('span', 'rp-who', reviewWho(review)));
    head.appendChild(intentPill(review.intent));
    head.appendChild(el('span', 'rp-when', (review.received_at || '').slice(0, 10)));
    card.appendChild(head);
  } else {
    const head = el('div', 'rp-head');
    head.appendChild(intentPill(review.intent));
    card.appendChild(head);
  }

  if (review.summary) card.appendChild(el('p', 'rp-summary', review.summary));
  const asks = asksList(review.asks);
  if (asks) card.appendChild(asks);
  const excerpt = excerptBlock(review);
  if (excerpt) card.appendChild(excerpt);

  const note = el('p', 'rp-note');
  note.hidden = true;

  const proposals = review.proposals ?? [];
  if (!proposals.length) {
    card.appendChild(el('p', 'rp-note', 'Nothing proposed from this one.'));
  }

  for (const proposal of proposals) {
    const row = el('div', 'rp-proposal');
    const title = el('div', 'rp-title');
    title.appendChild(document.createTextNode(proposal.title));
    if (proposal.detail) title.appendChild(el('small', null, proposal.detail));
    row.appendChild(title);

    const acts = el('div', 'rp-acts');
    const accept = el('button', 'btn primary small', 'Accept');
    accept.type = 'button';
    const decline = el('button', 'btn quiet small', 'Decline');
    decline.type = 'button';

    const run = async (fn) => {
      accept.disabled = true;
      decline.disabled = true;
      note.hidden = true;
      try {
        await fn();
        await onChange();
      } catch (error) {
        accept.disabled = false;
        decline.disabled = false;
        note.className = 'rp-note rp-err';
        note.textContent = errorText(error);
        note.hidden = false;
      }
    };

    // Accepting is the missions API and nothing else: a proposal becomes a
    // pending mission, which is the only move its validator allows.
    accept.addEventListener('click', () => run(() => apiFetch(`/api/missions/${proposal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    })));
    decline.addEventListener('click', () => run(() => apiFetch(`/api/missions/${proposal.id}`, { method: 'DELETE' })));

    acts.appendChild(accept);
    acts.appendChild(decline);
    row.appendChild(acts);
    card.appendChild(row);
  }

  const dismiss = el('button', 'btn quiet small', 'Dismiss this reply');
  dismiss.type = 'button';
  dismiss.addEventListener('click', async () => {
    dismiss.disabled = true;
    note.hidden = true;
    try {
      await apiFetch(`/api/replies/${review.id}/dismiss`, { method: 'POST' });
      await onChange();
    } catch (error) {
      dismiss.disabled = false;
      note.className = 'rp-note rp-err';
      note.textContent = errorText(error);
      note.hidden = false;
    }
  });
  card.appendChild(dismiss);
  card.appendChild(note);

  return card;
}

/** GET /api/replies, never a throw: no funnel is a quiet state, not an error. */
export async function fetchReviews(status = 'open') {
  try {
    const body = await apiFetch(`/api/replies?status=${encodeURIComponent(status)}`);
    return {
      reviews: body?.reviews ?? [],
      canRead: Boolean(body?.canRead),
      // Why not, in the screen's own words. The Worker knows whether the Mac
      // can do the reading, so the buttons never say "needs an API key" when
      // an API key is not what is missing.
      readNote: typeof body?.readNote === 'string' && body.readNote ? body.readNote : 'needs an API key',
      error: null,
    };
  } catch (error) {
    return { reviews: [], canRead: false, readNote: 'needs an API key', error: errorText(error) };
  }
}

/**
 * POST /api/replies/scan. Returns a line for the screen to show — the two
 * "not here" states read as states, not as failures.
 */
export async function scanReplies() {
  try {
    const body = await apiFetch('/api/replies/scan', { method: 'POST' });
    const parts = [`${body.read} read`];
    if (body.known) parts.push(`${body.known} already read`);
    if (body.proposed) parts.push(`${body.proposed} proposed`);
    if (body.failed?.length) parts.push(`${body.failed.length} could not be read`);
    return { ok: true, note: parts.join(' · ') };
  } catch (error) {
    return { ok: false, note: errorText(error) };
  }
}
