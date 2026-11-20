// An email Andy sent himself from the lead pop-up (audit A4, A5; 13 Nov).
//
// The pop-up used to mark a lead « sent » the moment Gmail opened: before he
// had sent anything, backwards from « in talks » or « won », and with its own
// +4-day follow-up instead of the 7/14 rhythm. A follow-up never cleared
// « Follow-up due » and left no trace in the timeline.
//
// Now the screen asks once he has sent it, and this records it the way the
// send log does (intake outreach_sent): the stage only ever moves forward, a
// « sent » event names what went out, and recordMailTimes sets the next date
// on the cadence, or ends it after the third email. It can be undone.
import { getLead, getLeadStage, recordMailTimes, nowIso, ValidationError, STATE_STAGES } from './db.js';
import { logMessage } from './message-log.js';
import { movesForward } from './api/gmail.js';

const KINDS = Object.freeze({ email: 'first email', followup: 'follow-up' });

/** Records one email Andy sent. Returns the lead after it, and what undoes it. */
export async function recordOwnSend(db, uid, { mode = 'email', at = nowIso(), request_id = crypto.randomUUID(), subject = null, body = null, sender = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(KINDS, mode)) throw new ValidationError('mode must be email or followup', 'mode');
  const row=await db.prepare('SELECT email FROM leads WHERE uid=?').bind(uid).first();
  if (!row) return null;
  const saved=await logMessage(db,uid,{ key:`popup:${uid}:${request_id}`,at,detail:`${KINDS[mode]} · sent by Andy from HQ`,batch:'hq-popup',template:mode==='followup'?'followup':'first-email',to:row.email?.trim().toLowerCase() || null,subject,body,sender,provenance:'self_reported' });
  return {lead:await getLead(db,uid),duplicate:saved.duplicate,undo:saved.duplicate?null:{event_id:saved.id,stage:saved.before.stage,follow_up:saved.before.follow_up ?? null,last_sent_at:saved.before.last_sent_at ?? null}};
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Puts a lead back as it was before one recordOwnSend, if that send is still
 *  its newest « sent » event. Anything else happened since: refused. */
export async function undoOwnSend(db, uid, undo = {}) {
  const eventId = Number(undo.event_id);
  if (!Number.isInteger(eventId) || eventId < 1) throw new ValidationError('event_id is required', 'event_id');
  if (!STATE_STAGES.includes(undo.stage)) throw new ValidationError('stage is not a stage', 'stage');
  if (undo.follow_up !== null && !(typeof undo.follow_up === 'string' && DAY.test(undo.follow_up))) {
    throw new ValidationError('follow_up must be a date or null', 'follow_up');
  }
  if (undo.last_sent_at !== null && !(typeof undo.last_sent_at === 'string' && ISO.test(undo.last_sent_at))) {
    throw new ValidationError('last_sent_at must be a time or null', 'last_sent_at');
  }
  const newest = await db.prepare(
    "SELECT id, at FROM lead_events WHERE uid = ? AND kind = 'sent' ORDER BY at DESC, id DESC LIMIT 1",
  ).bind(uid).first();
  if (!newest || newest.id !== eventId) {
    throw new ValidationError('another email was recorded since: nothing was undone', 'event_id');
  }
  const current = await getLeadStage(db, uid);
  const at = nowIso();
  const statements = [
    db.prepare('DELETE FROM lead_events WHERE id = ? AND uid = ?').bind(eventId, uid),
    db.prepare('UPDATE lead_state SET follow_up = ?, last_sent_at = ?, updated_at = ? WHERE uid = ?')
      .bind(undo.follow_up, undo.last_sent_at, at, uid),
  ];
  // Only the stage this send set is taken back; a stage Andy changed since stays.
  if (current === 'sent' && undo.stage !== 'sent') {
    statements.push(db.prepare("UPDATE lead_state SET stage = ?, sent_at = CASE WHEN ? = 'sent' THEN sent_at ELSE NULL END WHERE uid = ?")
      .bind(undo.stage, undo.stage, uid));
    statements.push(db.prepare('INSERT INTO lead_events (uid, kind, detail, at) VALUES (?, ?, ?, ?)').bind(uid, 'stage', undo.stage, at));
  }
  await db.batch(statements);
  return getLead(db, uid);
}

/* « LinkedIn sent » (NIRMATA, 14 Nov). Andy sends LinkedIn messages himself, in his name;
   HQ only records that he did. A separate channel: no stage, no follow-up date, no email count. */

/** Records one LinkedIn message Andy sent. Returns the lead after it, and what undoes it. */
export async function recordLinkedIn(db, uid, { at = nowIso() } = {}) {
  const exists = await db.prepare('SELECT 1 FROM leads WHERE uid = ?').bind(uid).first();
  if (!exists) return null;
  const row = await db.prepare(
    "INSERT INTO lead_events (uid, kind, detail, at) VALUES (?, 'linkedin', 'LinkedIn message · sent by Andy', ?) RETURNING id",
  ).bind(uid, at).first();
  return { lead: await getLead(db, uid), undo: { event_id: row?.id ?? null } };
}

/** Takes back one recordLinkedIn, if it is still the lead's newest LinkedIn event. */
export async function undoLinkedIn(db, uid, undo = {}) {
  const eventId = Number(undo.event_id);
  if (!Number.isInteger(eventId) || eventId < 1) throw new ValidationError('event_id is required', 'event_id');
  const newest = await db.prepare(
    "SELECT id FROM lead_events WHERE uid = ? AND kind = 'linkedin' ORDER BY at DESC, id DESC LIMIT 1",
  ).bind(uid).first();
  if (!newest || newest.id !== eventId) {
    throw new ValidationError('another LinkedIn message was recorded since: nothing was undone', 'event_id');
  }
  await db.prepare("DELETE FROM lead_events WHERE id = ? AND uid = ? AND kind = 'linkedin'").bind(eventId, uid).run();
  return getLead(db, uid);
}
