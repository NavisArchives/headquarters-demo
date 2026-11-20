-- 0020: when each onboarding answer came in, and from whom (22 Oct, phone
-- questionnaire). The client now answers on his own phone; Andy's prospect
-- page shows « reçu le … » per answer.
--
-- One JSON object beside `onboarding`, merged the same way (json_patch):
-- { "<answer key>": { "at": "<ISO time>", "by": "client" | "andy" } }.
-- A cleared answer clears its entry. Additive: older code never reads it.

ALTER TABLE prospects ADD COLUMN onboarding_meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(onboarding_meta) AND json_type(onboarding_meta) = 'object');
