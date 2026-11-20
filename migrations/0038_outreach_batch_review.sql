-- Structural only. Reserved by HEADQUARTERS in the UX review ANSWER.md.
-- Historical facts remain unknown; no backfill or existing-row updates.
ALTER TABLE outreach_batch_items ADD COLUMN in_reply_to TEXT;
ALTER TABLE outreach_batch_items ADD COLUMN template TEXT;
ALTER TABLE outreach_batches ADD COLUMN skipped_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outreach_batches ADD COLUMN verification_json TEXT NOT NULL DEFAULT '{}';

-- HEADQUARTERS review (F1): open-batch and reply lookups find batch rows by lead and by
-- recipient; without these, one daily build scans every row once per lead.
CREATE INDEX outreach_batch_items_uid ON outreach_batch_items(uid);
CREATE INDEX outreach_batch_items_recipient ON outreach_batch_items(recipient);
