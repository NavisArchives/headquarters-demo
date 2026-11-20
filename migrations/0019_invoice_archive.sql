-- 0019: the invoice archive — every invoice Andy sent before HQ (2023–2026),
-- kept with its ORIGINAL number exactly as printed ("4.R.S.L.25",
-- "2.AA.DA", "6_R.O.K.001", "14.R.U.I.01-24"), plus business expenses.
--
-- ADDITIVE ONLY: ADD COLUMN, one new table, one index. No table is dropped and
-- no existing row is rewritten. The archive rows themselves are data, carried
-- by data/archive/import-archive.sql (generated from
-- data/archive/invoices-2023-2026.json by scripts/import-archive.mjs).
--
-- An archive invoice is an ordinary `invoices` row with:
--   series = 'archive'  — outside the live numbering: it never takes a `seq`,
--                         issueInvoice's counter is per (series, year) so it
--                         never sees one, and the client index (the NN in
--                         <n>.R.A.<letters>.<NN>) does not count it either
--                         (db.js). It is read-only: db.js refuses to unissue,
--                         void, re-send or re-bank one.
--   status  = 'issued', number = the printed number, seq = NULL.

-- Who the invoice was made out to, as printed ("The UGC London Ltd" on a
-- client HQ files as The UGC Consultancy Ltd). NULL = the client's name.
ALTER TABLE invoices ADD COLUMN billed_to TEXT;

-- Which business issued it: "the Belgian business (BCE 0000.000.000)"
-- or "the business abroad (Tax ID 0000000000)".
-- NULL = the current issuer from Your invoice details (every live invoice).
ALTER TABLE invoices ADD COLUMN issuer_entity TEXT;

-- Where the record comes from: "Invoice PDF p.31", an email id, a bank export.
ALTER TABLE invoices ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS invoices_by_series_year ON invoices(series, year);

-- A client can carry what HQ knows about it beyond the invoice block (other
-- names it pays under, a printed address that was a template left-over...).
ALTER TABLE clients ADD COLUMN notes TEXT NOT NULL DEFAULT '';
-- The archive's stable key for a client ('lumen', 'oona'...), so a second
-- run of the import finds the client it made instead of making another.
ALTER TABLE clients ADD COLUMN archive_key TEXT;

-- A payment says which account it arrived in (an id from
-- settings.bank_accounts: 'kbc', 'wise', 'bog'), the bank's own reference
-- ("communication") and where the proof is.
ALTER TABLE payments ADD COLUMN bank_account TEXT;
ALTER TABLE payments ADD COLUMN reference TEXT;
ALTER TABLE payments ADD COLUMN source TEXT;

-- Business purchases (an iPad, a lens, the second company set-up).
-- `ref` is the import's stable key; amounts are integer cents in EUR, with
-- the original currency kept beside it when it was paid in another one.
CREATE TABLE IF NOT EXISTS expenses (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                    TEXT    NOT NULL UNIQUE,
  spent_on               TEXT    NOT NULL,
  year                   INTEGER NOT NULL,
  vendor                 TEXT    NOT NULL,
  description            TEXT    NOT NULL DEFAULT '',
  order_ref              TEXT,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency               TEXT    NOT NULL DEFAULT 'EUR',
  original_amount_cents  INTEGER,
  original_currency      TEXT,
  paid_with              TEXT,
  flag                   TEXT,
  notes                  TEXT    NOT NULL DEFAULT '',
  source                 TEXT,
  created_at             TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_by_year ON expenses(year, spent_on);
