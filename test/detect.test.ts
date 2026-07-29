// Background detection jobs run against a real SQLite database so the hand-written
// scope SQL (group / status / tag filters + id cursor) is actually exercised.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase, type SqliteD1Database } from '../server/sqlite';
import { first, query, run } from '../src/db';
import {
  advanceDetectJob,
  startDetectJob,
  stopDetectJob,
  getLatestDetectJob,
  type DetectJobRow,
} from '../src/detect';

const tempDirs: string[] = [];
const openDatabases: SqliteD1Database[] = [];

function createDatabase() {
  const dir = mkdtempSync(resolve(tmpdir(), 'cf-outlook-detect-'));
  tempDirs.push(dir);
  const db = openDatabase(resolve(dir, 'test.db'));
  openDatabases.push(db);
  applyMigrations(db, resolve('migrations'));
  return db as unknown as D1Database;
}

async function seedAccounts(db: D1Database, specs: Array<{ email: string; group: number; status?: string }>) {
  // Migration 0001 already seeds the default group as id 1
  await run(db, "INSERT OR IGNORE INTO groups (id, name, color) VALUES (1, 'g1', '#111'), (2, 'g2', '#222')");
  for (const spec of specs) {
    await run(
      db,
      `INSERT INTO accounts (email, client_id, refresh_token, password, group_id, remark, status)
       VALUES (?, 'cid', 'rt', '', ?, '', ?)`,
      [spec.email, spec.group, spec.status ?? 'active']
    );
  }
}

// Every probe: token call succeeds, the mail list call succeeds, the Inbox count returns 3.
function stubHealthyMailbox() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({
        access_token: 'at',
        scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
      }));
    }
    if (url.includes('/messages')) return new Response(JSON.stringify({ value: [] }));
    return new Response(JSON.stringify({ totalItemCount: 3 }));
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (openDatabases.length) openDatabases.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('background detection job', () => {
  it('walks one group only and finishes after covering it', async () => {
    const db = createDatabase();
    await seedAccounts(db, [
      { email: 'a1@x.c', group: 1 },
      { email: 'a2@x.c', group: 1 },
      { email: 'b1@x.c', group: 2 },
    ]);
    stubHealthyMailbox();

    const { job, created } = await startDetectJob(db, { group_id: 1, label: 'g1' });
    expect(created).toBe(true);
    expect(job.total).toBe(2);

    expect(await advanceDetectJob({ DB: db } as any)).toContain('+2');
    // Second pass has nothing left in scope, so the job settles as done
    expect(await advanceDetectJob({ DB: db } as any)).toContain('done');

    const finished = (await getLatestDetectJob(db)) as DetectJobRow;
    expect(finished.state).toBe('done');
    expect(finished.processed).toBe(2);
    expect(finished.connected).toBe(2);
    expect(finished.deleted).toBe(0);

    // Counts were written for the scoped group only
    const counted = await query<{ email: string; inbox_total: number | null }>(
      db, 'SELECT email, inbox_total FROM accounts ORDER BY id'
    );
    expect(counted.map((row) => row.inbox_total)).toEqual([3, 3, null]);
  });

  it('deletes mailboxes whose refresh token is permanently dead', async () => {
    const db = createDatabase();
    await seedAccounts(db, [{ email: 'dead@x.c', group: 1 }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }), { status: 400 }
    )));

    await startDetectJob(db, { group_id: 1 });
    await advanceDetectJob({ DB: db } as any);

    const job = (await getLatestDetectJob(db)) as DetectJobRow;
    expect(job.deleted).toBe(1);
    expect(job.failed).toBe(0);
    expect(await first(db, 'SELECT id FROM accounts')).toBeNull();
  });

  it('stops after the batch in flight and refuses a second concurrent job', async () => {
    const db = createDatabase();
    await seedAccounts(db, [{ email: 'a1@x.c', group: 1 }, { email: 'a2@x.c', group: 1 }]);
    stubHealthyMailbox();

    await startDetectJob(db, { group_id: 1 });
    const second = await startDetectJob(db, { group_id: 2 });
    expect(second.created).toBe(false);
    expect(second.job.scope_group_id).toBe(1);

    expect(await stopDetectJob(db)).toBe(true);
    expect(await advanceDetectJob({ DB: db } as any)).toContain('stopped');
    expect(((await getLatestDetectJob(db)) as DetectJobRow).state).toBe('stopped');
  });

  it('filters by status and tag together with the group', async () => {
    const db = createDatabase();
    await seedAccounts(db, [
      { email: 'ok@x.c', group: 1, status: 'active' },
      { email: 'bad@x.c', group: 1, status: 'error' },
    ]);
    await run(db, "INSERT INTO tags (id, name, color) VALUES (1, 'vip', '#0f0')");
    await run(db, 'INSERT INTO account_tags (account_id, tag_id) VALUES (2, 1)');

    const byStatus = await startDetectJob(db, { group_id: 1, status: 'error' });
    expect(byStatus.job.total).toBe(1);
    await run(db, "UPDATE detect_jobs SET state = 'done'");

    const byTag = await startDetectJob(db, { tag_id: 1 });
    expect(byTag.job.total).toBe(1);
  });
});

