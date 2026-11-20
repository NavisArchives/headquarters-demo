import { hqToday, ValidationError } from './db.js';
import { draftHash, readDraft } from './outreach-drafts.js';
import { fileVerifiedOutreachBatch, LIMITS } from './intake.js';

const accepted = new Set([200, 201, 202]);
const aliases = {
  delivered: 'delivered', softbounce: 'soft_bounce', soft_bounce: 'soft_bounce',
  hardbounce: 'hard_bounce', hard_bounce: 'hard_bounce', spam: 'spam',
  complaint: 'spam', spam_complaint: 'spam', blocked: 'blocked',
};

function csvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(value); value = '';
      if (char !== ',') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
      }
    } else value += char;
  }
  if (quoted) throw new ValidationError('CSV has an unclosed quote', 'events');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function parseDeliveryEvents(input) {
  let rows = input;
  if (typeof input === 'string') {
    if (input.trim().startsWith('[')) {
      try { rows = JSON.parse(input); } catch { throw new ValidationError('Events JSON is invalid', 'events'); }
    } else {
      const [header, ...values] = csvRows(input.replace(/^\uFEFF/, ''));
      const keys = (header || []).map((value) => value.trim().toLowerCase().replace(/[-_\s]/g, ''));
      if (!['messageid', 'event', 'date'].every((key) => keys.includes(key))) throw new ValidationError('Events CSV needs messageId, event and date headers', 'events');
      rows = values.map((row) => ({ messageId: row[keys.indexOf('messageid')], event: row[keys.indexOf('event')], date: row[keys.indexOf('date')] }));
    }
  }
  if (!Array.isArray(rows) || rows.length > 10000) throw new ValidationError('Provide at most 10,000 event rows', 'events');
  return rows.map((row) => {
    if (!row || typeof row.messageId !== 'string' || !row.messageId.trim() || typeof row.event !== 'string') throw new ValidationError('Each event needs a messageId and event', 'events');
    if (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) throw new ValidationError('Each event needs a valid date', 'events');
    return { messageId: row.messageId.trim(), event: aliases[row.event.trim().toLowerCase().replace(/[\s-]/g, '_')] || 'other', date: new Date(row.date).toISOString() };
  });
}

export function summarizeDelivery(batch, sendLog, events, spamSubjects = []) {
  if (!Array.isArray(sendLog) || sendLog.length > 280) throw new ValidationError('Provide the send log JSON array (at most 280 rows)', 'send_log');
  if (!Array.isArray(spamSubjects) || spamSubjects.some((value) => typeof value !== 'string') || spamSubjects.length > 280) throw new ValidationError('Spam-tagged subjects must be a list', 'spam_subjects');
  const subjects = spamSubjects.map((value) => value.trim()).filter(Boolean);
  const known = new Set(batch.items.map((item) => item.uid));
  const seen = new Set();
  const messages = new Map();
  let apiFailed = 0;
  for (const entry of sendLog) {
    if (!entry || !Array.isArray(entry.uids) || entry.uids.length !== 1 || !known.has(entry.uids[0])) throw new ValidationError('Every send log row must identify exactly one lead in this batch', 'send_log');
    const uid = entry.uids[0];
    if (seen.has(uid)) throw new ValidationError('Conflicting send identity for the same lead', 'send_log');
    seen.add(uid);
    if (!accepted.has(entry.status)) { apiFailed += 1; continue; }
    if (typeof entry.messageId !== 'string' || !entry.messageId.trim()) throw new ValidationError('A successful send needs its real provider messageId', 'send_log');
    const id = entry.messageId.trim();
    if (messages.has(id)) throw new ValidationError('Conflicting message identity for different leads', 'send_log');
    messages.set(id, { uid, events: new Map() });
  }
  let unmatched = 0;
  let ignored = 0;
  for (const event of parseDeliveryEvents(events)) {
    const message = messages.get(event.messageId);
    if (!message) { unmatched += 1; continue; }
    if (event.event === 'other') { ignored += 1; continue; }
    if (batch.day && hqToday(new Date(event.date)) < batch.day) { ignored += 1; continue; }
    const previous = message.events.get(event.event);
    if (!previous || previous > event.date) message.events.set(event.event, event.date);
  }
  const counts = { delivered: 0, soft_bounce: 0, hard_bounce: 0, spam: 0, blocked: 0 };
  const delivered = [];
  // Addresses that must never be written to again: a hard bounce, a complaint, a block.
  // A soft bounce is temporary and only counts toward the 3 % rule.
  const stops = [];
  let pending = 0;
  for (const [messageId, message] of messages) {
    const kinds = message.events;
    if (kinds.has('hard_bounce')) counts.hard_bounce += 1;
    else if (kinds.has('soft_bounce')) counts.soft_bounce += 1;
    if (kinds.has('spam')) counts.spam += 1;
    if (kinds.has('blocked')) counts.blocked += 1;
    const stopKind = ['hard_bounce', 'spam', 'blocked'].find((kind) => kinds.has(kind));
    if (stopKind) stops.push({ uid: message.uid, kind: stopKind });
    if (kinds.has('delivered') && !['hard_bounce', 'soft_bounce', 'spam', 'blocked'].some((kind) => kinds.has(kind))) {
      counts.delivered += 1;
      delivered.push({ uid: message.uid, messageId, at: kinds.get('delivered') });
    } else if (!kinds.size) pending += 1;
  }
  const total = messages.size;
  const bounceRate = total ? (counts.hard_bounce + counts.soft_bounce) / total : 0;
  const reasons = [];
  if (bounceRate > 0.03) reasons.push('bounces_above_3_percent');
  if (counts.spam) reasons.push('spam_complaint');
  if (counts.blocked) reasons.push('blocked');
  if (subjects.length >= 2) reasons.push('two_spam_tagged_subjects');
  return { counts, total, bounce_rate: bounceRate, failed: Boolean(reasons.length), reasons,
    pending, api_failed: apiFailed, not_in_log: known.size - seen.size,
    unmatched_events: unmatched, ignored_events: ignored, spam_subjects: subjects.length, delivered, stops };
}

