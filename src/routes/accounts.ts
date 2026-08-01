import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { query, first, run, batchRun, chunk, getSetting, D1_MAX_BOUND_PARAMS } from '../db';
import { ok, fail, badRequest, notFound } from '../response';
import { maskToken, isValidEmail } from '../utils/validation';
import { AccountImportRequestError, importAccounts } from '../accountImport';
import { getMailAccessToken, getInboxTotal, isPermanentTokenFailure, type GraphError } from '../graph';
import {
  probeAccount,
  publicProbeResult,
  persistProbeResults,
  refreshAccountToken,
  mapWithConcurrency,
  PROBE_CONCURRENCY,
} from '../probe';
import {
  startDetectJob,
  stopDetectJob,
  getLatestDetectJob,
  advanceDetectJob,
} from '../detect';

const accounts = new Hono<{ Bindings: Env }>();

const MAX_CONNECTION_TESTS_PER_REQUEST = 10;
// One page of the account list; each account costs a token call plus a folder call.
const MAX_INBOX_COUNTS_PER_REQUEST = 20;
// Guard rail for selection-based background jobs (the id list is stored as JSON)
const MAX_SELECTED_JOB_ACCOUNTS = 20000;

function importGroupId(value: unknown, allowNumericString = false): number {
  if (value === undefined) return 1;
  const normalized = allowNumericString && typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isInteger(normalized) || (normalized as number) <= 0) {
    throw new AccountImportRequestError('INVALID_GROUP_ID', 'group_id 必须是正整数');
  }
  return normalized as number;
}

function accountImportFailure(error: unknown): Response {
  if (error instanceof AccountImportRequestError) {
    return fail(error.code, error.message, error.status);
  }
  throw error;
}

// Mask account for list responses
function safeAccount(acc: AccountRow) {
  return {
    id: acc.id,
    email: acc.email,
    client_id: maskToken(acc.client_id),
    refresh_token: maskToken(acc.refresh_token),
    group_id: acc.group_id,
    remark: acc.remark,
    status: acc.status,
    country: acc.country,
    ip_type: acc.ip_type,
    inbox: {
      total: acc.inbox_total ?? null,
      checked_at: acc.inbox_count_updated_at ?? null,
    },
    created_at: acc.created_at,
    updated_at: acc.updated_at,
  };
}

// GET /api/accounts
accounts.get('/', async (c) => {
  const groupId = c.req.query('group_id');
  const keyword = c.req.query('keyword');
  const tagId = c.req.query('tag_id');

  let sql = `SELECT a.*, g.name AS group_name, g.color AS group_color
             FROM accounts a LEFT JOIN groups g ON a.group_id = g.id`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tagId) {
    sql += ' JOIN account_tags at ON at.account_id = a.id';
    conditions.push('at.tag_id = ?');
    params.push(parseInt(tagId, 10));
  }
  if (groupId) {
    conditions.push('a.group_id = ?');
    params.push(parseInt(groupId, 10));
  }
  if (keyword) {
    conditions.push('(a.email LIKE ? OR a.remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY a.created_at DESC';

  const rows = await query<AccountRow & { group_name: string; group_color: string }>(
    c.env.DB, sql, params
  );

  // Attach tags per account in one atomic batch (avoid N+1); the id list is
  // chunked because D1 allows at most 100 bound parameters per statement
  const tagMap = new Map<number, { id: number; name: string; color: string }[]>();
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const results = await batchRun<{ account_id: number; id: number; name: string; color: string }>(
      c.env.DB,
      chunk(ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `SELECT at.account_id, t.id, t.name, t.color FROM account_tags at
              JOIN tags t ON t.id = at.tag_id WHERE at.account_id IN (${part.map(() => '?').join(',')}) ORDER BY t.name`,
        params: part,
      }))
    );
    for (const res of results) {
      for (const tr of res.results) {
        const list = tagMap.get(tr.account_id) ?? [];
        list.push({ id: tr.id, name: tr.name, color: tr.color });
        tagMap.set(tr.account_id, list);
      }
    }
  }

  const data = rows.map((r) => ({
    ...safeAccount(r),
    group_name: r.group_name ?? '默认分组',
    group_color: r.group_color ?? '#2563eb',
    tags: tagMap.get(r.id) ?? [],
  }));

  return ok(data);
});

