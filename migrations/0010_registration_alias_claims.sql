-- Durable registration mailbox allocation ledger.
-- Rows are never deleted or recycled: released and expired alias indices stay burned.
CREATE TABLE IF NOT EXISTS registration_alias_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  mailbox_email TEXT NOT NULL,
  alias_index INTEGER NOT NULL CHECK (alias_index >= 0),
  recipient TEXT NOT NULL COLLATE NOCASE,
  claim_token_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'completed', 'released', 'expired')),
  lease_expires_at INTEGER NOT NULL,
  hard_expires_at INTEGER NOT NULL,
  finalization_reason TEXT NOT NULL DEFAULT '',
  finalized_at INTEGER,
  consumed_message_id TEXT,
  consumed_message_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (account_id, alias_index),
  UNIQUE (recipient),
  UNIQUE (claim_token_hash),
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_registration_claims_state_lease
  ON registration_alias_claims (state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_registration_claims_account_created
  ON registration_alias_claims (account_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_claims_consumed_message
  ON registration_alias_claims (mailbox_email, consumed_message_id)
  WHERE consumed_message_id IS NOT NULL;

-- Short-lived cross-request lock preventing concurrent Microsoft refresh-token
-- rotations for the same physical mailbox. Expired lock rows are stealable.
CREATE TABLE IF NOT EXISTS registration_mailbox_locks (
  mailbox_email TEXT PRIMARY KEY COLLATE NOCASE,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
