import { ValidationError } from './db.js';
import { buildableDays, canonicalRows, draftHash, readDraft } from './outreach-drafts.js';
import { sha256Hex } from './lead-batches.js';
import { eligibility } from './outreach-policy.js';
import { messageIdFrom } from './send-list.js';

const emailOf = (value) => String(value || '').trim().toLowerCase();

async function factsFor(db, items) {
  const { results } = await db.prepare(`
    SELECT l.*, COALESCE(s.stage, 'new') AS stage, s.follow_up, s.last_sent_at, s.last_reply_at,
      (SELECT COUNT(*) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent') AS sends,
      EXISTS (SELECT 1 FROM email_suppression es WHERE es.email = lower(trim(l.email))) AS suppressed,
      (SELECT e.sent_to FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at, e.id LIMIT 1) AS first_sent_to,
      (SELECT json_object('sender', e.sender, 'subject', e.subject, 'detail', e.detail)
        FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at, e.id LIMIT 1) AS original_json,
      (SELECT other.uid FROM leads other WHERE other.uid <> l.uid
        AND lower(trim(other.email)) = lower(trim(l.email))
        AND EXISTS (SELECT 1 FROM lead_events e WHERE e.uid = other.uid AND e.kind = 'sent') LIMIT 1) AS inbox_written_via
    FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid
    WHERE l.uid IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(items.map((item) => item.uid))).all();
  return new Map((results || []).map((row) => [row.uid, row]));
}

export async function approveDailyDraft(db, id, hash, actor, now = new Date()) {
  const batch = await readDraft(db, id);
  if (!batch || batch.status !== 'draft' || batch.content_hash !== hash) throw new ValidationError('Batch changed or already reviewed; reload', 'content_hash');
  if (!buildableDays(now).includes(batch.day)) throw new ValidationError('This batch is stale; build today’s batch again', 'day');
  if (!batch.items.length || batch.items.length > 280) throw new ValidationError('Approve 1–280 emails', 'items');
  if (await draftHash(batch.items, batch.day) !== hash) throw new ValidationError('Batch text changed; reload', 'content_hash');
  const facts = await factsFor(db, batch.items);
  for (const item of batch.items) {
    const row = facts.get(item.uid);
    if (!row) throw new ValidationError('A lead is missing; rebuild the batch', 'items');
    const policy = eligibility({ ...row, subject: item.subject, hook: item.hook, today: batch.day,
      address_changed_since_send: Boolean(row.first_sent_to) && emailOf(row.first_sent_to) !== emailOf(row.email) }, now);
    if (!policy.eligible || policy.step !== item.step || policy.email !== item.recipient || policy.lang !== item.lang) {
      throw new ValidationError(`${row.name}: ${policy.reasons.join('; ') || 'lead facts changed'}`, 'items');
    }
  }
  const at = now.toISOString();
  const since = new Date(now.getTime() - 86400000).toISOString();
  let result;
  try {
    result = await db.batch([
      db.prepare(`
        UPDATE outreach_batches SET status = 'approved', approved_at = ?, approved_by = ?
        WHERE id = ? AND status = 'draft' AND content_hash = ?
          AND EXISTS (
            SELECT 1 FROM outreach_senders a WHERE a.email = outreach_batches.sender AND a.paused = 0
              AND a.daily_limit >= ?
                + (SELECT COUNT(*) FROM outreach_reservations r WHERE r.day = outreach_batches.day AND r.sender = a.email)
                + (SELECT COUNT(*) FROM lead_events e WHERE e.kind = 'sent' AND e.at >= ? AND (e.sender = a.email OR e.sender IS NULL))
          )
          AND ? + (SELECT COUNT(*) FROM outreach_reservations r WHERE r.day = outreach_batches.day)
            + (SELECT COUNT(*) FROM lead_events e WHERE e.kind = 'sent' AND e.at >= ?) <= 280
          AND NOT EXISTS (
            SELECT 1 FROM outreach_batch_items i JOIN leads l ON l.uid = i.uid
            LEFT JOIN lead_state s ON s.uid = i.uid
            WHERE i.batch_id = outreach_batches.id AND (
              lower(trim(l.email)) <> i.recipient OR s.last_reply_at IS NOT NULL
              OR s.stage IN ('passed', 'won', 'replied', 'talks')
              OR EXISTS (SELECT 1 FROM email_suppression es WHERE es.email = i.recipient)
              OR (SELECT COUNT(*) FROM lead_events e WHERE e.uid = i.uid AND e.kind = 'sent') <> i.step - 1
              OR (i.step > 1 AND (s.follow_up IS NULL OR s.follow_up > outreach_batches.day))
              OR EXISTS (SELECT 1 FROM leads other WHERE other.uid <> i.uid AND lower(trim(other.email)) = i.recipient
                AND EXISTS (SELECT 1 FROM lead_events e WHERE e.uid = other.uid AND e.kind = 'sent'))
            )
          )
      `).bind(at, actor, id, hash, batch.items.length, since, batch.items.length, since),
      db.prepare(`
        INSERT INTO outreach_reservations (day, recipient, batch_id, sender)
        SELECT b.day, i.recipient, b.id, b.sender
        FROM outreach_batches b JOIN outreach_batch_items i ON i.batch_id = b.id
        WHERE b.id = ? AND b.status = 'approved' AND b.approved_at = ? AND changes() = 1
      `).bind(id, at),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/.test(error.message)) throw new ValidationError('An inbox is already reserved today; reload', 'items');
    throw error;
  }
  if (!result[0].meta.changes) throw new ValidationError('Approval blocked: sender paused, capacity exhausted or lead facts changed', 'approval');
  return readDraft(db, id);
}

// Mirrors check() in the read-only external Brevo script. No dispatch lives here.
export function renderedProblems(row, firstTouch) {
  const reasons = [];
  for (const key of ['email', 'subject', 'text', ...(firstTouch ? [] : ['in_reply_to'])]) {
    if (typeof row[key] !== 'string' || !row[key].trim()) reasons.push(`missing_${key}`);
  }
  if (row.text?.includes('{{') || (row.text?.includes('{') && row.text?.includes('}'))) reasons.push('unfilled_token');
  if (/^\s*(re|tr|fw|fwd|aw|wg|antw)\s*:/i.test(row.subject)) reasons.push('reply_prefixed_subject');
  if (firstTouch && row.in_reply_to) reasons.push('first_touch_must_not_thread');
  if (!firstTouch && !(row.in_reply_to?.startsWith('<') && row.in_reply_to?.endsWith('>'))) reasons.push('unknown_original_message_id');
  return reasons;
}

export async function exportDailyDraft(db, id) {
  const batch = await readDraft(db, id);
  if (!batch || batch.status !== 'approved') throw new ValidationError('Export requires an approved batch', 'status');
  if (await draftHash(batch.items, batch.day) !== batch.content_hash) throw new ValidationError('Approved text changed; approve again', 'content_hash');
  // A paused sender (by hand, or by a failed stop rule) releases nothing, even from a batch approved earlier.
  const account = await db.prepare('SELECT paused, reason FROM outreach_senders WHERE email = ?').bind(batch.sender).first();
  if (!account || account.paused) throw new ValidationError(`Export blocked: the sender is paused${account?.reason ? ` · ${account.reason}` : ''}`, 'sender');
  const facts = await factsFor(db, batch.items);
  const held = [];
  const groups = { 'first-touch': [], followups: [] };
  const rowHashes = {};
  for (const item of [...batch.items].sort((a, b) => a.uid.localeCompare(b.uid))) {
    const row = canonicalRows([item], batch.day)[0];
    rowHashes[item.uid] = await sha256Hex(JSON.stringify(row));
    const firstTouch = item.step === 1;
    const reasons = renderedProblems(row, firstTouch);
    const lead = facts.get(item.uid);
    if (!lead) reasons.push('missing_lead');
    else {
      if (lead.suppressed) reasons.push('suppressed');
      if (['passed', 'won', 'replied', 'talks'].includes(lead.stage) || lead.last_reply_at) reasons.push('conversation_or_closed');
      if (emailOf(lead.email) !== item.recipient) reasons.push('recipient_changed');
      if (Number(lead.sends) !== item.step - 1) reasons.push('send_history_changed');
      if (!firstTouch) {
        const original = JSON.parse(lead.original_json || '{}');
        if (!original.sender) reasons.push('unknown_first_sender');
        else if (emailOf(original.sender) !== batch.sender) reasons.push('different_first_sender');
        if (!original.subject || original.subject !== item.subject) reasons.push('original_subject_changed_or_unknown');
        const messageId = messageIdFrom(original.detail);
        if (!messageId || messageId !== item.in_reply_to) reasons.push('unknown_or_changed_original_message_id');
      }
    }
    if (reasons.length) { held.push({ uid: item.uid, reasons: [...new Set(reasons)] }); continue; }
    if (firstTouch) delete row.in_reply_to;
    groups[firstTouch ? 'first-touch' : 'followups'].push(row);
  }
  const files = [];
  for (const [kind, rows] of Object.entries(groups)) {
    if (!rows.length) continue;
    const content = JSON.stringify({ tag: `hq-${batch.id}-${kind}`, rows }, null, 2) + '\n';
    files.push({ kind, filename: `${batch.day}-${batch.id}-${kind}.json`, sha256: await sha256Hex(content), content, count: rows.length });
  }
  return { content_hash: batch.content_hash, sender: batch.sender, files, held, row_hashes: rowHashes };
}
