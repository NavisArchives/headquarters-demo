/* Whose turn is it with a lead? One answer, derived from message facts only,
   used by Home and Outreach alike so they never disagree (Codex handover 003,
   NIRMATA 20 Nov). Stage stays what it is; the turn is a separate fact.

     yours           they wrote after Andy's last email: he owes an answer
     theirs          Andy wrote last: waiting for them
     follow_up_due   Andy wrote last and the follow-up date has come
     handled         their last message was marked handled or dismissed, nothing newer
     closed          passed, won, or they said no
     incomplete      the facts are missing or conflict: shown, never guessed

   An automatic reply is never a reply: it does not make it Andy's turn. */

export const TURNS = Object.freeze(['yours', 'theirs', 'follow_up_due', 'handled', 'closed', 'incomplete']);
export const WARM_INTENTS = Object.freeze(['interested', 'wants_info', 'wants_call', 'asks_rate']);

export const TURN_LABELS = Object.freeze({
  yours: 'Your turn to answer',
  theirs: 'Waiting for their answer',
  follow_up_due: 'Follow-up due',
  handled: 'Handled, nothing due',
  closed: 'Closed',
  incomplete: 'Check this conversation',
});

const time = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
};

/**
 * @param {object} f
 * @param {string} f.stage            lead_state.stage ('new' when there is none)
 * @param {string|null} f.last_out   Andy's newest email to them
 * @param {string|null} f.last_in    their newest real (non-automatic) message
 * @param {string|null} f.latest_intent   intent of their newest reviewed reply
 * @param {string|null} f.latest_status   status of that review (open/handled/dismissed)
 * @param {string|null} f.latest_review_at  when that review's message arrived
 * @param {string|null} f.follow_up  lead_state.follow_up (YYYY-MM-DD)
 * @param {boolean} [f.linked=true]  false for a reply no lead is linked to
 * @param {string} f.today           YYYY-MM-DD in HQ's zone
 * @returns {{turn: string, reason: string}}
 */
export function whoseTurn(f) {
  const stage = f.stage || 'new';
  if (f.linked === false) return { turn: 'incomplete', reason: 'reply_not_linked' };
  if (stage === 'passed' || stage === 'won') return { turn: 'closed', reason: stage };
  const out = time(f.last_out);
  const inn = time(f.last_in);
  if (Number.isNaN(out) || Number.isNaN(inn)) return { turn: 'incomplete', reason: 'unreadable_time' };
  if (f.latest_intent === 'not_interested' && (out === null || inn === null || inn >= out)) {
    return { turn: 'closed', reason: 'said_no' };
  }
  // Old records keep only a date. A date-only time on the same day as the other
  // cannot say who wrote last (the 20 Sep import has both on one day).
  const dateOnly = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
  if (inn !== null && out !== null && (dateOnly(f.last_in) || dateOnly(f.last_out))
    && String(f.last_in).slice(0, 10) === String(f.last_out).slice(0, 10)) {
    return { turn: 'incomplete', reason: 'same_day_order_unknown' };
  }
  if (inn !== null && out !== null && inn === out) return { turn: 'incomplete', reason: 'same_time_both_ways' };
  if (inn !== null && (out === null || inn > out)) {
    // Andy marked their newest message as dealt with and nothing came after it.
    const reviewed = time(f.latest_review_at);
    if ((f.latest_status === 'handled' || f.latest_status === 'dismissed') && reviewed !== null && !Number.isNaN(reviewed) && reviewed >= inn) {
      return { turn: 'handled', reason: f.latest_status };
    }
    return { turn: 'yours', reason: 'they_wrote_last' };
  }
  // The stage says they answered, yet no answer is on record: say so, do not guess.
  if (inn === null && (stage === 'replied' || stage === 'talks')) {
    return { turn: 'incomplete', reason: out === null ? 'no_mail_times' : 'no_reply_time' };
  }
  if (out !== null) {
    if (f.follow_up && f.today && f.follow_up <= f.today) return { turn: 'follow_up_due', reason: 'follow_up_date' };
    return { turn: 'theirs', reason: 'you_wrote_last' };
  }
  return { turn: 'theirs', reason: 'no_conversation' };
}

/** Andy needs to act: an answer, or a conversation he must look at. */
export const needsAndy = (turn) => turn === 'yours' || turn === 'incomplete';
