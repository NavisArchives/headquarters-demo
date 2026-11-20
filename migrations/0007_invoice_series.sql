-- The numbering, as the owner states it finally (2026-09-21).
--
--   <n>.R.A.<client letters>.<NN>
--
--   n   the invoice's number WITHIN ITS YEAR and within its series
--   R   Realis
--   A   Andy — fixed, part of the format, never the client's letter
--   <client letters>  the client's initials: Aubin is `L`, Lumen `SC`
--   NN  that client's running index, all time, across every series
--
-- 0006 established ONE counter running over every invoice ever issued, on the
-- reading that the real numbering does not restart in January. The owner has
-- now corrected that twice over: the counter is per year, AND the series
-- itself starts over. 5.R.A.L.01 was issued as *Realis Agency*; from here the
-- issuer is *Realis Studio* and its first invoice is number 1. Without a
-- series the two would collide the moment a studio invoice reached 5 in 2026.
--
-- ADDITIVE ONLY: one ADD COLUMN and one index swap. No table is dropped and
-- no row is rewritten — the one row that must change series is data, and it
-- is carried by
-- .superpowers/sdd/2026-09-20-hq-dashboard/series-remote.sql, applied once
-- per database, so this file stays a schema change and nothing else.

-- 'agency' is the closed Realis Agency series (5.R.A.L.01 alone). 'studio' is
-- the live one and is the default, so every invoice issued from now belongs
-- to it without anything having to say so.
ALTER TABLE invoices ADD COLUMN series TEXT NOT NULL DEFAULT 'studio';

-- Uniqueness is per (series, year): 1.R.A.L.02 in the studio series of 2026
-- and a hypothetical agency 1 do not collide, and the counter restarts in
-- January as the owner's numbering does.
DROP INDEX IF EXISTS invoices_seq_unique;
DROP INDEX IF EXISTS invoices_seq_per_year;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_series_year_seq
  ON invoices(series, year, seq) WHERE seq IS NOT NULL;
