import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations, openDatabase, type SqliteD1Database } from '../server/sqlite';
import { first, query, run } from '../src/db';
import registration, { extractRegistrationCodes, messageHasExactRecipient } from '../src/registration';
import externalRoutes from '../src/routes/external';
import type { GraphMailMessage } from '../src/types';

const KR_KEY = 'kr-test-api-key-not-a-real-secret';
const US2_KEY = 'us2-test-api-key-not-a-real-secret';
const CLAIM_SECRET = 'claim-signing-test-secret-not-production';

const tempDirs: string[] = [];
const databases: SqliteD1Database[] = [];

function createDatabase() {
  const dir = mkdtempSync(resolve(tmpdir(), 'cf-outlook-registration-'));
  tempDirs.push(dir);
  const db = openDatabase(resolve(dir, 'test.db'));
  databases.push(db);
  applyMigrations(db, resolve('migrations'));
  return db;
}

function createDatabasePair() {
  const dir = mkdtempSync(resolve(tmpdir(), 'cf-outlook-registration-shared-'));
  tempDirs.push(dir);
  const path = resolve(dir, 'test.db');
  const firstDb = openDatabase(path);
  databases.push(firstDb);
  applyMigrations(firstDb, resolve('migrations'));
  const secondDb = openDatabase(path);
  databases.push(secondDb);
  return [firstDb, secondDb] as const;
}

function envFor(db: SqliteD1Database) {
  return {
    DB: db as unknown as D1Database,
    REGISTRATION_KR_API_KEY: KR_KEY,
    REGISTRATION_US2_API_KEY: US2_KEY,
    REGISTRATION_CLAIM_SECRET: CLAIM_SECRET,
  } as any;
}

async function addAccount(db: SqliteD1Database, email = 'mailbox@example.com') {
  await run(
    db as unknown as D1Database,
    'INSERT INTO accounts (email, client_id, refresh_token, status) VALUES (?, ?, ?, ?)',
    [email, 'microsoft-client', 'rt-old', 'active']
  );
}

async function post(
  db: SqliteD1Database,
  path: string,
  apiKey: string,
  body?: object,
  headers: Record<string, string> = {}
) {
  return registration.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    envFor(db)
  );
}

async function allocate(db: SqliteD1Database, apiKey: string, idempotencyKey: string) {
  const response = await post(db, '/claims', apiKey, undefined, { 'Idempotency-Key': idempotencyKey });
  const body = await response.json() as {
    success: boolean;
    data: { claim: string; recipient: string; expires_at: string };
    error?: { code: string };
  };
  return { response, body };
}

function graphMessage(
  id: string,
  receivedDateTime: string,
  options: {
    subject?: string;
    preview?: string;
    body?: string;
    recipients?: string[];
    headers?: Array<{ name: string; value: string }>;
  } = {}
) {
  return {
    id,
    subject: options.subject || 'Your verification code is 123456',
    from: { emailAddress: { name: 'Sender', address: 'sender@example.com' } },
    toRecipients: (options.recipients || []).map((address) => ({ emailAddress: { name: '', address } })),
    ccRecipients: [],
    receivedDateTime,
    bodyPreview: options.preview || 'Verification code 123456',
    isRead: false,
    hasAttachments: false,
    body: { contentType: 'text', content: options.body || 'Verification code: 123456' },
    internetMessageHeaders: options.headers || [],
  };
}

