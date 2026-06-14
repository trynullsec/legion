/**
 * M7 capability unit tests — deterministic, no real spawn, no seatbelt needed.
 * - seatbelt profile generation (the .sb text is correct-by-construction)
 * - T82 refuse-to-start: an unenforceable profile makes the supervisor refuse
 *   to spawn, recording the refusal — never an unconfined run.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, getWorkerEvents, runMigrations } from '@legion/db';
import { resolveCapabilityProfile } from '@legion/core';
import { buildSeatbeltProfile } from '../src/seatbelt.js';
import { UnavailableEnforcer } from '../src/enforcer.js';
import { EnforcementUnavailableError, WorkerSupervisor } from '../src/supervisor.js';
import type { Pool } from 'pg';

describe('seatbelt profile generation', () => {
  it('denies by default, confines writes, allows only the proxy port outbound', () => {
    const sb = buildSeatbeltProfile(resolveCapabilityProfile('coder'), {
      writePaths: ['/tmp/legion-x/work'],
      readPaths: ['/tmp/legion-x/work'],
      proxyPort: 51515,
    });
    expect(sb).toContain('(deny default)');
    expect(sb).toMatch(/\(allow file-write\* \(subpath "[^"]*work"\)\)/);
    // network is fail-closed except the loopback proxy chokepoint (seatbelt
    // requires the host to be "localhost", never a numeric IP)
    expect(sb).toContain('(remote ip "localhost:51515")');
    expect(sb).not.toContain('(allow network-outbound)\n'); // never a blanket net allow
    // a write path that does not exist still resolves to an absolute path,
    // never the empty string (the /tmp→/private symlink gotcha guard)
    expect(sb).not.toContain('(subpath "")');
  });

  it('open profile (no subprocess) still allows exec of the interpreter itself', () => {
    const sb = buildSeatbeltProfile(resolveCapabilityProfile('open'), {
      writePaths: ['/tmp/legion-y/work/deliverables'],
      readPaths: ['/tmp/legion-y/work'],
      proxyPort: 6000,
    });
    expect(sb).toContain('(allow process-exec*)');
    expect(sb).not.toContain('/SELF'); // placeholder must be resolved away
  });
});

describe('T82: refuse-to-start when enforcement is unavailable', () => {
  let pool: Pool;
  let scratch: string;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-t82-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await pool.end();
  });

  it('the supervisor refuses to spawn and records the refusal — no unconfined run', async () => {
    const supervisor = new WorkerSupervisor({
      pool,
      enforcer: new UnavailableEnforcer('seatbelt blocked in this environment'),
      workdirRoot: scratch,
    });

    await expect(
      supervisor.startWorker({
        missionId: crypto.randomUUID(),
        role: 'coder',
        task: 'noop',
      }),
    ).rejects.toBeInstanceOf(EnforcementUnavailableError);
  });

  it('records WORKER_FAILED {ENFORCEMENT_UNAVAILABLE} and never WORKER_STARTED', async () => {
    const supervisor = new WorkerSupervisor({
      pool,
      enforcer: new UnavailableEnforcer(),
      workdirRoot: scratch,
    });
    const missionId = crypto.randomUUID();
    // capture the workerId by listing the mission's workers after the throw
    await supervisor
      .startWorker({ missionId, role: 'open', task: 'noop', extraEnv: { LEGION_TOOLSET: 'web' } })
      .catch(() => {});

    const workers = await supervisor.listWorkers(missionId);
    expect(workers).toHaveLength(1);
    const events = await getWorkerEvents(pool, workers[0]!.workerId);
    const types = events.map((e) => e.type);
    expect(types).toContain('WORKER_CREATED');
    expect(types).toContain('WORKER_FAILED');
    expect(types).not.toContain('WORKER_STARTED'); // never executed
    const failed = events.find((e) => e.type === 'WORKER_FAILED')!;
    expect(failed.payload.reason).toBe('ENFORCEMENT_UNAVAILABLE');
  });
});
