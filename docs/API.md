# 对外 API 使用文档

用 API Key 免登录拉取指定邮箱的邮件，适合脚本自动获取验证码、集成到其他系统。

## 1. 启用 / 获取 API Key

登录后台 → **系统设置** → **对外 API** → 点「生成 API Key」。

- 生成后会显示完整 Key 和调用示例，点「复制」即可。
- 「重新生成」会让旧 Key **立即失效**；「停用」会关闭整个对外 API。
- Key 是明文存放在你自己的 D1 里，只有后台登录后能看到。

## 2. 接口

### 获取邮箱列表

```
GET /api/external/accounts
```

返回所有可用邮箱账号列表，支持按国家和IP类型筛选。

**参数**：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `country` | ❌ | 国家代码筛选（如 US、UK、CA 等） |
| `ip_type` | ❌ | IP类型筛选（`residential`住宅IP / `native`原生IP / `datacenter`机房IP） |

**返回示例**：

```json
{
  "success": true,
  "data": {
    "count": 100,
    "items": [
      { "email": "abc@outlook.com", "status": "active", "remark": "", "country": "US", "ip_type": "residential" },
      { "email": "test@hotmail.com", "status": "active", "remark": "测试账号", "country": "UK", "ip_type": "native" }
    ]
  }
}
```

**筛选示例**：

```bash
# 获取美国住宅IP的邮箱列表
curl "https://你的域名/api/external/accounts?key=你的Key&country=US&ip_type=residential"

# 获取所有英国邮箱
curl "https://你的域名/api/external/accounts?key=你的Key&country=UK"
```

### 获取邮件列表

```
GET /api/external/emails
```

**鉴权**（二选一）：

- 请求头：`X-API-Key: <你的Key>`
- 或查询参数：`?key=<你的Key>`

**参数**：

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `email` | ✅ | 要查询的邮箱地址（必须是后台已添加的账号） |
| `folder` | ❌ | `inbox`(默认) / `junkemail` / `deleteditems` / `all`（收件箱+垃圾箱合并） |
| `top` | ❌ | 返回条数，默认 10，最大 50 |
| `keyword` | ❌ | 搜索关键词 |
| `extract_code` | ❌ | 传 `1` 时自动从邮件中提取验证码，返回 `codes` 字段 |

## 3. 调用示例

**浏览器 / curl（查询参数方式）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com&key=你的Key&folder=all&top=5"
```

**请求头方式（更安全，Key 不出现在 URL / 日志里）**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com" \
  -H "X-API-Key: 你的Key"
```

**Python（取最新验证码的典型用法）**

```python
import re, requests

resp = requests.get(
    "https://你的域名/api/external/emails",
    params={"email": "abc@outlook.com", "folder": "all", "top": 5},
    headers={"X-API-Key": "你的Key"},
)
data = resp.json()
for mail in data["data"]["items"]:
    # 从主题或正文预览里提取 6 位数字验证码
    m = re.search(r"\b(\d{6})\b", mail["subject"] + " " + mail["bodyPreview"])
    if m:
        print("验证码:", m.group(1))
        break
```

**使用 `extract_code=1` 自动提取验证码**

```bash
curl "https://你的域名/api/external/emails?email=abc@outlook.com&key=你的Key&extract_code=1&top=5"
```

返回结果会包含 `codes` 字段：

```json
{
  "success": true,
  "data": {
    "email": "abc@outlook.com",
    "count": 1,
    "items": [
      {
        "id": "AAQ...",
        "subject": "Your verification code is 123456",
        "from": { "name": "Microsoft", "address": "account@microsoft.com" },
        "receivedDateTime": "2026-06-08T08:00:00Z",
        "bodyPreview": "Use code 123456 to sign in...",
        "isRead": false,
        "codes": ["123456"]
      }
    ]
  }
}
```

**获取邮箱列表**

```bash
curl "https://你的域名/api/external/accounts?key=你的Key"
```

返回所有可用邮箱，用于选择要查询的邮箱。

## 4. 返回格式

成功（HTTP 200）：

