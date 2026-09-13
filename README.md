# docker-outlook-email

一个自托管的 **Outlook / Hotmail 邮箱集中管理后台**。

项目通过 Microsoft Graph API 读取已授权邮箱，使用 **Docker Compose + Node.js + Hono + SQLite** 运行。账号资料、系统设置和任务状态保存在自己的服务器上，邮件内容按需从微软接口读取。

> 本项目不是邮箱注册工具，也不是邮件服务器。只能管理你本人拥有或已明确授权使用的邮箱账号。

## 功能

### 邮箱账号管理

- 集中管理 Outlook、Hotmail、Live 等微软邮箱
- 单个添加、OAuth 授权和批量导入账号
- 支持粘贴文本、选择多个 TXT、选择整个文件夹导入
- 大批量账号分块查询和写入，应用层不设置固定文件数、账号行数或文本长度上限
- 自动识别新增、重复、格式错误和字段错误，并显示分类结果
- 批量导出、删除、移动分组、启用和停用账号
- 分组、标签、状态、邮箱和备注筛选
- 保存国家、IP 类型等账号信息；外部 API 支持按这些字段筛选

批量导入格式：

```text
邮箱----密码----client_id----refresh_token
```

实际可处理的数据量仍取决于浏览器内存、反向代理请求体限制和服务器资源。

### 邮件管理

- 查看收件箱、垃圾邮件和已删除邮件
- “全部”视图按时间聚合收件箱和垃圾邮件
- 查看纯文本或 HTML 邮件正文
- 搜索邮件；通过外部 API 提取验证码
- 下载邮件附件
- 单封或批量将邮件移入“已删除邮件”文件夹
- 统计每个邮箱的收件箱邮件数

> 删除邮件需要微软应用具有 `Mail.ReadWrite` 权限。只有 `Mail.Read` 权限时可以读取，但可能无法删除。

### Token 与后台任务

- 测试账号连接和授权状态
- 批量刷新 Microsoft Refresh Token
- 自动保存微软轮换后的新 Refresh Token
- 后台执行批量检测、Token 刷新和邮件数统计
- 关闭或刷新浏览器后，已创建的后台任务继续运行
- 可配置定时刷新 Token

### 推送与接口

- Telegram 新邮件推送
- API Key 鉴权的外部接口
- 通过接口读取账号、邮件和验证码
- GPTMail 临时邮箱集成
- 中文、英文界面
- 深色、浅色和跟随系统主题

## 安装

### 1. 准备环境

推荐使用 Linux 服务器，需要安装：

- Git
- Docker Engine
- Docker Compose v2
- OpenSSL

确认环境：

```bash
git --version
docker --version
docker compose version
openssl version
```

### 2. 下载项目

```bash
git clone https://github.com/zzusec/cf-outlook-email.git
cd cf-outlook-email
```

### 3. 创建配置

```bash
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`：

```dotenv
# 管理后台初始密码
ADMIN_PASSWORD=请设置一个强密码

# Cookie 签名密钥，填写 openssl rand -hex 32 的输出
COOKIE_SECRET=请替换为随机字符串

# 浏览器实际访问的地址；使用反向代理或 OAuth 时建议明确填写
PUBLIC_URL=https://mail.example.com

# 宿主机端口
APP_PORT=8787

# 默认只允许本机访问，由 Nginx/Caddy 对外提供 HTTPS
BIND_ADDRESS=127.0.0.1

# 可选，也可以登录后台后配置
# GPTMAIL_API_KEY=
```

配置说明：

| 变量 | 是否必填 | 默认值 | 用途 |
|---|:---:|---|---|
| `ADMIN_PASSWORD` | 是 | 无 | 数据库尚未保存密码哈希时使用的初始登录密码 |
| `COOKIE_SECRET` | 是 | 无 | 登录 Cookie 签名密钥，生成后应长期保持不变 |
| `PUBLIC_URL` | 推荐 | 根据请求推导 | 公网访问地址、OAuth 回调地址和安全 Cookie 判断 |
| `APP_PORT` | 否 | `8787` | 映射到宿主机的端口 |
| `BIND_ADDRESS` | 否 | `127.0.0.1` | 宿主机监听地址 |
| `GPTMAIL_API_KEY` | 否 | 无 | GPTMail API Key |

