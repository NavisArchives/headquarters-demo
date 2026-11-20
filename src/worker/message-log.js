import { hqToday, nowIso, ValidationError } from './db.js';

function ownerConflict() {
  const error = new ValidationError('Message belongs to another lead', 'message_key');
  error.status = 422;
  return error;
}

// One database transaction owns the message, state and cadence. No claim can
// suppress recovery after a stopped Worker; the unique message key is authoritative.
export async function logMessage(db, uid, input) {
  const before = await db.prepare(`
    SELECT l.uid, COALESCE(s.stage, 'new') AS stage, s.follow_up, s.last_sent_at
    FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid WHERE l.uid = ?
  `).bind(uid).first();
  if (!before) throw new ValidationError('no lead with that uid', 'lead_uid');

  const known = await db.prepare('SELECT id, uid FROM lead_events WHERE message_key = ?')
    .bind(input.key).first();
  if (known) {
    if (known.uid !== uid) throw ownerConflict();
    return { id: known.id, duplicate: true, before };
  }

  const at = input.at || nowIso();
  if (!Number.isFinite(Date.parse(at))) throw new ValidationError('Invalid send time', 'sent_at');
  const key = input.key;
  if (!key || key.length > 700) throw new ValidationError('A stable message identity is required', 'message_key');
  const sentDay = hqToday(new Date(at));
  const now = nowIso();
  const note = `closed after 3rd email, removed from prospect list, ${at.slice(0, 10)}`;

  // The identity must be owned by this exact logging operation before any
  // cadence or closer statement can touch state. A stale preflight is not proof.
  const ownership = `EXISTS (
    SELECT 1 FROM lead_events
    WHERE message_key = ? AND uid = ? AND at = ? AND COALESCE(template, '') = ?
  )`;
  const ownerArgs = [key, uid, at, input.template || ''];
  const result = await db.batch([
    db.prepare(`
      INSERT INTO lead_events
        (uid, kind, detail, at, batch, template, sent_to, message_key, sender, subject, body, thread_id, provenance)
      VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_key) WHERE message_key IS NOT NULL DO NOTHING RETURNING id
    `).bind(uid, input.detail || '', at, input.batch || null, input.template || null,
      input.to || null, key, input.sender || null, input.subject ?? null,
      input.body ?? null, input.thread_id || null, input.provenance || 'reported'),
    db.prepare(`
      INSERT INTO lead_state (uid, stage, sent_at, updated_at)
      SELECT ?, 'sent', ?, ? WHERE ${ownership}
      ON CONFLICT(uid) DO UPDATE SET
        stage = CASE WHEN lead_state.stage IN ('new', 'looked', 'shortlist') THEN 'sent' ELSE lead_state.stage END,
        sent_at = COALESCE(lead_state.sent_at, excluded.sent_at), updated_at = excluded.updated_at
    `).bind(uid, at, now, ...ownerArgs),
    db.prepare(`
      UPDATE lead_state SET
        last_sent_at = CASE WHEN last_sent_at IS NULL OR last_sent_at < ? THEN ? ELSE last_sent_at END,
        follow_up = CASE
          WHEN (last_sent_at IS NULL OR last_sent_at < ?)
            AND (last_reply_at IS NULL OR last_reply_at < ?) AND stage NOT IN ('passed', 'won') THEN
            CASE (
              SELECT COUNT(*) FROM lead_events e WHERE e.uid = lead_state.uid AND e.kind = 'sent'
                AND (lead_state.last_reply_at IS NULL OR e.at > lead_state.last_reply_at)
            )
              WHEN 1 THEN date(?, '+7 days') WHEN 2 THEN date(?, '+14 days') ELSE NULL
            END
          ELSE follow_up
        END,
        updated_at = ?
      WHERE uid = ? AND ${ownership}
    `).bind(at, at, at, at, sentDay, sentDay, now, uid, ...ownerArgs),
    db.prepare(`
      INSERT INTO lead_events (uid, kind, detail, at)
      SELECT uid, 'stage', 'passed', ? FROM lead_state
      WHERE uid = ? AND stage NOT IN ('passed', 'won', 'replied', 'talks') AND ? = 'closer-3rd' AND ${ownership}
    `).bind(at, uid, input.template || '', ...ownerArgs),
    db.prepare(`
      UPDATE lead_state SET stage = 'passed', passed_at = COALESCE(passed_at, ?), follow_up = NULL, updated_at = ?,
        notes = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || CHAR(10) || ? END
      WHERE uid = ? AND stage NOT IN ('passed', 'won', 'replied', 'talks') AND ? = 'closer-3rd' AND ${ownership}
    `).bind(at, now, note, note, uid, input.template || '', ...ownerArgs),
  ]);
  const eventId = result[0].results?.[0]?.id;
  const event = eventId ? { id: eventId, uid }
    : await db.prepare('SELECT id, uid FROM lead_events WHERE message_key = ?').bind(key).first();
  if (event?.uid !== uid) throw ownerConflict();
  return { id: event.id, duplicate: !eventId, before };
}
