import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock D1 database that tracks every prepared statement's bindings and
// returns canned results. Helpers below swap `_stmt.first` / `_stmt.all`
// return values per test.
function createMockDB() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1, changes: 0 } }),
  };
  return {
    prepare: vi.fn(() => mockStmt),
    _stmt: mockStmt,
  };
}

// Ingest route: API-key-gated upsert into the account pool. Verifies the
// auth gate, the upsert-on-email behaviour, and that disabled accounts are
// preserved (not silently re-enabled by automation pushes). The token probe
// is stubbed via a global fetch mock so no real network call is made.
describe('ingest route', () => {
  beforeEach(() => {
    // Stub fetch so getMailAccessToken never hits the network. A 200 from
    // login.microsoftonline.com means the token probe succeeds and the
    // account is considered active.
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'tok', refresh_token: 'rt', token_type: 'Bearer' }),
    }) as unknown as typeof fetch;
  });

  function mockIngestDB(opts: {
    configuredKey?: string;
    existing?: Record<string, unknown> | null;
  }) {
    const mockDB = createMockDB();
    // first() call sequence:
    //   1. API-key lookup (external_api_key)
    //   2. per-account existence check (SELECT id, status)
    //   3. (for new accounts) none — insert via run()
    mockDB._stmt.first
      .mockResolvedValueOnce(opts.configuredKey ? { value: opts.configuredKey } : null)
      .mockResolvedValue(opts.existing === undefined ? null : opts.existing);
    return mockDB;
  }

  async function postIngest(mockDB: any, body: unknown, apiKey = 'omk_test') {
    const ingestRoute = (await import('../src/routes/ingest')).default;
    return ingestRoute.request('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(body),
    }, { DB: mockDB } as any);
  }

  it('rejects when API key is not configured', async () => {
    const mockDB = mockIngestDB({ configuredKey: undefined });
    const res = await postIngest(mockDB, [{ email: 'a@b.c', client_id: 'cid', refresh_token: 'rt' }]);
    expect(res.status).toBe(403);
  });

  it('rejects a wrong API key', async () => {
    const mockDB = mockIngestDB({ configuredKey: 'omk_real' });
    const res = await postIngest(mockDB, [{ email: 'a@b.c', client_id: 'cid', refresh_token: 'rt' }], 'omk_wrong');
    expect(res.status).toBe(401);
  });

  it('inserts a new account and reports inserted=1', async () => {
    const mockDB = mockIngestDB({ configuredKey: 'omk_test', existing: null });
    const res = await postIngest(mockDB, [{ email: 'a@b.c', client_id: 'cid', refresh_token: 'rt' }]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.inserted).toBe(1);
    expect(body.data.updated).toBe(0);
  });

  it('updates an existing account without touching a disabled status', async () => {
    const mockDB = mockIngestDB({
      configuredKey: 'omk_test',
      existing: { id: 9, status: 'disabled' },
    });
    const res = await postIngest(mockDB, [{ email: 'a@b.c', client_id: 'cid', refresh_token: 'new-rt' }]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.updated).toBe(1);
    // The UPDATE binds: [password, client_id, refresh_token, status, remark, country, ip_type, id]
    const updateCall = mockDB._stmt.bind.mock.calls.find((args) => args.length === 8);
    expect(updateCall).toBeDefined();
    expect(updateCall![2]).toBe('new-rt');
    expect(updateCall![3]).toBe('disabled'); // preserved
  });

  it('rejects malformed input with a per-account error, not a 400', async () => {
    const mockDB = mockIngestDB({ configuredKey: 'omk_test', existing: null });
    const res = await postIngest(mockDB, [{ email: 'not-an-email', client_id: 'cid', refresh_token: 'rt' }]);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.inserted).toBe(0);
    expect(body.data.errors).toHaveLength(1);
  });
});

// Tasks route: log cleanup honors retention_days and supports a full wipe.
describe('tasks route: log cleanup', () => {
  it('deletes all logs when { all: true }', async () => {
    const mockDB = createMockDB();
    mockDB._stmt.run.mockResolvedValue({ meta: { changes: 42 } });
    const taskRoute = (await import('../src/routes/tasks')).default;
    const res = await taskRoute.request('/logs/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }, { DB: mockDB } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.deleted).toBe(42);
  });

  it('prunes by retention_days otherwise', async () => {
    const mockDB = createMockDB();
    mockDB._stmt.run.mockResolvedValue({ meta: { changes: 3 } });
    const taskRoute = (await import('../src/routes/tasks')).default;
    const res = await taskRoute.request('/logs/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retention_days: 7 }),
    }, { DB: mockDB } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.retention_days).toBe(7);
    // The DELETE binds a single "-7 days" offset
    const deleteCall = mockDB._stmt.bind.mock.calls.find((args) => args.length === 1);
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toBe('-7 days');
  });
});
