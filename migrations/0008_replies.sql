-- The reply funnel.
--
-- A reply arrives in Gmail, HQ reads it once, stores what it understood, and
-- proposes missions. Two rules are baked into the schema rather than left to
-- the code:
--
--   * One review per message. `message_id` is UNIQUE, so re-scanning the same
--     mailbox can only ever be a no-op — the classifier is never asked twice
--     and no duplicate proposals appear.
--   * A proposal is not a mission. `missions.status` gains 'proposed', and
--     `missions.source_review_id` says which reply it came from, so a mission
--     whose provenance you cannot check cannot exist.
--
-- Nothing here stores instructions. `body_excerpt` is the email's own text,
-- kept only so the owner can read the original before accepting anything.

CREATE TABLE IF NOT EXISTS reply_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The lead this reply was matched to, when it could be matched at all. A
  -- reply from an address on no list is still worth reading, so this is NULL-able.
  uid           TEXT    REFERENCES leads(uid),
  message_id    TEXT    NOT NULL UNIQUE,
  thread_id     TEXT,
  from_email    TEXT    NOT NULL DEFAULT '',
  subject       TEXT    NOT NULL DEFAULT '',
  received_at   TEXT,
  -- First 2000 characters of what they wrote. Data, never instructions.
  body_excerpt  TEXT    NOT NULL DEFAULT '',
  intent        TEXT    NOT NULL,
  summary       TEXT    NOT NULL DEFAULT '',
  -- JSON array of { kind, detail, url?, due_hint? } — validated before it lands.
  asks          TEXT    NOT NULL DEFAULT '[]',
  language      TEXT    NOT NULL DEFAULT 'other',
  reviewed_at   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',
  CHECK (status IN ('open','handled','dismissed')),
  CHECK (intent IN ('interested','wants_info','wants_call','asks_rate',
                    'sign_up_elsewhere','not_now','not_interested','auto_reply','unclear'))
);

CREATE INDEX IF NOT EXISTS reply_reviews_by_status ON reply_reviews(status, received_at DESC);
CREATE INDEX IF NOT EXISTS reply_reviews_by_lead   ON reply_reviews(uid);

-- Missions gain 'proposed' and a link back to the reply. SQLite cannot widen a
-- CHECK in place, so the table is rebuilt: same columns, same indexes, two
-- additions. Nothing references missions, so no cascade is involved.
CREATE TABLE missions_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  detail           TEXT    NOT NULL DEFAULT '',
  slug             TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  blocked_on       TEXT,
  due              TEXT,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  done_at          TEXT,
  source_review_id INTEGER REFERENCES reply_reviews(id) ON DELETE SET NULL,
  CHECK (status IN ('proposed','pending','in_progress','blocked','done')),
  CHECK (status <> 'blocked' OR (blocked_on IS NOT NULL AND blocked_on <> ''))
);

INSERT INTO missions_new
  (id, title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, source_review_id)
SELECT id, title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, NULL
FROM missions;

DROP TABLE missions;
ALTER TABLE missions_new RENAME TO missions;

CREATE INDEX IF NOT EXISTS missions_by_status  ON missions(status, position, id);
CREATE INDEX IF NOT EXISTS missions_by_project ON missions(slug, status);
CREATE INDEX IF NOT EXISTS missions_by_review  ON missions(source_review_id);
