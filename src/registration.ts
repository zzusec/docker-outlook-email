import { Hono } from 'hono';
import { batchRun, first, query, run } from './db';
import {
  fetchEmailDetail,
  fetchEmails,
  getMailAccessToken,
  isPermanentTokenFailure,
  type GraphError,
} from './graph';
import { fail, ok } from './response';
import type { AccountRow, Env, GraphMailMessage } from './types';
import { hashPassword, hmacSign } from './utils/crypto';

const SOFT_LEASE_MS = 30 * 60 * 1000;
const HARD_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MESSAGE_CLOCK_SKEW_MS = 2 * 60 * 1000;
const POLL_RETRY_SECONDS = 5;
const MAIL_TOP_PER_FOLDER = 20;
const MAILBOX_LOCK_MS = 5 * 60 * 1000;

const RELEASE_REASONS = new Set([
  'failed',
  'canceled',
  'timeout',
  'stopped',
  'proxy_failure',
  'registration_failure',
  'registration_failed',
  'durable_save_failed',
  'other',
]);

interface RegistrationClaimRow {
  id: number;
  account_id: number;
  mailbox_email: string;
  alias_index: number;
  recipient: string;
  claim_token_hash: string;
  client_id: string;
  idempotency_key: string;
  state: 'active' | 'completed' | 'released' | 'expired';
  lease_expires_at: number;
  hard_expires_at: number;
  finalization_reason: string;
  finalized_at: number | null;
  consumed_message_id: string | null;
  consumed_message_fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

interface RegistrationConfig {
  claimSecret: string;
  clients: Map<string, string>;
}

type RegistrationVariables = {
  registrationClientId: string;
  registrationClaimSecret: string;
};

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function parseRegistrationConfig(env: Env): RegistrationConfig | null | 'invalid' {
  const claimSecret = env.REGISTRATION_CLAIM_SECRET?.trim() || '';
  const clients = new Map<string, string>();

  const addClient = (clientId: string, apiKey: string | undefined): boolean => {
    const normalizedId = clientId.trim().toLowerCase();
    const key = apiKey?.trim() || '';
    if (!key) return true;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalizedId) || clients.has(normalizedId)) return false;
    clients.set(normalizedId, key);
    return true;
  };

  if (!addClient('kr', env.REGISTRATION_KR_API_KEY)) return 'invalid';
  if (!addClient('us2', env.REGISTRATION_US2_API_KEY)) return 'invalid';

  const raw = env.REGISTRATION_API_KEYS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return 'invalid';
      for (const [clientId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string' || !addClient(clientId, value)) return 'invalid';
      }
    } catch {
      return 'invalid';
    }
  }

  if (!claimSecret && clients.size === 0) return null;
  if (!claimSecret || clients.size === 0) return 'invalid';

  const uniqueKeys = new Set(clients.values());
  if (uniqueKeys.size !== clients.size) return 'invalid';
  return { claimSecret, clients };
}

