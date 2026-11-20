-- Additive. The work platforms Andy is signed up to (Projects → Platforms, 20 Nov).
-- A platform is not a project: this table is never joined to projects, finance or
-- invoices. Deliberately no column for a login email, password, code, key or ID number.
CREATE TABLE platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'to_sign_up'
    CHECK(status IN ('to_sign_up','signed_up','test_to_do','waiting','active','closed')),
  next_step TEXT NOT NULL DEFAULT '',
  pay TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