async function approvedBatch(db, id) {
  const batch = await readDraft(db, id);
  if (!batch || batch.status !== 'approved') throw new ValidationError('After-sending checks require an approved batch', 'status');
  if (await draftHash(batch.items, batch.day) !== batch.content_hash) throw new ValidationError('Approved text changed; reload', 'content_hash');
  return batch;
}

export async function saveVerification(db, id, input, now = new Date()) {
  const batch = await approvedBatch(db, id);
  if (input.content_hash !== batch.content_hash) throw new ValidationError('Batch changed; reload', 'content_hash');
  // Later partial exports must not erase a previously confirmed complaint or
  // bounce, or replace one accepted provider identity with a different send.
  const previous = JSON.parse(batch.verification_json || '{}');
  summarizeDelivery(batch, input.send_log, input.events, input.spam_subjects || []);
  const byUid = new Map((previous.send_log || []).map((entry) => [entry.uids[0], entry]));
  for (const entry of input.send_log) {
    const old = byUid.get(entry.uids[0]);
    if (old && accepted.has(old.status) && accepted.has(entry.status) && old.messageId.trim() !== entry.messageId.trim()) {
      throw new ValidationError('An accepted provider message identity changed; check the batch log', 'send_log');
    }
    if (!old || !accepted.has(old.status) || accepted.has(entry.status)) byUid.set(entry.uids[0], entry);
  }
  const sendLog = [...byUid.values()];
  const uniqueEvents = new Map([...parseDeliveryEvents(previous.events || []), ...parseDeliveryEvents(input.events)]
    .map((event) => [JSON.stringify([event.messageId, event.event, event.date]), event]));
  const events = [...uniqueEvents.values()];
  const summary = summarizeDelivery(batch, sendLog, events, input.spam_subjects || []);
  const verification = { verification_id: crypto.randomUUID(), content_hash: batch.content_hash, send_log: sendLog, events,
    spam_subjects: input.spam_subjects || [], verified_at: now.toISOString(), summary };
  const result = await db.prepare(`
    UPDATE outreach_batches SET verification_json = ?
    WHERE id = ? AND status = 'approved' AND content_hash = ? AND verification_json = ?
  `).bind(JSON.stringify(verification), id, batch.content_hash, batch.verification_json).run();
  if (!result.meta.changes) throw new ValidationError('Batch changed; reload', 'content_hash');
  await applyStops(db, batch, summary, now);
  return verification;
}

const STOP_REASON = { hard_bounce: 'hard bounce', spam: 'spam complaint', blocked: 'blocked by the provider' };
export const STOP_HOLD_PREFIX = 'Stop rule failed';

