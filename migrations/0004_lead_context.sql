-- Preserve the mature Leads dashboard's mailbox timestamps and detailed log.
CREATE TABLE IF NOT EXISTS lead_context (
  uid TEXT PRIMARY KEY REFERENCES leads(uid) ON DELETE CASCADE,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
