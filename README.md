# cf-outlook-email

一个部署在自己服务器上的 **Outlook / Hotmail 邮箱集中管理后台**。

项目通过 Microsoft Graph API 读取已授权邮箱，可以在一个网页里管理多个 Outlook、Hotmail、Live 邮箱，批量检查账号状态、刷新 Token、查看邮件、搜索验证码，并提供 Telegram 推送和外部 API。

本仓库当前以 **Docker Compose + Node.js + SQLite** 方式部署，数据保存在服务器本地。

> 这不是邮箱注册工具，也不是邮件服务器。项目只能访问你主动添加并完成授权的微软邮箱。请确保你对所有账号拥有合法使用权限。

## 项目能做什么

- 集中管理多个 Outlook、Hotmail、Live 邮箱
- 通过微软 OAuth 一键添加邮箱
- 批量导入、导出、删除、移动和筛选账号
- 批量检测账号状态、刷新 Token
- 查看收件箱、垃圾邮件、已删除邮件
- 聚合多个文件夹并按时间查看邮件
- 搜索邮件、提取验证码、下载附件
- 按分组、标签、状态、国家和 IP 类型筛选账号
- 统计每个邮箱的邮件数量
- 后台执行批量检测和刷新，关闭网页后任务仍会继续
- 定时刷新 Token
- 将新邮件推送到 Telegram
- 通过 API Key 调用外部接口读取邮箱和验证码
- 使用 GPTMail 创建临时邮箱
- 中文、英文界面以及深色、浅色主题

## 页面预览

| 深色模式 | 浅色模式 |
|:---:|:---:|
| ![深色模式](./docs/preview.png) | ![浅色模式](./docs/preview-light.png) |

## 安装

### 1. 准备服务器

推荐使用 Linux 服务器，并提前安装：

- Git
- Docker Engine
- Docker Compose v2

确认 Docker 可以正常运行：

```bash
docker --version
docker compose version
```

### 2. 下载项目

```bash
git clone https://github.com/zzusec/cf-outlook-email.git
cd cf-outlook-email
```

### 3. 创建配置文件

```bash
cp .env.example .env
openssl rand -hex 32
vim .env
```

将 `openssl` 生成的随机字符串填入 `COOKIE_SECRET`，并修改以下配置：

```dotenv
# 管理后台初始密码
ADMIN_PASSWORD=请设置一个强密码

# Cookie 签名密钥，填入 openssl rand -hex 32 的输出
COOKIE_SECRET=请替换为随机字符串

# 浏览器访问本项目的完整地址，只填写协议和域名，不要添加路径
PUBLIC_URL=https://mail.example.com

# 宿主机端口
APP_PORT=8787

# 默认只允许本机访问，适合通过 Nginx/Caddy 反向代理
BIND_ADDRESS=127.0.0.1

# 可选，也可以登录后台后再填写
# GPTMAIL_API_KEY=
```

必须修改：

- `ADMIN_PASSWORD`
- `COOKIE_SECRET`
- `PUBLIC_URL`

`PUBLIC_URL` 示例：

```text
https://mail.example.com
```

不要填写：

```text
https://mail.example.com/
https://mail.example.com/path
```

如果只是临时通过服务器 IP 测试，可以设置：

```dotenv
PUBLIC_URL=http://你的服务器IP:8787
BIND_ADDRESS=0.0.0.0
APP_PORT=8787
```

> 直接开放 `8787` 端口不适合正式使用。生产环境建议保持 `BIND_ADDRESS=127.0.0.1`，再通过 Nginx 或 Caddy 提供 HTTPS。

### 4. 构建并启动

```bash
docker compose up -d --build
```

查看容器状态：

```bash
docker compose ps
```

查看启动日志：

```bash
docker compose logs --tail=200 outlook-email
```

检查服务是否正常：

```bash
curl http://127.0.0.1:8787/healthz
```

正常情况下会返回：

```json
{"ok":true}
```

首次启动时，程序会自动：

1. 创建 `data/` 数据目录
2. 创建 SQLite 数据库
3. 执行尚未运行的数据库迁移
4. 启动 Web 服务和后台定时任务

数据库默认保存在：

