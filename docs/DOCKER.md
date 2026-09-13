# Docker 服务器部署

Docker 模式复用现有 Hono 后端和前端，使用本地 SQLite 代替 Cloudflare D1。容器每 5 分钟唤醒 Token 保活和 Telegram 邮件推送调度器，是否实际执行由系统设置控制；后台批量检测任务每 5 秒推进一次。Cloudflare 部署入口仍然保留，两种模式可以并行验证后再切换流量。

## 1. 首次部署

服务器需要安装 Docker Engine 和 Docker Compose v2。

```bash
git clone https://github.com/zzusec/docker-outlook-email.git
cd docker-outlook-email
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`：

- `ADMIN_PASSWORD`：管理后台初始密码。
- `COOKIE_SECRET`：填入上一条命令生成的随机值，后续不要随意更换，否则现有登录会话会失效。
- `PUBLIC_URL`：公网访问地址，例如 `https://mail.example.com`。OAuth 回调和安全 Cookie 会使用这个地址。
- `APP_PORT`：服务器暴露的端口，默认 `8787`。
- `BIND_ADDRESS`：默认只监听宿主机回环地址 `127.0.0.1`，由同机反向代理对外提供 HTTPS。

启动：

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8787/healthz
```

首次启动会自动执行 `migrations/` 下尚未运行的数据库迁移，SQLite 文件持久化在 `./data/outlook-email.db`。

## 2. 从 Cloudflare D1 迁移已有数据

先在仍能登录 Cloudflare 的电脑上安装依赖并导出。只导出应用表，避免把 D1 内部迁移表带入 SQLite：

```bash
mkdir -p data
pnpm install
pnpm exec wrangler d1 export outlook-email-db \
  --remote \
  --no-schema \
  --table settings \
  --table groups \
  --table accounts \
  --table temp_emails \
  --table tags \
  --table account_tags \
  --table push_state \
  --output ./data/d1-data.sql
chmod 600 ./data/d1-data.sql
```

把整个项目（包含 `data/d1-data.sql`）传到服务器。在第一次启动正式服务前导入：

```bash
docker compose build
docker compose run --rm outlook-email import /data/d1-data.sql
docker compose up -d
```

导入命令只允许写入空的应用数据库，以免误覆盖服务器上已有数据。导入后，登录密码以 D1 中 `login_password_hash` 对应的原密码为准；`.env` 中的 `ADMIN_PASSWORD` 只在数据库尚未保存密码哈希时使用。

导出文件中含有 Outlook refresh token、API Key 和推送配置。迁移验证完成后请安全删除 `data/d1-data.sql`，不要上传到 Git 或公开存储。

建议先保持 Cloudflare 版本在线，通过服务器端口或临时域名检查账号、分组、设置和收信功能，确认无误后再修改 DNS。切换期间不要同时在两端修改账号或设置，因为两个 SQLite 数据库不会自动同步。

## 3. HTTPS 反向代理

生产环境应通过 Caddy、Nginx 或其他反向代理提供 HTTPS。Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name mail.example.com;

    # 在这里配置你的 ssl_certificate 和 ssl_certificate_key

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

确保 `.env` 中的 `PUBLIC_URL` 与浏览器实际使用的 HTTPS 域名完全一致。如果使用自建 Azure 应用，还需要把 `https://mail.example.com/api/oauth/callback` 加入应用的重定向 URI。

## 4. 日常运维

查看日志和健康状态：

```bash
docker compose logs -f --tail=200 outlook-email
docker compose ps
curl https://mail.example.com/healthz
```

更新版本：

```bash
git pull
docker compose up -d --build
```

备份数据库时先短暂停止服务，确保 SQLite WAL 已完整落盘，再复制整个 `data` 目录：

```bash
docker compose stop
tar -czf outlook-email-data-$(date +%F).tar.gz data
docker compose start
```

恢复时也应先停止服务，并同时恢复 `data` 目录中的数据库及其 WAL/SHM 文件。

## 5. 配置说明

| 变量 | 必填 | 默认值 | 说明 |
|---|:---:|---|---|
| `ADMIN_PASSWORD` | 是 | 无 | 首次登录密码 |
| `COOKIE_SECRET` | 是 | 无 | 登录 Cookie 签名密钥 |
| `PUBLIC_URL` | 建议 | 自动读取请求头 | 公网 HTTPS 地址，OAuth 场景应明确填写 |
| `APP_PORT` | 否 | `8787` | Compose 暴露到宿主机的端口 |
| `BIND_ADDRESS` | 否 | `127.0.0.1` | 宿主机监听地址；同机反代无需改动 |
| `GPTMAIL_API_KEY` | 否 | 无 | GPTMail API Key |

`DATABASE_PATH` 和容器内部 `PORT` 已由 Compose 固定配置，通常不需要修改。
