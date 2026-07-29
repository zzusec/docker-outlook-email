-- Background jobs now cover two kinds of work:
--   detect  - full probe (token + mail access + Inbox count)
--   refresh - token refresh only, for a hand-picked selection
-- scope_ids holds the explicit account id list (JSON array) for selection-based
-- jobs; when it is set, cursor_id counts how many of those ids are already done.
ALTER TABLE detect_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'detect';
ALTER TABLE detect_jobs ADD COLUMN scope_ids TEXT NOT NULL DEFAULT '';