```json
{
  "success": true,
  "data": {
    "email": "abc@outlook.com",
    "folder": "all",
    "count": 2,
    "items": [
      {
        "id": "AAQ...",
        "subject": "Your verification code is 123456",
        "from": { "name": "Microsoft", "address": "account@microsoft.com" },
        "receivedDateTime": "2026-06-08T08:00:00Z",
        "bodyPreview": "Use code 123456 to sign in...",
        "isRead": false
      }
    ]
  }
}
```

失败：

```json
{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "API Key 无效" } }
```

## 5. 错误码

| HTTP | code | 含义 |
|:----:|------|------|
| 403 | `API_DISABLED` | 还没生成 API Key（去系统设置生成） |
| 401 | `UNAUTHORIZED` | Key 缺失或不正确 |
| 400 | `BAD_REQUEST` | 缺少 `email` 参数 |
| 404 | `NOT_FOUND` | 该邮箱不在后台账号列表里 |
| 400 | `DISABLED` | 该账号已被停用 |
| 502 | `TOKEN_FAILED` | 该账号 Token 失效，需在后台「重新授权」 |
| 502 | `GRAPH_ERROR` | 调用 Microsoft Graph 失败 |

## 6. 注册邮箱 Claim API

该 API 供注册服务以不透明 Claim 使用 Outlook Plus 收件人。调用方拿不到邮箱密码、Microsoft Client ID、Refresh Token 或 Access Token，也不能指定底层邮箱账号。

### 6.1 服务端配置

注册 API 使用与上文「对外 API」完全独立的、按客户端区分的环境 Secret。真实值不得写入仓库、`wrangler.toml`、前端或请求 URL。

Cloudflare Workers：

```bash
wrangler secret put REGISTRATION_KR_API_KEY
wrangler secret put REGISTRATION_US2_API_KEY
wrangler secret put REGISTRATION_CLAIM_SECRET
```

Docker / Node 可在 `.env` 中设置同名变量。也可以用一个 JSON Secret 扩展客户端：

```dotenv
REGISTRATION_API_KEYS={"kr":"随机强Key","us2":"另一个随机强Key"}
REGISTRATION_CLAIM_SECRET=独立的随机签名密钥
```

- `REGISTRATION_KR_API_KEY` 固定解析为 `client_id=kr`。
- `REGISTRATION_US2_API_KEY` 固定解析为 `client_id=us2`。
- `REGISTRATION_API_KEYS` 的 JSON 对象键是稳定的客户端 ID，值是各自独立的 API Key。
- Key 只能放在 `X-API-Key`；注册路由不接受 `?key=`。
- `REGISTRATION_CLAIM_SECRET` 用于从客户端 ID + `Idempotency-Key` 派生可重放的不透明 Claim。不要在仍有活跃 Claim 时轮换；服务仅在数据库保存 Claim 的 SHA-256 哈希。
- 未配置完整 Secret 时，注册 API 返回 `REGISTRATION_DISABLED` 或 `REGISTRATION_CONFIG_INVALID`，不会回退到管理员 API Key。

### 6.2 Claim 生命周期

- 软租约为 30 分钟；每次有效验证码轮询会续租，但不会超过创建后 2 小时的硬过期时间。
- 别名索引从主地址（索引 `0`）开始，然后是 `+1`、`+2`……。
- 完成、释放或过期的索引永久保留在账本中，绝不重新分配。
- 可用邮箱之间按历史分配数进行均衡，不会先耗尽单个邮箱。
- 同一物理邮箱的 Microsoft Token 刷新和查信会跨请求串行化，避免并发旋转 Refresh Token；锁被占用时 `/code` 返回 `ready:false` 和短重试提示。
- `complete` 只能在调用方已将注册结果持久化后调用；此前的失败、取消和停止使用 `release`。

### 6.3 分配 Claim

```http
POST /api/external/registration/claims
X-API-Key: <该客户端的注册 API Key>
Idempotency-Key: <一次注册尝试的稳定唯一 ID>
```

请求体为空。相同客户端重复提交相同 `Idempotency-Key` 会返回完全相同的 Claim 和收件人，不会再烧一个别名。

```json
{
  "success": true,
  "data": {
    "claim": "不透明Claim",
    "recipient": "mailbox+17@example.com",
    "expires_at": "2026-08-01T12:30:00.000Z"
  }
}
```

响应只包含 Claim、合成收件人和当前软租约过期时间。

### 6.4 轮询验证码

