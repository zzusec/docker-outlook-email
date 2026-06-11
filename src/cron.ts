import type { Env, AccountRow } from './types';
import { query, first, run } from './db';
import { getAccessToken } from './graph';

// Hard cap per run: each account = 1 subrequest (token refresh); free plan allows 50/invocation
const MAX_BATCH = 40;

async function getSetting(db: D1Database, key: string): Promise<string | undefined> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [key, value]
  );
}

// Refresh a batch of the least-recently-updated accounts' tokens.
// Returns a short summary string (also persisted for the settings page to show).
export async function runTokenRefresh(env: Env, opts: { force?: boolean } = {}): Promise<string> {
  const db = env.DB;

  if (!opts.force) {
    const enabled = await getSetting(db, 'token_refresh_enabled');
    if (enabled !== '1') return 'skipped: disabled';

    // Interval gate — lets the user pick an effective interval larger than the base cron rate
    const intervalHours = parseInt((await getSetting(db, 'token_refresh_interval_hours')) || '24', 10) || 24;
    const lastRun = parseInt((await getSetting(db, 'token_refresh_last_run')) || '0', 10);
    const now = Date.now();
    if (lastRun && now - lastRun < intervalHours * 3600 * 1000) {
      return 'skipped: within interval';
    }
  }

  const batch = Math.min(
    parseInt((await getSetting(db, 'token_refresh_batch')) || '20', 10) || 20,
    MAX_BATCH
  );

  // Oldest-updated active accounts first, so refreshes rotate across runs
  const accounts = await query<AccountRow>(
    db,
    `SELECT * FROM accounts WHERE status != 'disabled' ORDER BY updated_at ASC LIMIT ?`,
    [batch]
  );

  let ok = 0;
  let fail = 0;
  for (const acc of accounts) {
    const res = await getAccessToken(acc.client_id, acc.refresh_token);
    if (res.token) {
      ok++;
      const newToken = res.newRefreshToken && res.newRefreshToken !== acc.refresh_token ? res.newRefreshToken : acc.refresh_token;
      await run(
        db,
        "UPDATE accounts SET refresh_token = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [newToken, acc.id]
      );
    } else {
      fail++;
      await run(db, "UPDATE accounts SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [acc.id]);
    }
  }

  const summary = `${new Date().toISOString()} 刷新 ${accounts.length} 个：成功 ${ok}，失败 ${fail}`;
  await setSetting(db, 'token_refresh_last_run', String(Date.now()));
  await setSetting(db, 'token_refresh_last_result', summary);
  return summary;
}
