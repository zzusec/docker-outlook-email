import { readFile } from 'node:fs/promises';
import { afterEach, describe, it, expect, vi } from 'vitest';

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

// Regression: saving a new refresh_token must clear a stale 'error' status
// (the error verdict referred to the old token), while a deliberate
// 'disabled' status must never be auto-changed.
describe('accounts route: status recovery on token update', () => {
  const baseAccount = {
    id: 5,
    email: 'a@b.c',
    password: '',
    client_id: 'cid',
    refresh_token: 'old-token',
    group_id: 1,
    remark: '',
    status: 'error',
  };

  async function putAccount(body: object, account: Record<string, unknown> = baseAccount) {
    const accountsRoute = (await import('../src/routes/accounts')).default;
    const mockDB = createMockDB();
    mockDB._stmt.first.mockResolvedValue(account);
    const res = await accountsRoute.request(
      `/${account.id}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { DB: mockDB } as any
    );
    // The full UPDATE binds 10 params:
    // [email, password, client_id, refresh_token, group_id, remark, status, country, ip_type, id]
    const updateCall = mockDB._stmt.bind.mock.calls.find((args) => args.length === 10);
    return { res, updateCall };
  }

  it('resets error to active when a new refresh_token is saved', async () => {
    const { res, updateCall } = await putAccount({ refresh_token: 'brand-new-token' });
    expect(res.status).toBe(200);
    expect(updateCall).toBeDefined();
    expect(updateCall![3]).toBe('brand-new-token');
    expect(updateCall![6]).toBe('active');
  });

  it('keeps error status when no new token is provided', async () => {
    const { updateCall } = await putAccount({ remark: 'note' });
    expect(updateCall![6]).toBe('error');
  });

  it('does not re-enable a disabled account on token save', async () => {
    const { updateCall } = await putAccount(
      { refresh_token: 'brand-new-token' },
      { ...baseAccount, status: 'disabled' }
    );
    expect(updateCall![6]).toBe('disabled');
  });
});

// Inbox totals used to appear only for accounts that had been tested manually,
// so most rows rendered "—" forever. The list view now hydrates them on demand.
describe('accounts route: on-demand inbox counts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('counts the requested accounts and stores the totals', async () => {
    const mockDB = createMockDB() as ReturnType<typeof createMockDB> & { batch: ReturnType<typeof vi.fn> };
    mockDB.batch = vi.fn().mockResolvedValue([]);
    mockDB._stmt.all.mockResolvedValue({
      results: [{ id: 7, email: 'a@b.c', client_id: 'cid', refresh_token: 'rt', status: 'active' }],
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt-new',
        scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totalItemCount: 182 })));
    vi.stubGlobal('fetch', fetchMock);

    const accountsRoute = (await import('../src/routes/accounts')).default;
    const res = await accountsRoute.request(
      '/inbox-counts',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [7] }) },
      { DB: mockDB } as any
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { counted: number; results: Array<{ inbox: { total: number } }> } };
    expect(body.data.counted).toBe(1);
    expect(body.data.results[0].inbox.total).toBe(182);
    const statements = mockDB.batch.mock.calls[0][0] as unknown[];
    expect(statements.length).toBe(1);
    expect(mockDB.prepare.mock.calls.some((args) => String(args[0]).includes('inbox_total = ?'))).toBe(true);
  });
});

// A refresh token that Microsoft rejects with invalid_grant can never be revived,
// so the scheduled refresh drops the account instead of parking it in "error".
describe('cron token refresh: dead mailbox cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('deletes accounts whose refresh token failed permanently', async () => {
    const mockDB = createMockDB();
    mockDB._stmt.all.mockResolvedValue({
      results: [{ id: 9, email: 'dead@b.c', client_id: 'cid', refresh_token: 'rt', status: 'active' }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'token revoked' }), { status: 400 })
    ));

    const { runTokenRefresh } = await import('../src/cron');
    const summary = await runTokenRefresh({ DB: mockDB } as any, { force: true });

    expect(summary).toContain('删除失效 1');
    expect(mockDB.prepare.mock.calls.some((args) => String(args[0]) === 'DELETE FROM accounts WHERE id = ?')).toBe(true);
    expect(mockDB.prepare.mock.calls.some((args) => String(args[0]).includes("status = 'error'"))).toBe(false);
  });

  it('keeps accounts whose refresh only hit a transient failure', async () => {
    const mockDB = createMockDB();
    mockDB._stmt.all.mockResolvedValue({
      results: [{ id: 10, email: 'busy@b.c', client_id: 'cid', refresh_token: 'rt', status: 'active' }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 })
    ));

    const { runTokenRefresh } = await import('../src/cron');
    const summary = await runTokenRefresh({ DB: mockDB } as any, { force: true });

    expect(summary).toContain('失败 1');
    expect(summary).not.toContain('删除失效');
    expect(mockDB.prepare.mock.calls.some((args) => String(args[0]) === 'DELETE FROM accounts WHERE id = ?')).toBe(false);
  });
});

describe('email detail fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('normalizes uppercase Outlook REST HTML content type after Graph rejects the token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        Id: 'message-id',
        Subject: 'HTML email',
        From: { EmailAddress: { Name: 'Sender', Address: 'sender@example.com' } },
        ToRecipients: [],
        CcRecipients: [],
        ReceivedDateTime: '2026-07-26T12:00:00Z',
        BodyPreview: 'Preview',
        IsRead: false,
        HasAttachments: false,
        Body: { ContentType: ' HTML ', Content: '<strong>Rendered email</strong>' },
      })));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchEmailDetail } = await import('../src/graph');
    const result = await fetchEmailDetail('access-token', 'message-id');

    expect(result.error).toBeUndefined();
    expect(result.item?.body).toEqual({
      contentType: 'html',
      content: '<strong>Rendered email</strong>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('graph.microsoft.com');
    expect(String(fetchMock.mock.calls[1][0])).toContain('outlook.office.com');
  });
});

describe('email body viewer HTML document detection', () => {
  it('renders only complete HTML documents when providers mislabel them as text', async () => {
    const appSource = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');
    const functionSource = appSource.match(/function isFullHtmlDocument\(content\) \{[\s\S]*?\n\}/)?.[0];
    expect(functionSource).toBeTruthy();

    const isFullHtmlDocument = new Function(`${functionSource}; return isFullHtmlDocument;`)() as (content: string) => boolean;
    expect(isFullHtmlDocument('<!DOCTYPE html><html lang="en"><head></head><body>Code</body></html>')).toBe(true);
    expect(isFullHtmlDocument('﻿ \n<HTML lang="en"><body>Code</body></html>')).toBe(true);
    expect(isFullHtmlDocument('<div>HTML fragment</div>')).toBe(false);
    expect(isFullHtmlDocument('Source code: <html lang="en">')).toBe(false);
    expect(isFullHtmlDocument('&lt;html lang="en"&gt;')).toBe(false);
  });
});

describe('frontend account count and settings layout', () => {
  it('renders the cached inbox count beside each account without another API request', async () => {
    const appSource = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');
    const helperSource = appSource.match(/function accountInboxCountHtml\(account\) \{[\s\S]*?\n\}/)?.[0];

    expect(helperSource).toBeTruthy();
    expect(helperSource).toContain('account?.inbox?.total');
    expect(helperSource).toContain('account?.inbox?.checked_at');
    expect(helperSource).not.toContain('api(');
    expect(appSource).toContain('${accountInboxCountHtml(a)}');
  });

  it('keeps every settings control and action in the redesigned layout', async () => {
    const appSource = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');

    for (const id of [
      'sPassword', 'sApiKey', 'sSiteTitle', 'sExternalKey',
      'sRefreshEnabled', 'sRefreshInterval', 'sRefreshBatch',
      'sTgEnabled', 'sTgToken', 'sTgChatId', 'sTgInterval',
    ]) {
      expect(appSource).toContain(`id="${id}"`);
    }
    for (const handler of [
      'saveSettings()', 'generateApiKey()', 'clearApiKey()',
      'saveRefreshSettings()', 'refreshTokensNow(this)',
      'saveTelegramSettings()', 'testTelegram(this)', 'pushNow(this)',
    ]) {
      expect(appSource).toContain(`onclick="${handler}"`);
    }
    expect(appSource).toContain('class="settings-overview"');
    expect(appSource).toContain('class="settings-grid"');
  });

  it('returns from the email viewer to its actual in-app source page', async () => {
    const appSource = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');

    expect(appSource).toContain("let previousPage = 'accounts';");
    expect(appSource).toContain('if (page !== currentPage) previousPage = currentPage;');
    expect(appSource).toContain("previousPage !== 'emails' ? previousPage : 'accounts'");
    expect(appSource).toContain('onclick="goBackFromEmails()"');
    expect(appSource.indexOf('onclick="refreshEmails()"')).toBeLessThan(appSource.indexOf('onclick="goBackFromEmails()"'));
  });

  it('imports accounts from multiple TXT files or a selected folder without multipart upload', async () => {
    const appSource = await readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8');

    expect(appSource).toContain('data-import-file-input');
    expect(appSource).toContain('multiple webkitdirectory');
    expect(appSource).toContain('file.text()');
    expect(appSource).not.toContain('ACCOUNT_IMPORT_MAX_FILES');
    expect(appSource).not.toContain('ACCOUNT_IMPORT_MAX_CHARS');
    expect(appSource).not.toContain('ACCOUNT_IMPORT_MAX_LINES');
    expect(appSource).not.toContain('已超过单次导入限制');
    expect(appSource).toContain('overlay.dataset.importReadId !== readId');
    expect(appSource).toContain("api('/accounts/import'");
    expect(appSource).not.toContain('new FormData');
  });
});

describe('static asset deployment cache policy', () => {
  it('revalidates stable asset names and cache-busts the current release', async () => {
    const serverSource = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
    const indexSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const loginSource = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');

    expect(serverSource).toContain("c.header('Cache-Control', 'no-cache')");
    expect(serverSource).not.toContain('max-age=3600');
    expect(indexSource).toContain('/assets/style.css?v=20260801-1');
    expect(indexSource).toContain('/assets/i18n.js?v=20260801-1');
    expect(indexSource).toContain('/assets/app.js?v=20260801-1');
    expect(loginSource).toContain('/assets/i18n.js?v=20260801-1');
  });
});