注意：

- 复制 `.env.example` 后必须替换 `ADMIN_PASSWORD` 和 `COOKIE_SECRET` 的占位文本。程序只检查它们是否为空，不会识别示例占位值；直接使用示例值会导致密码和 Cookie 密钥可预测。
- 缺少 `ADMIN_PASSWORD` 或 `COOKIE_SECRET` 时，服务会拒绝启动。
- `PUBLIC_URL` 只能填写协议、主机和可选端口，不能包含业务路径、参数或锚点。
- 第一次成功登录后，密码哈希会写入 SQLite。以后应在后台修改密码，仅修改 `.env` 不会覆盖数据库中的密码。
- 修改 `COOKIE_SECRET` 会使现有登录会话全部失效。

### 4. 构建并启动

```bash
docker compose up -d --build
```

查看状态和日志：

```bash
docker compose ps
docker compose logs --tail=200 outlook-email
```

健康检查（以下命令假设使用默认的 `APP_PORT=8787`）：

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

如果修改了 `APP_PORT`，宿主机健康检查和反向代理上游端口也要改成相同值。容器内部端口始终为 `8787`。

正常返回：

```json
{"status":"ok"}
```

也可以查看 Docker 健康状态：

```bash
docker inspect --format='{{.State.Health.Status}}' outlook-email
```

正常应输出：

```text
healthy
```

首次启动会自动：

1. 创建 `./data` 数据目录
2. 创建 `./data/outlook-email.db`
3. 执行 `migrations/` 中尚未运行的数据库迁移
4. 启动 Web 服务和后台调度器

数据映射关系：

```text
宿主机：./data
容器内：/data
数据库：./data/outlook-email.db
```

### 5. 配置 HTTPS

生产环境建议保持：

```dotenv
BIND_ADDRESS=127.0.0.1
APP_PORT=8787
PUBLIC_URL=https://mail.example.com
```

然后通过同一台服务器上的 Nginx 或 Caddy 提供 HTTPS。最小 Nginx 代理配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

配置后检查：

```bash
curl -fsS https://mail.example.com/healthz
```

如果只是临时通过服务器 IP 测试，可以使用：

```dotenv
PUBLIC_URL=http://服务器IP:8787
BIND_ADDRESS=0.0.0.0
APP_PORT=8787
```

> 不建议在生产环境直接将管理后台的 HTTP 端口暴露到公网。

## 添加 Outlook 邮箱

登录后台后可以通过以下方式添加账号：

- 填写 Client ID 和 Refresh Token
- 使用默认 Client ID 完成手动授权
- 使用自己注册的 Azure 应用进行网页一键授权
- 批量粘贴或读取 TXT 文件

默认提供的 Thunderbird Client ID 可以用于回调地址为 `https://localhost` 的手动授权流程，但不能用于自己网站域名上的 OAuth 回调。

如果需要网页一键授权，请注册自己的 Azure 应用，并添加重定向 URI：

```text
https://mail.example.com/api/oauth/callback
```

该项目使用不带 Client Secret 的公共客户端授权流程。Azure 应用需要：

- 账户类型包含个人 Microsoft 账户
- 允许公共客户端流
- 不要配置成必须提供 Client Secret 的 Web 机密客户端
- 授予 `Mail.ReadWrite` 和 `offline_access` 委托权限