async function authenticateRegistrationClient(
  env: Env,
  provided: string
): Promise<{ clientId: string; claimSecret: string } | Response> {
  const config = parseRegistrationConfig(env);
  if (config === null) {
    return fail('REGISTRATION_DISABLED', 'Registration mailbox service is disabled', 503);
  }
  if (config === 'invalid') {
    return fail('REGISTRATION_CONFIG_INVALID', 'Registration mailbox service configuration is invalid', 503);
  }
  if (!provided) return fail('UNAUTHORIZED', 'Registration API key is missing or invalid', 401);

  const providedHash = await hashPassword(provided);
  for (const [clientId, configuredKey] of config.clients) {
    const configuredHash = await hashPassword(configuredKey);
    if (constantTimeEqual(providedHash, configuredHash)) {
      return { clientId, claimSecret: config.claimSecret };
    }
  }
  return fail('UNAUTHORIZED', 'Registration API key is missing or invalid', 401);
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function claimResponse(row: RegistrationClaimRow, claim: string): Response {
  return ok({ claim, recipient: row.recipient, expires_at: iso(row.lease_expires_at) });
}

function logClaim(
  event: string,
  row: Pick<RegistrationClaimRow, 'id' | 'client_id' | 'account_id' | 'alias_index' | 'state'>,
  startedAt: number,
  details: { transition?: string; failure_category?: string } = {}
): void {
  console.log(JSON.stringify({
    event,
    claim_id: row.id,
    client_id: row.client_id,
    mailbox_id: row.account_id,
    alias_index: row.alias_index,
    state: row.state,
    transition: details.transition,
    latency_ms: Math.max(0, Date.now() - startedAt),
    failure_category: details.failure_category,
  }));
}

export async function reconcileExpiredRegistrationClaims(
  db: D1Database,
  now = Date.now()
): Promise<number> {
  const expired = await query<RegistrationClaimRow>(
    db,
    `UPDATE registration_alias_claims
     SET state = 'expired', finalization_reason = 'lease_expired', finalized_at = ?, updated_at = ?
     WHERE state = 'active' AND (lease_expires_at <= ? OR hard_expires_at <= ?)
     RETURNING *`,
    [now, now, now, now]
  );
  for (const row of expired) {
    logClaim('registration_claim_expired', row, now, { transition: 'active->expired' });
  }
  return expired.length;
}

async function acquireMailboxLock(
  db: D1Database,
  mailboxEmail: string,
  owner: string,
  now: number
): Promise<boolean> {
  const result = await query<{ owner: string }>(
    db,
    `INSERT INTO registration_mailbox_locks (mailbox_email, owner, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(mailbox_email) DO UPDATE SET
       owner = excluded.owner,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE registration_mailbox_locks.expires_at <= ?
     RETURNING owner`,
    [mailboxEmail, owner, now + MAILBOX_LOCK_MS, now, now]
  );
  return result[0]?.owner === owner;
}

async function releaseMailboxLock(db: D1Database, mailboxEmail: string, owner: string): Promise<void> {
  await run(
    db,
    'DELETE FROM registration_mailbox_locks WHERE mailbox_email = ? AND owner = ?',
    [mailboxEmail, owner]
  );
}

async function deriveClaimToken(clientId: string, idempotencyKey: string, claimSecret: string): Promise<string> {
  return hmacSign(JSON.stringify(['registration-claim-v1', clientId, idempotencyKey]), claimSecret);
}

async function findClaimByCredential(
  db: D1Database,
  clientId: string,
  claim: string
): Promise<RegistrationClaimRow | null> {
  if (!/^[a-f0-9]{64}$/.test(claim)) return null;
  const claimHash = await hashPassword(claim);
  const row = await first<RegistrationClaimRow>(
    db,
    'SELECT * FROM registration_alias_claims WHERE claim_token_hash = ?',
    [claimHash]
  );
  if (!row || row.client_id !== clientId) return null;
  return row;
}

function claimStateFailure(row: RegistrationClaimRow): Response {
  if (row.state === 'expired') return fail('CLAIM_EXPIRED', 'Registration claim expired', 410);
  return fail('CLAIM_TERMINAL', `Registration claim is already ${row.state}`, 409);
}

function registrationFailure(
  code: string,
  message: string,
  status: number,
  retryAfterSeconds?: number
): Response {
  const headers = retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined;
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers }
  );
}

function microsoftFailure(error?: GraphError, tokenFailure = false): Response {
  const code = error?.code?.toUpperCase() || '';
  if (code === 'RATE_LIMITED') {
    return registrationFailure('MICROSOFT_THROTTLED', 'Microsoft mail service is throttling requests', 503, 15);
  }
  if (code === 'NETWORK_ERROR' || code === 'GRAPH_ERROR') {
    return registrationFailure('MICROSOFT_UNAVAILABLE', 'Microsoft mail service is temporarily unavailable', 503, 10);
  }
  if (tokenFailure || code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return registrationFailure('TOKEN_FAILED', 'Mailbox authorization failed', 502);
  }
  return registrationFailure('MAILBOX_UNAVAILABLE', 'Mailbox is temporarily unavailable', 503, 10);
}

