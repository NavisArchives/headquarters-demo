-- Payments, prepayment invoices, and one running invoice counter (2026-09-20).
--
-- Driven by the real invoice 5.R.A.L.01 (design addendum 4): its total is
-- €3000.00 and €1700.00 of it was already paid. `invoices.paid_on` alone
-- cannot say that — it is all-or-nothing — so a payment is now a row, and an
-- invoice is settled when its payments cover its total.
--
-- ADDITIVE ONLY. Unlike 0005 this migration never drops a finance table:
-- `invoices`, `invoice_lines` and `clients` now hold the real running invoice.
-- Everything here is CREATE, ALTER ... ADD COLUMN, or an index swap.

-- A payment against an invoice. Several per invoice (a prepayment and the
-- balance, or instalments); amounts are integer cents and always positive —
-- a refund is not a negative payment and will get its own shape if it is ever
-- needed. `label` is what the owner calls it on the invoice ("Prepayment
-- website (50%) ..."), `method` is optional and free text (bank, Wise, cash).
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_on      TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  method       TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_by_invoice ON payments(invoice_id, paid_on);

-- `kind`: a prepayment invoice asks for part of a larger project now. It is
-- not a different document — same numbering, same lifecycle — so it is a
-- column, not a table. `request_cents` is the amount asked for now; NULL means
-- the whole total, which is every ordinary invoice.
--
-- What is OWED on a prepayment is `request_cents` minus its payments, never
-- `total_cents` minus them: on 5.R.A.L.01 the remaining €1300.00 is part 2,
-- which has not been asked for yet. It is neither outstanding nor overdue; it
-- is reported on its own as "not yet invoiced".
ALTER TABLE invoices ADD COLUMN kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','prepayment'));
ALTER TABLE invoices ADD COLUMN request_cents INTEGER;

-- Part 2 becomes its own invoice, pointing back at the prepayment it
-- completes, so the print can say "Part 2 of <subject> · part 1 (5.R.A.L.01)
-- paid €1700.00" and so the parent stops reporting that money as not yet
-- invoiced once the child is issued.
ALTER TABLE invoices ADD COLUMN parent_id INTEGER REFERENCES invoices(id);
CREATE INDEX IF NOT EXISTS invoices_by_parent ON invoices(parent_id);

-- One running counter, not one per year. `5.R.A.L.01` is global sequence 5;
-- the trailing pair counts that client's invoices and is NOT a year (addendum
-- 4 replaces addendum 2 here). The old partial unique index was on
-- (year, seq), which would let the counter restart every January — exactly
-- what the real numbering does not do. `year` stays filled, but it no longer
-- takes part in the uniqueness.
DROP INDEX IF EXISTS invoices_seq_per_year;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_seq_unique ON invoices(seq) WHERE seq IS NOT NULL;
