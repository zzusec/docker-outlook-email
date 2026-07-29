// Background detection: probe every account in a scope (group / status / tag)
// without keeping a browser tab open. The job row holds the progress counters and
// an ascending-id cursor; a driver (Node interval, or the Workers cron trigger)
// repeatedly calls advanceDetectJob() to process one batch at a time.
import type { Env, AccountRow } from './types';
import { query, first, run, getSetting } from './db';
import {
  probeAccount,
  persistProbeResults,
  refreshAccountToken,
  mapWithConcurrency,
  PROBE_CONCURRENCY,
} from './probe';

// Accounts per batch. Small batches keep the Workers subrequest budget in reach
// and let a stop request take effect quickly.
export const DETECT_BATCH = 10;

// detect  — full probe: token + mail access + Inbox count
// refresh — token refresh only, over a hand-picked selection
export type DetectJobKind = 'detect' | 'refresh';

export interface DetectJobRow {
  id: number;
  kind: DetectJobKind;
  scope_ids: string;
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
  kind?: DetectJobKind;
  ids?: number[] | null;
  group_id?: number | null;
  status?: string | null;
  tag_id?: number | null;
  label?: string;
}

// Explicit selections are stored as a JSON id list; cursor_id then counts how
// many of those ids have been handled (an id cursor would not survive gaps).
function parseScopeIds(job: Pick<DetectJobRow, 'scope_ids'>): number[] {
  if (!job.scope_ids) return [];
  try {
    const parsed = JSON.parse(job.scope_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is number => Number.isInteger(v)) : [];
  } catch {
    return [];
  }
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

  const kind: DetectJobKind = scope.kind === 'refresh' ? 'refresh' : 'detect';
  const ids = [...new Set((scope.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  const groupId = !ids.length && scope.group_id && scope.group_id > 0 ? scope.group_id : null;
  const tagId = !ids.length && scope.tag_id && scope.tag_id > 0 ? scope.tag_id : null;
  const status = !ids.length ? scope.status || null : null;

  let total = ids.length;
  if (!ids.length) {
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
    total = countRow?.n ?? 0;
  }

  await run(
    db,
    `INSERT INTO detect_jobs (kind, scope_ids, scope_group_id, scope_status, scope_tag_id, scope_label, total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [kind, ids.length ? JSON.stringify(ids) : '', groupId, status, tagId, scope.label ?? '', total]
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

  const selectedIds = parseScopeIds(job);
  let accounts: AccountRow[];
  let nextCursor: number;

  if (selectedIds.length) {
    // Explicit selection: cursor_id is an index into the stored id list
    const slice = selectedIds.slice(job.cursor_id, job.cursor_id + DETECT_BATCH);
    if (!slice.length) return settle('done');
    nextCursor = job.cursor_id + slice.length;
    // Rows may have been deleted meanwhile; those ids simply drop out
    accounts = await query<AccountRow>(
      db,
      `SELECT a.* FROM accounts a WHERE a.id IN (${slice.map(() => '?').join(',')}) ORDER BY a.id ASC`,
      slice
    );
    if (!accounts.length) {
      await run(
        db,
        `UPDATE detect_jobs SET cursor_id = ?, processed = processed + ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [nextCursor, slice.length, job.id]
      );
      return `batch: skipped ${slice.length} missing (${job.processed + slice.length}/${job.total})`;
    }
  } else {
    const { joins, where, params } = scopeQuery(job);
    const cursorClause = where ? `${where} AND a.id > ?` : ' WHERE a.id > ?';
    accounts = await query<AccountRow>(
      db,
      `SELECT a.* FROM accounts a${joins}${cursorClause} ORDER BY a.id ASC LIMIT ?`,
      [...params, job.cursor_id, DETECT_BATCH]
    );
    if (!accounts.length) return settle('done');
    nextCursor = accounts[accounts.length - 1].id;
  }

  const deleteInvalid = (await getSetting(db, 'token_refresh_delete_invalid')) !== '0';
  let succeeded = 0;
  let deletedCount = 0;
  let lastError: { code: string; message: string } | undefined;

  if (job.kind === 'refresh') {
    const outcomes = await mapWithConcurrency(accounts, PROBE_CONCURRENCY, (account) =>
      refreshAccountToken(db, account, deleteInvalid)
    );
    succeeded = outcomes.filter((outcome) => outcome.refreshed).length;
    deletedCount = outcomes.filter((outcome) => outcome.deleted).length;
    lastError = outcomes.find((outcome) => outcome.error)?.error;
  } else {
    const probes = await mapWithConcurrency(accounts, PROBE_CONCURRENCY, async (account) => ({
      account,
      result: await probeAccount(account),
    }));
    const deletedIds = await persistProbeResults(db, probes, deleteInvalid);
    succeeded = probes.filter(({ result }) => result.connected).length;
    deletedCount = deletedIds.length;
    lastError = probes.find(({ result }) => result.error)?.result.error;
  }

  const processedNow = selectedIds.length
    ? Math.min(DETECT_BATCH, selectedIds.length - job.cursor_id)
    : accounts.length;
  const failed = accounts.length - succeeded - deletedCount;
  const lastAccount = accounts[accounts.length - 1];

  await run(
    db,
    `UPDATE detect_jobs SET cursor_id = ?, processed = processed + ?, connected = connected + ?,
     failed = failed + ?, deleted = deleted + ?, last_email = ?, last_error = ?,
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [
      nextCursor,
      processedNow,
      succeeded,
      failed,
      deletedCount,
      lastAccount.email,
      lastError ? `${lastError.code}: ${lastError.message}`.slice(0, 200) : '',
      job.id,
    ]
  );

  return `batch: +${processedNow} (${job.processed + processedNow}/${job.total})`;
}
