-- 0032: the address a send went to (NIRMATA, 14 Nov). A lead's email can change after it was
-- written to (Fabré, Vandevoort: written at a personal address on 30 Sep, given the clinic inbox
-- on 14 Nov), and a follow-up must then not go to an inbox that never saw the first letter.
-- Additive and nullable. Filled from now on by the intake send log and the HQ pop-up.
ALTER TABLE lead_events ADD COLUMN sent_to TEXT;

-- Send logs that carried the address in their text: « batch <b> · … · to <e> · message <m> ».
UPDATE lead_events
SET sent_to = lower(trim(CASE WHEN instr(substr(detail, instr(detail, ' · to ') + 6), ' · ') > 0
                              THEN substr(substr(detail, instr(detail, ' · to ') + 6), 1,
                                          instr(substr(detail, instr(detail, ' · to ') + 6), ' · ') - 1)
                              ELSE substr(detail, instr(detail, ' · to ') + 6) END))
WHERE kind = 'sent' AND sent_to IS NULL AND instr(detail, ' · to ') > 0;
