-- 0028: an overdue invoice Andy has chased can be put aside for a few days
-- (audit B7, 14 Nov). Until this date it leaves Home's « Chase » list; it stays
-- overdue everywhere else. NULL means not snoozed.
ALTER TABLE invoices ADD COLUMN chase_snoozed_until TEXT;
