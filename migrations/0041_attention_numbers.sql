-- Every « needs your attention » item gets a short number the first time it shows up
-- (N-14), kept for good: it never shifts when other items are resolved, so Andy can
-- say « 14 is done » by voice (Andy, 20 Nov). Additive only.
CREATE TABLE IF NOT EXISTS attention_numbers (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
