import type { GraphTokenResponse, GraphMailMessage } from './types';
import { maskToken } from './utils/validation';

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Two classes of consumer MSA tokens show up in the wild:
//   1) Graph-capable (sometimes opaque "Ew..." tickets, sometimes JWT) → graph.microsoft.com
//   2) Outlook-resource-only (IMAP/EWS era scopes on outlook.office.com) → Outlook REST v2
// Token shape alone is NOT a reliable discriminator (opaque tokens can work on Graph),
// so we always try Graph first and fall back to Outlook REST on 401.
const OUTLOOK_REST_BASE = 'https://outlook.office.com/api/v2.0';

export interface GraphError {
  code: string;
  message: string;
}

function encodePathId(id: string): string {
  return encodeURIComponent(id);
}

// Prefer Graph mail scopes. Many bulk-imported Hotmail RTs were originally
// authorized only for IMAP/POP/SMTP; requesting Graph scopes on refresh is an
// incremental-consent upgrade that permanently switches the RT to Graph mail.
export const GRAPH_MAIL_UPGRADE_SCOPE =
  'https://graph.microsoft.com/Mail.ReadWrite offline_access openid profile';

export function isImapOnlyScope(scope?: string): boolean {
  if (!scope) return false;
  const s = scope.toLowerCase();
  if (s.includes('mail.read') || s.includes('mail.readwrite')) return false;
  return (
    s.includes('imap.accessasuser') ||
    s.includes('pop.accessasuser') ||
    // SMTP-only / outlook resource without mail.read
    (s.includes('outlook.office.com') && !s.includes('mail.read'))
  );
}

// OAuth error codes that mean this refresh_token can never work again: the grant
// was revoked/expired, or the user must re-consent interactively. Everything else
// (network errors, 429 throttling, 5xx, invalid_client — a wrong client_id rather
// than a dead mailbox) is transient or operator error and must NOT delete accounts.
const PERMANENT_TOKEN_ERRORS = new Set([
  'invalid_grant',
  'unauthorized_client',
  'interaction_required',
  'consent_required',
  'account_disabled',
]);

export function isPermanentTokenFailure(error?: GraphError): boolean {
  if (!error?.code) return false;
  return PERMANENT_TOKEN_ERRORS.has(error.code.toLowerCase());
}

