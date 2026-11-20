// D1's free plan stops every query for the rest of the UTC day once the account has read its
// daily rows (14 Nov 2026: the send list answered 1101 and every lead failed). Say so in words
// Andy and the sessions can act on, instead of « something went wrong ».

export const READ_LIMIT_MESSAGE = "HQ's database has used today's free read allowance (Cloudflare D1). It comes back at 00:00 UTC (19:00 Lima, 01:00 Brussels). Nothing was lost.";

/** True when D1 refused because the account's daily row-read (or write) limit is spent. */
export function isReadLimit(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
  return /free tier daily row (read|write) limit|exceeded D1's .*daily/i.test(text);
}

export const readLimitResponse = () => new Response(JSON.stringify({ error: READ_LIMIT_MESSAGE, code: 'd1_daily_limit' }), {
  status: 503,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3600' },
});
