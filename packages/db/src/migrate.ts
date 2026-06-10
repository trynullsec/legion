import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export async function runMigrations(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await pool.query(
      'select 1 from schema_migrations where name = $1',
      [file],
    );
    if (rows.length > 0) continue;

    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [
        file,
      ]);
      await client.query('commit');
      applied.push(file);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}
