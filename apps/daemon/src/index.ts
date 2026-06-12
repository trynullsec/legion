import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPool } from '@legion/db';
import { Orchestrator } from '@legion/orchestrator';
import { WorkerSupervisor } from '@legion/runtime';
import { createApp } from './app.js';
import { Scheduler } from './scheduler.js';

const PORT = 4242;

const pool = createPool();
const supervisor = new WorkerSupervisor({ pool });
const orchestrator = new Orchestrator({ pool, supervisor });
const scheduler = new Scheduler(pool, orchestrator);

// Daemon restart with workers running: mark orphaned RUNNING workers FAILED.
const orphaned = await supervisor.reconcileOrphans();
if (orphaned.length > 0) {
  console.log(`reconciled ${orphaned.length} orphaned worker(s):`, orphaned);
}

// Crash reconciliation (M5 pin 5d): emit MERGE_APPROVED for any merge commit
// that exists in a user repo while the mission never recorded the event.
const reconciledMerges = await orchestrator.reconcileMerges();
if (reconciledMerges.length > 0) {
  console.log(`reconciled ${reconciledMerges.length} merge(s):`, reconciledMerges);
}

const app = createApp(pool, supervisor, orchestrator, scheduler);

// M6c: start the scheduler loop. Its boot tick catches up any missed runs
// (exactly once each) while the daemon was down.
scheduler.start();

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
