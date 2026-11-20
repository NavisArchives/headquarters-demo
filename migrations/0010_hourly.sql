-- An hourly rhythm, alongside once / monthly / daily (2026-09-22).
--
-- Some work is sold by the hour rather than by the day: a weekly shift, a
-- standing session, a treatment slot. `daily` could be abused for it by
-- calling a quarter-day "2 hours", but then the invoice reads "0.25 days" and
-- the rate on the card is a day rate that was never agreed. An hour is its own
-- unit, so it gets its own kind.
--
-- `hourly` behaves exactly like `daily`: the line is the agreed rate, and
-- nothing is owed until hours are logged. Only the word changes.
--
-- SQLite cannot add a value to an existing CHECK, so both tables are migrated
-- BY COPY — create, INSERT SELECT, drop, rename — never by drop, because
-- `order_lines` holds live rows. Every column, default, foreign key and index
-- is otherwise exactly as 0009 had them.
--
-- Order matters. `order_entries_new` is created pointing at `order_lines_new`,
-- so at no moment does a live table reference one that has been dropped;
-- renaming `order_lines_new` to `order_lines` rewrites that reference for us.

CREATE TABLE order_lines_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  unit_cents   INTEGER NOT NULL,
  quantity     REAL    NOT NULL DEFAULT 1,    -- once: how many; the rest: 1
  position     INTEGER NOT NULL DEFAULT 0,
  CHECK (kind IN ('once','monthly','daily','hourly')),
  CHECK (unit_cents >= 0),
  CHECK (quantity > 0)
);
INSERT INTO order_lines_new (id, order_id, kind, description, unit_cents, quantity, position)
  SELECT id, order_id, kind, description, unit_cents, quantity, position FROM order_lines;

CREATE TABLE order_entries_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_id      INTEGER NOT NULL REFERENCES order_lines_new(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  happened_on  TEXT    NOT NULL,              -- YYYY-MM-DD; monthly: the 1st
  period       TEXT,                          -- monthly only: YYYY-MM
  quantity     REAL    NOT NULL DEFAULT 1,    -- daily: days; hourly: hours
  unit_cents   INTEGER NOT NULL,              -- the rate as it was at the time
  description  TEXT    NOT NULL DEFAULT '',
  invoice_id   INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL,
  CHECK (kind IN ('once','monthly','daily','hourly')),
  CHECK (quantity > 0)
);
INSERT INTO order_entries_new (id, order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at)
  SELECT id, order_id, line_id, kind, happened_on, period, quantity, unit_cents, description, invoice_id, created_at FROM order_entries;

DROP TABLE order_entries;
DROP TABLE order_lines;

ALTER TABLE order_lines_new RENAME TO order_lines;
ALTER TABLE order_entries_new RENAME TO order_entries;

CREATE INDEX IF NOT EXISTS order_lines_by_order ON order_lines(order_id, position, id);
CREATE INDEX IF NOT EXISTS order_entries_by_order ON order_entries(order_id, happened_on, id);
CREATE INDEX IF NOT EXISTS order_entries_by_invoice ON order_entries(invoice_id);
-- A month is charged once per line, however often the order is opened.
CREATE UNIQUE INDEX IF NOT EXISTS order_entries_month_once ON order_entries(line_id, period) WHERE period IS NOT NULL;
