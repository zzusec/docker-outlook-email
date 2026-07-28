// Warmup script - pre-load modules before server starts
const { openDatabase, applyMigrations } = require('./dist/sqlite.cjs');

console.log('Warming up...');
const start = Date.now();

try {
  const db = openDatabase('/data/outlook-email.db');
  db.prepare('SELECT 1').get();
  db.prepare('SELECT COUNT(*) FROM accounts').get();
  db.close();
  console.log(`Warmup complete in ${Date.now() - start}ms`);
} catch (e) {
  console.log('Warmup skipped (db not ready)');
}
