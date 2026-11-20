import { DEFAULT_PROFILE, compose } from '../shared/outreach.js';
import { getDraft, getSetting } from './db.js';

export function buildComposeRow(lead) {
  let languages = [];
  let payload = {};
  try {
    const parsed = JSON.parse(lead.languages ?? '[]');
    if (Array.isArray(parsed)) languages = parsed;
  } catch { /* Unknown language stays unknown. */ }
  try {
    const parsed = JSON.parse(lead.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch { /* Unknown payload stays empty. */ }
  return { ...payload, ...lead, languages };
}

/** The same approved compose path is used by the lead preview and daily builder. */
export async function composeLead(db, lead, options = {}, now = new Date()) {
  const profile = options.profile ?? await getSetting(db, 'profile') ?? DEFAULT_PROFILE;
  const saved = options.lang && options.mode !== 'closer' ? await getDraft(db, lead.uid, options.lang) : null;
  const history = {
    replied: Boolean(lead.last_reply_at || lead.replied_at) || ['replied', 'talks', 'won'].includes(lead.stage),
    sends: Number(lead.sends || 0),
    lastSentAt: lead.last_sent_at || lead.sent_at || null,
    now: now.toISOString(),
  };
  return compose(buildComposeRow(lead), {
    ...options, profile, history, originalSubject: lead.first_subject,
    draft: saved ? { ...saved, toName: saved.to_name } : undefined,
  });
}
