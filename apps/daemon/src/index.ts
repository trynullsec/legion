import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '@legion/db';
import { WorkerSupervisor } from '@legion/runtime';
import { createApp } from './app.js';

const PORT = 4242;

const pool = createPool();
const supervisor = new WorkerSupervisor({ pool });

// Daemon restart with workers running: mark orphaned RUNNING workers FAILED.
const orphaned = await supervisor.reconcileOrphans();
if (orphaned.length > 0) {
  console.log(`reconciled ${orphaned.length} orphaned worker(s):`, orphaned);
}

const app = createApp(pool, supervisor);

// Serve the built Mission Board (apps/board/dist) for everything non-API.
const boardDist = path.relative(
  process.cwd(),
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'board',
    'dist',
  ),
);
app.use('*', serveStatic({ root: boardDist }));
app.use('*', serveStatic({ root: boardDist, path: 'index.html' }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`legion daemon listening on http://localhost:${info.port}`);
});
