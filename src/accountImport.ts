import { batchRun, chunk, D1_MAX_BOUND_PARAMS, first } from './db';
import { isValidEmail } from './utils/validation';

const FIELD_LIMITS = {
  email: 254,
  password: 1024,
  clientId: 256,
  refreshToken: 8192,
} as const;
const CONTROL_CHARACTER_RE = /\p{Cc}/u;
const INSERT_FIELDS_PER_ACCOUNT = 5;
const INSERT_ACCOUNTS_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / INSERT_FIELDS_PER_ACCOUNT);

export type AccountImportReason =
  | 'format'
  | 'invalid_email'
  | 'email_too_long'
  | 'password_too_long'
  | 'client_id_required'
  | 'client_id_too_long'
  | 'refresh_token_required'
  | 'refresh_token_too_long'
  | 'control_character'
  | 'duplicate_in_input'
  | 'already_exists';

export type AccountImportLineResult = {
  line: number;
  email: string;
  status: 'added' | 'duplicate' | 'invalid';
  reason?: AccountImportReason;
  field?: 'email' | 'password' | 'client_id' | 'refresh_token';
};

export interface AccountImportSummary {
  total: number;
  blank: number;
  added: number;
  duplicates: number;
  invalid: number;
  results: AccountImportLineResult[];
}

export class AccountImportRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'AccountImportRequestError';
  }
}

type ParsedAccount = {
  line: number;
  email: string;
  password: string;
  clientId: string;
  refreshToken: string;
  emailKey: string;
};

function splitPhysicalLines(input: string): string[] {
  const lines = input.split(/\r\n|\n|\r/);
  // A final line terminator ends the preceding physical line; it does not create
  // another blank account line by itself.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function safeEmail(rawEmail: string): string {
  const email = rawEmail.trim();
  if (!email || email.length > FIELD_LIMITS.email || CONTROL_CHARACTER_RE.test(email)) return '';
  return email;
}

function invalidResult(
  line: number,
  email: string,
  reason: AccountImportReason,
  field?: AccountImportLineResult['field']
): AccountImportLineResult {
  return { line, email, status: 'invalid', reason, ...(field ? { field } : {}) };
}

function parseImportText(accountString: string): {
  blank: number;
  total: number;
  accounts: ParsedAccount[];
  results: AccountImportLineResult[];
} {
  const text = accountString.startsWith('﻿') ? accountString.slice(1) : accountString;
  const lines = splitPhysicalLines(text);
  const nonBlankLines = lines.filter((line) => line.trim().length > 0);
  if (nonBlankLines.length === 0) {
    throw new AccountImportRequestError('EMPTY_IMPORT', '账号数据不能为空');
  }
  let blank = 0;
  const accounts: ParsedAccount[] = [];
  const results: AccountImportLineResult[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = index + 1;
    if (!rawLine.trim()) {
      blank++;
      continue;
    }

    const parts = rawLine.split('----');
    if (parts.length !== 4) {
      results.push(invalidResult(line, '', 'format'));
      continue;
    }

    const [rawEmail, rawPassword, rawClientId, rawRefreshToken] = parts;
    const emailForResponse = safeEmail(rawEmail);
    const fieldNames = ['email', 'password', 'client_id', 'refresh_token'] as const;
    const controlFieldIndex = parts.findIndex((field) => CONTROL_CHARACTER_RE.test(field));
    if (controlFieldIndex >= 0) {
      results.push(invalidResult(line, emailForResponse, 'control_character', fieldNames[controlFieldIndex]));
      continue;
    }

    const email = rawEmail.trim();
    const password = rawPassword.trim();
    const clientId = rawClientId.trim();
    const refreshToken = rawRefreshToken.trim();
    if (rawEmail.length > FIELD_LIMITS.email) {
      results.push(invalidResult(line, '', 'email_too_long'));
      continue;
    }
    if (!email || !isValidEmail(email)) {
      results.push(invalidResult(line, emailForResponse, 'invalid_email'));
      continue;
    }
    if (rawPassword.length > FIELD_LIMITS.password) {
      results.push(invalidResult(line, email, 'password_too_long'));
      continue;
    }
    if (!clientId) {
      results.push(invalidResult(line, email, 'client_id_required'));
      continue;
    }
    if (rawClientId.length > FIELD_LIMITS.clientId) {
      results.push(invalidResult(line, email, 'client_id_too_long'));
      continue;
    }
    if (!refreshToken) {
      results.push(invalidResult(line, email, 'refresh_token_required'));
      continue;
    }
    if (rawRefreshToken.length > FIELD_LIMITS.refreshToken) {
      results.push(invalidResult(line, email, 'refresh_token_too_long'));
      continue;
    }

    const emailKey = email.toLowerCase();
    if (seen.has(emailKey)) {
      results.push({
        line,
        email,
        status: 'duplicate',
        reason: 'duplicate_in_input',
      });
      continue;
    }
    seen.add(emailKey);
    accounts.push({ line, email, password, clientId, refreshToken, emailKey });
  }

  return { blank, total: nonBlankLines.length, accounts, results };
}