```text
./data/outlook-email.db
```

### 5. 登录后台

完成反向代理后，打开：

```text
https://mail.example.com
```

使用 `.env` 中的 `ADMIN_PASSWORD` 登录。

第一次成功登录后，密码哈希会保存到数据库。以后修改登录密码请在后台系统设置中操作，仅修改 `.env` 中的 `ADMIN_PASSWORD` 不一定会覆盖数据库里已有的密码。

## 添加 Outlook 邮箱

登录后台后：

1. 打开“账号管理”
2. 点击“添加账号”
3. 选择“一键授权”
4. 在微软登录窗口中登录目标邮箱
5. 同意授权
6. 授权信息自动回填后保存

支持：

- Outlook.com
- Hotmail.com
- Live.com
- 其他可以使用 Microsoft Graph API 的微软个人邮箱

也可以批量导入，默认格式为：

```text
邮箱----密码----client_id----refresh_token
```

详细接口说明见 [API 文档](./docs/API.md)。

## 配置 HTTPS 反向代理

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name mail.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`.env` 中必须对应填写：

```dotenv
PUBLIC_URL=https://mail.example.com
BIND_ADDRESS=127.0.0.1
APP_PORT=8787
```

如果使用自己创建的 Azure 应用，需要在 Azure 应用中添加以下重定向 URI：

```text
https://mail.example.com/api/oauth/callback
```

完整部署和迁移说明见 [Docker 部署文档](./docs/DOCKER.md)。

## 更新

项目没有使用远程预构建镜像。更新时需要拉取最新代码并在服务器上重新构建镜像。

### 标准更新流程

进入项目目录：

```bash
cd cf-outlook-email
```

先备份数据：

```bash
docker compose stop
tar -czf ../cf-outlook-email-data-$(date +%F-%H%M%S).tar.gz data
docker compose start
```

拉取最新代码：

```bash
git pull --ff-only
```

重新构建并启动：

```bash
docker compose up -d --build --remove-orphans
```

确认更新成功：

```bash
docker compose ps
docker compose logs --tail=200 outlook-email
curl http://127.0.0.1:8787/healthz
```

容器启动时会自动执行新增的数据库迁移，不需要手动修改 SQLite 数据库。

### 查看当前版本

```bash
git log -1 --oneline
```

### 更新失败怎么办

先查看日志：

```bash
docker compose logs --tail=300 outlook-email
```

如果新版本无法启动，可以切回更新前的 Git 提交，再重新构建：

```bash
git log --oneline -10
git checkout 更新前的提交ID
docker compose up -d --build --remove-orphans
```

确认问题解决后，再切回主分支：

```bash
git checkout main
```

如果数据库也需要回退，请使用更新前创建的数据备份恢复。

## 备份和恢复

### 备份

SQLite 使用 WAL 模式。为了保证备份完整，建议短暂停止容器并备份整个 `data/` 目录：

```bash
cd cf-outlook-email
docker compose stop
tar -czf ../cf-outlook-email-data-$(date +%F-%H%M%S).tar.gz data
docker compose start
```

备份文件中可能包含：

- 登录密码哈希
- Outlook Refresh Token
- API Key
- Telegram 配置
- 邮箱和分组数据

请把备份存放在安全位置，不要上传到公开网盘或 GitHub。

### 恢复

停止服务：

```bash
cd cf-outlook-email
docker compose stop
```

保留当前数据：

```bash
mv data data.before-restore
```

恢复备份：

```bash
tar -xzf ../cf-outlook-email-data-日期时间.tar.gz
```

重新启动：

```bash
docker compose up -d
docker compose logs --tail=200 outlook-email
curl http://127.0.0.1:8787/healthz
```

恢复时必须恢复完整的 `data/` 目录，不要只复制 `outlook-email.db` 而忽略可能存在的 WAL/SHM 文件。

## 常用命令

### 查看状态

```bash
docker compose ps
```

### 查看实时日志

```bash
docker compose logs -f --tail=200 outlook-email
```

### 停止服务

```bash
docker compose stop
```

### 启动服务

```bash
docker compose start
```

### 重启服务

```bash
docker compose restart outlook-email
```

