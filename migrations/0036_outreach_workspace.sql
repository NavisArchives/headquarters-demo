-- Additive renovation. Historical events remain untouched; unknown mail facts stay NULL.
ALTER TABLE lead_events ADD COLUMN message_key TEXT;
ALTER TABLE lead_events ADD COLUMN sender TEXT;
-- lead_events.subject already exists (0035_lead_events_subject, live since 19 Nov).
ALTER TABLE lead_events ADD COLUMN body TEXT;
ALTER TABLE lead_events ADD COLUMN thread_id TEXT;
ALTER TABLE lead_events ADD COLUMN provenance TEXT;
CREATE UNIQUE INDEX lead_events_message_key ON lead_events(message_key) WHERE message_key IS NOT NULL;
CREATE INDEX lead_events_sent_at ON lead_events(kind, at);

CREATE TABLE outreach_senders (
  email TEXT PRIMARY KEY CHECK(email = lower(trim(email))),
  daily_limit INTEGER NOT NULL DEFAULT 20 CHECK(daily_limit BETWEEN 0 AND 280),
  paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
  reason TEXT NOT NULL DEFAULT 'Review sender health and warm-up before enabling',
  updated_at TEXT NOT NULL
);
CREATE TABLE outreach_batches (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  sender TEXT NOT NULL REFERENCES outreach_senders(email),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','cancelled')),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  cancelled_at TEXT
);
CREATE INDEX outreach_batches_day ON outreach_batches(day, status, sender);
CREATE TABLE outreach_batch_items (
  batch_id TEXT NOT NULL REFERENCES outreach_batches(id) ON DELETE CASCADE,
  uid TEXT NOT NULL REFERENCES leads(uid),
  recipient TEXT NOT NULL,
  step INTEGER NOT NULL CHECK(step BETWEEN 1 AND 3),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  hook TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL CHECK(lang IN ('EN','FR','NL')),
  PRIMARY KEY(batch_id, uid),
  UNIQUE(batch_id, recipient)
);
CREATE TABLE outreach_reservations (
  day TEXT NOT NULL,
  recipient TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES outreach_batches(id),
  sender TEXT NOT NULL,
  PRIMARY KEY(day, recipient)
);
CREATE INDEX outreach_reservations_sender ON outreach_reservations(day, sender);
-- No changes to old opportunities: signed facts require explicit evidence.
CREATE TABLE signed_agreements (
  prospect_id INTEGER PRIMARY KEY REFERENCES prospects(id),
  signed_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3),
  evidence TEXT NOT NULL CHECK(length(trim(evidence)) > 0),
  recorded_at TEXT NOT NULL
);
CREATE TABLE outreach_delivery_events (
  event_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  happened_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX outreach_delivery_time ON outreach_delivery_events(kind, happened_at);
