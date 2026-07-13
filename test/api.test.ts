import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock D1 database
function createMockDB() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }),
  };
  return {
    prepare: vi.fn(() => mockStmt),
    _stmt: mockStmt,
  };
}

// Test crypto utilities
describe('crypto utils', () => {
  it('hashPassword produces consistent hex output', async () => {
    // Web Crypto is available in vitest with happy-dom or jsdom
    const { hashPassword } = await import('../src/utils/crypto');
    const hash1 = await hashPassword('test123');
    const hash2 = await hashPassword('test123');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  it('hmacSign and hmacVerify roundtrip', async () => {
    const { hmacSign, hmacVerify } = await import('../src/utils/crypto');
    const secret = 'test-secret-key';
    const payload = 'admin:1234567890';
    const sig = await hmacSign(payload, secret);
    expect(sig).toMatch(/^[0-9a-f]+$/);
    const valid = await hmacVerify(payload, sig, secret);
    expect(valid).toBe(true);
    const invalid = await hmacVerify(payload, sig + 'x', secret);
    expect(invalid).toBe(false);
  });
});

// Test validation utilities
describe('validation utils', () => {
  it('isValidEmail accepts valid emails', async () => {
    const { isValidEmail } = await import('../src/utils/validation');
    expect(isValidEmail('user@outlook.com')).toBe(true);
    expect(isValidEmail('a.b@c.d')).toBe(true);
  });

  it('isValidEmail rejects invalid emails', async () => {
    const { isValidEmail } = await import('../src/utils/validation');
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-email')).toBe(false);
    expect(isValidEmail('@no-user.com')).toBe(false);
  });

  it('maskToken masks long strings', async () => {
    const { maskToken } = await import('../src/utils/validation');
    expect(maskToken('abcdefghijklmnop')).toBe('abcd****mnop');
    expect(maskToken('short')).toBe('****');
  });
});

// Test auth session
describe('auth session', () => {
  it('issueSessionCookie and verifySession roundtrip', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const secret = 'my-test-secret';
    const cookie = await issueSessionCookie(secret);
    expect(cookie).toContain('admin:');
    const valid = await verifySession(cookie, secret);
    expect(valid).toBe(true);
  });

  it('verifySession rejects tampered cookie', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const secret = 'my-test-secret';
    const cookie = await issueSessionCookie(secret);
    const tampered = cookie.slice(0, -4) + 'xxxx';
    const valid = await verifySession(tampered, secret);
    expect(valid).toBe(false);
  });

  it('verifySession rejects wrong secret', async () => {
    const { issueSessionCookie, verifySession } = await import('../src/auth');
    const cookie = await issueSessionCookie('secret-a');
    const valid = await verifySession(cookie, 'secret-b');
    expect(valid).toBe(false);
  });
});

