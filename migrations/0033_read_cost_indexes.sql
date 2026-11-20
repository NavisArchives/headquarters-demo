-- 0033: read cost (14 Nov: the account hit D1's free daily row-read limit). Additive indexes only.
-- 1. The per-lead questions (« how many emails », « last one », « LinkedIn », « where did the first
--    go ») ask lead_events by uid AND kind. With only (uid, at) and (kind, batch) the planner took
--    (kind, batch) and read every « sent » event of HQ once per lead: 1.5 M rows for one list.
CREATE INDEX IF NOT EXISTS lead_events_by_uid_kind ON lead_events(uid, kind, at);
-- 2. One letter per inbox: leads sharing an address are found by the address, not by a table scan.
CREATE INDEX IF NOT EXISTS leads_by_email ON leads(lower(trim(email)));
