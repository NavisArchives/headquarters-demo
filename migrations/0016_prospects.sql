-- 0016: potential clients and the pipeline they move through, with the
-- onboarding questionnaire filled in at the first meeting.
--
-- Andy, 16 Oct (via Nirmata): "upgrade headquarters with … potential client,
-- like an actual pipeline … an onboarding process, where I fill in or select
-- all his needs … he might stand next to me … so make a safe view button."
--
-- A prospect is the deal: who (name, organisation, contact), where it stands
-- (stage), what happens next (next_step, next_at), and what it came from (the
-- lead it was, the Gmail thread). `entities` are the businesses one prospect
-- brings (a surgeon's personal brand, his clinic, his academy); the
-- questionnaire asks about each. `onboarding` holds the answers as one JSON
-- object, merged key by key as they are typed (json_patch), so two open
-- screens never overwrite each other's fields.
--
-- `notes` is internal and never leaves HQ's own screens: the client-facing
-- onboarding route reads only the name, the organisation, the brand, the
-- entities and the answers.

CREATE TABLE IF NOT EXISTS prospects (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  organisation          TEXT    NOT NULL DEFAULT '',
  email                 TEXT,
  phone                 TEXT,
  address               TEXT,
  brand                 TEXT    NOT NULL DEFAULT 'realis',
  stage                 TEXT    NOT NULL DEFAULT 'lead',
  next_step             TEXT    NOT NULL DEFAULT '',
  next_at               TEXT,
  lead_uid              TEXT,
  gmail_thread          TEXT,
  entities              TEXT    NOT NULL DEFAULT '[]',
  notes                 TEXT    NOT NULL DEFAULT '',
  onboarding            TEXT    NOT NULL DEFAULT '{}',
  onboarding_updated_at TEXT,
  lost_reason           TEXT,
  position              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  CHECK (brand IN ('realis', 'archive')),
  CHECK (stage IN ('lead', 'meeting', 'onboarding', 'proposal', 'contract', 'won', 'lost')),
  CHECK (next_at IS NULL OR next_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]*'),
  CHECK (json_valid(entities) AND json_type(entities) = 'array'),
  CHECK (json_valid(onboarding) AND json_type(onboarding) = 'object')
);

CREATE INDEX IF NOT EXISTS prospects_stage ON prospects(stage, next_at);
CREATE INDEX IF NOT EXISTS prospects_lead ON prospects(lead_uid);
