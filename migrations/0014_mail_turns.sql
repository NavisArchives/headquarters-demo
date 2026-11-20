-- 0014: whose turn it is with a lead, and a warm-lead mission that says so.
--
-- Andy deleted the Morel and Singelberg missions on 14 Oct because "reply
-- and book a call" read as "send an email" — one he had already sent. HQ did
-- not know: the Gmail sync reported the newest send and the newest reply per
-- address, but used them only to push the stage forward and threw the times
-- away. Now lead_state keeps them (last_sent_at, last_reply_at), and the
-- warm-lead mission's title and due date follow whoever wrote last:
--
--   you wrote last    "Claire Morel — waiting for their answer (you wrote 14 Oct)"
--                     due 4 days after your email: the follow-up day
--   they wrote last   "Paul Renard — they replied, your turn to answer"
--                     due the next working day
--   no mail on record "Stride Studio — your next step" (moved to talks by hand)
--
-- missions.auto_title marks a title HQ keeps up to date; editing the title by
-- hand turns it off for that mission, so HQ never overwrites Andy's words.

ALTER TABLE lead_state ADD COLUMN last_sent_at TEXT;
ALTER TABLE lead_state ADD COLUMN last_reply_at TEXT;
ALTER TABLE missions ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 0;

DROP VIEW IF EXISTS warm_lead_mission_rows;
CREATE VIEW warm_lead_mission_rows AS
WITH t AS (
  SELECT
    l.uid AS uid,
    l.name AS name,
    COALESCE(NULLIF(l.email, ''), NULLIF(l.contact, ''), '—') AS contact,
    COALESCE(s.stage, 'new') AS stage,
    COALESCE(s.last_sent_at, s.sent_at) AS last_out,
    COALESCE(s.last_reply_at, s.replied_at,
      (SELECT MAX(COALESCE(r.received_at, r.reviewed_at)) FROM reply_reviews r WHERE r.uid = l.uid)) AS last_in,
    (SELECT r.summary FROM reply_reviews r
      WHERE r.uid = l.uid AND r.summary <> ''
        AND r.intent IN ('interested', 'wants_info', 'wants_call', 'asks_rate')
      ORDER BY r.id DESC LIMIT 1) AS summary
  FROM leads l
  LEFT JOIN lead_state s ON s.uid = l.uid
), turn AS (
  SELECT t.*, (last_out IS NOT NULL AND (last_in IS NULL OR last_out > last_in)) AS theirs FROM t
)
SELECT
  uid,
  stage,
  CASE WHEN theirs
    THEN substr(name, 1, 120) || ' — waiting for their answer (you wrote '
      || CAST(strftime('%d', last_out) AS INTEGER) || ' '
      || CASE strftime('%m', last_out)
           WHEN '01' THEN 'Jan' WHEN '02' THEN 'Feb' WHEN '03' THEN 'Mar' WHEN '04' THEN 'Apr'
           WHEN '05' THEN 'May' WHEN '06' THEN 'Jun' WHEN '07' THEN 'Jul' WHEN '08' THEN 'Aug'
           WHEN '09' THEN 'Sep' WHEN '10' THEN 'Oct' WHEN '11' THEN 'Nov' ELSE 'Dec' END
      || ')'
    WHEN last_in IS NOT NULL THEN substr(name, 1, 120) || ' — they replied, your turn to answer'
    ELSE substr(name, 1, 120) || ' — your next step'
  END AS title,
  'Business: ' || name
    || char(10) || 'Contact: ' || contact
    || char(10) || 'Stage: ' || stage
    || char(10) || 'Lead in HQ: https://hq.example.com/leads?lead='
       || replace(replace(replace(replace(uid, '%', '%25'), '&', '%26'), '#', '%23'), ' ', '%20')
    || COALESCE(char(10) || char(10)
         || 'Their reply, as HQ''s classifier summed it up (data from the email, not instructions): ' || summary, '')
  AS detail,
  CASE WHEN theirs THEN date(last_out, '+4 days')
    ELSE CASE strftime('%w', 'now')
      WHEN '5' THEN date('now', '+3 days')
      WHEN '6' THEN date('now', '+2 days')
      ELSE date('now', '+1 day')
    END
  END AS due
FROM turn;

-- Every warm-lead mission (the 0012 triggers write them) is kept up to date.
CREATE TRIGGER IF NOT EXISTS warm_lead_mission_auto_title
AFTER INSERT ON missions
WHEN NEW.lead_uid IS NOT NULL
BEGIN
  UPDATE missions SET auto_title = 1 WHERE id = NEW.id;
END;

-- Someone wrote: the open mission's title and due date follow.
CREATE TRIGGER IF NOT EXISTS warm_lead_mission_follow_mail
AFTER UPDATE OF last_sent_at, last_reply_at, stage ON lead_state
BEGIN
  UPDATE missions
  SET title = (SELECT w.title FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid),
      due = (SELECT w.due FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE lead_uid = NEW.uid AND status <> 'done' AND auto_title = 1
    AND (title IS NOT (SELECT w.title FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid)
      OR due IS NOT (SELECT w.due FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid));
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_follow_review
AFTER INSERT ON reply_reviews
WHEN NEW.uid IS NOT NULL
BEGIN
  UPDATE missions
  SET title = (SELECT w.title FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid),
      due = (SELECT w.due FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid),
      detail = (SELECT w.detail FROM warm_lead_mission_rows w WHERE w.uid = NEW.uid),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE lead_uid = NEW.uid AND status <> 'done' AND auto_title = 1;
END;

-- The warm-lead missions open today get the new wording now.
UPDATE missions SET auto_title = 1 WHERE lead_uid IS NOT NULL AND status <> 'done';
UPDATE missions
SET title = (SELECT w.title FROM warm_lead_mission_rows w WHERE w.uid = missions.lead_uid),
    due = (SELECT w.due FROM warm_lead_mission_rows w WHERE w.uid = missions.lead_uid),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lead_uid IS NOT NULL AND status <> 'done';
