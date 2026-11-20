-- 0018: questionnaires tailored per prospect, templates Andy saves, and the
-- client typing on the live page (Andy's F31, 19 Oct, via NIRMATA).
--
-- `form_config` is a prospect's own questionnaire: the sections in order, the
-- questions turned off, Andy's own questions, the example videos (shape and
-- checks in onboarding-form.js cleanConfig). Null means "the built-in one its
-- `template` column names", so every prospect onboarded so far is unchanged.
--
-- `onboarding_templates` holds the setups Andy saves under a name ("Save as
-- template"); the two built-in ones live in the code.
--
-- The client writes only short text, only through his live link, and at most
-- 30 times a minute: `live_write_minute` / `live_write_count` count that.
-- `live_misses` counts wrong live links per address and minute, so the short
-- links (/live/<name>-<6 characters>) cannot be guessed by trying.

ALTER TABLE prospects ADD COLUMN form_config TEXT CHECK (form_config IS NULL OR (json_valid(form_config) AND json_type(form_config) = 'object'));
ALTER TABLE prospects ADD COLUMN live_write_minute TEXT;
ALTER TABLE prospects ADD COLUMN live_write_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS onboarding_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  config     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  CHECK (length(trim(name)) > 0 AND length(name) <= 80),
  CHECK (json_valid(config) AND json_type(config) = 'object')
);

CREATE TABLE IF NOT EXISTS live_misses (
  address TEXT    NOT NULL,
  minute  TEXT    NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address, minute)
);
