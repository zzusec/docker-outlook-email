-- 添加国家和IP类型字段到 accounts 表
ALTER TABLE accounts ADD COLUMN country TEXT DEFAULT '';
ALTER TABLE accounts ADD COLUMN ip_type TEXT DEFAULT '';

-- 创建国家索引以优化按国家筛选的查询
CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(country);