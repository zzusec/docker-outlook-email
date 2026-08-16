-- 0011_ingest_and_task_logs.sql
-- 自动化上传(ingest)与任务日志(task_logs)
--
-- task_logs: 各类任务每次运行的明细日志(token 刷新 / 邮件推送 / 检测 / 日志清理)
--   level: info | warn | error
--   保留期由 settings.task_log_retention_days 控制(默认 30 天),cron 每小时清理
CREATE TABLE IF NOT EXISTS task_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_logs_created ON task_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task);

-- 日志保留期默认 30 天
INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('task_log_retention_days', '30', CURRENT_TIMESTAMP);