// Get access token using refresh_token.
// Returns new_refresh_token when Microsoft issues a rotated token.
//
// Default (no scope): Microsoft reuses the original authorized scopes.
// Optional scope: used to upgrade IMAP-only RTs to Graph Mail.ReadWrite.
// Never use https://graph.microsoft.com/.default for delegated refresh —
// offline_access is an OIDC scope and is not part of Graph .default.
export async function getAccessToken(
  clientId: string,
  refreshToken: string,
  scope?: string
): Promise<{ token?: string; newRefreshToken?: string; scope?: string; error?: GraphError }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (scope) body.set('scope', scope);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, string>;
      return {
        error: {
          code: err.error || 'TOKEN_FAILED',
          message: err.error_description
            ? sanitizeErrorMessage(err.error_description)
            : `Token request failed with status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as GraphTokenResponse;
    return {
      token: data.access_token,
      newRefreshToken: data.refresh_token,
      scope: data.scope,
    };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error during token request: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Token for reading/writing mail. Auto-upgrades IMAP/POP-only refresh tokens
// to Graph Mail.ReadWrite when Microsoft allows incremental consent.
export async function getMailAccessToken(
  clientId: string,
  refreshToken: string
): Promise<{
  token?: string;
  newRefreshToken?: string;
  scope?: string;
  upgraded?: boolean;
  error?: GraphError;
}> {
  const first = await getAccessToken(clientId, refreshToken);
  if (!first.token) return first;

  if (!isImapOnlyScope(first.scope)) {
    return first;
  }

  const rtForUpgrade = first.newRefreshToken || refreshToken;
  const upgraded = await getAccessToken(clientId, rtForUpgrade, GRAPH_MAIL_UPGRADE_SCOPE);
  if (!upgraded.token) {
    // Keep the original access token so callers can still surface a clear 401
    // from the mail API rather than a cryptic upgrade failure.
    return {
      token: first.token,
      newRefreshToken: first.newRefreshToken,
      scope: first.scope,
      error: upgraded.error,
    };
  }

  return {
    token: upgraded.token,
    // Prefer the latest rotated RT (upgrade step), else the first rotation.
    newRefreshToken: upgraded.newRefreshToken || first.newRefreshToken,
    scope: upgraded.scope,
    upgraded: true,
  };
}

// ---- Response shape normalizers (Outlook REST uses PascalCase) ----

type AnyRec = Record<string, unknown>;

function pick<T = unknown>(obj: AnyRec | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

function normalizeAddress(raw: unknown): { name: string; address: string } {
  const r = (raw || {}) as AnyRec;
  const ea = (pick<AnyRec>(r, 'emailAddress', 'EmailAddress') || r) as AnyRec;
  return {
    name: String(pick(ea, 'name', 'Name') ?? ''),
    address: String(pick(ea, 'address', 'Address') ?? ''),
  };
}

function normalizeRecipients(raw: unknown): Array<{ emailAddress: { name: string; address: string } }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const addr = normalizeAddress(item);
    return { emailAddress: { name: addr.name, address: addr.address } };
  });
}

function normalizeMessage(raw: AnyRec): GraphMailMessage {
  const fromRaw = pick<AnyRec>(raw, 'from', 'From');
  const bodyRaw = pick<AnyRec>(raw, 'body', 'Body');
  return {
    id: String(pick(raw, 'id', 'Id') ?? ''),
    subject: String(pick(raw, 'subject', 'Subject') ?? ''),
    from: {
      emailAddress: normalizeAddress(fromRaw),
    },
    toRecipients: normalizeRecipients(pick(raw, 'toRecipients', 'ToRecipients')),
    ccRecipients: normalizeRecipients(pick(raw, 'ccRecipients', 'CcRecipients')),
    receivedDateTime: String(pick(raw, 'receivedDateTime', 'ReceivedDateTime') ?? ''),
    bodyPreview: String(pick(raw, 'bodyPreview', 'BodyPreview') ?? ''),
    isRead: Boolean(pick(raw, 'isRead', 'IsRead')),
    hasAttachments: Boolean(pick(raw, 'hasAttachments', 'HasAttachments')),
    body: bodyRaw
      ? {
          contentType: String(pick(bodyRaw, 'contentType', 'ContentType') ?? 'text').trim().toLowerCase(),
          content: String(pick(bodyRaw, 'content', 'Content') ?? ''),
        }
      : undefined,
  };
}

function normalizeAttachment(raw: AnyRec): GraphAttachment {
  return {
    id: String(pick(raw, 'id', 'Id') ?? ''),
    name: String(pick(raw, 'name', 'Name') ?? ''),
    contentType: String(pick(raw, 'contentType', 'ContentType') ?? 'application/octet-stream'),
    size: Number(pick(raw, 'size', 'Size') ?? 0),
    contentBytes: pick<string>(raw, 'contentBytes', 'ContentBytes'),
  };
}

function httpError(status: number, action: string): GraphError {
  if (status === 401) {
    return {
      code: 'UNAUTHORIZED',
      message:
        `${action} 401：访问令牌不被 Graph / Outlook REST 接受。` +
        `请对该账号「重新授权」（建议 Graph Mail.ReadWrite + offline_access）。`,
    };
  }
  if (status === 403) {
    return { code: 'FORBIDDEN', message: `${action} 403：权限不足` };
  }
  if (status === 404) {
    return { code: 'NOT_FOUND', message: '邮件不存在' };
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: '邮件接口限流，请稍后重试' };
  }
  return { code: 'GRAPH_ERROR', message: `${action} failed: ${status}` };
}

type Backend = 'graph' | 'outlook';

interface BackendRequest {
  url: string;
  init?: RequestInit;
}

// Try Graph first; on 401 fall back to Outlook REST. Covers both modern Graph-capable
// MSA tokens (incl. opaque Ew...) and legacy outlook.office.com resource tokens.
async function fetchWithMailFallback(
  accessToken: string,
  build: (backend: Backend) => BackendRequest
): Promise<{ res: Response; backend: Backend } | { error: GraphError; status?: number }> {
  const order: Backend[] = ['graph', 'outlook'];
  let lastStatus = 0;
  let lastNetwork: string | undefined;

  for (const backend of order) {
    const { url, init } = build(backend);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 401 && backend === 'graph') {
        // Fall through to Outlook REST
        lastStatus = 401;
        continue;
      }
      return { res, backend };
    } catch (e) {
      lastNetwork = e instanceof Error ? e.message : 'unknown';
      // Network blip on Graph → still try Outlook REST once
      if (backend === 'graph') continue;
      return { error: { code: 'NETWORK_ERROR', message: `Network error: ${lastNetwork}` } };
    }
  }

  if (lastNetwork) {
    return { error: { code: 'NETWORK_ERROR', message: `Network error: ${lastNetwork}` } };
  }
  return { error: httpError(lastStatus || 401, 'Mail API'), status: lastStatus || 401 };
}

// Fetch email list from inbox / junk / deleted / all
export async function fetchEmails(
  accessToken: string,
  options: { folder?: string; top?: number; skip?: number; keyword?: string } = {}
): Promise<{ items?: GraphMailMessage[]; error?: GraphError }> {
  const { folder = 'inbox', top = 20, skip = 0, keyword } = options;

  // Aggregated view: merge inbox + junk, sorted by date desc. Single page (skip ignored)
  // to keep merged ordering correct; 2 subrequests stay within the free-tier budget.
  // Note: each sub-call may itself dual-try Graph→REST, so worst case is 4 subrequests.
  if (folder === 'all') {
    const [inbox, junk] = await Promise.all([
      fetchEmails(accessToken, { folder: 'inbox', top, skip: 0, keyword }),
      fetchEmails(accessToken, { folder: 'junkemail', top, skip: 0, keyword }),
    ]);
    if (inbox.error && junk.error) return { error: inbox.error };
    const merged = [...(inbox.items ?? []), ...(junk.items ?? [])]
      .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
      .slice(0, top);
    return { items: merged };
  }

  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const useGraph = backend === 'graph';
    const base = useGraph ? GRAPH_BASE : OUTLOOK_REST_BASE;
    const params = new URLSearchParams({
      $top: String(top),
      $skip: String(skip),
      $orderby: useGraph ? 'receivedDateTime desc' : 'ReceivedDateTime desc',
      $select: useGraph
        ? 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments'
        : 'Id,Subject,From,ReceivedDateTime,BodyPreview,IsRead,HasAttachments',
    });
    const headers: Record<string, string> = {
      Prefer: 'outlook.body-content-type="text"',
    };
    if (keyword) {
      params.set('$search', `"${keyword}"`);
      if (useGraph) headers['ConsistencyLevel'] = 'eventual';
    }
    return {
      url: `${base}/me/mailFolders/${folder}/messages?${params.toString()}`,
      init: { headers },
    };
  });

  if ('error' in result) return { error: result.error };
  const { res } = result;
  if (!res.ok) return { error: httpError(res.status, 'Failed to fetch emails') };

  try {
    const data = (await res.json()) as { value?: AnyRec[] };
    return { items: (data.value || []).map((m) => normalizeMessage(m)) };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error parsing emails: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Get the total number of items in the Inbox folder without enumerating messages.
export async function getInboxTotal(
  accessToken: string
): Promise<{ total?: number; error?: GraphError }> {
  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const useGraph = backend === 'graph';
    const base = useGraph ? GRAPH_BASE : OUTLOOK_REST_BASE;
    const select = useGraph ? 'totalItemCount' : 'TotalItemCount';
    return {
      url: `${base}/me/mailFolders/inbox?` + new URLSearchParams({ $select: select }).toString(),
    };
  });

  if ('error' in result) return { error: result.error };
  const { res } = result;
  if (!res.ok) return { error: httpError(res.status, 'Failed to fetch Inbox count') };

  try {
    const data = (await res.json()) as AnyRec;
    const total = pick<number>(data, 'totalItemCount', 'TotalItemCount');
    if (!Number.isInteger(total) || (total as number) < 0) {
      return { error: { code: 'GRAPH_ERROR', message: 'Mail API returned an invalid Inbox count' } };
    }
    return { total: total as number };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error fetching Inbox count: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Fetch single email detail
export async function fetchEmailDetail(
  accessToken: string,
  messageId: string
): Promise<{ item?: GraphMailMessage; error?: GraphError }> {
  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const useGraph = backend === 'graph';
    const base = useGraph ? GRAPH_BASE : OUTLOOK_REST_BASE;
    const select = useGraph
      ? 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isRead,hasAttachments'
      : 'Id,Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,Body,BodyPreview,IsRead,HasAttachments';
    return {
      url:
        `${base}/me/messages/${encodePathId(messageId)}?` +
        new URLSearchParams({ $select: select }).toString(),
      init: {
        headers: { Prefer: 'outlook.body-content-type="html"' },
      },
    };
  });

  if ('error' in result) return { error: result.error };
  const { res } = result;
  if (res.status === 404) return { error: { code: 'NOT_FOUND', message: '邮件不存在' } };
  if (!res.ok) return { error: httpError(res.status, 'Failed to fetch email detail') };

  try {
    const data = (await res.json()) as AnyRec;
    return { item: normalizeMessage(data) };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Delete a message (soft-deletes it to Deleted Items)
export async function deleteEmail(
  accessToken: string,
  messageId: string
): Promise<{ ok: boolean; error?: GraphError }> {
  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const base = backend === 'graph' ? GRAPH_BASE : OUTLOOK_REST_BASE;
    return {
      url: `${base}/me/messages/${encodePathId(messageId)}`,
      init: { method: 'DELETE' },
    };
  });

  if ('error' in result) return { ok: false, error: result.error };
  const { res } = result;
  if (res.status === 204 || res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, error: { code: 'NOT_FOUND', message: '邮件不存在' } };
  if (res.status === 403) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: '无删除权限：该账号是只读授权。请在「编辑账号 → 重新授权」重新授权以获取读写权限',
      },
    };
  }
  return { ok: false, error: httpError(res.status, '删除失败') };
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64, present when fetching a single fileAttachment
}

// List attachments metadata for a message
export async function listAttachments(
  accessToken: string,
  messageId: string
): Promise<{ items?: GraphAttachment[]; error?: GraphError }> {
  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const useGraph = backend === 'graph';
    const base = useGraph ? GRAPH_BASE : OUTLOOK_REST_BASE;
    const select = useGraph ? 'id,name,contentType,size' : 'Id,Name,ContentType,Size';
    return {
      url: `${base}/me/messages/${encodePathId(messageId)}/attachments?$select=${select}`,
    };
  });

  if ('error' in result) return { error: result.error };
  const { res } = result;
  if (!res.ok) return { error: httpError(res.status, '获取附件列表失败') };

  try {
    const data = (await res.json()) as { value?: AnyRec[] };
    return { items: (data.value ?? []).map(normalizeAttachment) };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Fetch a single attachment (includes base64 contentBytes for fileAttachment)
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<{ attachment?: GraphAttachment; error?: GraphError }> {
  const result = await fetchWithMailFallback(accessToken, (backend) => {
    const base = backend === 'graph' ? GRAPH_BASE : OUTLOOK_REST_BASE;
    return {
      url: `${base}/me/messages/${encodePathId(messageId)}/attachments/${encodePathId(attachmentId)}`,
    };
  });

  if ('error' in result) return { error: result.error };
  const { res } = result;
  if (res.status === 404) return { error: { code: 'NOT_FOUND', message: '附件不存在' } };
  if (!res.ok) return { error: httpError(res.status, '获取附件失败') };

  try {
    const data = (await res.json()) as AnyRec;
    return { attachment: normalizeAttachment(data) };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Remove any token-like strings from error messages
function sanitizeErrorMessage(msg: string): string {
  // Redact anything that looks like a token (long base64/alphanumeric strings)
  return msg.replace(/[A-Za-z0-9_-]{40,}/g, (match) => maskToken(match));
}