// Test response helpers
describe('response helpers', () => {
  it('ok returns success JSON', async () => {
    const { ok } = await import('../src/response');
    const res = ok({ id: 1 }, 'created');
    const body = await res.json() as { success: boolean; data: { id: number }; message: string };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(1);
    expect(body.message).toBe('created');
  });

  it('fail returns error JSON with status', async () => {
    const { fail } = await import('../src/response');
    const res = fail('NOT_FOUND', 'not found', 404);
    expect(res.status).toBe(404);
    const body = await res.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// Test password verification logic
describe('verifyPassword', () => {
  it('verifies against ADMIN_PASSWORD when no hash stored', async () => {
    const { verifyPassword } = await import('../src/auth');
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(null); // No hash in DB
    mockDB._stmt.run.mockResolvedValue({}); // Store hash

    const result = await verifyPassword(mockDB as any, 'admin123', 'admin123');
    expect(result).toBe(true);
  });

  it('rejects wrong password', async () => {
    const { verifyPassword } = await import('../src/auth');
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(null);

    const result = await verifyPassword(mockDB as any, 'wrong', 'admin123');
    expect(result).toBe(false);
  });
});

describe('account connection tests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('verifies Inbox access, persists a rotated token, and keeps an empty Inbox count', async () => {
    const account = {
      id: 1,
      email: 'empty@outlook.com',
      client_id: 'client-id',
      refresh_token: 'old-token',
      password: '',
      group_id: 1,
      remark: '',
      status: 'active',
      inbox_total: null,
      inbox_count_updated_at: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    };
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(account),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    };
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn().mockResolvedValue([]),
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'new-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalItemCount: 0 }))));

    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/1/test', { method: 'POST' }),
      { DB: db } as any
    );
    const body = await res.json() as { success: boolean; data: { connected: boolean; inbox: { total: number; checked_at: string } } };

    expect(body.success).toBe(true);
    expect(body.data.connected).toBe(true);
    expect(body.data.inbox.total).toBe(0);
    expect(body.data.inbox.checked_at).toBeTruthy();
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(statement.bind).toHaveBeenLastCalledWith('new-token', 'active', 0, body.data.inbox.checked_at, 1);
  });

  it('rejects a connection-test batch larger than ten accounts', async () => {
    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', ids: Array.from({ length: 11 }, (_, i) => i + 1) }),
      }),
      { DB: {} } as any
    );
    const body = await res.json() as { success: boolean; error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('最多测试 10 个账号');
  });

  it('rejects the removed local password batch action', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() };
    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_password', ids: [1, 2] }),
      }), { DB: db } as any
    );
    const body = await res.json() as { success: boolean; error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('未知操作');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects malformed token input before writing credentials', async () => {
    const db = { prepare: vi.fn(), batch: vi.fn() };
    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_tokens', ids: [1], token_data: 'not-a-valid-token-line' }),
      }), { DB: db } as any
    );
    const body = await res.json() as { success: boolean; error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('格式错误');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects a refresh_tokens batch larger than ten accounts', async () => {
    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_tokens', ids: Array.from({ length: 11 }, (_, i) => i + 1) }),
      }),
      { DB: {} } as any
    );
    const body = await res.json() as { success: boolean; error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('最多刷新 10 个账号');
  });

  it('refreshes selected tokens, persists rotation, continues after failures, and never returns tokens', async () => {
    const rows = [
      {
        id: 1,
        email: 'rotate@outlook.com',
        client_id: 'client-1',
        refresh_token: 'secret-old-1',
        password: 'pwd-1',
        group_id: 1,
        remark: '',
        status: 'active',
        inbox_total: 3,
        inbox_count_updated_at: '2026-01-01',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
      {
        id: 2,
        email: 'same@outlook.com',
        client_id: 'client-2',
        refresh_token: 'secret-old-2',
        password: '',
        group_id: 1,
        remark: '',
        status: 'error',
        inbox_total: null,
        inbox_count_updated_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
      {
        id: 3,
        email: 'fail@outlook.com',
        client_id: 'client-3',
        refresh_token: 'secret-old-3',
        password: '',
        group_id: 1,
        remark: '',
        status: 'active',
        inbox_total: null,
        inbox_count_updated_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    ];
    const statement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: rows }),
      run: vi.fn().mockResolvedValue({}),
    };
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn().mockResolvedValue([]),
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-secret-1',
        refresh_token: 'secret-new-1',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-secret-2',
        // no refresh_token → success without rotation
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The refresh token has expired',
      }), { status: 400 })));

    const accounts = (await import('../src/routes/accounts')).default;
    const res = await accounts.fetch(
      new Request('https://example.test/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_tokens', ids: [1, 2, 3, 99] }),
      }),
      { DB: db } as any
    );
    const body = await res.json() as {
      success: boolean;
      data: {
        requested: number;
        refreshed: number;
        failed: number;
        results: Array<{ id: number; email: string; refreshed: boolean; rotated?: boolean; error?: { code: string; message: string } }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.requested).toBe(4);
    expect(body.data.refreshed).toBe(2);
    expect(body.data.failed).toBe(2);

    const byId = new Map(body.data.results.map((result) => [result.id, result]));
    expect(byId.get(1)).toMatchObject({ email: 'rotate@outlook.com', refreshed: true, rotated: true });
    expect(byId.get(2)).toMatchObject({ email: 'same@outlook.com', refreshed: true, rotated: false });
    expect(byId.get(3)?.refreshed).toBe(false);
    expect(byId.get(3)?.error?.code).toBe('invalid_grant');
    expect(byId.get(99)).toMatchObject({ email: '', refreshed: false });
    expect(byId.get(99)?.error?.code).toBe('NOT_FOUND');

    // Response must never leak credentials or access tokens.
    const raw = JSON.stringify(body);
    for (const secret of [
      'secret-old-1', 'secret-old-2', 'secret-old-3',
      'secret-new-1', 'access-secret-1', 'access-secret-2', 'pwd-1',
    ]) {
      expect(raw).not.toContain(secret);
    }

    // Rotated token persisted; non-rotated success only flips status; failure marks error.
    expect(statement.bind).toHaveBeenCalledWith('secret-new-1', 'active', 1);
    expect(statement.bind).toHaveBeenCalledWith('active', 2);
    expect(statement.bind).toHaveBeenCalledWith('error', 3);
    // One SELECT + three UPDATEs (missing id skips write)
    expect(statement.run).toHaveBeenCalledTimes(3);
  });
});