// POST /api/accounts/import - strict JSON batch import with per-line results
accounts.post('/import', async (c) => {
  const contentType = c.req.header('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return fail('UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json', 415);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return fail('INVALID_JSON', '请求体必须是有效 JSON');
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return fail('INVALID_REQUEST', '请求体必须是 JSON 对象');
  }

  const body = rawBody as Record<string, unknown>;
  if (typeof body.account_string !== 'string') {
    return fail('INVALID_ACCOUNT_STRING', 'account_string 必须是字符串');
  }

  try {
    const result = await importAccounts(c.env.DB, body.account_string, importGroupId(body.group_id));
    return ok(
      result,
      `导入完成：新增 ${result.added}，重复 ${result.duplicates}，无效 ${result.invalid}`
    );
  } catch (error) {
    return accountImportFailure(error);
  }
});

// POST /api/accounts (supports legacy batch import)
accounts.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    account_string?: string;
    email?: string;
    client_id?: string;
    refresh_token?: string;
    password?: string;
    group_id?: number | string;
    remark?: string;
    country?: string;
    ip_type?: string;
  };

  // Legacy batch import mode: share the strict importer, but keep the old
  // success payload and the added=0 error behavior for existing clients.
  if (Object.prototype.hasOwnProperty.call(body, 'account_string')) {
    if (typeof body.account_string !== 'string') {
      return fail('INVALID_ACCOUNT_STRING', 'account_string 必须是字符串');
    }
    try {
      const result = await importAccounts(c.env.DB, body.account_string, importGroupId(body.group_id, true));
      if (result.added > 0) return ok({ added: result.added }, `成功添加 ${result.added} 个账号`);
      return badRequest('没有新账号被添加（可能格式错误或已存在）');
    } catch (error) {
      return accountImportFailure(error);
    }
  }

  const groupId = body.group_id ?? 1;

  // Single add mode
  const email = body.email?.trim();
  const clientId = body.client_id?.trim();
  const refreshToken = body.refresh_token?.trim();

  if (!email || !clientId || !refreshToken) {
    return badRequest('邮箱、Client ID 和 Refresh Token 不能为空');
  }
  if (!isValidEmail(email)) {
    return badRequest('邮箱格式不正确');
  }

  try {
    const result = await run(
      c.env.DB,
      'INSERT INTO accounts (email, password, client_id, refresh_token, group_id, remark, country, ip_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [email, body.password ?? '', clientId, refreshToken, groupId, body.remark ?? '', body.country ?? '', body.ip_type ?? '']
    );
    return ok({ id: result.meta.last_row_id }, '账号添加成功');
  } catch {
    return badRequest('邮箱已存在');
  }
});

// GET /api/accounts/export - export accounts as text (same format as import)
// MUST be before /:id to avoid being matched as id="export"
accounts.get('/export', async (c) => {
  const groupId = c.req.query('group_id');
  const idsParam = c.req.query('ids');
  type ExportRow = { email: string; password: string; client_id: string; refresh_token: string };

  let rows: ExportRow[];
  // `ids` (comma-separated) takes precedence — used for single-row and selected exports
  if (idsParam) {
    const ids = idsParam
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n));
    if (!ids.length) return ok({ content: '', count: 0 });
    // Chunked batch: D1 allows at most 100 bound parameters per statement.
    // created_at is fetched so newest-first order survives the merge across chunks.
    const results = await batchRun<ExportRow & { created_at: string }>(
      c.env.DB,
      chunk(ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `SELECT email, password, client_id, refresh_token, created_at FROM accounts
              WHERE id IN (${part.map(() => '?').join(',')})`,
        params: part,
      }))
    );
    rows = results
      .flatMap((r) => r.results)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  } else {
    let sql = 'SELECT email, password, client_id, refresh_token FROM accounts';
    const params: unknown[] = [];
    if (groupId) {
      sql += ' WHERE group_id = ?';
      params.push(parseInt(groupId, 10));
    }
    sql += ' ORDER BY created_at DESC';
    rows = await query<ExportRow>(c.env.DB, sql, params);
  }

  const lines = rows.map(r => `${r.email}----${r.password || ''}----${r.client_id}----${r.refresh_token}`);
  return ok({ content: lines.join('\n'), count: rows.length });
});

