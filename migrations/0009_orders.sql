-- Orders: what a client is charged for on one project.
--
-- A client can have several projects; each project can have one order, and the
-- order says what is charged and how often:
--   once     a fixed amount, charged one time (a build, a package)
--   monthly  a fixed amount, charged every month the order runs (care, hosting)
--   daily    a rate, charged per day worked (a shoot day, an editing day)
--
-- What is actually owed lives in order_entries: one row per charge that has
-- happened. Monthly rows are brought up to date from the order's start; daily
-- rows are logged by hand as days are worked; once rows are written when the
-- line is added. An entry carries invoice_id once it has been put on an
-- invoice, so nothing is ever billed twice.

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  slug         TEXT,                          -- the project, from the registry
  title        TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'active',
  started_on   TEXT    NOT NULL,              -- YYYY-MM-DD
  ended_on     TEXT,                          -- YYYY-MM-DD, NULL while it runs
  currency     TEXT    NOT NULL DEFAULT 'EUR',
  notes        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  CHECK (status IN ('active','ended'))
);
CREATE INDEX IF NOT EXISTS orders_by_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS orders_by_slug ON orders(slug);

CREATE TABLE IF NOT EXISTS order_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  unit_cents   INTEGER NOT NULL,
  quantity     REAL    NOT NULL DEFAULT 1,    -- once: how many; monthly/daily: 1
  position     INTEGER NOT NULL DEFAULT 0,
  CHECK (kind IN ('once','monthly','daily')),
  CHECK (unit_cents >= 0),
  CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS order_lines_by_order ON order_lines(order_id, position, id);

CREATE TABLE IF NOT EXISTS order_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_id      INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  happened_on  TEXT    NOT NULL,              -- YYYY-MM-DD; monthly: the 1st
  period       TEXT,                          -- monthly only: YYYY-MM
  quantity     REAL    NOT NULL DEFAULT 1,
  unit_cents   INTEGER NOT NULL,              -- the rate as it was at the time
  description  TEXT    NOT NULL DEFAULT '',
  invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL,
  CHECK (kind IN ('once','monthly','daily')),
  CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS order_entries_by_order ON order_entries(order_id, happened_on, id);
CREATE INDEX IF NOT EXISTS order_entries_by_invoice ON order_entries(invoice_id);
-- A month is charged once per line, however often the order is opened.
CREATE UNIQUE INDEX IF NOT EXISTS order_entries_month_once ON order_entries(line_id, period) WHERE period IS NOT NULL;
