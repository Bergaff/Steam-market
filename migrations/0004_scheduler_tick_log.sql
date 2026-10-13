-- Compact scheduler summaries retained for browser diagnostics (seven days).
CREATE TABLE IF NOT EXISTS scheduler_tick_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  skipped        TEXT,
  steam_requests INTEGER NOT NULL DEFAULT 0,
  steam_errors   INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  summary_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduler_tick_log_started ON scheduler_tick_log(started_at DESC);
