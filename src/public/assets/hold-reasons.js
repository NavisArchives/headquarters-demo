/* One plain label per reason the planner holds a lead back, defined once and
   used by Outreach → Planner and the assistant alike (NIRMATA H5, 19 Nov).
   Never truncated, never a session or team name. */
export const HOLD_LABELS = Object.freeze({
  already_contacted_elsewhere: 'Already written to at another address',
  already_in_open_batch: 'Already in another open batch',
  conversation_or_closed: 'In conversation or closed',
  excluded_list: 'On the do-not-contact list',
  history_incomplete: 'Send history incomplete',
  language_unavailable: 'No letter in their language',
  missing_email: 'No email address',
  missing_original_subject: 'Original subject missing',
  nl_company_unverified: 'Dutch company not verified',
  not_due: 'Not due yet',
  personal_review_required: 'Needs your own review',
  recipient_changed: 'Email address changed since the first email',
  reply_prefixed_subject: 'Subject starts with « Re: »',
  sequence_complete: 'All emails already sent',
  shared_inbox_in_plan: 'Same inbox already in this batch',
  suppressed: 'Blocked address',
  sender_daily_limit: 'Over the sender\'s daily limit',
  missing_approved_closer: 'No approved last email',
  missing_approved_template: 'No approved letter',
  no_sector_letter: 'No letter for this sector',
});

/** The plain label for a hold reason; an unknown code is shown as words, in full. */
export function holdLabel(code) {
  if (HOLD_LABELS[code]) return HOLD_LABELS[code];
  const words = String(code ?? '').replaceAll('_', ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Held';
}
