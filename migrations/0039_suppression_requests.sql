-- Additive. One audit line per suppression request filed through the intake door
-- (kind 'suppression'), so addresses are never suppressed by hand-written SQL again.
-- intake_requests keeps its own kinds (its CHECK cannot change without a rebuild).
CREATE TABLE suppression_requests (
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  emails INTEGER NOT NULL CHECK(emails >= 1),
  suppressed INTEGER NOT NULL CHECK(suppressed >= 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY (source, idempotency_key)
);
