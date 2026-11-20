// The one read model for « whose turn is it » (src/shared/turn.js), used by
// Home (/api/outreach/replies) and Outreach (the cockpit queue) alike, so the
// two never describe the same conversation differently. Read-only; no table.
import { hqToday } from './db.js';
import { whoseTurn, TURN_LABELS } from '../shared/turn.js';

// An automatic reply recorded by the mailbox sync (lead_state.last_reply_at)
// carries no intent. When its time matches an auto_reply review within this
// window, and no real message is as new, it is not counted as their answer.
const AUTO_MATCH_MS = 120_000;
const UNLINKED_LIMIT = 50;
const LEAD_LIMIT = 300;

// The newer of two times; an unreadable one wins, so the turn says « incomplete » instead of guessing.
const later = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  const x = Date.parse(a); const y = Date.parse(b);
  if (!Number.isFinite(x)) return a;
  if (!Number.isFinite(y)) return b;
  return x >= y ? a : b;
};

/**
 * Every lead in a conversation (replied/talks, or anyone who ever wrote back),
 * plus open warm replies no lead is linked to. Bounded: the pool comes from
 * lead_state_by_stage and reply_reviews_by_lead, never a scan of all leads.
 */
export async function conversationTurns(db, now = new Date()) {
  const today = hqToday(now);
  const [leads, unlinked] = await Promise.all([
    db.prepare(`
      WITH pool AS (
        SELECT uid FROM lead_state WHERE stage IN ('replied', 'talks')
        UNION
        SELECT uid FROM reply_reviews WHERE uid IS NOT NULL
      )
      SELECT l.uid, l.name, COALESCE(s.stage, 'new') AS stage, s.follow_up,
        COALESCE(s.last_sent_at, s.sent_at) AS last_out,
        COALESCE(s.last_reply_at, s.replied_at) AS state_in,
        (SELECT MAX(COALESCE(a.received_at, a.reviewed_at)) FROM reply_reviews a
          WHERE a.uid = l.uid AND a.intent = 'auto_reply') AS auto_in,
        r.id AS review_id, r.intent, r.status AS review_status, r.summary, r.thread_id,
        COALESCE(r.received_at, r.reviewed_at) AS review_in
      FROM pool JOIN leads l ON l.uid = pool.uid
      LEFT JOIN lead_state s ON s.uid = l.uid
      LEFT JOIN reply_reviews r ON r.id = (
        SELECT latest.id FROM reply_reviews latest
        WHERE latest.uid = l.uid AND latest.intent <> 'auto_reply'
        ORDER BY COALESCE(latest.received_at, latest.reviewed_at) DESC, latest.id DESC LIMIT 1
      )
      WHERE COALESCE(s.stage, 'new') NOT IN ('passed', 'won')
      LIMIT ${LEAD_LIMIT}
    `).all(),
    db.prepare(`
      SELECT id, from_email, summary, intent, thread_id, COALESCE(received_at, reviewed_at) AS review_in
      FROM reply_reviews
      WHERE status = 'open' AND uid IS NULL AND intent IN ('interested', 'wants_info', 'wants_call', 'asks_rate')
      ORDER BY review_in DESC LIMIT ${UNLINKED_LIMIT}
    `).all(),
  ]);

  const rows = (leads.results || []).map((row) => {
    let stateIn = row.state_in;
    // The sync's newest incoming time is the autoresponder's, and nothing real is as new.
    if (stateIn && row.auto_in && Math.abs(Date.parse(stateIn) - Date.parse(row.auto_in)) <= AUTO_MATCH_MS
      && !(row.review_in && Date.parse(row.review_in) >= Date.parse(stateIn) - AUTO_MATCH_MS)) stateIn = null;
    const lastIn = later(stateIn, row.review_in);
    const { turn, reason } = whoseTurn({
      stage: row.stage, last_out: row.last_out, last_in: lastIn, follow_up: row.follow_up, today,
      latest_intent: row.intent, latest_status: row.review_status, latest_review_at: row.review_in,
    });
    return {
      uid: row.uid, name: row.name, stage: row.stage, turn, reason, label: TURN_LABELS[turn],
      last_out: row.last_out || null, last_in: lastIn || null, follow_up: row.follow_up || null,
      review_id: row.review_id ?? null, intent: row.intent ?? null, summary: row.summary || '',
      thread_id: row.thread_id || null,
    };
  });
  for (const r of unlinked.results || []) {
    const { turn, reason } = whoseTurn({ linked: false });
    rows.push({ uid: null, name: r.from_email, stage: null, turn, reason, label: TURN_LABELS[turn],
      last_out: null, last_in: r.review_in || null, follow_up: null, review_id: r.id, intent: r.intent,
      summary: r.summary || '', thread_id: r.thread_id || null });
  }
  // Oldest unanswered first: whoever has waited longest for Andy comes first.
  rows.sort((a, b) => String(a.last_in || '').localeCompare(String(b.last_in || '')) || String(a.uid).localeCompare(String(b.uid)));
  return { today, rows, truncated: (leads.results || []).length >= LEAD_LIMIT };
}
