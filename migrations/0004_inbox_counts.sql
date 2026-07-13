-- Last successfully observed Inbox item count. NULL means the count has not been fetched.
ALTER TABLE accounts ADD COLUMN inbox_total INTEGER;
ALTER TABLE accounts ADD COLUMN inbox_count_updated_at TEXT;