// POST /api/accounts/batch - batch operations (delete / move group)
// MUST be before /:id
accounts.post('/batch', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: string;
    ids?: number[];
    group_id?: number;
    token_data?: string;
  };

  if (!body.ids?.length) return badRequest('请选择账号');

  // Each action runs as one atomic D1 batch; ids are chunked so every
  // statement stays within D1's 100-bound-params limit.
  const inList = (part: number[]) => part.map(() => '?').join(',');
  const validIds = () => [...new Set((body.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];

  if (body.action === 'refresh_tokens') {
    const ids = validIds();
    if (!ids.length) return badRequest('请选择有效账号');
    if (ids.length > MAX_CONNECTION_TESTS_PER_REQUEST) {
      return badRequest(`单次最多刷新 ${MAX_CONNECTION_TESTS_PER_REQUEST} 个账号，请分批操作`);
    }
    const found = await query<AccountRow>(
      c.env.DB,
      `SELECT * FROM accounts WHERE id IN (${inList(ids)})`,
      ids
    );
    const byId = new Map(found.map((account) => [account.id, account]));
    const deleteInvalid = (await getSetting(c.env.DB, 'token_refresh_delete_invalid')) !== '0';
    const results: Array<{
      id: number;
      email: string;
      refreshed: boolean;
      rotated?: boolean;
      deleted?: boolean;
      error?: GraphError;
    }> = [];

    for (const id of ids) {
      const account = byId.get(id);
      if (!account) {
        results.push({ id, email: '', refreshed: false, error: { code: 'NOT_FOUND', message: '账号不存在' } });
        continue;
      }
      results.push(await refreshAccountToken(c.env.DB, account, deleteInvalid));
    }

    const refreshed = results.filter((result) => result.refreshed).length;
    const removed = results.filter((result) => result.deleted).length;
    const failed = results.length - refreshed;
    return ok(
      { requested: ids.length, refreshed, failed, deleted: removed, results },
      `Token 刷新完成：成功 ${refreshed}，失败 ${failed}${removed ? `，删除失效 ${removed}` : ''}`
    );
  }

  if (body.action === 'update_tokens') {
    const ids = validIds();
    if (!ids.length) return badRequest('请选择有效账号');
    if (typeof body.token_data !== 'string' || !body.token_data.trim()) {
      return badRequest('请粘贴 Token 数据');
    }
    if (body.token_data.length > 200000) return badRequest('Token 数据过长');

    const tokenMap = new Map<string, string>();
    const lines = body.token_data.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length !== ids.length) return badRequest('每个选中账号必须恰好提供一行 邮箱----refresh_token');
    for (const line of lines) {
      const delimiter = line.indexOf('----');
      if (delimiter <= 0) return badRequest('Token 格式错误：每行应为 邮箱----refresh_token');
      const email = line.slice(0, delimiter).trim();
      const token = line.slice(delimiter + 4).trim();
      const key = email.toLowerCase();
      if (!isValidEmail(email) || !token || token.length > 8192 || /[\x00-\x1F\x7F]/.test(token)) {
        return badRequest('Token 数据包含无效邮箱或 Token');
      }
      if (tokenMap.has(key)) return badRequest('Token 数据包含重复邮箱');
      tokenMap.set(key, token);
    }

    const selectedResults = await batchRun<AccountRow>(
      c.env.DB,
      chunk(ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `SELECT * FROM accounts WHERE id IN (${inList(part)})`,
        params: part,
      }))
    );
    const selectedAccounts = selectedResults.flatMap((result) => result.results);
    if (selectedAccounts.length !== ids.length) return badRequest('选中账号已不存在，请刷新页面后重试');
    if (selectedAccounts.some((account) => !tokenMap.has(account.email.toLowerCase()))) {
      return badRequest('Token 数据与选中账号不完全匹配');
    }

    await batchRun(
      c.env.DB,
      selectedAccounts.map((account) => ({
        sql: `UPDATE accounts SET refresh_token = ?, inbox_total = NULL, inbox_count_updated_at = NULL,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        params: [tokenMap.get(account.email.toLowerCase())!, account.id],
      }))
    );
    return ok({ updated: selectedAccounts.length, inbox_counts_invalidated: selectedAccounts.length }, `已更新 ${selectedAccounts.length} 个账号的 Token，请执行批量测试连接`);
  }

  if (body.action === 'test') {
    const ids = [...new Set(body.ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return badRequest('请选择有效账号');
    if (ids.length > MAX_CONNECTION_TESTS_PER_REQUEST) {
      return badRequest(`单次最多测试 ${MAX_CONNECTION_TESTS_PER_REQUEST} 个账号，请分批操作`);
    }

    const foundAccounts = await query<AccountRow>(
      c.env.DB,
      `SELECT * FROM accounts WHERE id IN (${inList(ids)})`,
      ids
    );
    const probes = await mapWithConcurrency(
      foundAccounts,
      PROBE_CONCURRENCY,
      async (account) => ({ account, result: await probeAccount(account) })
    );
    const deleteInvalid = (await getSetting(c.env.DB, 'token_refresh_delete_invalid')) !== '0';
    const deletedIds = await persistProbeResults(c.env.DB, probes, deleteInvalid);
    const deletedSet = new Set(deletedIds);

    const byId = new Map(probes.map((probe) => [probe.account.id, probe.result]));
    const results = ids.map((id) => byId.get(id) ?? {
      id,
      email: '',
      exists: false,
      connected: false,
      stage: 'not_found' as const,
      error: { code: 'NOT_FOUND', message: '账号不存在' },
      inbox: { total: null, checked_at: null },
    });
    const connected = results.filter((result) => result.exists && result.connected).length;
    const failed = results.filter((result) => result.exists && !result.connected).length;
    const missing = results.length - connected - failed;

    return ok({
      requested: ids.length,
      tested: probes.length,
      connected,
      failed,
      missing,
      deleted: deletedIds.length,
      results: results.map((result) => ({
        ...publicProbeResult(result),
        deleted: deletedSet.has(result.id),
      })),
    }, `测试完成：成功 ${connected}，失败 ${failed}${missing ? `，不存在 ${missing}` : ''}${deletedIds.length ? `，删除失效 ${deletedIds.length}` : ''}`);
  }

  if (body.action === 'delete') {
    await batchRun(
      c.env.DB,
      chunk(body.ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `DELETE FROM accounts WHERE id IN (${inList(part)})`,
        params: part,
      }))
    );
    return ok(null, `已删除 ${body.ids.length} 个账号`);
  }

  if (body.action === 'move' && body.group_id !== undefined) {
    // group_id occupies one bound slot per statement, hence limit - 1
    await batchRun(
      c.env.DB,
      chunk(body.ids, D1_MAX_BOUND_PARAMS - 1).map((part) => ({
        sql: `UPDATE accounts SET group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${inList(part)})`,
        params: [body.group_id, ...part],
      }))
    );
    return ok(null, `已移动 ${body.ids.length} 个账号`);
  }

  if (body.action === 'enable') {
    await batchRun(
      c.env.DB,
      chunk(body.ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `UPDATE accounts SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${inList(part)})`,
        params: part,
      }))
    );
    return ok(null, `已启用 ${body.ids.length} 个账号`);
  }

  if (body.action === 'disable') {
    await batchRun(
      c.env.DB,
      chunk(body.ids, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `UPDATE accounts SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id IN (${inList(part)})`,
        params: part,
      }))
    );
    return ok(null, `已停用 ${body.ids.length} 个账号`);
  }

  return badRequest('未知操作');
});

// ---- Background detection jobs (survive a closed browser tab) ----

// POST /api/accounts/detect/start — probe every account in the given scope
accounts.post('/detect/start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    kind?: string;
    ids?: number[];
    group_id?: number | string;
    status?: string;
    tag_id?: number | string;
    label?: string;
  };
  const toId = (v: number | string | undefined) => {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    return Number.isInteger(n) && (n as number) > 0 ? (n as number) : null;
  };
  const status = ['active', 'error', 'disabled'].includes(String(body.status)) ? String(body.status) : null;
  const kind = body.kind === 'refresh' || body.kind === 'count' ? body.kind : 'detect';
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => Number.isInteger(id) && id > 0) : [];
  if (ids.length > MAX_SELECTED_JOB_ACCOUNTS) {
    return badRequest(`单个任务最多 ${MAX_SELECTED_JOB_ACCOUNTS} 个账号，请分批操作`);
  }

  const { job, created } = await startDetectJob(c.env.DB, {
    kind,
    ids,
    group_id: toId(body.group_id),
    status,
    tag_id: toId(body.tag_id),
    label: typeof body.label === 'string' ? body.label.slice(0, 100) : '',
  });
  const nouns: Record<string, string> = { refresh: '刷新', count: '统计', detect: '检测' };
  const noun = nouns[kind];
  if (!created) return ok(job, `已有${nouns[job.kind] ?? '检测'}任务在运行，返回当前任务`);
  if (!job.total) return ok(job, '该范围内没有账号');

  // Kick the first batch immediately so the UI shows progress right away; the
  // driver (Node interval / Workers cron) keeps it going from there.
  const firstBatch = advanceDetectJob(c.env).catch(() => undefined);
  try {
    // Workers kills stray promises when the response returns; Node does not.
    c.executionCtx.waitUntil(firstBatch);
  } catch {
    // No ExecutionContext bound (Node server, tests) — the promise runs on its own
  }
  return ok(job, `已在后台开始${noun} ${job.total} 个邮箱`);
});

// GET /api/accounts/detect/status — latest job (running or finished)
accounts.get('/detect/status', async (c) => {
  const job = await getLatestDetectJob(c.env.DB);
  return ok(job);
});

// POST /api/accounts/detect/stop
accounts.post('/detect/stop', async (c) => {
  const stopped = await stopDetectJob(c.env.DB);
  const job = await getLatestDetectJob(c.env.DB);
  return ok(job, stopped ? '正在停止，当前批次结束后停止' : '没有正在运行的检测任务');
});

// POST /api/accounts/inbox-counts
// Refresh the Inbox totals of specific accounts. The list view calls this lazily
// for the rows it renders, so counts appear for accounts that were never tested
// instead of showing "—" forever.
accounts.post('/inbox-counts', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[] };
  const ids = [...new Set((body.ids ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return badRequest('请选择账号');
  if (ids.length > MAX_INBOX_COUNTS_PER_REQUEST) {
    return badRequest(`单次最多统计 ${MAX_INBOX_COUNTS_PER_REQUEST} 个账号，请分批操作`);
  }

  const found = await query<AccountRow>(
    c.env.DB,
    `SELECT * FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const deleteInvalid = (await getSetting(c.env.DB, 'token_refresh_delete_invalid')) !== '0';

  const results = await mapWithConcurrency(found, PROBE_CONCURRENCY, async (account) => {
    const tokenResult = await getMailAccessToken(account.client_id, account.refresh_token);
    if (!tokenResult.token) {
      const dead = deleteInvalid && isPermanentTokenFailure(tokenResult.error);
      return {
        id: account.id,
        email: account.email,
        total: null as number | null,
        checked_at: null as string | null,
        deleted: dead,
        status: dead ? undefined : ('error' as const),
        error: tokenResult.error,
      };
    }

    const rotated =
      tokenResult.newRefreshToken && tokenResult.newRefreshToken !== account.refresh_token
        ? tokenResult.newRefreshToken
        : undefined;
    const countResult = await getInboxTotal(tokenResult.token);
    if (countResult.total === undefined) {
      return {
        id: account.id,
        email: account.email,
        total: null as number | null,
        checked_at: null as string | null,
        deleted: false,
        status: 'active' as const,
        rotated,
        error: countResult.error,
      };
    }
    return {
      id: account.id,
      email: account.email,
      total: countResult.total,
      checked_at: new Date().toISOString(),
      deleted: false,
      status: 'active' as const,
      rotated,
    };
  });

  const statements: { sql: string; params?: unknown[] }[] = [];
  for (const result of results) {
    if (result.deleted) {
      statements.push({ sql: 'DELETE FROM account_tags WHERE account_id = ?', params: [result.id] });
      statements.push({ sql: 'DELETE FROM accounts WHERE id = ?', params: [result.id] });
      continue;
    }
    const assignments: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [result.status];
    if (result.rotated) {
      assignments.unshift('refresh_token = ?');
      params.unshift(result.rotated);
    }
    if (result.total !== null) {
      assignments.push('inbox_total = ?', 'inbox_count_updated_at = ?');
      params.push(result.total, result.checked_at);
    }
    statements.push({
      sql: `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`,
      params: [...params, result.id],
    });
  }
  await batchRun(c.env.DB, statements);

  const counted = results.filter((result) => result.total !== null).length;
  const removed = results.filter((result) => result.deleted).length;
  return ok({
    requested: ids.length,
    counted,
    deleted: removed,
    results: results.map((result) => ({
      id: result.id,
      email: result.email,
      deleted: result.deleted,
      inbox: { total: result.total, checked_at: result.checked_at },
      ...(result.error ? { error: result.error } : {}),
    })),
  }, `统计完成：成功 ${counted}${removed ? `，删除失效 ${removed}` : ''}`);
});

