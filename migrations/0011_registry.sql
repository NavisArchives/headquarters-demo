-- The registry overlay (2026-09-22).
--
-- Until today a new project meant editing projects.json and running a gated
-- deploy. That is the one thing that still made the owner need a terminal to
-- run his own business, so the registry gains a second layer.
--
-- projects.json stays committed and stays live as the DEFAULTS layer. This
-- table holds only what the owner created in HQ (origin='db', a complete
-- entry) or changed about a committed one (origin='override', a sparse patch
-- over the file entry of the same slug). The effective registry is
-- mergeRegistry(file, rows), computed per request.
--
-- The consequence worth stating: with no rows, the merge returns the file
-- exactly. Day zero is provably identical to yesterday, and DELETE FROM
-- projects is a complete rollback with no code change.
--
-- Keyed by slug and deliberately NOT a foreign key anywhere, for the same
-- reason project_meta is not: invoices, orders, clients and missions all carry
-- a slug as plain TEXT, and the registry has always been a file.
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT    PRIMARY KEY,
  origin      TEXT    NOT NULL CHECK (origin IN ('db','override')),
  entry       TEXT    NOT NULL,            -- JSON; complete for 'db', sparse for 'override'
  brand       TEXT             CHECK (brand IS NULL OR brand IN ('realis','andyssarchives')),
  position    INTEGER NOT NULL DEFAULT 0,  -- order among db-born projects
  archived_at TEXT,                        -- NULL = live; set = off the boards, money intact
  version     INTEGER NOT NULL DEFAULT 1,  -- points at project_versions.version
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL             -- doubles as the optimistic-lock token
);
CREATE INDEX IF NOT EXISTS idx_projects_live ON projects (archived_at, position);

-- Immutable. A save writes a new row; a restore writes another new row whose
-- entry is an old one. Nothing is ever UPDATEd here, so undo is a write and
-- history cannot be rewritten by the thing it is meant to protect against.
CREATE TABLE IF NOT EXISTS project_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  origin      TEXT    NOT NULL,
  entry       TEXT    NOT NULL,
  brand       TEXT,
  archived_at TEXT,
  at          TEXT    NOT NULL,
  actor       TEXT    NOT NULL DEFAULT '',
  note        TEXT    NOT NULL DEFAULT '',   -- "created", "restored from v3", …
  UNIQUE (slug, version)
);

-- Append-only, and separate from the record, so archiving or discarding a
-- project never deletes its history. Modelled on lead_events.
CREATE TABLE IF NOT EXISTS project_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  slug        TEXT NOT NULL,
  action      TEXT NOT NULL,   -- create|edit|archive|unarchive|restore|discard|revert
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_project_events_slug ON project_events (slug, at DESC);
