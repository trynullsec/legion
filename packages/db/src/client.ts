import './env.js';
import pg from 'pg';

/** Last-resort fallback only; the source of truth is DATABASE_URL in the repo-root .env. */
export const DEFAULT_DATABASE_URL =
  'postgres://legion:legion@localhost:5434/legion';

export function createPool(databaseUrl?: string): pg.Pool {
  return new pg.Pool({
    connectionString:
      databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
}
