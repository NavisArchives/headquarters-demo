import { isPersonalDataset } from '../public/assets/personal-lists.js';
import { langsFor, sectorOf, sectorRefusal } from '../shared/outreach.js';

// Used at planning AND approval. No caller can turn a warning into eligibility.
export function eligibility(row, now = new Date()) {
  const reasons = [];
  const email = String(row.email || '').trim().toLowerCase();
  const stage = row.stage || 'new';
  if (isPersonalDataset(row.dataset) || row.business === 'Agencies') reasons.push('excluded_list');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reasons.push('missing_email');
  if (row.suppressed) reasons.push('suppressed');
  if (['passed','won','talks','replied'].includes(stage) || row.last_reply_at) reasons.push('conversation_or_closed');
  if (row.inbox_written_via || row.same_person_written_via) reasons.push('already_contacted_elsewhere');
  if (row.address_changed_since_send) reasons.push('recipient_changed');
  const sends = Number(row.sends || 0);
  if (sends >= 3) reasons.push('sequence_complete');
  const day = row.today || now.toISOString().slice(0, 10);
  if (sends > 0 && (!row.follow_up || row.follow_up > day)) reasons.push('not_due');
  if (!sends && ['sent'].includes(stage)) reasons.push('history_incomplete');
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch { /* unknown */ }
  let languages = row.languages || [];
  try { if (typeof languages === 'string') languages = JSON.parse(languages); } catch { languages = []; }
  const full = { ...payload, ...row, languages };
  const country = String(row.country || '').trim().toLowerCase();
  if (['nl','netherlands','the netherlands','nederland'].includes(country)) {
    const form = String(payload.legal_form || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!['BV','NV'].includes(form)) reasons.push('nl_company_unverified');
  }
  // The first release does not automate Swiss personalized exceptions.
  if (['ch','switzerland','suisse','schweiz'].includes(country)) reasons.push('personal_review_required');
  const lang = langsFor(full)[0];
  if (!['EN','NL','FR'].includes(lang)) reasons.push('language_unavailable');
  const sector = sectorOf(full);
  if (['architect', 'local', 'clinic'].includes(sector)) {
    const refusal = sectorRefusal(full, sector, sends === 2 ? 'closer' : sends ? 'followup' : 'email', { hook: row.hook || payload.extra?.hook, subject: row.subject }, { sends, replied: !!row.last_reply_at, lastSentAt: row.last_sent_at, now: now.toISOString() });
    if (refusal) reasons.push(refusal);
  }
  return { eligible: reasons.length === 0, reasons, step: sends + 1, lang, email };
}
