-- 0029: a monthly charge starts when it starts (audit B10, 14 Nov). A care plan
-- begins at go-live, not on the day the quote was accepted; until now every
-- monthly line accrued from the order's start, so one added in November billed
-- back to September. NULL (every line before this) keeps the order's start.
ALTER TABLE order_lines ADD COLUMN starts_on TEXT;
