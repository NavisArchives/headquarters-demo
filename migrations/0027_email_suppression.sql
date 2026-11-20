-- 0027: an address that unsubscribed, bounced hard, was blocked or complained is
-- never written to again, whichever list it comes back on (audit, 13 Nov). Until
-- now the stop sat on one lead row; the same address imported later under another
-- list started as « new ». Keyed on the lower-cased address, not on a lead.
CREATE TABLE IF NOT EXISTS email_suppression (
  email  TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  at     TEXT NOT NULL
);

-- Back-fill from every stop Brevo has already recorded on a lead (« Brevo: <reason> »).
INSERT OR IGNORE INTO email_suppression (email, reason, source, at)
SELECT lower(trim(l.email)), substr(e.detail, 8), 'backfill:lead_events', MIN(e.at)
FROM lead_events e JOIN leads l ON l.uid = e.uid
WHERE e.kind = 'stop' AND l.email IS NOT NULL AND trim(l.email) <> ''
GROUP BY lower(trim(l.email));
