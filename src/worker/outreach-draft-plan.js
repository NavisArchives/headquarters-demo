import { eligibility } from './outreach-policy.js';
import { hasSite } from '../shared/outreach.js';

const REPLY_PREFIX = /^\s*(re|tr|fw|fwd|aw|wg|antw)\s*:/i;

function priority(row) {
  const sends = Number(row.sends || 0);
  if (sends === 1) return 0;
  if (sends === 2) return 1;
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch { /* unknown */ }
  return String(row.website || '').trim() && hasSite({ ...payload, ...row }) ? 3 : 2;
}

/** Select approved copy only. Persistence and HTTP responses belong to the caller. */
export async function planDraftRows(rows, { day, limit, composeLead, now = new Date(`${day}T12:00:00Z`) }) {
  const cap = Math.min(280, Math.max(0, Math.floor(Number(limit) || 0)));
  const ordered = [...rows].sort((a, b) => priority(a) - priority(b)
    || String(a.follow_up || '').localeCompare(String(b.follow_up || ''))
    || Number(b.score || 0) - Number(a.score || 0)
    || a.uid.localeCompare(b.uid));
  const items = [];
  const skipped = [];
  const inboxes = new Set();

  for (const row of ordered) {
    const policy = eligibility({
      ...row, today: day,
      address_changed_since_send: Boolean(row.first_sent_to)
        && row.first_sent_to.toLowerCase().trim() !== String(row.email || '').toLowerCase().trim(),
    }, now);
    const reasons = [...policy.reasons];
    if (row.open_batch_id) reasons.push('already_in_open_batch');
    if (inboxes.has(policy.email)) reasons.push('shared_inbox_in_plan');
    if (policy.step > 1) {
      if (!String(row.first_subject || '').trim()) reasons.push('missing_original_subject');
      else if (REPLY_PREFIX.test(row.first_subject)) reasons.push('reply_prefixed_subject');
    }
    if (reasons.length) {
      skipped.push({ uid: row.uid, name: row.name, reasons });
      continue;
    }
    if (items.length >= cap) {
      skipped.push({ uid: row.uid, name: row.name, reasons: ['sender_daily_limit'] });
      continue;
    }

    const mode = policy.step === 3 ? 'closer' : policy.step === 2 ? 'followup' : 'email';
    // The caller must explicitly provide approved closer copy. Reusing a second
    // touch would silently turn a two-email template into a three-email sequence.
    const draft = await composeLead(row, {
      mode, lang: policy.lang, subject: policy.step > 1 ? row.first_subject : undefined,
    });
    const missing = !draft || draft.noDraft || !draft.subject?.trim() || !draft.body?.trim();
    if (missing || (policy.step === 3 && draft.template !== 'closer-3rd')) {
      skipped.push({ uid: row.uid, name: row.name, reasons: [
        // A code, never compose's own sentence (it names who writes the copy): the screens turn codes into words.
        policy.step === 3 ? 'missing_approved_closer' : draft?.noDraft ? 'no_sector_letter' : 'missing_approved_template',
      ] });
      continue;
    }
    const subject = policy.step > 1 ? row.first_subject : draft.subject;
    if (REPLY_PREFIX.test(subject)) {
      skipped.push({ uid: row.uid, name: row.name, reasons: ['reply_prefixed_subject'] });
      continue;
    }
    items.push({
      uid: row.uid, recipient: policy.email, step: policy.step, subject,
      body: draft.body, lang: policy.lang, hook: row.hook || '',
      template: draft.template || mode,
      in_reply_to: policy.step > 1 ? row.in_reply_to || null : null,
    });
    inboxes.add(policy.email);
  }
  return { items, skipped };
}
