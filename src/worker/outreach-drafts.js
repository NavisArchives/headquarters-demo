import { cleanDay, getSetting, hqToday, ValidationError } from './db.js';
import { sha256Hex } from './lead-batches.js';
import { composeLead } from './lead-compose.js';
import { planDraftRows } from './outreach-draft-plan.js';
import { messageIdFrom } from './send-list.js';

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Today and tomorrow in HQ's zone. A 10:00 Brussels batch leaves at 04:00 Lima,
 *  so it is built and approved the day before (Andy: ready by 14:00 Brussels). */
export function buildableDays(now = new Date()) {
  const today = hqToday(now);
  return [today, nextDay(today)];
}

// A no-website lead, as hasSite() in shared/outreach.js decides it.
const NO_SITE_SQL = `(trim(COALESCE(l.website, '')) = ''
      OR lower(trim(COALESCE(l.category, ''))) = 'no site'
      OR (json_valid(l.payload) AND lower(trim(COALESCE(json_extract(l.payload, '$.extra.Need'), ''))) = 'no website'))`;
const OPEN_OTHER_BATCH = `
  SELECT b.id FROM outreach_batch_items i
  JOIN outreach_batches b ON b.id = i.batch_id
  WHERE i.uid = l.uid AND b.status IN ('draft', 'approved')
    AND NOT EXISTS (
      SELECT 1 FROM lead_events sent
      WHERE sent.uid = i.uid AND sent.kind = 'sent' AND sent.batch = b.id
    )
  LIMIT 1
`;

export function canonicalRows(items, day) {
  return [...items].sort((a, b) => a.uid.localeCompare(b.uid)).map((item) => ({
    email: item.recipient, subject: item.subject, text: item.body,
    in_reply_to: item.step > 1 ? item.in_reply_to || null : null,
    uids: [item.uid], day,
  }));
}

export async function draftHash(items, day) {
  return sha256Hex(JSON.stringify(canonicalRows(items, day)));
}

export async function readDraft(db, id) {
  const batch = await db.prepare('SELECT * FROM outreach_batches WHERE id = ?').bind(id).first();
  if (!batch) return null;
  const { results } = await db.prepare(`
    SELECT i.*, l.name FROM outreach_batch_items i
    JOIN leads l ON l.uid = i.uid
    WHERE i.batch_id = ?
    ORDER BY CASE i.step WHEN 2 THEN 0 WHEN 3 THEN 1 ELSE 2 END,
      CASE WHEN trim(COALESCE(l.website, '')) = '' OR lower(l.category) = 'no site' THEN 0 ELSE 1 END,
      l.score DESC, i.uid
  `).bind(id).all();
  return { ...batch, items: results || [], skipped: JSON.parse(batch.skipped_json || '[]') };
}