// GET /api/accounts/:id
accounts.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const acc = await first<AccountRow & { group_name: string; group_color: string }>(
    c.env.DB,
    `SELECT a.*, g.name AS group_name, g.color AS group_color
     FROM accounts a LEFT JOIN groups g ON a.group_id = g.id WHERE a.id = ?`,
    [id]
  );
  if (!acc) return notFound('账号不存在');

  const tagRows = await query<{ id: number; name: string; color: string }>(
    c.env.DB,
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN account_tags at ON at.tag_id = t.id WHERE at.account_id = ?`,
    [id]
  );

  // Detail view intentionally exposes current credentials to the authenticated administrator.
  return ok({
    ...acc,
    group_name: acc.group_name ?? '默认分组',
    group_color: acc.group_color ?? '#2563eb',
    tags: tagRows,
    tag_ids: tagRows.map((t) => t.id),
  });
});

// PUT /api/accounts/:id
accounts.put('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!existing) return notFound('账号不存在');

  const body = (await c.req.json().catch(() => ({}))) as Partial<{
    email: string;
    client_id: string;
    refresh_token: string;
    password: string;
    group_id: number;
    remark: string;
    status: string;
    country: string;
    ip_type: string;
    tag_ids: number[];
  }>;

  // Sync tags if provided (replace the full set)
  if (Array.isArray(body.tag_ids)) {
    await run(c.env.DB, 'DELETE FROM account_tags WHERE account_id = ?', [id]);
    for (const tid of body.tag_ids) {
      if (Number.isInteger(tid)) {
        await run(c.env.DB, 'INSERT OR IGNORE INTO account_tags (account_id, tag_id) VALUES (?, ?)', [id, tid]);
      }
    }
    // If only tags changed, return early
    if (Object.keys(body).length === 1) return ok(null, '标签已更新');
  }

  // Status-only update
  if (body.status && Object.keys(body).length === 1) {
    await run(
      c.env.DB,
      'UPDATE accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [body.status, id]
    );
    return ok(null, '状态更新成功');
  }

  const email = body.email?.trim() ?? existing.email;
  const clientId = body.client_id?.trim() ?? existing.client_id;
  const refreshToken = body.refresh_token?.trim() ?? existing.refresh_token;

  if (!email || !clientId || !refreshToken) {
    return badRequest('邮箱、Client ID 和 Refresh Token 不能为空');
  }

  // A newly supplied refresh_token invalidates a stale 'error' verdict (the
  // error referred to the old token). Deliberate 'disabled' is never auto-changed.
  const status =
    body.status ??
    (body.refresh_token?.trim() && existing.status === 'error' ? 'active' : existing.status);

  try {
    await run(
      c.env.DB,
      `UPDATE accounts SET email = ?, password = ?, client_id = ?, refresh_token = ?,
       group_id = ?, remark = ?, status = ?, country = ?, ip_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        email,
        body.password ?? existing.password,
        clientId,
        refreshToken,
        body.group_id ?? existing.group_id,
        body.remark ?? existing.remark,
        status,
        body.country ?? existing.country,
        body.ip_type ?? existing.ip_type,
        id,
      ]
    );
    return ok(null, '账号更新成功');
  } catch {
    return badRequest('更新失败，邮箱可能已存在');
  }
});

// DELETE /api/accounts/:id
accounts.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const existing = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!existing) return notFound('账号不存在');

  await run(c.env.DB, 'DELETE FROM account_tags WHERE account_id = ?', [id]);
  await run(c.env.DB, 'DELETE FROM accounts WHERE id = ?', [id]);
  return ok(null, '账号已删除');
});

// POST /api/accounts/:id/test - test token refresh and actual Inbox access
accounts.post('/:id/test', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const acc = await first<AccountRow>(c.env.DB, 'SELECT * FROM accounts WHERE id = ?', [id]);
  if (!acc) return notFound('账号不存在');

  const result = await probeAccount(acc);
  const deleteInvalid = (await getSetting(c.env.DB, 'token_refresh_delete_invalid')) !== '0';
  const deletedIds = await persistProbeResults(c.env.DB, [{ account: acc, result }], deleteInvalid);
  const deleted = deletedIds.length > 0;
  return ok(
    { ...publicProbeResult(result), deleted },
    result.connected ? 'Graph API 连接正常' : deleted ? 'Token 已永久失效，账号已删除' : 'Graph API 连接失败'
  );
});

export default accounts;