/**
 * What a verification decides, enforced in HQ (the external Brevo runner has no
 * guard of its own; HQ's export is the gate). Both writes only ever add:
 *   - every hard-bounced, complained or blocked address is suppressed for good;
 *   - a failed stop rule pauses the sender until Andy resumes it with a review note.
 * A later partial upload re-derives the summary from all evidence kept so far, so
 * it can add a stop but never lift one; a repeated click changes nothing.
 */
export async function applyStops(db, batch, summary, now = new Date()) {
  const at = now.toISOString();
  const recipients = new Map(batch.items.map((item) => [item.uid, item.recipient]));
  const writes = summary.stops.filter((stop) => recipients.get(stop.uid)).map((stop) => db.prepare(
    'INSERT OR IGNORE INTO email_suppression (email, reason, source, at) VALUES (?, ?, ?, ?)',
  ).bind(String(recipients.get(stop.uid)).trim().toLowerCase(), STOP_REASON[stop.kind], `verification:${batch.id}`, at));
  if (summary.failed) {
    const note = `${STOP_HOLD_PREFIX} on batch ${batch.id} (${summary.reasons.join(', ')}). Review delivery before resuming.`;
    writes.push(db.prepare(`UPDATE outreach_senders SET paused = 1, updated_at = ?,
        reason = CASE WHEN instr(reason, ?) > 0 THEN reason ELSE substr(? || CASE WHEN paused = 1 AND reason <> '' THEN ' · ' || reason ELSE '' END, 1, 300) END
      WHERE email = ?`).bind(at, `batch ${batch.id} `, note, batch.sender));
  }
  if (writes.length) await db.batch(writes);
  return { suppressed: summary.stops.length, paused: summary.failed };
}

export async function logVerifiedDelivered(db, id, hash, now = new Date(), offset = 0, verificationId = null) {
  const batch = await approvedBatch(db, id);
  const verification = JSON.parse(batch.verification_json || '{}');
  if (hash !== batch.content_hash || verification.content_hash !== hash) throw new ValidationError('Upload delivery verification for this exact approved batch first', 'verification');
  if (verificationId !== null && verificationId !== verification.verification_id) throw new ValidationError('Delivery evidence changed; reload before continuing', 'verification_id');
  const summary = summarizeDelivery(batch, verification.send_log, verification.events, verification.spam_subjects);
  if (!Number.isInteger(offset) || offset < 0 || offset > summary.delivered.length) throw new ValidationError('Invalid delivery cursor', 'offset');
  const selected = summary.delivered.slice(offset, offset + 20);
  const next = offset + selected.length;
  const result = { filed: 0, duplicates: 0, moved: 0, failed: [], stop_rule_failed: summary.failed,
    next_offset: next < summary.delivered.length ? next : null, total: summary.delivered.length };
  const eligible = [];
  for (const delivery of selected) {
    const prior = await db.prepare('SELECT uid, batch FROM lead_events WHERE message_key = ?')
      .bind(`gmail:${batch.sender}:${delivery.messageId}`).first();
    if (prior && (prior.uid !== delivery.uid || prior.batch !== id)) {
      result.failed.push({ lead_uid: delivery.uid, error: 'Message already belongs to another lead or batch' });
      continue;
    }
    if (prior) { result.duplicates += 1; continue; }
    const item = batch.items.find((row) => row.uid === delivery.uid);
    eligible.push({ lead_uid: item.uid, to: item.recipient, sent_at: delivery.at, message_id: delivery.messageId,
      sender: batch.sender, subject: item.subject, template: item.template,
      ...(item.body.length <= LIMITS.detail ? { body: item.body } : {}) });
  }
  if (eligible.length) {
    const filed = await fileVerifiedOutreachBatch(db, { batch: id, sent: eligible }, now);
    for (const key of ['filed', 'duplicates', 'moved']) result[key] += filed.body[key];
    result.failed.push(...filed.body.failed);
  }
  // Confirmed records no longer reserve an additional unsent slot. The sent
  // events themselves now count toward capacity; failed/unverified rows stay reserved.
  await db.prepare(`
    DELETE FROM outreach_reservations WHERE batch_id = ?
      AND EXISTS (SELECT 1 FROM lead_events e WHERE e.uid IN (
        SELECT i.uid FROM outreach_batch_items i
        WHERE i.batch_id = outreach_reservations.batch_id AND i.recipient = outreach_reservations.recipient
      ) AND e.kind = 'sent' AND e.batch = outreach_reservations.batch_id)
  `).bind(id).run();
  return result;
}