describe('background refresh job (selected accounts)', () => {
  it('refreshes only the picked ids and saves rotated tokens', async () => {
    const db = createDatabase();
    await seedAccounts(db, [
      { email: 'pick1@x.c', group: 1 },
      { email: 'skip@x.c', group: 1 },
      { email: 'pick2@x.c', group: 2 },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt-rotated',
      scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
    }))));

    const { job } = await startDetectJob(db, { kind: 'refresh', ids: [1, 3], label: '选中 2 个' });
    expect(job.kind).toBe('refresh');
    expect(job.total).toBe(2);

    await advanceDetectJob({ DB: db } as any);
    const finished = (await getLatestDetectJob(db)) as DetectJobRow;
    expect(finished.processed).toBe(2);
    expect(finished.connected).toBe(2);

    const rows = await query<{ email: string; refresh_token: string; inbox_total: number | null }>(
      db, 'SELECT email, refresh_token, inbox_total FROM accounts ORDER BY id'
    );
    expect(rows.map((row) => row.refresh_token)).toEqual(['rt-rotated', 'rt', 'rt-rotated']);
    // A refresh job must not spend calls on Inbox counts
    expect(rows.every((row) => row.inbox_total === null)).toBe(true);
  });

  it('keeps counting progress when a selected account was deleted meanwhile', async () => {
    const db = createDatabase();
    await seedAccounts(db, [{ email: 'gone@x.c', group: 1 }]);
    await run(db, 'DELETE FROM accounts WHERE id = 1');
    stubHealthyMailbox();

    await startDetectJob(db, { kind: 'refresh', ids: [1] });
    expect(await advanceDetectJob({ DB: db } as any)).toContain('skipped');
    expect(await advanceDetectJob({ DB: db } as any)).toContain('done');
    expect(((await getLatestDetectJob(db)) as DetectJobRow).processed).toBe(1);
  });
});

describe('detect routes', () => {
  it('routes /detect/* without colliding with /:id handlers', async () => {
    const db = createDatabase();
    await seedAccounts(db, [{ email: 'a1@x.c', group: 1 }]);
    stubHealthyMailbox();
    const accountsRoute = (await import('../src/routes/accounts')).default;

    const started = await accountsRoute.request(
      '/detect/start',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: 1 }) },
      { DB: db } as any
    );
    expect(started.status).toBe(200);
    const startBody = await started.json() as { data: DetectJobRow };
    expect(startBody.data.total).toBe(1);

    const status = await accountsRoute.request('/detect/status', {}, { DB: db } as any);
    const statusBody = await status.json() as { data: DetectJobRow };
    expect(statusBody.data.state).toBe('running');

    const stopped = await accountsRoute.request('/detect/stop', { method: 'POST' }, { DB: db } as any);
    const stopBody = await stopped.json() as { data: DetectJobRow };
    expect(stopBody.data.state).toBe('stopping');
  });
});