export async function buildDailyDraft(db, input, now = new Date()) {
  cleanDay(input.day, 'day');
  if (!buildableDays(now).includes(input.day)) {
    throw new ValidationError('Build for today or tomorrow; further ahead needs fresh checks on its day', 'day');
  }
  const sender = normalizeEmail(input.sender);
  const account = await db.prepare('SELECT * FROM outreach_senders WHERE email = ?').bind(sender).first();
  if (!account) throw new ValidationError('Configure the sender first', 'sender');
  const { results } = await db.prepare(`
    SELECT l.*, COALESCE(s.stage, 'new') AS stage, s.follow_up, s.last_sent_at, s.last_reply_at,
      (SELECT COUNT(*) FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent') AS sends,
      EXISTS (SELECT 1 FROM email_suppression es WHERE es.email = lower(trim(l.email))) AS suppressed,
      (SELECT json_object('subject', e.subject, 'sender', e.sender, 'detail', e.detail, 'sent_to', e.sent_to)
        FROM lead_events e WHERE e.uid = l.uid AND e.kind = 'sent' ORDER BY e.at, e.id LIMIT 1) AS first_sent_json,
      (${OPEN_OTHER_BATCH}) AS open_batch_id,
      (SELECT other.uid FROM leads other
        WHERE lower(trim(other.email)) = lower(trim(l.email)) AND other.uid <> l.uid
          AND EXISTS (SELECT 1 FROM lead_events e WHERE e.uid = other.uid AND e.kind = 'sent')
        LIMIT 1) AS inbox_written_via
    FROM leads l LEFT JOIN lead_state s ON s.uid = l.uid
    WHERE l.dataset <> 'travel-volunteer-stays' AND l.business <> 'Agencies'
    ORDER BY CASE WHEN s.follow_up <= ? THEN 0 WHEN ${NO_SITE_SQL} THEN 1 ELSE 2 END, l.score DESC, l.uid
    LIMIT 2000
  `).bind(input.day).all();
  const rows = (results || []).map((row) => {
    const first = JSON.parse(row.first_sent_json || '{}');
    return { ...row, first_subject: first.subject, first_sender: first.sender,
      first_sent_to: first.sent_to, in_reply_to: messageIdFrom(first.detail) };
  });
  const profile = await getSetting(db, 'profile');
  const plan = await planDraftRows(rows, {
    day: input.day, limit: account.daily_limit, now,
    composeLead: (row, options) => composeLead(db, row, { ...options, profile }, now),
  });
  const id = crypto.randomUUID();
  const hash = await draftHash(plan.items, input.day);
  await db.batch([
    db.prepare(`
      INSERT INTO outreach_batches (id, day, sender, content_hash, created_at, skipped_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, input.day, sender, hash, now.toISOString(), JSON.stringify(plan.skipped)),
    ...plan.items.map((item) => db.prepare(`
      INSERT INTO outreach_batch_items
        (batch_id, uid, recipient, step, subject, body, lang, hook, template, in_reply_to)
      SELECT ?, l.uid, ?, ?, ?, ?, ?, ?, ?, ? FROM leads l
      WHERE l.uid = ? AND NOT EXISTS (${OPEN_OTHER_BATCH})
    `).bind(id, item.recipient, item.step, item.subject, item.body, item.lang, item.hook,
      item.template, item.in_reply_to, item.uid)),
  ]);
  const saved = await readDraft(db, id);
  if (saved.items.length !== plan.items.length) {
    await db.prepare("UPDATE outreach_batches SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .bind(now.toISOString(), id).run();
    throw new ValidationError('A lead entered another batch while building. Build again.', 'items');
  }
  return saved;
}

export async function editDraft(db, id, input) {
  const batch = await readDraft(db, id);
  if (!batch || batch.status === 'cancelled') throw new ValidationError('This batch cannot be edited', 'id');
  if (input.content_hash !== batch.content_hash) throw new ValidationError('Batch changed; reload before editing', 'content_hash');
  const item = batch.items.find((row) => row.uid === input.uid);
  if (!item) throw new ValidationError('Unknown batch row', 'uid');
  let items;
  if (input.remove === true) items = batch.items.filter((row) => row.uid !== input.uid);
  else {
    for (const [field, max] of [['subject', 500], ['body', 20000]]) {
      if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > max) {
        throw new ValidationError(`${field} must contain 1–${max} characters`, field);
      }
    }
    if (item.step > 1 && input.subject !== item.subject) throw new ValidationError('A follow-up keeps its original subject', 'subject');
    if (/^\s*(re|tr|fw|fwd|aw|wg|antw)\s*:/i.test(input.subject)) throw new ValidationError('Do not prefix the subject with Re:', 'subject');
    items = batch.items.map((row) => row.uid === input.uid ? { ...row, subject: input.subject, body: input.body } : row);
  }
  const hash = await draftHash(items, batch.day);
  const result = await db.batch([
    db.prepare(`
      UPDATE outreach_batches SET status = 'draft', content_hash = ?, approved_at = NULL, approved_by = NULL
      WHERE id = ? AND content_hash = ? AND status IN ('draft', 'approved')
        AND COALESCE(json_extract(verification_json, '$.summary.total'), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.batch = outreach_batches.id AND e.kind = 'sent')
    `).bind(hash, id, batch.content_hash),
    db.prepare(`
      DELETE FROM outreach_reservations WHERE batch_id = ?
        AND EXISTS (SELECT 1 FROM outreach_batches WHERE id = ? AND status = 'draft' AND content_hash = ?)
    `).bind(id, id, hash),
    input.remove === true ? db.prepare(`
      DELETE FROM outreach_batch_items WHERE batch_id = ? AND uid = ?
        AND EXISTS (SELECT 1 FROM outreach_batches WHERE id = ? AND status = 'draft' AND content_hash = ?)
    `).bind(id, input.uid, id, hash) : db.prepare(`
      UPDATE outreach_batch_items SET subject = ?, body = ? WHERE batch_id = ? AND uid = ?
        AND EXISTS (SELECT 1 FROM outreach_batches WHERE id = ? AND status = 'draft' AND content_hash = ?)
    `).bind(input.subject, input.body, id, input.uid, id, hash),
  ]);
  if (!result[0].meta.changes) throw new ValidationError('Batch changed or sending has already been verified; reload', 'content_hash');
  return readDraft(db, id);
}
