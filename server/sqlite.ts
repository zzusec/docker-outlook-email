import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

type SqliteValue = null | number | bigint | string | Uint8Array;

function normalizeValue(value: unknown): SqliteValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(`Unsupported SQLite bind value: ${typeof value}`);
}

function metadata(rowsRead = 0, changes = 0, lastRowId = 0) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: rowsRead,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

export class SqlitePreparedStatement {
  readonly owner: SqliteD1Database;
  readonly sql: string;
  readonly params: SqliteValue[];

  constructor(owner: SqliteD1Database, sql: string, params: SqliteValue[] = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this.owner, this.sql, values.map(normalizeValue));
  }

  async all<T = Record<string, unknown>>() {
    return this.executeQuery<T>();
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.statement().get(...this.params) as T | undefined;
    if (row === undefined) return null;
    if (columnName) return (row as Record<string, T>)[columnName] ?? null;
    return row;
  }

  async run() {
    return this.executeMutation();
  }

  execute<T = Record<string, unknown>>() {
    if (/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(this.sql)) {
      return this.executeQuery<T>();
    }
    return this.executeMutation();
  }

  private statement(): StatementSync {
    return this.owner.native.prepare(this.sql);
  }

  private executeQuery<T>() {
    const rows = this.statement().all(...this.params) as T[];
    return {
      success: true as const,
      results: rows,
      meta: metadata(rows.length),
    };
  }

  private executeMutation() {
    const result = this.statement().run(...this.params);
    const changes = Number(result.changes);
    return {
      success: true as const,
      results: [],
      meta: metadata(0, changes, Number(result.lastInsertRowid)),
    };
  }
}

export class SqliteD1Database {
  readonly native: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.native = new DatabaseSync(path);
    this.native.exec('PRAGMA foreign_keys = ON');
    this.native.exec('PRAGMA journal_mode = WAL');
    this.native.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): SqlitePreparedStatement {
    return new SqlitePreparedStatement(this, sql);
  }

  async batch<T = Record<string, unknown>>(statements: SqlitePreparedStatement[]) {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqlitePreparedStatement) || statement.owner !== this) {
          throw new TypeError('Batch statements must belong to this database');
        }
        return statement.execute<T>();
      });
      this.native.exec('COMMIT');
      return results;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.native.close();
  }
}

export function openDatabase(path: string): SqliteD1Database {
  return new SqliteD1Database(resolve(path));
}

export function applyMigrations(db: SqliteD1Database, migrationsDir: string): string[] {
  db.native.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);

  const appliedRows = db.native.prepare('SELECT name FROM d1_migrations').all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((row) => row.name));
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const newlyApplied: string[] = [];
  const recordMigration = db.native.prepare('INSERT INTO d1_migrations (name) VALUES (?)');

  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(resolve(migrationsDir, name), 'utf8');
    db.native.exec('BEGIN IMMEDIATE');
    try {
      db.native.exec(sql);
      recordMigration.run(name);
      db.native.exec('COMMIT');
      newlyApplied.push(name);
    } catch (error) {
      db.native.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed`, { cause: error });
    }
  }

  return newlyApplied;
}

function hasApplicationData(db: SqliteD1Database): boolean {
  const tables = ['settings', 'accounts', 'temp_emails', 'tags', 'account_tags', 'push_state'];
  for (const table of tables) {
    const row = db.native.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (row.count > 0) return true;
  }

  const customGroups = db.native
    .prepare(
      `SELECT COUNT(*) AS count FROM groups
       WHERE id != 1 OR name != '默认分组' OR description != '默认邮箱分组' OR color != '#2563eb'`
    )
    .get() as { count: number };
  return customGroups.count > 0;
}

function withoutDumpTransactions(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?)\s*;?\s*$/i.test(line))
    .join('\n');
}

export function importD1Data(db: SqliteD1Database, inputPath: string): void {
  if (hasApplicationData(db)) {
    throw new Error('Refusing to import into a database that already contains application data');
  }

  const sql = readFileSync(resolve(inputPath), 'utf8');
  if (/\bd1_migrations\b/i.test(sql)) {
    throw new Error('The export contains d1_migrations; export only the application tables with --table');
  }
  if (/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i.test(sql)) {
    throw new Error('The export contains schema statements; create it with wrangler d1 export --no-schema');
  }

  db.native.exec('BEGIN IMMEDIATE');
  try {
    db.native.exec('DELETE FROM groups WHERE id = 1');
    db.native.exec(withoutDumpTransactions(sql));
    db.native.exec(`
      INSERT OR IGNORE INTO groups (id, name, description, color)
      VALUES (1, '默认分组', '默认邮箱分组', '#2563eb')
    `);
    db.native.exec('COMMIT');
  } catch (error) {
    db.native.exec('ROLLBACK');
    throw new Error('D1 data import failed', { cause: error });
  }
}
