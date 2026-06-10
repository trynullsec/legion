import { createPool } from './client.js';
import { runMigrations } from './migrate.js';

const pool = createPool();
try {
  const applied = await runMigrations(pool);
  if (applied.length === 0) {
    console.log('migrations: up to date');
  } else {
    for (const name of applied) console.log(`migrations: applied ${name}`);
  }
} finally {
  await pool.end();
}
