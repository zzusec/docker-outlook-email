import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first, run, query } from '../db';
import { ok, fail } from '../response';
import { getAccessToken, fetchEmails, fetchEmailDetail } from '../graph';
import registrationRoutes, { extractRegistrationCodes } from '../registration';

// External API: fetch emails by API key, no login required.
// Mounted BEFORE the cookie auth middleware so it is not gated by sessions.
const external = new Hono<{ Bindings: Env }>();

// Registration routes use separate per-client environment secrets and accept
// credentials only through X-API-Key. The legacy read-only API keeps its existing
// settings-backed key contract for compatibility.
external.route('/registration', registrationRoutes);
external.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/registration/') || path.startsWith('/api/external/registration/')) {
    await next();
    return;
  }

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
  // Top-level `accounts` alias for grok-register / OutlookEmail adapter compatibility
  return ok({ count: items.length, items, accounts: items });
});

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
        const codes = extractRegistrationCodes(bodyText);

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

    return ok({ email, folder, count: itemsWithCodes.length, items: itemsWithCodes, emails: itemsWithCodes });
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

  return ok({ email, folder, count: items.length, items, emails: items });
});

export default external;
