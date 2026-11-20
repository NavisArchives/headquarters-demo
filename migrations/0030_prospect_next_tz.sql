-- 0030: a meeting's time says whose clock it is on (audit C14, M7, P5). Andy
-- works from Lima with Belgian clients, 6 hours apart; « 18:30 » alone was a
-- trap. NULL (every deal before this) is shown as before, without a zone.
ALTER TABLE prospects ADD COLUMN next_tz TEXT;
