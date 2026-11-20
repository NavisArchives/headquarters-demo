// Platforms (Projects → Platforms): the six statuses, in the order the list
// shows them — the ones that need Andy first. Shared by the Worker and the page.
export const PLATFORM_STATUSES = [
  ['test_to_do', 'Test to do'],
  ['to_sign_up', 'To sign up'],
  ['signed_up', 'Signed up'],
  ['waiting', 'Waiting'],
  ['active', 'Active'],
  ['closed', 'Closed'],
];
export const PLATFORM_STATUS_LABEL = Object.fromEntries(PLATFORM_STATUSES);
export const PLATFORM_RANK = Object.fromEntries(PLATFORM_STATUSES.map(([k], i) => [k, i]));

/** Needs-Andy first, then by status order, then most recently changed. */
export function sortPlatforms(rows) {
  return [...rows].sort((a, b) => (PLATFORM_RANK[a.status] ?? 9) - (PLATFORM_RANK[b.status] ?? 9)
    || String(b.updated_at).localeCompare(String(a.updated_at))
    || a.name.localeCompare(b.name));
}
