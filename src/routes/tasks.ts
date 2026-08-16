import { Hono } from 'hono';
import type { Env, TaskLogRow } from '../types';
import { query, first, run, getSetting } from '../db';
import { ok, badRequest } from '../response';

// Task log viewer / cleanup. Logs are written by the cron jobs (token refresh,
// email push) and the detect background jobs. Retention is configurable in
// settings (task_log_retention_days, default 30); the cron tick prunes hourly.
const tasks = new Hono<{ Bindings: Env }>();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// GET /api/tasks/logs?page=1&page_size=50&task=&level=
tasks.get('/logs', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('page_size') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const taskFilter = c.req.query('task');
  const levelFilter = c.req.query('level');

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (taskFilter) {
    conditions.push('task = ?');
    params.push(taskFilter);
  }
  if (levelFilter) {
    conditions.push('level = ?');
    params.push(levelFilter);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalRow = await first<{ c: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS c FROM task_logs ${where}`,
    params
  );
  const total = totalRow?.c ?? 0;

  const offset = (page - 1) * pageSize;
  const rows = await query<TaskLogRow>(
    c.env.DB,
    `SELECT * FROM task_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return ok({
    items: rows,
    page,
    page_size: pageSize,
    total,
  });
});

// POST /api/tasks/logs/cleanup
// Body: { all: true } clears everything; otherwise prune by retention_days
// (falls back to the settings value, then 30 days).
tasks.post('/logs/cleanup', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    all?: boolean;
    retention_days?: number;
  };

  if (body.all) {
    const r = await run(c.env.DB, 'DELETE FROM task_logs', []);
    return ok({ deleted: r.meta.changes ?? 0 }, '已清空全部日志');
  }

  const days =
    Math.max(1, parseInt(String(body.retention_days ?? ''), 10)) ||
    parseInt((await getSetting(c.env.DB, 'task_log_retention_days')) || '30', 10) ||
    30;
  const r = await run(
    c.env.DB,
    `DELETE FROM task_logs WHERE created_at < datetime('now', ?)`,
    [`-${days} days`]
  );
  return ok({ deleted: r.meta.changes ?? 0, retention_days: days }, `已清理 ${days} 天前的日志`);
});

export default tasks;