function mockMicrosoft(options: {
  inbox?: ReturnType<typeof graphMessage>[];
  junk?: ReturnType<typeof graphMessage>[];
  details?: Record<string, ReturnType<typeof graphMessage>>;
  rotatedRefreshToken?: string;
}) {
  const refreshTokens: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/oauth2/v2.0/token')) {
      const params = new URLSearchParams(String(init?.body || ''));
      refreshTokens.push(params.get('refresh_token') || '');
      return new Response(JSON.stringify({
        access_token: 'access-token-not-secret',
        refresh_token: options.rotatedRefreshToken,
        scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
      }));
    }
    if (url.includes('/mailFolders/inbox/messages')) {
      return new Response(JSON.stringify({ value: options.inbox || [] }));
    }
    if (url.includes('/mailFolders/junkemail/messages')) {
      return new Response(JSON.stringify({ value: options.junk || [] }));
    }
    const messageMatch = url.match(/\/me\/messages\/([^?]+)/);
    if (messageMatch) {
      const id = decodeURIComponent(messageMatch[1]);
      const detail = options.details?.[id];
      return detail
        ? new Response(JSON.stringify(detail))
        : new Response('', { status: 404 });
    }
    throw new Error(`Unexpected Microsoft request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, refreshTokens };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (databases.length) databases.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('registration claim migration and allocation', () => {
  it('is additive, manually idempotent, and records all non-reuse constraints', () => {
    const db = createDatabase();
    const migration = readFileSync(resolve('migrations/0010_registration_alias_claims.sql'), 'utf8');
    expect(() => db.native.exec(migration)).not.toThrow();

    const indexes = db.native
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'registration_alias_claims'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain('idx_registration_claims_consumed_message');
  });

  it('serializes concurrent KR/US2 allocations and replays idempotency exactly', async () => {
    const [db, peerDb] = createDatabasePair();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const [kr, us2] = await Promise.all([
      allocate(db, KR_KEY, 'attempt-kr-1'),
      allocate(peerDb, US2_KEY, 'attempt-us2-1'),
    ]);
    expect(kr.response.status).toBe(200);
    expect(us2.response.status).toBe(200);
    expect(new Set([kr.body.data.recipient, us2.body.data.recipient])).toEqual(
      new Set(['mailbox+1@example.com', 'mailbox+2@example.com'])
    );
    expect(kr.body.data.claim).not.toBe(us2.body.data.claim);

    const replay = await allocate(db, KR_KEY, 'attempt-kr-1');
    expect(replay.body.data).toEqual(kr.body.data);
    expect(await query(db as unknown as D1Database, 'SELECT id FROM registration_alias_claims')).toHaveLength(2);
  });

  it('never reuses released or expired alias indices', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const firstClaim = await allocate(db, KR_KEY, 'burn-0');
    expect(firstClaim.body.data.recipient).toBe('mailbox+1@example.com');
    expect((await post(db, '/release', KR_KEY, { claim: firstClaim.body.data.claim, reason: 'failed' })).status).toBe(200);

    const secondClaim = await allocate(db, KR_KEY, 'burn-1');
    expect(secondClaim.body.data.recipient).toBe('mailbox+2@example.com');
    await run(
      db as unknown as D1Database,
      'UPDATE registration_alias_claims SET lease_expires_at = 0 WHERE recipient = ?',
      [secondClaim.body.data.recipient]
    );

    const thirdClaim = await allocate(db, KR_KEY, 'burn-2');
    expect(thirdClaim.body.data.recipient).toBe('mailbox+3@example.com');
    const states = await query<{ recipient: string; state: string }>(
      db as unknown as D1Database,
      'SELECT recipient, state FROM registration_alias_claims ORDER BY alias_index'
    );
    expect(states).toEqual([
      { recipient: 'mailbox+1@example.com', state: 'released' },
      { recipient: 'mailbox+2@example.com', state: 'expired' },
      { recipient: 'mailbox+3@example.com', state: 'active' },
    ]);

    await run(db as unknown as D1Database, 'DELETE FROM accounts WHERE email = ?', ['mailbox@example.com']);
    await addAccount(db);
    const afterReimport = await allocate(db, KR_KEY, 'burn-after-reimport');
    expect(afterReimport.body.data.recipient).toBe('mailbox+4@example.com');
  });

  it('balances new allocations across eligible active mailboxes', async () => {
    const db = createDatabase();
    await addAccount(db, 'first@example.com');
    await addAccount(db, 'second@example.com');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const one = await allocate(db, KR_KEY, 'balanced-1');
    const two = await allocate(db, KR_KEY, 'balanced-2');
    expect(new Set([one.body.data.recipient, two.body.data.recipient])).toEqual(
      new Set(['first+1@example.com', 'second+1@example.com'])
    );
  });
});

describe('registration authentication and lease semantics', () => {
  it('fails closed when registration secrets are not configured', async () => {
    const db = createDatabase();
    const response = await registration.request(
      '/claims',
      { method: 'POST', headers: { 'X-API-Key': KR_KEY, 'Idempotency-Key': 'disabled' } },
      { DB: db as unknown as D1Database } as any
    );
    expect(response.status).toBe(503);
    expect((await response.json() as any).error.code).toBe('REGISTRATION_DISABLED');
  });

  it('mounts under the external API without the legacy settings-backed key', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await externalRoutes.request(
      '/registration/claims',
      {
        method: 'POST',
        headers: { 'X-API-Key': KR_KEY, 'Idempotency-Key': 'mounted-route' },
      },
      envFor(db)
    );
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.recipient).toBe('mailbox+1@example.com');
  });

  it('accepts registration keys only in X-API-Key and rejects wrong-client claims', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const missing = await registration.request(
      `/claims?key=${encodeURIComponent(KR_KEY)}`,
      { method: 'POST', headers: { 'Idempotency-Key': 'query-key' } },
      envFor(db)
    );
    expect(missing.status).toBe(401);
    expect(JSON.stringify(await missing.json())).not.toContain(KR_KEY);

    const wrong = await post(db, '/claims', 'wrong-api-key-not-secret', undefined, { 'Idempotency-Key': 'wrong' });
    expect(wrong.status).toBe(401);

    const allocated = await allocate(db, KR_KEY, 'owned-by-kr');
    const crossClient = await post(db, '/code', US2_KEY, { claim: allocated.body.data.claim });
    expect(crossClient.status).toBe(404);
    expect((await crossClient.json() as any).error.code).toBe('CLAIM_NOT_FOUND');
  });

  it('serializes Microsoft token rotation per mailbox across concurrent claim polls', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const firstClaim = await allocate(db, KR_KEY, 'poll-lock-1');
    const secondClaim = await allocate(db, US2_KEY, 'poll-lock-2');

    let resolveToken!: (response: Response) => void;
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return tokenResponse;
      if (url.includes('/mailFolders/')) return Promise.resolve(new Response(JSON.stringify({ value: [] })));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstPollPromise = post(db, '/code', KR_KEY, { claim: firstClaim.body.data.claim });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const secondPoll = await post(db, '/code', US2_KEY, { claim: secondClaim.body.data.claim });
    expect(secondPoll.status).toBe(200);
    expect((await secondPoll.json() as any).data).toEqual(expect.objectContaining({
      ready: false,
      retry_after_seconds: 2,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveToken(new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'rt-rotated',
      scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
    })));
    expect((await firstPollPromise).status).toBe(200);
  });

  it('returns typed, retryable Microsoft throttling errors without upstream details', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const allocated = await allocate(db, KR_KEY, 'token-throttled');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'too_many_requests', error_description: 'upstream private detail' }), { status: 429 })
    ));

    const response = await post(db, '/code', KR_KEY, { claim: allocated.body.data.claim });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('15');
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('MICROSOFT_THROTTLED');
    expect(serialized).not.toContain('upstream private detail');
  });

  it('renews the soft lease without exceeding the hard expiry', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockMicrosoft({});

    const allocated = await allocate(db, KR_KEY, 'bounded-renewal');
    const hardExpiry = Date.now() + 10_000;
    await run(
      db as unknown as D1Database,
      'UPDATE registration_alias_claims SET hard_expires_at = ?, lease_expires_at = ? WHERE recipient = ?',
      [hardExpiry, hardExpiry - 1_000, allocated.body.data.recipient]
    );

    const response = await post(db, '/code', KR_KEY, { claim: allocated.body.data.claim });
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.ready).toBe(false);
    const row = await first<{ lease_expires_at: number; hard_expires_at: number }>(
      db as unknown as D1Database,
      'SELECT lease_expires_at, hard_expires_at FROM registration_alias_claims WHERE recipient = ?',
      [allocated.body.data.recipient]
    );
    expect(row?.lease_expires_at).toBe(hardExpiry);
    expect(row?.lease_expires_at).toBeLessThanOrEqual(row!.hard_expires_at);
  });
});

describe('exact recipient matching and message consumption', () => {
  it('extracts the Grok 3-3 confirmation-code format used by the registrar', () => {
    expect(extractRegistrationCodes('Your confirmation code is S6C-W8Z')).toContain('S6C-W8Z');
  });

  it('matches Plus recipients through toRecipients and approved delivery headers only', () => {
    const base = graphMessage('m', new Date().toISOString()) as GraphMailMessage;
    const target = 'mailbox+7@example.com';
    expect(messageHasExactRecipient({ ...base, toRecipients: [{ emailAddress: { name: '', address: target } }] }, target)).toBe(true);

    for (const name of ['X-Original-To', 'Delivered-To', 'Envelope-To']) {
      expect(messageHasExactRecipient({ ...base, internetMessageHeaders: [{ name, value: `<${target}>` }] }, target)).toBe(true);
    }
    expect(messageHasExactRecipient({
      ...base,
      toRecipients: [{ emailAddress: { name: '', address: 'mailbox@example.com' } }],
      internetMessageHeaders: [{ name: 'To', value: target }],
    }, target)).toBe(false);
  });

  it('searches Inbox and Junk, ignores old/primary rewrites, persists rotation, and never logs secrets or codes', async () => {
    const db = createDatabase();
    await addAccount(db);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const primary = await allocate(db, KR_KEY, 'primary-burn');
    await post(db, '/release', KR_KEY, { claim: primary.body.data.claim, reason: 'failed' });
    const plus = await allocate(db, KR_KEY, 'plus-recipient');
    expect(plus.body.data.recipient).toBe('mailbox+2@example.com');

    const old = graphMessage('old', new Date(Date.now() - 10 * 60_000).toISOString(), {
      recipients: [plus.body.data.recipient],
      body: 'Verification code: 111111',
    });
    const rewritten = graphMessage('rewritten', new Date().toISOString(), {
      recipients: ['mailbox@example.com'],
      body: 'Verification code: 222222',
    });
    const valid = graphMessage('junk-valid', new Date().toISOString(), {
      recipients: ['mailbox@example.com'],
      headers: [{ name: 'Delivered-To', value: `Registration <${plus.body.data.recipient}>` }],
      body: 'Verification code: 654321',
      preview: 'Use verification code 654321',
      subject: 'Verification code',
    });
    const { refreshTokens } = mockMicrosoft({
      inbox: [rewritten, old],
      junk: [valid],
      details: { old, rewritten, 'junk-valid': valid },
      rotatedRefreshToken: 'rt-rotated',
    });

    const response = await post(db, '/code', KR_KEY, { claim: plus.body.data.claim });
    expect(response.status).toBe(200);
    const responseBody = await response.json() as any;
    expect(responseBody.data).toEqual(expect.objectContaining({ ready: true, code: '654321' }));
    const serialized = JSON.stringify(responseBody);
    expect(serialized).not.toContain('rt-rotated');
    expect(serialized).not.toContain('microsoft-client');

    const replayResponse = await post(db, '/code', KR_KEY, { claim: plus.body.data.claim });
    expect((await replayResponse.json() as any).data.code).toBe('654321');

    const account = await first<{ refresh_token: string }>(
      db as unknown as D1Database,
      'SELECT refresh_token FROM accounts WHERE email = ?',
      ['mailbox@example.com']
    );
    expect(account?.refresh_token).toBe('rt-rotated');
    const claimRow = await first<{ consumed_message_id: string; consumed_message_fingerprint: string }>(
      db as unknown as D1Database,
      'SELECT consumed_message_id, consumed_message_fingerprint FROM registration_alias_claims WHERE recipient = ?',
      [plus.body.data.recipient]
    );
    expect(claimRow?.consumed_message_id).toBe('junk-valid');
    expect(claimRow?.consumed_message_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(refreshTokens).toEqual(['rt-old', 'rt-rotated']);

    const logs = logSpy.mock.calls.flat().join('\n');
    for (const forbidden of [KR_KEY, CLAIM_SECRET, plus.body.data.claim, 'rt-old', 'rt-rotated', '654321']) {
      expect(logs).not.toContain(forbidden);
    }
  });

  it('filters old exact-recipient messages and returns a retry hint', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const claim = await allocate(db, KR_KEY, 'old-only');
    const old = graphMessage('old-only-message', new Date(Date.now() - 10 * 60_000).toISOString(), {
      recipients: [claim.body.data.recipient],
      body: 'Verification code: 111111',
    });
    mockMicrosoft({ inbox: [old], details: { 'old-only-message': old } });

    const response = await post(db, '/code', KR_KEY, { claim: claim.body.data.claim });
    const body = await response.json() as any;
    expect(body.data).toEqual(expect.objectContaining({ ready: false, retry_after_seconds: 5 }));
    expect(await first(
      db as unknown as D1Database,
      'SELECT consumed_message_id FROM registration_alias_claims WHERE recipient = ?',
      [claim.body.data.recipient]
    )).toEqual({ consumed_message_id: null });
  });

  it('returns the same code on replay and prevents one message from satisfying another claim', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const firstClaim = await allocate(db, KR_KEY, 'message-owner');
    const secondClaim = await allocate(db, US2_KEY, 'message-loser');
    const shared = graphMessage('shared-message', new Date().toISOString(), {
      recipients: [firstClaim.body.data.recipient, secondClaim.body.data.recipient],
      subject: 'Verification code 777777',
      preview: 'Use verification code 777777',
      body: 'Verification code: 777777',
    });
    mockMicrosoft({ inbox: [shared], details: { 'shared-message': shared } });

    const firstPoll = await post(db, '/code', KR_KEY, { claim: firstClaim.body.data.claim });
    expect((await firstPoll.json() as any).data.code).toBe('777777');
    const replay = await post(db, '/code', KR_KEY, { claim: firstClaim.body.data.claim });
    expect((await replay.json() as any).data.code).toBe('777777');

    const losingPoll = await post(db, '/code', US2_KEY, { claim: secondClaim.body.data.claim });
    expect((await losingPoll.json() as any).data.ready).toBe(false);
    const consumedCount = await first<{ count: number }>(
      db as unknown as D1Database,
      'SELECT COUNT(*) AS count FROM registration_alias_claims WHERE consumed_message_id = ?',
      ['shared-message']
    );
    expect(consumedCount?.count).toBe(1);
  });
});

describe('terminal claim transitions', () => {
  it('makes complete/release idempotent and rejects conflicting terminal transitions', async () => {
    const db = createDatabase();
    await addAccount(db);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const completed = await allocate(db, KR_KEY, 'complete-idempotent');
    expect((await post(db, '/complete', KR_KEY, { claim: completed.body.data.claim })).status).toBe(200);
    expect((await post(db, '/complete', KR_KEY, { claim: completed.body.data.claim })).status).toBe(200);
    const releaseCompleted = await post(db, '/release', KR_KEY, { claim: completed.body.data.claim, reason: 'failed' });
    expect(releaseCompleted.status).toBe(409);

    const released = await allocate(db, KR_KEY, 'release-idempotent');
    expect((await post(db, '/release', KR_KEY, { claim: released.body.data.claim, reason: 'registration_failed' })).status).toBe(200);
    expect((await post(db, '/release', KR_KEY, { claim: released.body.data.claim, reason: 'registration_failed' })).status).toBe(200);
    const completeReleased = await post(db, '/complete', KR_KEY, { claim: released.body.data.claim });
    expect(completeReleased.status).toBe(409);

    const rows = await query<{ state: string; finalization_reason: string }>(
      db as unknown as D1Database,
      'SELECT state, finalization_reason FROM registration_alias_claims ORDER BY id'
    );
    expect(rows).toEqual([
      { state: 'completed', finalization_reason: 'registrar_committed' },
      { state: 'released', finalization_reason: 'registration_failed' },
    ]);
  });
});
