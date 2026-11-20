-- 0031: what the reports count by (audit E18, F4, F9; 14 Nov).
-- 1. A send's batch and template as fields, not only inside free text, so the
--    funnel can group by them. Back-filled from the text every send log wrote:
--    « batch <b> · template <t> · to <e> · message <m> » (parts after the batch optional).
ALTER TABLE lead_events ADD COLUMN batch TEXT;
ALTER TABLE lead_events ADD COLUMN template TEXT;

UPDATE lead_events
SET batch = TRIM(CASE WHEN instr(substr(detail, 7), ' · ') > 0
                      THEN substr(substr(detail, 7), 1, instr(substr(detail, 7), ' · ') - 1)
                      ELSE substr(detail, 7) END)
WHERE kind = 'sent' AND detail LIKE 'batch %' AND batch IS NULL;

UPDATE lead_events
SET template = TRIM(CASE WHEN instr(substr(detail, instr(detail, ' · template ') + 12), ' · ') > 0
                         THEN substr(substr(detail, instr(detail, ' · template ') + 12), 1,
                                     instr(substr(detail, instr(detail, ' · template ') + 12), ' · ') - 1)
                         ELSE substr(detail, instr(detail, ' · template ') + 12) END)
WHERE kind = 'sent' AND instr(detail, ' · template ') > 0 AND template IS NULL;

CREATE INDEX IF NOT EXISTS lead_events_sent_batch ON lead_events(kind, batch);
CREATE INDEX IF NOT EXISTS lead_events_sent_template ON lead_events(kind, template);

-- 2. What a deal is worth, so the pipeline has a value (F4). NULL: not known yet.
ALTER TABLE prospects ADD COLUMN value_cents INTEGER CHECK (value_cents IS NULL OR value_cents >= 0);
