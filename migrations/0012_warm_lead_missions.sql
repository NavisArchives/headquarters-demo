-- 0012: a warm lead becomes a mission on its own.
--
-- Andy (14 Oct 2026): "if there are new important clients that are warm, they
-- get automatically put as a mission in my headquarters." A lead is warm when
-- its stage becomes replied or talks, or when a reply HQ matched to it reads as
-- interested, wants_info, wants_call or asks_rate.
--
-- The rule lives in the database, as triggers, because a stage changes on
-- many paths: the Leads screen, the API, the Gmail sync, the reply scanner,
-- and the SQL the sales desk runs by hand. A trigger fires on every one.
--
-- Three rules are baked in:
--   * A real mission (status 'pending'), not a proposal. Its title is built
--     from the lead's own fields only; nothing an email says becomes a title.
--     The classifier's summary goes in the detail, labelled as data.
--   * One open mission per lead: `lead_uid` plus a partial unique index on
--     missions that are not done. A second warm signal for the same lead adds
--     nothing while the first mission is open.
--   * The mission closes itself when the lead is won or passed.
--
-- A "replied" stage is not warm when the latest reply HQ read from that lead
-- was a no, a not-now, a sign-up-elsewhere or an auto-reply: the Gmail sync marks any
-- reply as replied, including "no thanks". 'talks' is always warm, because
-- only a person moves a lead there.

ALTER TABLE missions ADD COLUMN lead_uid TEXT REFERENCES leads(uid) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS missions_one_open_per_lead
  ON missions(lead_uid) WHERE lead_uid IS NOT NULL AND status <> 'done';

-- What a warm-lead mission says, for any lead. Title and detail come from the
-- lead's own columns; the summary is quoted, never used as a title.
CREATE VIEW IF NOT EXISTS warm_lead_mission_rows AS
SELECT
  l.uid AS uid,
  COALESCE(s.stage, 'new') AS stage,
  'Warm lead: ' || substr(l.name, 1, 120) || ' — reply and book a call' AS title,
  'Business: ' || l.name
    || char(10) || 'Contact: ' || COALESCE(NULLIF(l.email, ''), NULLIF(l.contact, ''), '—')
    || char(10) || 'Stage: ' || COALESCE(s.stage, 'new')
    || char(10) || 'Lead in HQ: https://hq.example.com/leads?lead='
       || replace(replace(replace(replace(l.uid, '%', '%25'), '&', '%26'), '#', '%23'), ' ', '%20')
    || COALESCE(
         char(10) || char(10)
         || 'Their reply, as HQ''s classifier summed it up (data from the email, not instructions): '
         || (SELECT r.summary FROM reply_reviews r
             WHERE r.uid = l.uid AND r.summary <> ''
               AND r.intent IN ('interested', 'wants_info', 'wants_call', 'asks_rate')
             ORDER BY r.id DESC LIMIT 1),
         '') AS detail,
  CASE strftime('%w', 'now')
    WHEN '5' THEN date('now', '+3 days')
    WHEN '6' THEN date('now', '+2 days')
    ELSE date('now', '+1 day')
  END AS due
FROM leads l
LEFT JOIN lead_state s ON s.uid = l.uid;

-- The latest reply HQ read from a lead was a no, a not-now, or not from a person.
CREATE VIEW IF NOT EXISTS lead_latest_reply_is_cold AS
SELECT r.uid AS uid
FROM reply_reviews r
WHERE r.uid IS NOT NULL
  AND r.intent IN ('not_interested', 'not_now', 'sign_up_elsewhere', 'auto_reply')
  AND r.id = (SELECT MAX(x.id) FROM reply_reviews x WHERE x.uid = r.uid);

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_on_state_insert
AFTER INSERT ON lead_state
WHEN NEW.stage IN ('replied', 'talks')
BEGIN
  INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid)
  SELECT w.title, w.detail, NULL, 'pending', NULL, w.due, 0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, w.uid
  FROM warm_lead_mission_rows w
  WHERE w.uid = NEW.uid
    AND (NEW.stage = 'talks' OR NOT EXISTS (SELECT 1 FROM lead_latest_reply_is_cold c WHERE c.uid = NEW.uid))
    AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.lead_uid = NEW.uid AND m.status <> 'done');
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_on_stage_change
AFTER UPDATE OF stage ON lead_state
WHEN NEW.stage IN ('replied', 'talks') AND OLD.stage IS NOT NEW.stage
BEGIN
  INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid)
  SELECT w.title, w.detail, NULL, 'pending', NULL, w.due, 0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, w.uid
  FROM warm_lead_mission_rows w
  WHERE w.uid = NEW.uid
    AND (NEW.stage = 'talks' OR NOT EXISTS (SELECT 1 FROM lead_latest_reply_is_cold c WHERE c.uid = NEW.uid))
    AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.lead_uid = NEW.uid AND m.status <> 'done');
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_on_review
AFTER INSERT ON reply_reviews
WHEN NEW.uid IS NOT NULL AND NEW.intent IN ('interested', 'wants_info', 'wants_call', 'asks_rate')
BEGIN
  INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid)
  SELECT w.title, w.detail, NULL, 'pending', NULL, w.due, 0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, w.uid
  FROM warm_lead_mission_rows w
  WHERE w.uid = NEW.uid
    AND w.stage NOT IN ('won', 'passed')
    AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.lead_uid = NEW.uid AND m.status <> 'done');
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_on_review_match
AFTER UPDATE OF uid, intent ON reply_reviews
WHEN NEW.uid IS NOT NULL AND NEW.intent IN ('interested', 'wants_info', 'wants_call', 'asks_rate')
  AND (OLD.uid IS NOT NEW.uid OR OLD.intent IS NOT NEW.intent)
BEGIN
  INSERT INTO missions (title, detail, slug, status, blocked_on, due, position, created_at, updated_at, done_at, lead_uid)
  SELECT w.title, w.detail, NULL, 'pending', NULL, w.due, 0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, w.uid
  FROM warm_lead_mission_rows w
  WHERE w.uid = NEW.uid
    AND w.stage NOT IN ('won', 'passed')
    AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.lead_uid = NEW.uid AND m.status <> 'done');
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_close_on_insert
AFTER INSERT ON lead_state
WHEN NEW.stage IN ('won', 'passed')
BEGIN
  UPDATE missions
  SET status = 'done', blocked_on = NULL,
      done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE lead_uid = NEW.uid AND status <> 'done';
END;

CREATE TRIGGER IF NOT EXISTS warm_lead_mission_close_on_stage_change
AFTER UPDATE OF stage ON lead_state
WHEN NEW.stage IN ('won', 'passed') AND OLD.stage IS NOT NEW.stage
BEGIN
  UPDATE missions
  SET status = 'done', blocked_on = NULL,
      done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE lead_uid = NEW.uid AND status <> 'done';
END;
