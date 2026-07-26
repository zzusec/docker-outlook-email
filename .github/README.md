# CI 说明

## 工作流

| 文件 | 作用 | 触发 |
|---|---|---|
| `workflows/sync-upstream.yml` | 从官网仓库 `roseforyou/cf-outlook-email` 同步更新 | 每天北京时间 02:23，或手动 |
| `workflows/deploy.yml` | 部署到 Cloudflare Workers | push 到 `main`、手动，或被同步工作流调用 |

## 自动升级的判定规则

同步工作流每天比对官网仓库：

- **没有新提交** → 什么都不做。
- **能干净合并，且 `tsc --noEmit` + `vitest run` 全过** → 推 `main`，接着自动部署并做线上冒烟检查。
- **有冲突，或自检没过** → 生产环境完全不动，只开一个 Issue（同名 Issue 已存在则追加评论）等人工处理。

本仓库领先官网若干提交（Graph 优先 + Outlook REST 兜底、HTML 邮件渲染修复、`install.sh` 等），
所以冲突是常态而不是异常，走 Issue 通道是刻意设计。

## 需要的仓库 Secrets

Settings → Secrets and variables → Actions：

| 名称 | 取值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限需含 `Workers Scripts: Edit` + `D1: Edit` + `Account Settings: Read` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
| `D1_DATABASE_ID` | D1 数据库 `outlook-email-db` 的 ID |

`wrangler.toml` 含账号私密 ID，被 `.gitignore` 排除，CI 会用 `wrangler.toml.example`
加上 `D1_DATABASE_ID` 现场生成；`account_id` 通过环境变量 `CLOUDFLARE_ACCOUNT_ID` 传给 wrangler。

## 回滚

```bash
wrangler versions list
wrangler rollback <VERSION_ID>
```
