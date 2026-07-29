import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first, run, query } from '../db';
import { ok, fail } from '../response';
import { getAccessToken, fetchEmails, fetchEmailDetail } from '../graph';

// External API: fetch emails by API key, no login required.
// Mounted BEFORE the cookie auth middleware so it is not gated by sessions.
const external = new Hono<{ Bindings: Env }>();

// API-key auth: accept `X-API-Key` header or `?key=` query param
external.use('*', async (c, next) => {
  const row = await first<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'external_api_key'",
    []
  );
  const configured = row?.value;
  if (!configured) {
    return fail('API_DISABLED', '对外 API 未启用：请在「系统设置」生成 API Key', 403);
  }
  const provided = c.req.header('X-API-Key') || c.req.query('key') || '';
  if (provided !== configured) {
    return fail('UNAUTHORIZED', 'API Key 无效', 401);
  }
  await next();
});

// GET /api/external/accounts - 获取所有邮箱列表
external.get('/accounts', async (c) => {
  const country = c.req.query('country')?.trim() || '';
  const ipType = c.req.query('ip_type')?.trim() || '';

  let sql = `SELECT id, email, status, remark, country, ip_type, created_at FROM accounts WHERE status != 'disabled'`;
  const params: string[] = [];

  if (country) {
    sql += ' AND country = ?';
    params.push(country);
  }

  if (ipType) {
    sql += ' AND ip_type = ?';
    params.push(ipType);
  }

  sql += ' ORDER BY email';

  const rows = await query<AccountRow>(c.env.DB, sql, params);
  const items = rows.map((r) => ({
    email: r.email,
    status: r.status,
    remark: r.remark || '',
    country: r.country || '',
    ip_type: r.ip_type || '',
  }));
  return ok({ count: items.length, items });
});

// 验证码提取正则：支持4-8位数字/字母验证码
const CODE_PATTERNS = [
  // 明确的验证码标识
  /(?:验证码|verification\s*code|code|验证码为|code\s*is|安全码|security\s*code|动态码|dynamic\s*code|校验码|check\s*code|确认码|confirmation\s*code|验证码[:：]\s*|Code[:：]\s*|PIN|密码|password|passcode)[\s:： ]*([A-Za-z0-9]{4,8})\b/i,
  // 纯数字验证码（常见格式）
  /\b(\d{4,8})\b/g,
];

// 从邮件内容提取验证码
function extractCodes(text: string): string[] {
  const codes: Set<string> = new Set();
  const lowerText = text.toLowerCase();

  // 检查是否包含验证码相关关键词
  const hasCodeKeyword = /验证码|verification|code|安全码|security|动态码|dynamic|校验码|check|确认码|confirmation|pin|密码|password|passcode/i.test(text);

  if (!hasCodeKeyword) {
    return [];
  }

  for (const pattern of CODE_PATTERNS) {
    const matches = text.matchAll(pattern instanceof RegExp && pattern.global ? pattern : new RegExp(pattern.source, 'gi'));
    for (const match of matches) {
      if (match[1] && match[1].length >= 4 && match[1].length <= 8) {
        // 过滤掉常见的非验证码数字（年份、日期等）
        const code = match[1];
        if (/^\d{4}$/.test(code) && (code.startsWith('20') || code.startsWith('19'))) {
          continue; // 跳过年份
        }
        codes.add(code);
      }
    }
  }

  return Array.from(codes);
}

// GET /api/external/emails?email=<addr>&folder=inbox|junkemail|deleteditems|all&top=10&keyword=
// GET /api/external/emails?email=<addr>&extract_code=1 - 提取验证码
external.get('/emails', async (c) => {
  const email = (c.req.query('email') || '').trim().toLowerCase();
  if (!email) return fail('BAD_REQUEST', '缺少 email 参数', 400);

  const folder = c.req.query('folder') || 'inbox';
  const top = Math.min(parseInt(c.req.query('top') || '10', 10) || 10, 50);
  const keyword = c.req.query('keyword') || undefined;
  const extractCode = c.req.query('extract_code') === '1';

  const acc = await first<AccountRow>(
    c.env.DB,
    'SELECT * FROM accounts WHERE lower(email) = ?',
    [email]
  );
  if (!acc) return fail('NOT_FOUND', '账号不存在', 404);
  if (acc.status === 'disabled') return fail('DISABLED', '该账号已停用', 400);

  const tok = await getAccessToken(acc.client_id, acc.refresh_token);
  if (!tok.token) {
    await run(c.env.DB, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
    return fail('TOKEN_FAILED', tok.error?.message || 'Token 获取失败', 502);
  }
  // Persist a rotated refresh_token if Microsoft issued one
  if (tok.newRefreshToken && tok.newRefreshToken !== acc.refresh_token) {
    await run(
      c.env.DB,
      "UPDATE accounts SET refresh_token = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [tok.newRefreshToken, acc.id]
    );
  } else if (acc.status === 'error') {
    // Token works without rotation: clear the stale error flag
    await run(c.env.DB, "UPDATE accounts SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
  }

  const result = await fetchEmails(tok.token, { folder, top, skip: 0, keyword });
  if (result.error) return fail('GRAPH_ERROR', result.error.message, 502);

  // 如果需要提取验证码，获取邮件详情并提取
  if (extractCode && result.items?.length) {
    const itemsWithCodes = await Promise.all(
      result.items.slice(0, 10).map(async (e) => {
        // 获取邮件详情以获取完整内容
        const detail = await fetchEmailDetail(tok.token!, e.id);
        const bodyText = detail.item?.body?.content || e.bodyPreview || '';
        const codes = extractCodes(bodyText);

        return {
          id: e.id,
          subject: e.subject ?? '(无主题)',
          from: {
            name: e.from?.emailAddress?.name ?? '',
            address: e.from?.emailAddress?.address ?? '',
          },
          receivedDateTime: e.receivedDateTime,
          bodyPreview: e.bodyPreview ?? '',
          isRead: e.isRead,
          codes,
        };
      })
    );

    return ok({ email, folder, count: itemsWithCodes.length, items: itemsWithCodes });
  }

  const items = (result.items ?? []).map((e) => ({
    id: e.id,
    subject: e.subject ?? '(无主题)',
    from: {
      name: e.from?.emailAddress?.name ?? '',
      address: e.from?.emailAddress?.address ?? '',
    },
    receivedDateTime: e.receivedDateTime,
    bodyPreview: e.bodyPreview ?? '',
    isRead: e.isRead,
  }));

  return ok({ email, folder, count: items.length, items });
});

export default external;