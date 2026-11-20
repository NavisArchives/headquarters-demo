CREATE TABLE IF NOT EXISTS datasets (
  key          TEXT PRIMARY KEY,           -- folder name: ugc-brands-agencies
  business     TEXT    NOT NULL,           -- UGC | Web design — becomes a tab
  title        TEXT    NOT NULL,
  subtitle     TEXT,
  collected    TEXT,                       -- YYYY-MM-DD
  method       TEXT,
  scoring      TEXT,
  tier_hot     INTEGER NOT NULL,           -- score >= tier_hot  → Hot
  tier_warm    INTEGER NOT NULL,           -- score >= tier_warm → Warm, else Cool
  row_count    INTEGER NOT NULL DEFAULT 0,
  imported_at  TEXT    NOT NULL
);

-- Facts. Owned by datasets/*/data.json and re-imported from it. Never edited by hand.
CREATE TABLE IF NOT EXISTS leads (
  uid           TEXT PRIMARY KEY,          -- <dataset>/<id>, the key the old app used
  dataset       TEXT    NOT NULL REFERENCES datasets(key) ON DELETE CASCADE,
  id            TEXT    NOT NULL,
  business      TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  website       TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  subcategory   TEXT,
  city          TEXT,
  area          TEXT,
  region        TEXT,
  country       TEXT    NOT NULL,
  languages     TEXT    NOT NULL DEFAULT '[]',   -- JSON array of NL | FR | EN
  email         TEXT,
  phone         TEXT,
  contact       TEXT,
  contact_type  TEXT,                            -- email | form | linkedin | portal | phone | other
  score         INTEGER NOT NULL,
  tier          TEXT    NOT NULL,                -- Hot | Warm | Cool, derived at import
  verified      TEXT,
  payload       TEXT    NOT NULL,                -- the complete original row, JSON
  imported_at   TEXT    NOT NULL,
  CHECK (tier IN ('Hot','Warm','Cool'))
);
CREATE INDEX IF NOT EXISTS leads_by_business ON leads(business, score DESC);
CREATE INDEX IF NOT EXISTS leads_by_dataset  ON leads(dataset);

-- State. Owned by the person. The importer never writes here.
CREATE TABLE IF NOT EXISTS lead_state (
  uid         TEXT PRIMARY KEY REFERENCES leads(uid) ON DELETE CASCADE,
  stage       TEXT    NOT NULL DEFAULT 'new',
  starred     INTEGER NOT NULL DEFAULT 0,
  notes       TEXT    NOT NULL DEFAULT '',
  follow_up   TEXT,                              -- YYYY-MM-DD
  looked_at   TEXT,
  sent_at     TEXT,
  replied_at  TEXT,
  won_at      TEXT,
  passed_at   TEXT,
  updated_at  TEXT    NOT NULL,
  CHECK (stage IN ('new','looked','shortlist','sent','replied','talks','won','passed'))
);
CREATE INDEX IF NOT EXISTS lead_state_by_stage ON lead_state(stage, updated_at DESC);

-- Append-only history. What the browser's local storage never had.
CREATE TABLE IF NOT EXISTS lead_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  uid     TEXT NOT NULL REFERENCES leads(uid) ON DELETE CASCADE,
  kind    TEXT NOT NULL,                         -- stage | star | note | opened | sent | replied | followup
  detail  TEXT NOT NULL DEFAULT '',
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lead_events_by_uid ON lead_events(uid, at DESC);

-- A draft per lead per language, replacing localStorage "leads.drafts".
CREATE TABLE IF NOT EXISTS lead_drafts (
  uid         TEXT NOT NULL REFERENCES leads(uid) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  to_name     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (uid, lang)
);

-- The outreach profile and other one-row settings, replacing localStorage "leads.profile".
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                     -- JSON
  updated_at  TEXT NOT NULL
);