具体配置步骤见 [Azure OAuth 配置参考](./docs/GUIDE.md#自己注册-azure-应用)。

## 升级

项目镜像在服务器上从源码构建，没有远程预构建镜像。升级时必须拉取代码并重新构建，单独执行 `docker compose pull` 无法完成升级。

### 1. 备份

SQLite 使用 WAL 模式。升级前应停止服务，并备份完整的 `data/` 和 `.env`：

```bash
cd /path/to/cf-outlook-email || exit 1

# 记录回退时需要匹配的源码版本
git rev-parse HEAD || exit 1

# 停止服务，确保 SQLite WAL 完整落盘
# 备份完成后保持停止，直接进行下一步升级
docker compose stop || exit 1
umask 077
backup="../cf-outlook-email-backup-$(date +%F-%H%M%S).tar.gz"
tar -czf "$backup" data .env || { docker compose start; exit 1; }
```

如果备份后决定取消升级，可以执行 `docker compose start` 恢复旧版本服务。

不要只复制 `data/outlook-email.db`，完整数据目录中还可能包含：

```text
outlook-email.db-wal
outlook-email.db-shm
```

### 2. 拉取并重建

```bash
cd /path/to/cf-outlook-email
git pull --ff-only
docker compose up -d --build --remove-orphans
```

`--ff-only` 可以避免服务器意外生成自动合并提交。如果服务器工作区有本地修改，应先处理这些修改，不要直接强制覆盖。

### 3. 验证升级

```bash
docker compose ps
docker compose logs --tail=200 outlook-email
curl -fsS http://127.0.0.1:8787/healthz
docker inspect --format='{{.State.Health.Status}}' outlook-email
git log -1 --oneline
```

容器启动时会自动执行新增的数据库迁移，不需要手动修改 SQLite 表结构。

### 升级失败

先查看日志：

```bash
docker compose logs --tail=300 outlook-email
```

源码回退不等于数据库回退。如果新版本已经执行数据库迁移，需要完整回退时，应同时恢复：

- 升级前的源码版本
- 升级前备份的完整 `data/` 目录
- 对应的 `.env`

不要让两个版本同时使用同一个 SQLite 数据目录。

## 卸载

### 停止服务但保留数据

```bash
cd /path/to/cf-outlook-email
docker compose down --remove-orphans
```

该命令会删除容器和 Compose 网络，但不会删除绑定挂载的：

```text
./data
```

以后可以重新启动：

```bash
docker compose up -d
```

### 删除本地构建镜像

```bash
docker compose down --remove-orphans
docker image rm docker-outlook-email:local
```

如果镜像仍被其他容器引用，Docker 会拒绝删除。应先检查相关容器，不建议默认使用强制删除参数。

### 彻底卸载并删除数据

先把需要保留的备份移到项目目录之外，然后执行：

```bash
input_dir=/path/to/cf-outlook-email
project_dir=$(realpath -e "$input_dir") || { echo "项目路径不存在"; exit 1; }

# 防止路径为空、写成根目录或指向错误项目
case "$project_dir" in
    /*) ;;
    *) echo "必须使用绝对路径"; exit 1 ;;
esac
[ "$project_dir" != "/" ] || { echo "不能删除根目录"; exit 1; }
[ -f "$project_dir/docker-compose.yml" ] || { echo "未找到 docker-compose.yml"; exit 1; }
[ -d "$project_dir/data" ] || { echo "未找到数据目录"; exit 1; }

cd "$project_dir" || exit 1
docker compose down --remove-orphans || exit 1
if docker image inspect docker-outlook-email:local >/dev/null 2>&1; then
    docker image rm docker-outlook-email:local || exit 1
fi

cd / || exit 1
rm -rf -- "$project_dir"
```

> 最后一条命令会永久删除源码、`.env`、SQLite 数据、账号资料、Refresh Token 和全部系统设置，无法撤销。执行前请再次确认 `project_dir` 是正确的绝对路径，并确保备份存放在项目目录之外。

本项目使用 `./data:/data` 绑定挂载，不是 Docker 命名卷。因此 `docker compose down -v` 不会代替你删除宿主机上的 `./data`。

## 常用命令

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f --tail=200 outlook-email

# 停止/启动
docker compose stop
docker compose start

# 重启
docker compose restart outlook-email

# 重新构建
docker compose up -d --build --remove-orphans

# 健康检查
curl -fsS http://127.0.0.1:8787/healthz
```

## 数据安全

`data/`、`.env`、数据库备份和账号导出文件可能包含：

- Microsoft Refresh Token 和 Client ID
- 批量导入时保存的邮箱密码
- 管理后台登录密码哈希
- 外部 API Key
- Telegram Bot Token 和 Chat ID
- GPTMail API Key
- 邮箱、分组、标签和任务记录

请将这些文件视为高敏感数据，不要上传到 GitHub、公开网盘或发送给不可信人员。

## 相关文档

- [Docker 部署与 D1 数据迁移](./docs/DOCKER.md)
- [外部 API 文档](./docs/API.md)
- [Azure OAuth 配置参考](./docs/GUIDE.md#自己注册-azure-应用)
- [English README](./README_EN.md)

## 许可证

本项目使用 [GPL-3.0](./LICENSE) 协议开源。
