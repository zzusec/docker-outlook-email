// Background detection: probe every account in a scope (group / status / tag)
// without keeping a browser tab open. The job row holds the progress counters and
// an ascending-id cursor; a driver (Node interval, or the Workers cron trigger)
// repeatedly calls advanceDetectJob() to process one batch at a time.
import type { Env, AccountRow } from './types';
import { query, first, run, getSetting } from './db';
import { probeAccount, persistProbeResults, mapWithConcurrency, PROBE_CONCURRENCY } from './probe';

// Accounts per batch. Small batches keep the Workers subrequest budget in reach
// and let a stop request take effect quickly.
export const DETECT_BATCH = 10;

export interface DetectJobRow {
  id: number;
  scope_group_id: number | null;
  scope_status: string | null;
  scope_tag_id: number | null;
  scope_label: string;
  total: number;
  cursor_id: number;
  processed: number;
  connected: number;
  failed: number;
  deleted: number;
  state: 'running' | 'stopping' | 'stopped' | 'done';
  last_email: string;
  last_error: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface DetectScope {
  group_id?: number | null;
  status?: string | null;
  tag_id?: number | null;
  label?: string;
}

// Build the WHERE clause shared by the initial COUNT and every batch fetch.
function scopeQuery(job: Pick<DetectJobRow, 'scope_group_id' | 'scope_status' | 'scope_tag_id'>) {
  const joins = job.scope_tag_id ? ' JOIN account_tags at ON at.account_id = a.id' : '';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (job.scope_tag_id) {
    conditions.push('at.tag_id = ?');
    params.push(job.scope_tag_id);
  }
  if (job.scope_group_id) {
    conditions.push('a.group_id = ?');
    params.push(job.scope_group_id);
  }
  if (job.scope_status) {
    conditions.push('a.status = ?');
    params.push(job.scope_status);
  }
  return { joins, where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params };
}

export async function getLatestDetectJob(db: D1Database): Promise<DetectJobRow | null> {
  return first<DetectJobRow>(db, 'SELECT * FROM detect_jobs ORDER BY id DESC LIMIT 1');
}

export async function getActiveDetectJob(db: D1Database): Promise<DetectJobRow | null> {
  return first<DetectJobRow>(
    db,
    "SELECT * FROM detect_jobs WHERE state IN ('running', 'stopping') ORDER BY id DESC LIMIT 1"
  );
}

// Start a job for the given scope. Only one job runs at a time — the caller gets
// the already-running job back instead of a second one hammering Microsoft.
export async function startDetectJob(
  db: D1Database,
  scope: DetectScope
): Promise<{ job: DetectJobRow; created: boolean }> {
  const existing = await getActiveDetectJob(db);
  if (existing) return { job: existing, created: false };

  const groupId = scope.group_id && scope.group_id > 0 ? scope.group_id : null;
  const tagId = scope.tag_id && scope.tag_id > 0 ? scope.tag_id : null;
  const status = scope.status || null;
  const { joins, where, params } = scopeQuery({
    scope_group_id: groupId,
    scope_status: status,
    scope_tag_id: tagId,
  });
  const countRow = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM accounts a${joins}${where}`,
    params
  );

  await run(
    db,
    `INSERT INTO detect_jobs (scope_group_id, scope_status, scope_tag_id, scope_label, total)
     VALUES (?, ?, ?, ?, ?)`,
    [groupId, status, tagId, scope.label ?? '', countRow?.n ?? 0]
  );
  const job = await getLatestDetectJob(db);
  return { job: job as DetectJobRow, created: true };
}

// Ask the running job to stop. The runner finishes the batch in flight and then
// settles the row to 'stopped', so progress is never lost mid-batch.
export async function stopDetectJob(db: D1Database): Promise<boolean> {
  const active = await getActiveDetectJob(db);
  if (!active) return false;
  await run(
    db,
    "UPDATE detect_jobs SET state = 'stopping', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [active.id]
  );
  return true;
}

// Process one batch of the active job. Returns a short status string; callers
// that drive the loop (Node interval / Workers cron) can log or ignore it.
export async function advanceDetectJob(env: Env): Promise<string> {
  const db = env.DB;
  const job = await getActiveDetectJob(db);
  if (!job) return 'idle';

  const settle = async (state: 'stopped' | 'done') => {
    await run(
      db,
      `UPDATE detect_jobs SET state = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [state, job.id]
    );
    return `${state}: ${job.processed}/${job.total}`;
  };

  if (job.state === 'stopping') return settle('stopped');

  const { joins, where, params } = scopeQuery(job);
  const cursorClause = where ? `${where} AND a.id > ?` : ' WHERE a.id > ?';
  const accounts = await query<AccountRow>(
    db,
    `SELECT a.* FROM accounts a${joins}${cursorClause} ORDER BY a.id ASC LIMIT ?`,
    [...params, job.cursor_id, DETECT_BATCH]
  );
  if (!accounts.length) return settle('done');

  const probes = await mapWithConcurrency(accounts, PROBE_CONCURRENCY, async (account) => ({
    account,
    result: await probeAccount(account),
  }));
  const deleteInvalid = (await getSetting(db, 'token_refresh_delete_invalid')) !== '0';
  const deletedIds = await persistProbeResults(db, probes, deleteInvalid);

  const connected = probes.filter(({ result }) => result.connected).length;
  const failed = probes.length - connected - deletedIds.length;
  const lastAccount = accounts[accounts.length - 1];
  const lastError = probes.find(({ result }) => result.error)?.result.error;

  await run(
    db,
    `UPDATE detect_jobs SET cursor_id = ?, processed = processed + ?, connected = connected + ?,
     failed = failed + ?, deleted = deleted + ?, last_email = ?, last_error = ?,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [
      lastAccount.id,
      accounts.length,
      connected,
      failed,
      deletedIds.length,
      lastAccount.email,
      lastError ? `${lastError.code}: ${lastError.message}`.slice(0, 200) : '',
      job.id,
    ]
  );

  return `batch: +${accounts.length} (${job.processed + accounts.length}/${job.total})`;
}
