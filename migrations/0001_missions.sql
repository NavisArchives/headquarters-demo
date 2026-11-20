-- Per-project mutable context. Keyed by the registry's slug, deliberately NOT a
-- foreign key: the registry is a committed file, not a table. An orphaned row is
-- harmless and is surfaced rather than cascaded away.
CREATE TABLE IF NOT EXISTS project_meta (
  slug        TEXT PRIMARY KEY,
  notes       TEXT    NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  slug        TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  blocked_on  TEXT,
  due         TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  done_at     TEXT,
  CHECK (status IN ('pending','in_progress','blocked','done')),
  CHECK (status <> 'blocked' OR (blocked_on IS NOT NULL AND blocked_on <> ''))
);

CREATE INDEX IF NOT EXISTS missions_by_status  ON missions(status, position, id);
CREATE INDEX IF NOT EXISTS missions_by_project ON missions(slug, status);
