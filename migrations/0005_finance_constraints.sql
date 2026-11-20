-- Finance CHECK constraints (2026-09-20).
--
-- 0003 declared `status` and `vat_treatment` in comments only, while 0001 and
-- 0002 constrain their vocabularies with CHECK. SQLite cannot add a constraint
-- to an existing table, so the three finance tables are dropped and recreated.
--
-- THIS IS SAFE ONLY BECAUSE THE FINANCE TABLES ARE EMPTY. HQ starts finance
-- from zero — no seed clients, no imported invoices (see the phase-6 brief) —
-- and `clients`, `invoices` and `invoice_lines` hold no rows locally or
-- remotely at the time this migration is written. It destroys data if it is
-- ever run against a database where they do. Anything after this point must
-- migrate by copy (CREATE new -> INSERT SELECT -> DROP old -> ALTER RENAME),
-- never by drop.
--
-- Every column, default, foreign key and index is otherwise exactly as 0003
-- had them; the only additions are the two CHECK clauses.

-- Children first: invoice_lines references invoices, invoices references clients.
DROP TABLE IF EXISTS invoice_lines;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS clients;

CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  initials      TEXT,                      -- the letters used in invoice numbers
  slug          TEXT,                      -- a project, when there is one
  email         TEXT,
  address       TEXT,
  country       TEXT NOT NULL DEFAULT 'BE',-- decides the VAT treatment
  vat_number    TEXT,                      -- BTW / VAT
  company_reg   TEXT,                      -- KvK or equivalent
  created_at    TEXT NOT NULL
);

-- `status` holds only 'draft' | 'issued' | 'void'. sent/paid are never stored as a
-- status: they are the independent sent_on/paid_on dates, and the full read-time
-- status (draft/issued/sent/paid/void) plus `overdue` are derived in src/worker/db.js,
-- never persisted. `vat_treatment` is a treatment, not a rate — the rates live in
-- VAT_TREATMENTS in src/worker/db.js and must stay in step with this list.
CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT UNIQUE,              -- NULL while draft; allocated at issue
  seq            INTEGER,                  -- the unbroken per-year counter
  year           INTEGER,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  slug           TEXT,
  subject        TEXT NOT NULL DEFAULT '', -- the campaign
  po_number      TEXT,
  status         TEXT NOT NULL,            -- draft | issued | void
  issued_on      TEXT,
  due_on         TEXT,                     -- issued_on + 30 days by default
  sent_on        TEXT,
  paid_on        TEXT,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  vat_treatment  TEXT NOT NULL DEFAULT 'reverse_charge',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents      INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (status IN ('draft','issued','void')),
  CHECK (vat_treatment IN ('standard','reverse_charge','exempt_small','export'))
);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_seq_per_year ON invoices(year, seq) WHERE seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_by_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS invoices_by_status ON invoices(status);

-- Unchanged from addendum 1, except `no_charge`: a line whose amount is 0 but is
-- printed as "NO CHARGE" rather than "€0,00" (they mean different things to a client).
CREATE TABLE IF NOT EXISTS invoice_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT    NOT NULL,
  quantity     REAL    NOT NULL DEFAULT 1,
  unit_cents   INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  no_charge    INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invoice_lines_by_invoice ON invoice_lines(invoice_id, position);
