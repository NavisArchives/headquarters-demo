-- 0026: lead batches that import themselves once NIRMATA approves them
-- (Andy, 13 Nov: « lets do 1 then! »). LEADS files a dataset through the intake
-- door; NIRMATA files an approval naming that file's sha256 and row count; HQ
-- imports the batch in one transaction when both match. Nothing is deleted:
-- leads are upserted, and lead_state, lead_events and lead_drafts are never touched.
-- Numbered 0026 so it never collides with 0024/0025 (quotes, invoice brand),
-- which wait for a later release; wrangler applies each by name.

CREATE TABLE IF NOT EXISTS lead_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  rows        INTEGER NOT NULL,
  body        TEXT    NOT NULL,            -- the dataset JSON as filed; emptied once imported
  source      TEXT    NOT NULL,
  received_at TEXT    NOT NULL,
  imported_at TEXT,
  result      TEXT    CHECK (result IS NULL OR result IN ('imported', 'failed')),
  error       TEXT,
  UNIQUE (key, sha256)
);

CREATE TABLE IF NOT EXISTS lead_batch_approvals (
  key         TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  rows        INTEGER NOT NULL,
  approved_at TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  PRIMARY KEY (key, sha256)
);