```http
POST /api/external/registration/code
X-API-Key: <该客户端的注册 API Key>
Content-Type: application/json

{"claim":"不透明Claim"}
```

尚未找到：

```json
{
  "success": true,
  "data": {
    "ready": false,
    "retry_after_seconds": 5,
    "expires_at": "2026-08-01T12:35:00.000Z"
  }
}
```

找到后：

```json
{
  "success": true,
  "data": {
    "ready": true,
    "code": "123456",
    "expires_at": "2026-08-01T12:35:00.000Z"
  }
}
```

服务会同时检查 Inbox 与 Junk，仅接受：

1. 邮件接收时间不早于 Claim 创建时间（允许少量时钟偏差）；
2. `toRecipients`、`X-Original-To`、`Delivered-To` 或 `Envelope-To` 中存在与 Claim 收件人完全相等的地址；
3. 该邮件未被任何其他 Claim 消费。

对于 `+N` Claim，只改写到主地址而没有上述精确 `+N` 证据的邮件不会匹配。选中的 Microsoft 消息 ID/指纹会先原子写入账本再返回验证码；重复轮询同一 Claim 返回同一消息的验证码，同一消息不能满足第二个 Claim。

### 6.5 完成 Claim

调用方完成本地持久化之后：

```http
POST /api/external/registration/complete
X-API-Key: <该客户端的注册 API Key>
Content-Type: application/json

{"claim":"不透明Claim"}
```

成功响应：`{"success":true,"data":{"completed":true}}`。重复调用保持成功；已释放或过期的 Claim 不会被改成完成。

### 6.6 释放 Claim

注册未持久化、失败、取消或停止时：

```http
POST /api/external/registration/release
X-API-Key: <该客户端的注册 API Key>
Content-Type: application/json

{"claim":"不透明Claim","reason":"registration_failure"}
```

允许的非敏感原因：`failed`、`canceled`、`timeout`、`stopped`、`proxy_failure`、`registration_failure`、`registration_failed`、`durable_save_failed`、`other`。其他输入统一记录为 `other`，防止把凭据或错误详情写入账本。重复释放保持成功；别名索引仍永久烧毁。

### 6.7 注册 API 错误码

| HTTP | code | 含义 |
|:----:|------|------|
| 503 | `REGISTRATION_DISABLED` | 注册 Secret 未配置，服务关闭 |
| 503 | `REGISTRATION_CONFIG_INVALID` | Secret 缺失、JSON 无效、客户端/Key 重复等配置错误 |
| 401 | `UNAUTHORIZED` | `X-API-Key` 缺失或无效 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 分配请求缺少有效 `Idempotency-Key` |
| 503 | `NO_ELIGIBLE_MAILBOX` | 当前没有 active 且凭据完整的 Outlook 邮箱 |
| 404 | `CLAIM_NOT_FOUND` | Claim 无效，或属于另一个客户端 |
| 410 | `CLAIM_EXPIRED` | 软租约或硬期限已过期 |
| 409 | `CLAIM_TERMINAL` | Claim 已完成/释放，不能执行冲突转换 |
| 502 | `TOKEN_FAILED` | Microsoft 授权失效 |
| 503 | `MICROSOFT_THROTTLED` | Microsoft 限流；遵循 `Retry-After` |
| 503 | `MICROSOFT_UNAVAILABLE` | Microsoft 网络或服务临时故障 |
| 503 | `MAILBOX_UNAVAILABLE` | Claim 对应邮箱临时不可用 |

错误响应不会包含 API Key、Claim、邮箱凭据、OAuth Token、验证码或 Microsoft 原始错误正文。结构化日志只记录内部 Claim ID、客户端 ID、邮箱 ID、别名索引、状态转换、耗时和净化后的失败分类。

## 7. 安全建议

- Key 等同于这些邮箱的读取权限，**不要写进前端代码或公开仓库**；优先用 `X-API-Key` 请求头而非 URL 参数（URL 会进日志/历史记录）。注册 Claim API 则只允许请求头。
- 怀疑旧版对外 API Key 泄露时，到系统设置点「重新生成」即可让旧 Key 立即失效；注册 Key 必须在部署环境 Secret 中轮换。
- 接口只能读取**后台已添加**的邮箱，无法访问任意邮箱。
