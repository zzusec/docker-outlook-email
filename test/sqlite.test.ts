import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, importD1Data, openDatabase, type SqliteD1Database } from '../server/sqlite';
import { rewriteExternalUrl } from '../server/url';
import { batchRun, first, query, run } from '../src/db';

const tempDirs: string[] = [];
const openDatabases: SqliteD1Database[] = [];

function createDatabase() {
  const dir = mkdtempSync(resolve(tmpdir(), 'cf-outlook-email-'));
  tempDirs.push(dir);
  const db = openDatabase(resolve(dir, 'test.db'));
  openDatabases.push(db);
  return { dir, db };
}

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('SQLite D1 compatibility layer', () => {
  it('applies migrations once and supports the application DB helpers', async () => {
    const { db } = createDatabase();
    expect(applyMigrations(db, resolve('migrations'))).toEqual([
      '0001_init.sql',
      '0002_tags.sql',
      '0003_push_state.sql',
      '0004_inbox_counts.sql',
      '0007_add_country.sql',
      '0008_detect_jobs.sql',
      '0009_detect_job_kinds.sql',
      '0010_registration_alias_claims.sql',
      '0011_ingest_and_task_logs.sql',
    ]);
    expect(applyMigrations(db, resolve('migrations'))).toEqual([]);

    const d1 = db as unknown as D1Database;
    const inserted = await run(d1, 'INSERT INTO tags (name, color) VALUES (?, ?)', ['work', '#fff']);
    expect(inserted.meta.last_row_id).toBe(1);
    expect(await first<{ name: string }>(d1, 'SELECT name FROM tags WHERE id = ?', [1])).toEqual({ name: 'work' });
    expect(await query<{ name: string }>(d1, 'SELECT name FROM tags')).toEqual([{ name: 'work' }]);
  });

  it('returns rows from INSERT statements that use RETURNING', async () => {
    const { db } = createDatabase();
    applyMigrations(db, resolve('migrations'));
    const d1 = db as unknown as D1Database;

    const results = await batchRun<{ email: string }>(d1, [
      {
        sql: 'INSERT INTO accounts (email, client_id, refresh_token) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING email',
        params: ['returning@example.com', 'client', 'token'],
      },
      {
        sql: 'INSERT INTO accounts (email, client_id, refresh_token) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING email',
        params: ['returning@example.com', 'other-client', 'other-token'],
      },
    ]);

    expect(results.map((result) => result.results)).toEqual([
      [{ email: 'returning@example.com' }],
      [],
    ]);
  });

  it('rolls back all statements when a batch fails', async () => {
    const { db } = createDatabase();
    applyMigrations(db, resolve('migrations'));
    const d1 = db as unknown as D1Database;

    await expect(
      batchRun(d1, [
        { sql: 'INSERT INTO tags (name) VALUES (?)', params: ['duplicate'] },
        { sql: 'INSERT INTO tags (name) VALUES (?)', params: ['duplicate'] },
      ])
    ).rejects.toThrow();
    expect(await query(d1, 'SELECT * FROM tags')).toEqual([]);
  });

  it('imports a data-only D1 export into a fresh database', async () => {
    const { dir, db } = createDatabase();
    applyMigrations(db, resolve('migrations'));
    const dumpPath = resolve(dir, 'd1-data.sql');
    writeFileSync(
      dumpPath,
      [
        'BEGIN TRANSACTION;',
        "INSERT INTO groups (id, name, description, color) VALUES (1, 'Imported', '', '#000');",
        "INSERT INTO settings (key, value) VALUES ('site_name', 'Docker');",
        'COMMIT;',
      ].join('\n')
    );

    importD1Data(db, dumpPath);
    const d1 = db as unknown as D1Database;
    expect(await first<{ name: string }>(d1, 'SELECT name FROM groups WHERE id = 1')).toEqual({ name: 'Imported' });
    expect(await first<{ value: string }>(d1, "SELECT value FROM settings WHERE key = 'site_name'")).toEqual({
      value: 'Docker',
    });
    expect(() => importD1Data(db, dumpPath)).toThrow(/already contains application data/);
  });
});

describe('external URL rewriting', () => {
  it('uses PUBLIC_URL for OAuth and secure-cookie request URLs', () => {
    const request = new Request('http://127.0.0.1:8787/api/oauth/authorize?x=1');
    const rewritten = rewriteExternalUrl(request, 'https://mail.example.com');
    expect(rewritten.url).toBe('https://mail.example.com/api/oauth/authorize?x=1');
  });

  it('uses standard forwarded headers when PUBLIC_URL is absent', () => {
    const request = new Request('http://outlook-email:8787/api/auth/login', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'mail.example.com',
      },
    });
    expect(rewriteExternalUrl(request).url).toBe('https://mail.example.com/api/auth/login');
  });
});
