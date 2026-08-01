import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importAccounts } from '../src/accountImport';
import accountsRoute from '../src/routes/accounts';
import { first, query, run } from '../src/db';
import { applyMigrations, openDatabase, type SqliteD1Database } from '../server/sqlite';

const tempDirs: string[] = [];
const openDatabases: SqliteD1Database[] = [];

function createDatabase() {
  const dir = mkdtempSync(resolve(tmpdir(), 'cf-outlook-import-'));
  tempDirs.push(dir);
  const db = openDatabase(resolve(dir, 'test.db'));
  openDatabases.push(db);
  applyMigrations(db, resolve('migrations'));
  return { db, d1: db as unknown as D1Database };
}

async function postImport(
  db: D1Database,
  body: unknown,
  options: { path?: '/' | '/import'; contentType?: string; rawBody?: string } = {}
) {
  const path = options.path ?? '/import';
  const headers: Record<string, string> = {};
  if (options.contentType !== '') headers['Content-Type'] = options.contentType ?? 'application/json';
  return accountsRoute.request(
    path,
    {
      method: 'POST',
      headers,
      body: options.rawBody ?? JSON.stringify(body),
    },
    { DB: db } as never
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openDatabases.length) openDatabases.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

type ImportBody = {
  success: boolean;
  data: {
    total: number;
    blank: number;
    added: number;
    duplicates: number;
    invalid: number;
    results: Array<{ line: number; email: string; status: string; reason?: string; field?: string }>;
  };
  error?: { code: string; message: string };
};

describe('POST /api/accounts/import', () => {
  it('handles BOM, CRLF, blank passwords, strict four-part validation, and partial success', async () => {
    const { d1 } = createDatabase();
    await run(
      d1,
      'INSERT INTO accounts (email, password, client_id, refresh_token) VALUES (?, ?, ?, ?)',
      ['Stored@Example.com', 'stored-password', 'stored-client', 'stored-token']
    );

    const password = 'secret-password';
    const clientId = 'client-sensitive';
    const refreshToken = 'refresh-sensitive';
    const accountString = [
      `﻿First@Example.com--------${clientId}----${refreshToken}`,
      '',
      'too-many@example.com----password----client----token----extra',
      'not-an-email----password----client----token',
      'missing@example.com----password--------token',
      `Second@Example.com----${password}----client-two----token-two`,
      'second@example.com----other-password----other-client----other-token',
      'stored@example.com----password----client----token',
    ].join('\r\n');

    const response = await postImport(d1, { account_string: accountString, group_id: 1 });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(password);
    expect(responseText).not.toContain(clientId);
    expect(responseText).not.toContain(refreshToken);

    const body = JSON.parse(responseText) as ImportBody;
    expect(body.data).toMatchObject({ total: 7, blank: 1, added: 2, duplicates: 2, invalid: 3 });
    expect(body.data.results).toEqual([
      { line: 1, email: 'First@Example.com', status: 'added' },
      { line: 3, email: '', status: 'invalid', reason: 'format' },
      { line: 4, email: 'not-an-email', status: 'invalid', reason: 'invalid_email' },
      { line: 5, email: 'missing@example.com', status: 'invalid', reason: 'client_id_required' },
      { line: 6, email: 'Second@Example.com', status: 'added' },
      { line: 7, email: 'second@example.com', status: 'duplicate', reason: 'duplicate_in_input' },
      { line: 8, email: 'stored@example.com', status: 'duplicate', reason: 'already_exists' },
    ]);

    const inserted = await query<{ email: string; password: string }>(
      d1,
      'SELECT email, password FROM accounts ORDER BY id'
    );
    expect(inserted).toEqual([
      { email: 'Stored@Example.com', password: 'stored-password' },
      { email: 'First@Example.com', password: '' },
      { email: 'Second@Example.com', password },
    ]);
  });

  it('classifies length and control-character failures without exposing secret fields', async () => {
    const { d1 } = createDatabase();
    const longPassword = 'p'.repeat(1025);
    const longClientId = 'c'.repeat(257);
    const longToken = 't'.repeat(8193);
    const accountString = [
      `${'a'.repeat(250)}@x.co----password----client----token`,
      `password@example.com----${longPassword}----client----token`,
      `client@example.com----password----${longClientId}----token`,
      `token@example.com----password----client----${longToken}`,
      'required@example.com----password----client----',
      'control@example.com----password----client\tvalue----token',
    ].join('\n');

    const response = await postImport(d1, { account_string: accountString });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(longPassword);
    expect(responseText).not.toContain(longClientId);
    expect(responseText).not.toContain(longToken);

    const body = JSON.parse(responseText) as ImportBody;
    expect(body.data).toMatchObject({ total: 6, blank: 0, added: 0, duplicates: 0, invalid: 6 });
    expect(body.data.results.map((result) => result.reason)).toEqual([
      'email_too_long',
      'password_too_long',
      'client_id_too_long',
      'refresh_token_too_long',
      'refresh_token_required',
      'control_character',
    ]);
    expect(body.data.results[5].field).toBe('client_id');
    expect(await query(d1, 'SELECT * FROM accounts')).toEqual([]);
  });

  it('returns explicit 4xx errors for non-JSON, invalid request types, empty input, and missing groups', async () => {
    const { d1 } = createDatabase();

    const cases: Array<{
      response: () => Promise<Response>;
      status: number;
      code: string;
    }> = [
      {
        response: () => postImport(d1, {}, { contentType: 'text/plain', rawBody: '{}' }),
        status: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      },
      {
        response: () => postImport(d1, {}, { rawBody: '{' }),
        status: 400,
        code: 'INVALID_JSON',
      },
      {
        response: () => postImport(d1, []),
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        response: () => postImport(d1, { account_string: 123 }),
        status: 400,
        code: 'INVALID_ACCOUNT_STRING',
      },
      {
        response: () => postImport(d1, { account_string: 'valid@example.com----p----c----t', group_id: '1' }),
        status: 400,
        code: 'INVALID_GROUP_ID',
      },
      {
        response: () => postImport(d1, { account_string: '   \n\r\n' }),
        status: 400,
        code: 'EMPTY_IMPORT',
      },
      {
        response: () => postImport(d1, { account_string: 'valid@example.com----p----c----t', group_id: 999 }),
        status: 404,
        code: 'GROUP_NOT_FOUND',
      },
    ];

    for (const testCase of cases) {
      const response = await testCase.response();
      expect(response.status).toBe(testCase.status);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe(testCase.code);
    }
  });

  it('imports more than 500 accounts and 200,000 characters in one request', async () => {
    const { d1 } = createDatabase();
    const refreshToken = 't'.repeat(400);
    const accountString = Array.from(
      { length: 600 },
      (_, index) => `user${index}@example.com----password----client----${refreshToken}`
    ).join('\n');
    expect(accountString.length).toBeGreaterThan(200000);

    const response = await postImport(d1, { account_string: accountString });
    expect(response.status).toBe(200);
    const body = await response.json() as ImportBody;
    expect(body.data).toMatchObject({ total: 600, blank: 0, added: 600, duplicates: 0, invalid: 0 });
    expect(body.data.results).toHaveLength(600);

    const rows = await query<{ count: number }>(d1, 'SELECT COUNT(*) AS count FROM accounts');
    expect(rows[0]?.count).toBe(600);
  });

  it('returns HTTP 200 with full classifications when nothing is added', async () => {
    const { d1 } = createDatabase();
    await run(
      d1,
      'INSERT INTO accounts (email, client_id, refresh_token) VALUES (?, ?, ?)',
      ['exists@example.com', 'client', 'token']
    );

    const response = await postImport(d1, {
      account_string: [
        'exists@example.com----password----client----token',
        'invalid----password----client----token',
      ].join('\n'),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as ImportBody;
    expect(body.data).toMatchObject({ total: 2, added: 0, duplicates: 1, invalid: 1 });
  });
});

describe('account import database writes', () => {
  it('chunks existing-email lookups at the D1 bound-parameter limit', async () => {
    const { db, d1 } = createDatabase();
    const insert = db.native.prepare(
      'INSERT INTO accounts (email, password, client_id, refresh_token) VALUES (?, ?, ?, ?)'
    );
    const lines: string[] = [];
    for (let index = 0; index < 101; index++) {
      insert.run(`user${index}@example.com`, 'password', 'client', 'token');
      lines.push(`USER${index}@EXAMPLE.COM----password----client----token`);
    }
    const batchSpy = vi.spyOn(db, 'batch');

    const result = await importAccounts(d1, lines.join('\n'), 1);

    expect(result).toMatchObject({ total: 101, added: 0, duplicates: 101, invalid: 0 });
    const lookupCall = batchSpy.mock.calls.find((call) =>
      call[0].every((statement) => statement.sql.startsWith('SELECT email FROM accounts'))
    );
    expect(lookupCall?.[0]).toHaveLength(2);
    expect(lookupCall?.[0].map((statement) => statement.params.length)).toEqual([100, 1]);
  });

  it('keeps concurrent imports partially successful when both race on the same email', async () => {
    const { db, d1 } = createDatabase();
    const originalBatch = db.batch.bind(db);
    let lookupCount = 0;
    let releaseLookups!: () => void;
    const bothLookupsReady = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    vi.spyOn(db, 'batch').mockImplementation(async (statements) => {
      if (statements.every((statement) => statement.sql.startsWith('SELECT email FROM accounts'))) {
        const result = await originalBatch(statements);
        lookupCount++;
        if (lookupCount === 2) releaseLookups();
        await bothLookupsReady;
        return result;
      }
      return originalBatch(statements);
    });

    const [firstResult, secondResult] = await Promise.all([
      importAccounts(
        d1,
        ['shared@example.com----p----c----t', 'only-first@example.com----p----c----t'].join('\n'),
        1
      ),
      importAccounts(
        d1,
        ['shared@example.com----p----c----t', 'only-second@example.com----p----c----t'].join('\n'),
        1
      ),
    ]);

    expect(firstResult.added + secondResult.added).toBe(3);
    expect(firstResult.duplicates + secondResult.duplicates).toBe(1);
    expect([...firstResult.results, ...secondResult.results]).toContainEqual({
      line: 1,
      email: 'shared@example.com',
      status: 'duplicate',
      reason: 'already_exists',
    });
    expect((await query<{ email: string }>(d1, 'SELECT email FROM accounts ORDER BY email')).map((row) => row.email)).toEqual([
      'only-first@example.com',
      'only-second@example.com',
      'shared@example.com',
    ]);
  });

  it('uses three insert statements for 41 accounts and rolls the whole batch back on failure', async () => {
    const { db, d1 } = createDatabase();
    db.native.exec(`
      CREATE TRIGGER fail_account_import
      BEFORE INSERT ON accounts
      WHEN NEW.email = 'user25@example.com'
      BEGIN
        SELECT RAISE(ABORT, 'forced import failure');
      END
    `);
    const batchSpy = vi.spyOn(db, 'batch');
    const accountString = Array.from(
      { length: 41 },
      (_, index) => `user${index}@example.com----password-${index}----client-${index}----token-${index}`
    ).join('\n');

    await expect(importAccounts(d1, accountString, 1)).rejects.toThrow(/forced import failure/);

    const insertCall = batchSpy.mock.calls.find((call) =>
      call[0].some((statement) => statement.sql.startsWith('INSERT INTO accounts'))
    );
    expect(insertCall?.[0]).toHaveLength(3);
    expect(insertCall?.[0].map((statement) => statement.params.length)).toEqual([100, 100, 5]);
    expect(await query(d1, 'SELECT * FROM accounts')).toEqual([]);
  });
});

describe('legacy account creation compatibility', () => {
  it('keeps the legacy account_string success shape and added=0 error behavior', async () => {
    const { d1 } = createDatabase();
    const accountString = 'legacy@example.com----password----client----token';

    const addedResponse = await postImport(d1, { account_string: accountString }, { path: '/' });
    expect(addedResponse.status).toBe(200);
    expect(await addedResponse.json()).toEqual({
      success: true,
      data: { added: 1 },
      message: '成功添加 1 个账号',
    });

    const duplicateResponse = await postImport(d1, { account_string: accountString }, { path: '/' });
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toEqual({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: '没有新账号被添加（可能格式错误或已存在）',
      },
    });

    const numericStringGroupResponse = await postImport(
      d1,
      { account_string: 'legacy-string@example.com----password----client----token', group_id: '1' },
      { path: '/' }
    );
    expect(numericStringGroupResponse.status).toBe(200);
    expect(await numericStringGroupResponse.json()).toEqual({
      success: true,
      data: { added: 1 },
      message: '成功添加 1 个账号',
    });
  });

  it('keeps single-account creation response compatibility', async () => {
    const { d1 } = createDatabase();
    const response = await postImport(
      d1,
      {
        email: 'single@example.com',
        password: 'password',
        client_id: 'client',
        refresh_token: 'token',
        group_id: 1,
      },
      { path: '/' }
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { id: number }; message: string };
    expect(body).toEqual({ success: true, data: { id: 1 }, message: '账号添加成功' });
    expect(await first<{ email: string }>(d1, 'SELECT email FROM accounts WHERE id = ?', [1])).toEqual({
      email: 'single@example.com',
    });
  });
});