async function getRegistrationAccessToken(
  db: D1Database,
  account: AccountRow
): Promise<{ token: string } | { response: Response }> {
  const result = await getMailAccessToken(account.client_id, account.refresh_token);
  if (!result.token) {
    if (isPermanentTokenFailure(result.error)) {
      await run(
        db,
        "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [account.id]
      );
    }
    return { response: microsoftFailure(result.error, true) };
  }

  if (result.newRefreshToken && result.newRefreshToken !== account.refresh_token) {
    // Compare-and-swap prevents an older concurrent refresh from overwriting a
    // token already rotated and persisted by another request.
    await run(
      db,
      `UPDATE accounts
       SET refresh_token = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND refresh_token = ?`,
      [result.newRefreshToken, account.id, account.refresh_token]
    );
  }
  return { token: result.token };
}

export function extractRegistrationCodes(text: string): string[] {
  const codes = new Set<string>();
  if (!/验证码|verification|code|安全码|security|动态码|dynamic|校验码|check|确认码|confirmation|pin|密码|password|passcode/i.test(text)) {
    return [];
  }

  const patterns = [
    /\b([A-Z0-9]{3}-[A-Z0-9]{3})\b/gi,
    /(?:验证码|verification\s*code|code|验证码为|code\s*is|安全码|security\s*code|动态码|dynamic\s*code|校验码|check\s*code|确认码|confirmation\s*code|验证码[:：]\s*|Code[:：]\s*|PIN|密码|password|passcode)[\s:： ]*([A-Za-z0-9]{4,8})\b/gi,
    /\b(\d{4,8})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const code = match[1];
      if (!code || code.length < 4 || code.length > 8) continue;
      if (/^\d{4}$/.test(code) && (code.startsWith('20') || code.startsWith('19'))) continue;
      codes.add(code);
    }
  }
  return [...codes];
}

function addressesInHeader(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) || [];
}

export function messageHasExactRecipient(message: GraphMailMessage, recipient: string): boolean {
  const target = recipient.trim().toLowerCase();
  if (!target) return false;
  if (message.toRecipients.some((entry) => entry.emailAddress.address.trim().toLowerCase() === target)) {
    return true;
  }

  const acceptedHeaders = new Set(['x-original-to', 'delivered-to', 'envelope-to']);
  return (message.internetMessageHeaders || []).some((header) =>
    acceptedHeaders.has(header.name.trim().toLowerCase()) && addressesInHeader(header.value).includes(target)
  );
}

async function extractCodeFromMessage(accessToken: string, messageId: string): Promise<{
  code?: string;
  message?: GraphMailMessage;
  error?: GraphError;
}> {
  const detail = await fetchEmailDetail(accessToken, messageId);
  if (detail.error || !detail.item) return { error: detail.error || { code: 'NOT_FOUND', message: 'Message missing' } };
  const item = detail.item;
  const text = [item.subject, item.bodyPreview, item.body?.content || ''].join('\n');
  return { code: extractRegistrationCodes(text)[0], message: item };
}

async function codeForConsumedMessage(
  accessToken: string,
  row: RegistrationClaimRow
): Promise<Response> {
  const result = await extractCodeFromMessage(accessToken, row.consumed_message_id!);
  if (result.error) return microsoftFailure(result.error);
  if (!result.code) {
    return registrationFailure('MESSAGE_UNAVAILABLE', 'Previously matched verification message is unavailable', 503, 5);
  }
  return ok({ ready: true, code: result.code, expires_at: iso(row.lease_expires_at) });
}

const registration = new Hono<{ Bindings: Env; Variables: RegistrationVariables }>();

registration.use('*', async (c, next) => {
  const auth = await authenticateRegistrationClient(c.env, c.req.header('X-API-Key') || '');
  if (auth instanceof Response) return auth;
  c.set('registrationClientId', auth.clientId);
  c.set('registrationClaimSecret', auth.claimSecret);
  await next();
});

