import { Hono } from 'hono';
import type { Env, AccountRow } from '../types';
import { first, run, getSetting } from '../db';
import { ok, fail, badRequest } from '../response';
import { isValidEmail } from '../utils/validation';
import { getMailAccessToken, isPermanentTokenFailure } from '../graph';

// Ingest API: let external automation (register scripts) push accounts into
// the pool via API key, no login required. Mounted BEFORE cookie auth.
//
// Auth reuses external_api_key (the same key the read-only /api/external/emails
// endpoint uses), so the admin manages one key for both directions. Upsert is
// keyed by email: existing accounts get their credentials refreshed, new ones
// are created. A deliberately-disabled account is never auto-re-enabled by a
// push (the admin's manual hold survives automation).
const ingest = new Hono<{ Bindings: Env }>();

// API-key auth: accept `X-API-Key` header or `?key=` query param
ingest.use('*', async (c, next) => {
  const configured = await getSetting(c.env.DB, 'external_api_key');
  if (!configured) {
    return fail('API_DISABLED', '对外 API 未启用：请在「系统设置」生成 API Key', 403);
  }
  const provided = c.req.header('X-API-Key') || c.req.query('key') || '';
  if (provided !== configured) {
    return fail('UNAUTHORIZED', 'API Key 无效', 401);
  }
  await next();
});

interface IngestAccount {
  email: string;
  password?: string;
  client_id: string;
  refresh_token: string;
  group_id?: number;
  remark?: string;
  country?: string;
  ip_type?: string;
}

// POST /api/ingest/accounts
// Body: an array of accounts, or a single account object.
ingest.post('/accounts', async (c) => {
  const json = await c.req.json().catch(() => null);
  if (json === null) return badRequest('请求体不是合法 JSON');

  const list: IngestAccount[] = Array.isArray(json) ? json : [json];
  if (!list.length) return badRequest('没有账号');

  // Whether to drop accounts whose refresh_token is permanently invalid.
  // Defaults to deleting (the pool only wants usable mailboxes); the admin can
  // turn it off via token_refresh_delete_invalid = '0'.
  const deleteInvalid = (await getSetting(c.env.DB, 'token_refresh_delete_invalid')) !== '0';

  let inserted = 0;
  let updated = 0;
  const errors: Array<{ email: string; reason: string }> = [];

  for (const item of list) {
    const email = (item.email || '').trim();
    const clientId = (item.client_id || '').trim();
    const refreshToken = (item.refresh_token || '').trim();
    if (!email || !clientId || !refreshToken) {
      errors.push({ email: email || '(空)', reason: '缺少 email/client_id/refresh_token' });
      continue;
    }
    if (!isValidEmail(email)) {
      errors.push({ email, reason: '邮箱格式不正确' });
      continue;
    }

    // Upsert keyed by lowercased email. A fresh refresh_token clears a stale
    // 'error' verdict (the error referred to the old token). Deliberate
    // 'disabled' is preserved so the admin's manual hold survives pushes.
    const existing = await first<AccountRow>(c.env.DB, 'SELECT id, status FROM accounts WHERE LOWER(email) = ?', [email.toLowerCase()]);
    if (existing) {
      // A brand-new refresh_token means the old error verdict no longer applies.
      // Verify the token before trusting it — if Microsoft rejects it, either
      // delete the row (deleteInvalid) or mark error, so the pool stays clean.
      let nextStatus = existing.status;
      if (existing.status !== 'disabled') {
        const probe = await getMailAccessToken(clientId, refreshToken);
        if (probe.token) {
          nextStatus = 'active';
        } else if (isPermanentTokenFailure(probe.error)) {
          if (deleteInvalid) {
            await run(c.env.DB, 'DELETE FROM account_tags WHERE account_id = ?', [existing.id]);
            await run(c.env.DB, 'DELETE FROM accounts WHERE id = ?', [existing.id]);
            errors.push({ email, reason: 'refresh_token 已失效，账号已删除' });
            continue;
          }
          nextStatus = 'error';
        }
      }

      await run(
        c.env.DB,
        `UPDATE accounts SET password = ?, client_id = ?, refresh_token = ?, status = ?, remark = ?, country = COALESCE(?, country), ip_type = COALESCE(?, ip_type), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [
          item.password ?? '',
          clientId,
          refreshToken,
          nextStatus,
          item.remark ?? '',
          item.country ?? null,
          item.ip_type ?? null,
          existing.id,
        ]
      );
      updated++;
    } else {
      // New account: insert, then probe to set the right initial status
      const result = await run(
        c.env.DB,
        'INSERT INTO accounts (email, password, client_id, refresh_token, group_id, remark, country, ip_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          email,
          item.password ?? '',
          clientId,
          refreshToken,
          item.group_id ?? 1,
          item.remark ?? '',
          item.country ?? '',
          item.ip_type ?? '',
          'active',
        ]
      );
      const newId = result.meta.last_row_id as number;
      const probe = await getMailAccessToken(clientId, refreshToken);
      if (!probe.token && isPermanentTokenFailure(probe.error)) {
        if (deleteInvalid) {
          await run(c.env.DB, 'DELETE FROM accounts WHERE id = ?', [newId]);
          errors.push({ email, reason: 'refresh_token 已失效，未入库' });
          continue;
        }
        await run(c.env.DB, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [newId]);
      }
      inserted++;
    }
  }

  return ok(
    { inserted, updated, errors },
    `新增 ${inserted}，更新 ${updated}` + (errors.length ? `，失败 ${errors.length}` : '')
  );
});

export default ingest;
