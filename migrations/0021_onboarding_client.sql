-- 0021: an onboarding for a CLIENT, not only a prospect (Andy, 23 Oct:
-- « Alexis is not a prospect but a client, I have been working with him for
-- 3 years »).
--
-- The questionnaire, its answers, its received times and its link live on the
-- `prospects` row. The smallest change: that row may name the client it is
-- for. Linked to a client, it leaves the Prospects pipeline and shows on the
-- client's project page; its link and answers stay exactly where they are, so
-- a link already sent keeps working. Unlinking puts it back. Additive.

ALTER TABLE prospects ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prospects_client ON prospects(client_id);