registration.post('/claims', async (c) => {
  const startedAt = Date.now();
  const clientId = c.get('registrationClientId');
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || '';
  if (!idempotencyKey || idempotencyKey.length > 200 || /[\r\n\0]/.test(idempotencyKey)) {
    return fail('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', 400);
  }

  const now = Date.now();
  await reconcileExpiredRegistrationClaims(c.env.DB, now);
  const claim = await deriveClaimToken(clientId, idempotencyKey, c.get('registrationClaimSecret'));
  const claimHash = await hashPassword(claim);

  const existing = await first<RegistrationClaimRow>(
    c.env.DB,
    'SELECT * FROM registration_alias_claims WHERE client_id = ? AND idempotency_key = ?',
    [clientId, idempotencyKey]
  );
  if (existing) {
    if (!constantTimeEqual(existing.claim_token_hash, claimHash)) {
      return fail('CLAIM_SECRET_CHANGED', 'Claim signing secret changed; restore the previous secret', 503);
    }
    logClaim('registration_claim_replayed', existing, startedAt);
    return claimResponse(existing, claim);
  }

  const leaseExpiresAt = now + SOFT_LEASE_MS;
  const hardExpiresAt = now + HARD_LIFETIME_MS;
  await batchRun<RegistrationClaimRow>(c.env.DB, [{
    sql: `WITH eligible AS (
       SELECT
         a.id AS account_id,
         lower(a.email) AS mailbox_email,
         COALESCE(COUNT(rc.id), 0) AS allocation_count,
         COALESCE(MAX(rc.created_at), 0) AS last_claim_at,
         CASE
           WHEN COALESCE(MAX(rc.alias_index), 0) < 1 THEN 1
           ELSE COALESCE(MAX(rc.alias_index), 0) + 1
         END AS alias_index
       FROM accounts a
       LEFT JOIN registration_alias_claims rc ON lower(rc.mailbox_email) = lower(a.email)
       WHERE a.status = 'active'
         AND trim(a.client_id) != ''
         AND trim(a.refresh_token) != ''
         AND instr(a.email, '@') > 1
       GROUP BY a.id, a.email
       ORDER BY allocation_count ASC, last_claim_at ASC, a.id ASC
       LIMIT 1
     )
     INSERT OR IGNORE INTO registration_alias_claims (
       account_id, mailbox_email, alias_index, recipient, claim_token_hash,
       client_id, idempotency_key, state, lease_expires_at, hard_expires_at,
       created_at, updated_at
     )
     SELECT
       account_id,
       mailbox_email,
       alias_index,
       CASE
         WHEN alias_index <= 0 THEN mailbox_email
         ELSE substr(mailbox_email, 1, instr(mailbox_email, '@') - 1)
              || '+' || alias_index || substr(mailbox_email, instr(mailbox_email, '@'))
       END,
       ?, ?, ?, 'active', ?, ?, ?, ?
     FROM eligible
     RETURNING *`,
    params: [claimHash, clientId, idempotencyKey, leaseExpiresAt, hardExpiresAt, now, now],
  }]);

  // Reading by the unique idempotency tuple also handles a concurrent replay
  // that won the INSERT race.
  const allocated = await first<RegistrationClaimRow>(
    c.env.DB,
    'SELECT * FROM registration_alias_claims WHERE client_id = ? AND idempotency_key = ?',
    [clientId, idempotencyKey]
  );
  if (!allocated) return fail('NO_ELIGIBLE_MAILBOX', 'No eligible registration mailbox is available', 503);
  if (!constantTimeEqual(allocated.claim_token_hash, claimHash)) {
    return fail('CLAIM_SECRET_CHANGED', 'Claim signing secret changed; restore the previous secret', 503);
  }

  logClaim('registration_claim_allocated', allocated, startedAt, { transition: 'none->active' });
  return claimResponse(allocated, claim);
});

