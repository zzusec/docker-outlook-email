import type { AccountRow } from './types';
import { batchRun } from './db';
import {
  fetchEmails,
  getMailAccessToken,
  getInboxTotal,
  isPermanentTokenFailure,
  type GraphError,
} from './graph';

// How many accounts are probed in parallel. Each probe is 2-4 upstream calls,
// so this is deliberately modest to stay clear of Microsoft throttling.
export const PROBE_CONCURRENCY = 4;

export type ProbeStage = 'token' | 'mail' | 'not_found';

export interface AccountProbeResult {
  id: number;
  email: string;
  exists: boolean;
  connected: boolean;
  status?: 'active' | 'error';
  stage?: ProbeStage;
  error?: GraphError;
  count_error?: GraphError;
  inbox: { total: number | null; checked_at: string | null };
  newRefreshToken?: string;
  shouldUpdateInbox?: boolean;
}

export function publicProbeResult(result: AccountProbeResult) {
  return {
    id: result.id,
    email: result.email,
    exists: result.exists,
    connected: result.connected,
    ...(result.status ? { status: result.status } : {}),
    ...(result.stage ? { stage: result.stage } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.count_error ? { count_error: result.count_error } : {}),
    inbox: result.inbox,
  };
}

export async function probeAccount(acc: AccountRow): Promise<AccountProbeResult> {
  const inbox = {
    total: acc.inbox_total ?? null,
    checked_at: acc.inbox_count_updated_at ?? null,
  };
  const tokenResult = await getMailAccessToken(acc.client_id, acc.refresh_token);

  if (!tokenResult.token) {
    return {
      id: acc.id,
      email: acc.email,
      exists: true,
      connected: false,
      status: 'error',
      stage: 'token',
      error: tokenResult.error ?? { code: 'TOKEN_FAILED', message: 'Token acquisition failed' },
      inbox,
    };
  }

  // A refresh grant can succeed even when the app has no usable Graph Mail access.
  const mailResult = await fetchEmails(tokenResult.token, { folder: 'inbox', top: 1, skip: 0 });
  if (mailResult.error) {
    return {
      id: acc.id,
      email: acc.email,
      exists: true,
      connected: false,
      status: 'error',
      stage: 'mail',
      error: mailResult.error,
      inbox,
      newRefreshToken: tokenResult.newRefreshToken,
    };
  }

  const countResult = await getInboxTotal(tokenResult.token);
  if (countResult.error || countResult.total === undefined) {
    return {
      id: acc.id,
      email: acc.email,
      exists: true,
      connected: true,
      status: 'active',
      count_error: countResult.error ?? { code: 'GRAPH_ERROR', message: 'Inbox count unavailable' },
      inbox,
      newRefreshToken: tokenResult.newRefreshToken,
    };
  }

  return {
    id: acc.id,
    email: acc.email,
    exists: true,
    connected: true,
    status: 'active',
    inbox: { total: countResult.total, checked_at: new Date().toISOString() },
    newRefreshToken: tokenResult.newRefreshToken,
    shouldUpdateInbox: true,
  };
}

function probeUpdateStatement(acc: AccountRow, result: AccountProbeResult) {
  const assignments: string[] = [];
  const params: unknown[] = [];

  if (result.newRefreshToken && result.newRefreshToken !== acc.refresh_token) {
    assignments.push('refresh_token = ?');
    params.push(result.newRefreshToken);
  }
  assignments.push('status = ?', 'updated_at = CURRENT_TIMESTAMP');
  params.push(result.status);
  if (result.shouldUpdateInbox) {
    assignments.push('inbox_total = ?', 'inbox_count_updated_at = ?');
    params.push(result.inbox.total, result.inbox.checked_at);
  }
  params.push(acc.id);

  return {
    sql: `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  };
}

// Persist a probe round. Accounts whose refresh token failed permanently are
// deleted (when enabled) instead of being parked in "error" forever; the ids of
// the removed accounts are returned so the caller can report them.
export async function persistProbeResults(
  db: D1Database,
  probes: Array<{ account: AccountRow; result: AccountProbeResult }>,
  deleteInvalid: boolean
): Promise<number[]> {
  const deletedIds = probes
    .filter(({ result }) => deleteInvalid && result.stage === 'token' && isPermanentTokenFailure(result.error))
    .map(({ account }) => account.id);
  const dead = new Set(deletedIds);

  const statements = probes
    .filter(({ account }) => !dead.has(account.id))
    .map(({ account, result }) => probeUpdateStatement(account, result));
  for (const id of deletedIds) {
    statements.push({ sql: 'DELETE FROM account_tags WHERE account_id = ?', params: [id] });
    statements.push({ sql: 'DELETE FROM accounts WHERE id = ?', params: [id] });
  }
  await batchRun(db, statements);
  return deletedIds;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}
