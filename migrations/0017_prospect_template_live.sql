-- 0017: which questionnaire a prospect gets, and the live mirror of it.
--
-- NIRMATA, 18 Oct (for the Fontaine call, 20 Oct): a short "Site web (léger)"
-- questionnaire next to the full one, and a read-only public page the client
-- can follow on his own screen during a video call: /live/<token>.
--
-- `template` picks the questionnaire ('full' is the one every prospect had).
-- `live_token` is the secret in the mirror's address; `live_expires_at` ends
-- it after 7 days. Revoking clears both. The mirror reads the same safe
-- fields the safe view reads (name, organisation, brand, entities, answers):
-- never the notes, the contact details or the stage.

ALTER TABLE prospects ADD COLUMN template TEXT NOT NULL DEFAULT 'full' CHECK (template IN ('full', 'light'));
ALTER TABLE prospects ADD COLUMN live_token TEXT;
ALTER TABLE prospects ADD COLUMN live_expires_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS prospects_live_token ON prospects(live_token) WHERE live_token IS NOT NULL;
