-- 0022 (written as 0013 on 14 Oct, renumbered): every mission says where it came from, and HQ has one door for
-- missions filed by machines (POST /api/intake).
--
-- `source` is who made the mission: 'hq' (typed on the Missions screen),
-- 'warm_lead' (the 0012 triggers), 'reply' (a proposal from the reply scanner)
-- or an intake source ('nirmata', 'shortcut', 'email'). `source_ref` is that
-- source's own reference: the lead's uid, the reply review's id, or the
-- intake request's idempotency key.

ALTER TABLE missions ADD COLUMN source TEXT NOT NULL DEFAULT 'hq';
ALTER TABLE missions ADD COLUMN source_ref TEXT;

-- What already exists, labelled after the fact.
UPDATE missions SET source = 'warm_lead', source_ref = lead_uid WHERE lead_uid IS NOT NULL;
UPDATE missions SET source = 'reply', source_ref = CAST(source_review_id AS TEXT)
  WHERE source_review_id IS NOT NULL AND lead_uid IS NULL;

-- The 0012 triggers insert without naming a source; the column default says
-- 'hq'. A mission that carries a lead and still says 'hq' came from one of
-- them, so it is relabelled the moment it is written. (Intake requests that
-- carry a lead name their own source and are left alone.)
CREATE TRIGGER IF NOT EXISTS mission_source_from_warm_lead
AFTER INSERT ON missions
WHEN NEW.lead_uid IS NOT NULL AND NEW.source = 'hq'
BEGIN
  UPDATE missions SET source = 'warm_lead', source_ref = NEW.lead_uid WHERE id = NEW.id;
END;

-- One row per intake request, claimed BEFORE the mission is written: a retry
-- with the same key finds the claim and gets the same mission back instead
-- of a second one. Rate limits count these rows.
CREATE TABLE IF NOT EXISTS intake_requests (
  source          TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  mission_id      INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  -- What a reply or an outreach_sent made: the reply review's id, or the lead's uid.
  ref             TEXT,
  received_at     TEXT    NOT NULL,
  PRIMARY KEY (source, idempotency_key),
  CHECK (kind IN ('mission', 'proposition', 'warm_lead', 'reply', 'outreach_sent'))
);
CREATE INDEX IF NOT EXISTS intake_requests_by_time ON intake_requests(source, received_at);
