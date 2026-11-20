-- 0015: to-dos — the things Andy has to do himself, each with a deadline.
--
-- Andy, 15 Oct: "lets replace this by a to do list, actual things i have to
-- do … mission will contain leads, and actions … like get new passport, get
-- my vaccine, book my flight". A mission is the goal ("Move to Lima"); a to-do
-- is one action inside it, or on its own. A to-do can point at a lead, so a
-- mission's leads are the leads its to-dos are about.
--
-- Deadlines go to Google Calendar through a private feed (/cal/<token>.ics,
-- see calendar.js); the token lives in settings, never in this file.
--
-- `source` names where an imported to-do came from ("roadmap:c-clinic"), so
-- importing the same list twice adds nothing.

CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  due         TEXT,
  mission_id  INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  lead_uid    TEXT,
  source      TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  done_at     TEXT,
  CHECK (length(trim(title)) > 0 AND length(title) <= 200),
  CHECK (due IS NULL OR (length(due) = 10 AND due GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'))
);

CREATE UNIQUE INDEX IF NOT EXISTS todos_source ON todos(source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS todos_open_due ON todos(done_at, due);
CREATE INDEX IF NOT EXISTS todos_mission ON todos(mission_id);
