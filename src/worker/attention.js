// Acting on « needs your attention » items by number or by name (Andy, 20 Nov:
// « 3, 7 and 9 are done », « BrightDesk: answered », « 4 is interested »).
// Plan first (what would change), then apply (with a snapshot to undo), then undo.
// Nothing here sends, deletes, pays, approves or schedules: those stay Andy's own.
import { ValidationError, hqToday, patchLeadState } from './db.js';
import { todayQueue } from './outreach.js';

export const ATTENTION_ACTIONS = Object.freeze(['handled', 'interested', 'snooze', 'note']);
const MAX_REFS = 20;
const LEAD_KINDS = new Set(['warm_reply', 'check_conversation', 'follow_up']);

const squash = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Each ref (« N-14 », « 14 », « BrightDesk ») to one queue item, or why not. */
export function resolveRefs(queue, refs) {
  if (!Array.isArray(refs) || !refs.length) throw new ValidationError('say which items: numbers or names', 'refs');
  if (refs.length > MAX_REFS) throw new ValidationError(`at most ${MAX_REFS} items at once`, 'refs');
  return refs.map((raw) => {
    const ref = String(raw ?? '').trim();
    const num = /^(?:n\s*-?\s*)?(\d{1,6})$/i.exec(ref);
    if (num) {
      const item = queue.find((i) => i.number === `N-${Number(num[1])}`);
      return item ? { ref, item } : { ref, error: `N-${Number(num[1])} is not on the list now` };
    }
    // Dictation writes « Bright desk » for BrightDesk and drops accents: compare letters and digits only.
    const needle = squash(ref);
    if (!needle) return { ref, error: 'empty' };
    const exact = queue.filter((i) => squash(i.title) === needle);
    const found = exact.length ? exact : queue.filter((i) => squash(i.title).includes(needle));
    if (found.length === 1) return { ref, item: found[0] };
    if (!found.length) return { ref, error: `nothing on the list is called « ${ref} »` };
    return { ref, candidates: found, error: `« ${ref} » matches ${found.length}: ${found.slice(0, 5).map((i) => `${i.number} ${i.title}`).join(', ')}` };
  });
}

function options(action, opts = {}) {
  if (!ATTENTION_ACTIONS.includes(action)) throw new ValidationError(`action must be one of ${ATTENTION_ACTIONS.join(', ')}`, 'action');
  const days = opts.days === undefined ? 7 : Number(opts.days);
  if (action === 'snooze' && !(Number.isInteger(days) && days >= 1 && days <= 30)) throw new ValidationError('snooze is 1 to 30 days', 'days');
  const note = String(opts.note ?? '').trim();
  if (action === 'note' && (!note || note.length > 500)) throw new ValidationError('a note is 1 to 500 characters', 'note');
  return { days, note };
}

/** A name that matches several items: if exactly one of them can take this action, it is the
 *  one Andy means (« Clinique Aurore is done » with a reply and a deal of that name). */
function narrow(resolved, action, o, today) {
  return resolved.map((r) => {
    if (!r.candidates) return r;
    const able = r.candidates.filter((i) => !describe(i, action, o, today).why);
    return able.length === 1 ? { ref: r.ref, item: able[0] } : r;
  });
}

/** What the action would do to this item, in words, or why it cannot. */
function describe(item, action, { days, note }, today) {
  const lead = LEAD_KINDS.has(item.kind) && item.uid;
  if (action === 'handled') {
    if (item.review_id) return { change: 'mark the reply handled' };
    if (item.kind === 'follow_up') return { change: 'clear the follow-up date' };
    return { why: 'open it to deal with it: HQ does not close this kind of item for you' };
  }
  if (action === 'interested') {
    if (!lead) return { why: 'only a reply or a lead can be marked interested' };
    if (item.review_id) return { change: 'mark the reply interested and handled; lead to « In talks »' };
    // No recorded reply to close: the lead moves, and the card stays while an answer is owed.
    return { change: item.kind === 'follow_up' ? 'lead to « In talks », follow-up cleared' : 'lead to « In talks » (it stays listed until you answer)' };
  }
  if (action === 'snooze') {
    if (item.kind === 'follow_up') return { change: `move the follow-up to ${addDays(today, days)}` };
    if (item.deal_id) return { change: `move the next step to ${addDays(today, days)}` };
    return { why: 'a reply waits for an answer: mark it handled once answered' };
  }
  if (action === 'note') {
    if (!lead) return { why: 'notes go on a lead' };
    return { change: `add the note « ${note.slice(0, 60)}${note.length > 60 ? '…' : ''} »` };
  }
  return { why: 'unknown action' };
}

