import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import worker from '../src/index';
import { runEmailPush, runTokenRefresh } from '../src/cron';
import type { Env } from '../src/types';
import { applyMigrations, importD1Data, openDatabase } from './sqlite';
import { rewriteExternalUrl } from './url';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

class NodeExecutionContext {
  waitUntil(promise: Promise<unknown>): void {
    void promise.catch((error) => console.error('Background task failed:', error));
  }

  passThroughOnException(): void {}
}

function requiredEnv(name: 'ADMIN_PASSWORD' | 'COOKIE_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const databasePath = process.env.DATABASE_PATH || '/data/outlook-email.db';
  const migrationsDir = resolve(process.env.MIGRATIONS_DIR || './migrations');
  const db = openDatabase(databasePath);
  const applied = applyMigrations(db, migrationsDir);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

  if (process.argv[2] === 'import') {
    const inputPath = process.argv[3];
    if (!inputPath) throw new Error('Usage: node dist/server.mjs import /path/to/d1-data.sql');
    importD1Data(db, inputPath);
    db.close();
    console.log(`Imported D1 data from ${inputPath}`);
    return;
  }

  const env: Env = {
    DB: db as unknown as D1Database,
    ASSETS: {
      fetch: () => Promise.resolve(new Response('Not found', { status: 404 })),
    } as unknown as Fetcher,
    ADMIN_PASSWORD: requiredEnv('ADMIN_PASSWORD'),
    COOKIE_SECRET: requiredEnv('COOKIE_SECRET'),
    GPTMAIL_API_KEY: process.env.GPTMAIL_API_KEY?.trim() || undefined,
  };
  const publicUrl = process.env.PUBLIC_URL?.trim() || undefined;
  if (publicUrl) rewriteExternalUrl(new Request('http://localhost/'), publicUrl);

  const app = new Hono<{ Bindings: Env }>();
  app.get('/healthz', async (c) => {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ status: 'ok' });
  });
  app.use(
    '/assets/*',
    serveStatic({
      root: './public',
      onFound: (_path, c) => c.header('Cache-Control', 'public, max-age=3600'),
    })
  );
  app.get('/', serveStatic({ path: './public/index.html' }));
  app.get('/login.html', serveStatic({ path: './public/login.html' }));
  app.all('*', (c) => {
    const request = rewriteExternalUrl(c.req.raw, publicUrl);
    return worker.fetch(request, c.env, new NodeExecutionContext() as ExecutionContext);
  });

  let scheduledJobRunning = false;
  const runScheduledJobs = async () => {
    if (scheduledJobRunning) {
      console.warn('Skipping scheduled run because the previous run is still active');
      return;
    }
    scheduledJobRunning = true;
    try {
      console.log(await runTokenRefresh(env));
      console.log(await runEmailPush(env));
    } catch (error) {
      console.error('Scheduled run failed:', error);
    } finally {
      scheduledJobRunning = false;
    }
  };
  const timer = setInterval(() => void runScheduledJobs(), FIVE_MINUTES_MS);

  const port = Number.parseInt(process.env.PORT || '8787', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const server = serve(
    {
      fetch: (request) => app.fetch(request, env),
      hostname: '0.0.0.0',
      port,
    },
    () => console.log(`Outlook Email listening on 0.0.0.0:${port}; database: ${resolve(databasePath)}`)
  );

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
