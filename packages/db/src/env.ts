import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Repo root is three levels up from packages/db/src.
const REPO_ROOT_ENV = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.env',
);

// Loads DATABASE_URL for every consumer of @legion/db (migrate-cli, daemon,
// test suites). Real environment variables take precedence over the file.
dotenv.config({ path: REPO_ROOT_ENV });
