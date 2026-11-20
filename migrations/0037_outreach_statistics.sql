-- Small projections avoid scanning the send ledger every minute on the cockpit.
CREATE TABLE outreach_stat_hours (
  hour_utc TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK(n>=0)
);
CREATE TABLE outreach_stat_totals (
  id INTEGER PRIMARY KEY CHECK(id=1),
  sent_events INTEGER NOT NULL DEFAULT 0,
  identified INTEGER NOT NULL DEFAULT 0,
  exact_content INTEGER NOT NULL DEFAULT 0
);
INSERT INTO outreach_stat_hours SELECT substr(at,1,13)||':00:00Z',COUNT(*) FROM lead_events WHERE kind='sent' GROUP BY substr(at,1,13);
INSERT INTO outreach_stat_totals SELECT 1,COUNT(*),COALESCE(SUM(message_key IS NOT NULL),0),
  COALESCE(SUM(subject IS NOT NULL AND sender IS NOT NULL AND body IS NOT NULL),0) FROM lead_events WHERE kind='sent';
CREATE TRIGGER outreach_stats_insert AFTER INSERT ON lead_events WHEN NEW.kind='sent'
BEGIN
  INSERT INTO outreach_stat_hours(hour_utc,n) VALUES(substr(NEW.at,1,13)||':00:00Z',1)
    ON CONFLICT(hour_utc) DO UPDATE SET n=n+1;
  UPDATE outreach_stat_totals SET sent_events=sent_events+1,identified=identified+(NEW.message_key IS NOT NULL),
    exact_content=exact_content+(NEW.subject IS NOT NULL AND NEW.sender IS NOT NULL AND NEW.body IS NOT NULL) WHERE id=1;
END;
CREATE TRIGGER outreach_stats_delete AFTER DELETE ON lead_events WHEN OLD.kind='sent'
BEGIN
  UPDATE outreach_stat_hours SET n=n-1 WHERE hour_utc=substr(OLD.at,1,13)||':00:00Z';
  UPDATE outreach_stat_totals SET sent_events=sent_events-1,identified=identified-(OLD.message_key IS NOT NULL),
    exact_content=exact_content-(OLD.subject IS NOT NULL AND OLD.sender IS NOT NULL AND OLD.body IS NOT NULL) WHERE id=1;
END;
CREATE TRIGGER outreach_stats_update AFTER UPDATE ON lead_events
BEGIN
  UPDATE outreach_stat_hours SET n=n-1 WHERE OLD.kind='sent' AND hour_utc=substr(OLD.at,1,13)||':00:00Z';
  INSERT INTO outreach_stat_hours(hour_utc,n) SELECT substr(NEW.at,1,13)||':00:00Z',1 WHERE NEW.kind='sent'
    ON CONFLICT(hour_utc) DO UPDATE SET n=n+1;
  UPDATE outreach_stat_totals SET
    sent_events=sent_events-(OLD.kind='sent')+(NEW.kind='sent'),
    identified=identified-(OLD.kind='sent' AND OLD.message_key IS NOT NULL)+(NEW.kind='sent' AND NEW.message_key IS NOT NULL),
    exact_content=exact_content-(OLD.kind='sent' AND OLD.subject IS NOT NULL AND OLD.sender IS NOT NULL AND OLD.body IS NOT NULL)
      +(NEW.kind='sent' AND NEW.subject IS NOT NULL AND NEW.sender IS NOT NULL AND NEW.body IS NOT NULL) WHERE id=1;
END;
