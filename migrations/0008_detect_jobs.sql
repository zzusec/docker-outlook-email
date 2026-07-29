-- Background detection jobs: probe every account in a scope (group / status / tag)
-- without the browser having to stay open. One row per job; the runner walks the
-- account list by ascending id (cursor), so deletions during the run are harmless.
CREATE TABLE IF NOT EXISTS detect_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_group_id INTEGER,
  scope_status TEXT,
  scope_tag_id INTEGER,
  scope_label TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  connected INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  -- running | stopping | stopped | done
  state TEXT NOT NULL DEFAULT 'running',
  last_email TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_detect_jobs_state ON detect_jobs(state);