registration.post('/code', async (c) => {
  const startedAt = Date.now();
  const body = (await c.req.json().catch(() => ({}))) as { claim?: unknown };
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) return fail('BAD_REQUEST', 'claim is required', 400);

  const now = Date.now();
  await reconcileExpiredRegistrationClaims(c.env.DB, now);
  let row = await findClaimByCredential(c.env.DB, c.get('registrationClientId'), claim);
  if (!row) return fail('CLAIM_NOT_FOUND', 'Registration claim was not found', 404);
  if (row.state !== 'active') return claimStateFailure(row);

  const renewed = await query<RegistrationClaimRow>(
    c.env.DB,
    `UPDATE registration_alias_claims
     SET lease_expires_at = MIN(hard_expires_at, ?), updated_at = ?
     WHERE id = ? AND state = 'active' AND lease_expires_at > ? AND hard_expires_at > ?
     RETURNING *`,
    [now + SOFT_LEASE_MS, now, row.id, now, now]
  );
  if (!renewed[0]) {
    await reconcileExpiredRegistrationClaims(c.env.DB, now);
    row = (await first<RegistrationClaimRow>(c.env.DB, 'SELECT * FROM registration_alias_claims WHERE id = ?', [row.id]))!;
    return claimStateFailure(row);
  }
  row = renewed[0];

  const lockOwner = `${row.id}:${crypto.randomUUID()}`;
  if (!(await acquireMailboxLock(c.env.DB, row.mailbox_email, lockOwner, now))) {
    logClaim('registration_code_not_ready', row, startedAt, { failure_category: 'mailbox_busy' });
    return ok({ ready: false, retry_after_seconds: 2, expires_at: iso(row.lease_expires_at) });
  }

  try {
  const account = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [row.account_id]);
  if (!account || account.status === 'disabled' || account.email.trim().toLowerCase() !== row.mailbox_email) {
    logClaim('registration_code_poll_failed', row, startedAt, { failure_category: 'mailbox_unavailable' });
    return fail('MAILBOX_UNAVAILABLE', 'Claimed mailbox is unavailable', 503);
  }

  const tokenResult = await getRegistrationAccessToken(c.env.DB, account);
  if ('response' in tokenResult) {
    logClaim('registration_code_poll_failed', row, startedAt, { failure_category: 'token_failure' });
    return tokenResult.response;
  }

  if (row.consumed_message_id) {
    const response = await codeForConsumedMessage(tokenResult.token, row);
    logClaim('registration_code_poll_replayed', row, startedAt);
    return response;
  }

  const [inbox, junk] = await Promise.all([
    fetchEmails(tokenResult.token, { folder: 'inbox', top: MAIL_TOP_PER_FOLDER, skip: 0 }),
    fetchEmails(tokenResult.token, { folder: 'junkemail', top: MAIL_TOP_PER_FOLDER, skip: 0 }),
  ]);
  if (inbox.error || junk.error) {
    const error = inbox.error || junk.error;
    logClaim('registration_code_poll_failed', row, startedAt, { failure_category: 'mail_fetch' });
    return microsoftFailure(error);
  }

  const consumed = await query<{ consumed_message_id: string }>(
    c.env.DB,
    `SELECT consumed_message_id FROM registration_alias_claims
     WHERE mailbox_email = ? AND consumed_message_id IS NOT NULL`,
    [row.mailbox_email]
  );
  const consumedIds = new Set(consumed.map((item) => item.consumed_message_id));
  const minimumReceivedAt = row.created_at - MESSAGE_CLOCK_SKEW_MS;
  const candidates = [...(inbox.items || []), ...(junk.items || [])]
    .filter((message) => {
      const receivedAt = Date.parse(message.receivedDateTime);
      return Number.isFinite(receivedAt) && receivedAt >= minimumReceivedAt && !consumedIds.has(message.id);
    })
    .sort((left, right) => right.receivedDateTime.localeCompare(left.receivedDateTime));

  for (const candidate of candidates) {
    const detail = await extractCodeFromMessage(tokenResult.token, candidate.id);
    if (detail.error) {
      if (detail.error.code === 'NOT_FOUND') continue;
      logClaim('registration_code_poll_failed', row, startedAt, { failure_category: 'message_fetch' });
      return microsoftFailure(detail.error);
    }
    if (!detail.message || !detail.code || !messageHasExactRecipient(detail.message, row.recipient)) continue;

    const fingerprint = await hashPassword(JSON.stringify([
      row.mailbox_email,
      detail.message.id,
      detail.message.receivedDateTime,
    ]));
    let claimed: RegistrationClaimRow[] = [];
    try {
      claimed = await query<RegistrationClaimRow>(
        c.env.DB,
        `UPDATE registration_alias_claims
         SET consumed_message_id = ?, consumed_message_fingerprint = ?, updated_at = ?
         WHERE id = ? AND state = 'active' AND consumed_message_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM registration_alias_claims other
             WHERE other.mailbox_email = ? AND other.consumed_message_id = ? AND other.id != ?
           )
         RETURNING *`,
        [detail.message.id, fingerprint, Date.now(), row.id, row.mailbox_email, detail.message.id, row.id]
      );
    } catch (error) {
      if (!/constraint|unique/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }

    if (claimed[0]) {
      logClaim('registration_code_matched', claimed[0], startedAt, { transition: 'active->active' });
      return ok({ ready: true, code: detail.code, expires_at: iso(claimed[0].lease_expires_at) });
    }

    const raced = await first<RegistrationClaimRow>(
      c.env.DB,
      'SELECT * FROM registration_alias_claims WHERE id = ?',
      [row.id]
    );
    if (raced?.consumed_message_id) {
      logClaim('registration_code_poll_replayed', raced, startedAt);
      return codeForConsumedMessage(tokenResult.token, raced);
    }
  }

  logClaim('registration_code_not_ready', row, startedAt);
  return ok({ ready: false, retry_after_seconds: POLL_RETRY_SECONDS, expires_at: iso(row.lease_expires_at) });
  } finally {
    try {
      await releaseMailboxLock(c.env.DB, row.mailbox_email, lockOwner);
    } catch {
      logClaim('registration_mailbox_lock_release_failed', row, startedAt, {
        failure_category: 'mailbox_lock_release',
      });
    }
  }
});

