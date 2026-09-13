-- 0011_ingest_and_task_logs.sql
-- 自动化上传(ingest)与任务日志(task_logs)
--
-- task_logs: 各类任务每次运行的明细日志(token 刷新 / 邮件推送 / 检测 / 日志清理)
--   level: info | warn | error
--   保留期由 settings.task_log_retention_days 控制(默认 30 天),cron 每小时清理
--   注意:不要在这里 INSERT 默认值。settings 有数据会让 importD1Data()
--   判定为「已有业务数据」而拒绝导入备份;默认值在代码里兜底(getSetting(...) || '30')。
CREATE TABLE IF NOT EXISTS task_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_logs_created ON task_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task);
