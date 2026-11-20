-- 0035: the subject a send actually carried (NIRMATA, 17 Nov). Until now a follow-up's subject
-- was rebuilt from the template in the lead's first language, and 34 of 155 surgeon closers came
-- out wrong (the 30 Sep letters went out in FR/NL). The real subject, logged with the send, is
-- the one a closer repeats (no « Re: », Andy 16 Nov). Additive and nullable; old sends stay NULL.
ALTER TABLE lead_events ADD COLUMN subject TEXT;