async function finalizeClaim(
  db: D1Database,
  clientId: string,
  claim: string,
  target: 'completed' | 'released',
  reason: string
): Promise<{ row?: RegistrationClaimRow; response?: Response; changed?: boolean }> {
  const now = Date.now();
  await reconcileExpiredRegistrationClaims(db, now);
  let row = await findClaimByCredential(db, clientId, claim);
  if (!row) return { response: fail('CLAIM_NOT_FOUND', 'Registration claim was not found', 404) };
  if (row.state === target) return { row, changed: false };
  if (row.state !== 'active') return { response: claimStateFailure(row) };

  const updated = await query<RegistrationClaimRow>(
    db,
    `UPDATE registration_alias_claims
     SET state = ?, finalization_reason = ?, finalized_at = ?, updated_at = ?
     WHERE id = ? AND state = 'active' AND lease_expires_at > ? AND hard_expires_at > ?
     RETURNING *`,
    [target, reason, now, now, row.id, now, now]
  );
  if (updated[0]) return { row: updated[0], changed: true };

  row = (await first<RegistrationClaimRow>(db, 'SELECT * FROM registration_alias_claims WHERE id = ?', [row.id]))!;
  if (row.state === target) return { row, changed: false };
  return { response: claimStateFailure(row) };
}

registration.post('/complete', async (c) => {
  const startedAt = Date.now();
  const body = (await c.req.json().catch(() => ({}))) as { claim?: unknown };
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) return fail('BAD_REQUEST', 'claim is required', 400);

  const result = await finalizeClaim(
    c.env.DB,
    c.get('registrationClientId'),
    claim,
    'completed',
    'registrar_committed'
  );
  if (result.response) return result.response;
  logClaim('registration_claim_completed', result.row!, startedAt, {
    transition: result.changed ? 'active->completed' : 'completed->completed',
  });
  return ok({ completed: true });
});

registration.post('/release', async (c) => {
  const startedAt = Date.now();
  const body = (await c.req.json().catch(() => ({}))) as { claim?: unknown; reason?: unknown };
  const claim = typeof body.claim === 'string' ? body.claim.trim() : '';
  if (!claim) return fail('BAD_REQUEST', 'claim is required', 400);
  const requestedReason = typeof body.reason === 'string' ? body.reason.trim().toLowerCase() : '';
  const reason = RELEASE_REASONS.has(requestedReason) ? requestedReason : 'other';

  const result = await finalizeClaim(c.env.DB, c.get('registrationClientId'), claim, 'released', reason);
  if (result.response) return result.response;
  logClaim('registration_claim_released', result.row!, startedAt, {
    transition: result.changed ? 'active->released' : 'released->released',
  });
  return ok({ released: true });
});

export default registration;