export async function importAccounts(
  db: D1Database,
  accountString: string,
  groupId: number
): Promise<AccountImportSummary> {
  const group = await first<{ id: number }>(db, 'SELECT id FROM groups WHERE id = ?', [groupId]);
  if (!group) {
    throw new AccountImportRequestError('GROUP_NOT_FOUND', '目标分组不存在', 404);
  }

  const parsed = parseImportText(accountString);
  const existingKeys = new Set<string>();
  const emailKeys = parsed.accounts.map((account) => account.emailKey);
  if (emailKeys.length > 0) {
    const existingResults = await batchRun<{ email: string }>(
      db,
      chunk(emailKeys, D1_MAX_BOUND_PARAMS).map((part) => ({
        sql: `SELECT email FROM accounts WHERE LOWER(email) IN (${part.map(() => '?').join(',')})`,
        params: part,
      }))
    );
    for (const result of existingResults) {
      for (const row of result.results) existingKeys.add(row.email.trim().toLowerCase());
    }
  }

  const toInsert: ParsedAccount[] = [];
  for (const account of parsed.accounts) {
    if (existingKeys.has(account.emailKey)) {
      parsed.results.push({
        line: account.line,
        email: account.email,
        status: 'duplicate',
        reason: 'already_exists',
      });
    } else {
      toInsert.push(account);
    }
  }

  let added = 0;
  if (toInsert.length > 0) {
    const insertResults = await batchRun<{ email: string }>(
      db,
      chunk(toInsert, INSERT_ACCOUNTS_PER_STATEMENT).map((part) => {
        const params: unknown[] = [];
        for (const account of part) {
          params.push(account.email, account.password, account.clientId, account.refreshToken, groupId);
        }
        return {
          sql: `INSERT INTO accounts (email, password, client_id, refresh_token, group_id) VALUES ${part
            .map(() => '(?, ?, ?, ?, ?)')
            .join(', ')} ON CONFLICT(email) DO NOTHING RETURNING email`,
          params,
        };
      })
    );
    const insertedEmails = new Set(
      insertResults.flatMap((result) => result.results.map((row) => row.email))
    );

    for (const account of toInsert) {
      if (insertedEmails.has(account.email)) {
        added++;
        parsed.results.push({ line: account.line, email: account.email, status: 'added' });
      } else {
        parsed.results.push({
          line: account.line,
          email: account.email,
          status: 'duplicate',
          reason: 'already_exists',
        });
      }
    }
  }

  parsed.results.sort((a, b) => a.line - b.line);
  const duplicates = parsed.results.filter((result) => result.status === 'duplicate').length;
  const invalid = parsed.results.filter((result) => result.status === 'invalid').length;
  return {
    total: parsed.total,
    blank: parsed.blank,
    added,
    duplicates,
    invalid,
    results: parsed.results,
  };
}
