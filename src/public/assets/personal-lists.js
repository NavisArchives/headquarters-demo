// Lists that are Andy's own, never outreach (Andy, 28 Oct: the Travel list list is
// personal; never batch, Brevo or send it). One place, read by the Worker and the app.
export const PERSONAL_DATASETS = Object.freeze(['travel-volunteer-stays']);

export const isPersonalDataset = (key) => PERSONAL_DATASETS.includes(String(key ?? ''));
export const isPersonalUid = (uid) => isPersonalDataset(String(uid ?? '').split('/')[0]);
export const PERSONAL_REFUSAL = 'The Travel list list is personal: no outreach for it.';

// Agencies are partners or buyers of white-label work, not website clients
// (Andy, 13 Nov): the client pitch is never written for them.
export const AGENCIES = 'Agencies';
export const AGENCY_REFUSAL = 'Agencies get a white-label pitch, not the client email: it is not written here yet.';

/** Why no client outreach may be written for this lead, or null when it may. */
export const SUPPRESSED_REFUSAL = 'This address unsubscribed, bounced or complained: it is never written to again.';

export function outreachRefusal(lead) {
  if (isPersonalDataset(lead?.dataset) || isPersonalUid(lead?.uid)) return PERSONAL_REFUSAL;
  if (lead?.suppressed === true || Number(lead?.suppressed) === 1) return SUPPRESSED_REFUSAL;
  if (lead?.business === AGENCIES) return AGENCY_REFUSAL;
  return null;
}