/** The plan: one line per ref, nothing written. */
export async function planAttention(db, { refs, action, ...opts }, now = new Date()) {
  const o = options(action, opts);
  const today = hqToday(now);
  const queue = await todayQueue(db, undefined, now);
  return narrow(resolveRefs(queue, refs), action, o, today).map(({ ref, item, error }) => {
    if (error) return { ref, ok: false, why: error };
    const d = describe(item, action, o, today);
    return { ref, number: item.number, title: item.title, kind: item.kind, ok: !d.why, change: d.change ?? null, why: d.why ?? null };
  });
}

async function leadState(db, uid) {
  return db.prepare('SELECT stage, follow_up, notes FROM lead_state WHERE uid = ?').bind(uid).first();
}

/** Apply: the same plan, written, with a snapshot of everything it changed (for Undo). */
export async function applyAttention(db, { refs, action, ...opts }, now = new Date()) {
  const o = options(action, opts);
  const today = hqToday(now); const at = now.toISOString();
  const queue = await todayQueue(db, undefined, now);
  const done = []; const skipped = []; const undo = [];
  for (const { ref, item, error } of narrow(resolveRefs(queue, refs), action, o, today)) {
    if (error) { skipped.push({ ref, why: error }); continue; }
    const d = describe(item, action, o, today);
    if (d.why) { skipped.push({ ref, number: item.number, title: item.title, why: d.why }); continue; }
    if (item.review_id && (action === 'handled' || action === 'interested')) {
      const before = await db.prepare('SELECT intent, status FROM reply_reviews WHERE id = ?').bind(item.review_id).first();
      if (before) undo.push({ type: 'review', id: item.review_id, intent: before.intent, status: before.status });
      await db.prepare('UPDATE reply_reviews SET intent = ?, status = ? WHERE id = ?')
        .bind(action === 'interested' ? 'interested' : before?.intent ?? null, 'handled', item.review_id).run();
    }
    if (item.uid && (action === 'interested' || action === 'note' || item.kind === 'follow_up')) {
      const before = await leadState(db, item.uid);
      undo.push({ type: 'lead', uid: item.uid, stage: before?.stage ?? 'new', follow_up: before?.follow_up ?? null, notes: before?.notes ?? '' });
      const patch = {};
      if (action === 'interested') { patch.stage = 'talks'; patch.follow_up = null; }
      if (action === 'handled' && item.kind === 'follow_up') patch.follow_up = null;
      if (action === 'snooze' && item.kind === 'follow_up') patch.follow_up = addDays(today, o.days);
      if (action === 'note') patch.notes = [before?.notes, `${today}: ${o.note}`].filter(Boolean).join('\n');
      await patchLeadState(db, item.uid, patch, at);
    }
    if (item.deal_id && action === 'snooze') {
      const before = await db.prepare('SELECT next_at FROM prospects WHERE id = ?').bind(item.deal_id).first();
      undo.push({ type: 'deal', id: item.deal_id, next_at: before?.next_at ?? null });
      await db.prepare('UPDATE prospects SET next_at = ? WHERE id = ?').bind(addDays(today, o.days), item.deal_id).run();
    }
    done.push({ ref, number: item.number, title: item.title, change: d.change });
  }
  return { done, skipped, undo };
}

/** Undo: put back exactly what the snapshot says, through the same writers. */
export async function undoAttention(db, undo, now = new Date()) {
  if (!Array.isArray(undo) || !undo.length || undo.length > MAX_REFS * 2) throw new ValidationError('nothing to undo', 'undo');
  let restored = 0;
  for (const u of [...undo].reverse()) {
    if (u?.type === 'review' && Number.isInteger(u.id)) {
      await db.prepare('UPDATE reply_reviews SET intent = ?, status = ? WHERE id = ?').bind(u.intent ?? null, u.status ?? 'open', u.id).run();
      restored += 1;
    } else if (u?.type === 'lead' && typeof u.uid === 'string') {
      await patchLeadState(db, u.uid, { stage: u.stage || 'new', follow_up: u.follow_up ?? null, notes: typeof u.notes === 'string' ? u.notes : '' }, now.toISOString());
      restored += 1;
    } else if (u?.type === 'deal' && Number.isInteger(u.id)) {
      await db.prepare('UPDATE prospects SET next_at = ? WHERE id = ?').bind(u.next_at ?? null, u.id).run();
      restored += 1;
    } else throw new ValidationError('not an undo step', 'undo');
  }
  return { restored };
}