### 重新构建

```bash
docker compose up -d --build
```

### 完全停止并删除容器

```bash
docker compose down
```

`docker compose down` 不会删除绑定挂载的 `./data` 目录，但执行前仍建议先备份。

## 环境变量

| 变量 | 是否必填 | 默认值 | 用途 |
|---|:---:|---|---|
| `ADMIN_PASSWORD` | 是 | 无 | 管理后台初始密码 |
| `COOKIE_SECRET` | 是 | 无 | 登录 Cookie 签名密钥 |
| `PUBLIC_URL` | 推荐填写 | 根据请求头推导 | 公网访问地址、OAuth 回调和安全 Cookie |
| `APP_PORT` | 否 | `8787` | 映射到宿主机的端口 |
| `BIND_ADDRESS` | 否 | `127.0.0.1` | 宿主机监听地址 |
| `GPTMAIL_API_KEY` | 否 | 无 | GPTMail API Key |

注意：

- 缺少 `ADMIN_PASSWORD` 或 `COOKIE_SECRET` 时，容器会拒绝启动。
- `PUBLIC_URL` 只能包含协议、域名和可选端口，不能包含路径、参数或锚点。
- 修改 `COOKIE_SECRET` 会使所有现有登录会话失效。
- 不要提交 `.env` 和 `data/`。

## 后台任务

Docker 容器中运行一个长驻 Node.js 服务：

- 每 5 分钟唤醒 Token 刷新调度器
- 每 5 分钟唤醒 Telegram 新邮件推送调度器
- 每 5 秒推进一次后台批量检测任务

是否真正刷新或推送，由后台系统设置中的开关、任务间隔和批量大小决定。

自动刷新不能保证 Token 永远有效。用户撤销授权、微软风控、账号异常或应用权限变化都可能导致 Token 失效。

## 从 Cloudflare D1 迁移

如果以前使用 Cloudflare Workers + D1 版本，可以把现有账号、分组、设置和推送状态导入 Docker SQLite。

迁移文件中包含 Refresh Token、API Key 等敏感信息，而且导入只允许写入空数据库。请按照 [Docker 部署文档中的迁移步骤](./docs/DOCKER.md#2-从-cloudflare-d1-迁移已有数据) 操作。

## 技术结构

```text
浏览器
  ↓
Nginx / Caddy（HTTPS）
  ↓
Docker Compose
  ↓
Node.js + Hono
  ├── 前端静态文件
  ├── Microsoft Graph API
  ├── 后台定时任务
  └── SQLite：./data/outlook-email.db
```

主要目录：

```text
server/                  Node.js 服务入口和 SQLite 兼容层
src/                     后端业务逻辑和 API 路由
public/                  前端静态文件
migrations/              数据库迁移
Dockerfile               Docker 镜像构建配置
docker-compose.yml       容器、端口和数据目录配置
docker-entrypoint.sh     容器启动脚本
.env.example             环境变量示例
docs/                    Docker、API 和其他说明文档
```

## 安全建议

- 使用足够强的后台登录密码
- 使用随机且长期固定的 `COOKIE_SECRET`
- 生产环境必须使用 HTTPS
- 默认保持 `BIND_ADDRESS=127.0.0.1`
- 不要公开 `.env`、`data/` 和数据库备份
- 定期备份整个 `data/` 目录
- 只添加你本人拥有或明确授权管理的邮箱
- 正式使用建议注册自己的 Azure 应用

## 相关文档

- [Docker 详细部署与 D1 迁移](./docs/DOCKER.md)
- [外部 API 文档](./docs/API.md)
- [Azure OAuth 配置参考](./docs/GUIDE.md#自己注册-azure-应用)
- [English README](./README_EN.md)

## 免责声明

本项目仅供个人学习和管理自己拥有或已获授权的邮箱。不得用于未授权访问他人邮箱、窃取邮件、绕过访问控制或其他违法用途。使用者应自行承担部署和使用本项目产生的责任。

## 许可证

本项目使用 [GPL-3.0](./LICENSE) 协议开源。你可以使用、修改和分发本项目，但公开分发的衍生版本也必须按照 GPL-3.0 提供完整源代码。
