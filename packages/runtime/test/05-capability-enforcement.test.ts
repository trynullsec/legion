/**
 * M7 OS-confinement integration (T78/T79/T81/T84). REAL seatbelt, REAL escape
 * attempts — no simulated sandbox. Auto-detecting per the no-mock rule:
 *   - where seatbelt CAN apply (a normal terminal): run real escape attempts
 *     against the exact profile the supervisor generates and assert denial.
 *   - where it CANNOT (e.g. already inside a sandbox): assert the supervisor
 *     REFUSES TO START — never an unconfined run.
 *
 * The FS/net cases exercise the generated profile directly under sandbox-exec
 * (deterministic, no model); T81 spawns a real worker to prove the
 * CAPABILITY_PROFILE event is recorded before any work.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, getWorkerEvents, runMigrations } from '@legion/db';
import { resolveCapabilityProfile } from '@legion/core';
import { WorkerSupervisor, EnforcementUnavailableError } from '../src/supervisor.js';
import {
  buildSeatbeltProfile,
  canEnforceSeatbelt,
  seatbeltWrap,
  writeProfileFile,
  type ConcreteGrants,
} from '../src/seatbelt.js';
import type { Pool } from 'pg';

const ENFORCES = canEnforceSeatbelt().ok;

let pool: Pool;
let scratch: string;

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — M7 integration runs a real worker (T81).');
  }
  pool = createPool();
  await runMigrations(pool);
  scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-m7-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

/** Run a command under the seatbelt profile the supervisor would generate. */
function runConfined(
  role: string,
  grants: ConcreteGrants,
  command: string,
  args: string[],
): { status: number | null; stderr: string } {
  const profile = resolveCapabilityProfile(role);
  const sb = buildSeatbeltProfile(profile, grants);
  const file = writeProfileFile(grants.writePaths[0]!, sb);
  const wrapped = seatbeltWrap(file, command, args);
  const r = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('T78/T84: filesystem confinement (real OS denial)', () => {
  it('write INSIDE the workdir succeeds; write OUTSIDE fails closed (file never exists)', async () => {
    if (!ENFORCES) {
      // honest fallback: prove the supervisor refuses rather than running unconfined
      const sup = new WorkerSupervisor({ pool, workdirRoot: scratch });
      await expect(
        sup.startWorker({ missionId: crypto.randomUUID(), role: 'coder', task: 'noop' }),
      ).rejects.toBeInstanceOf(EnforcementUnavailableError);
      return;
    }

    const work = await mkdtemp(path.join(scratch, 'coder-'));
    await mkdir(path.join(work, '.tmp'), { recursive: true });
    const grants: ConcreteGrants = {
      writePaths: [work],
      readPaths: [work],
      proxyPort: 1, // unused here
    };
    const inside = path.join(work, 'in-scope.txt');
    const outside = path.join(scratch, 'ESCAPED.txt');

    // in-scope write must succeed (the allow-side is correct → T83 confidence)
    const ok = runConfined('coder', grants, '/bin/sh', ['-c', `echo hi > ${inside}`]);
    expect(ok.status).toBe(0);
    expect(existsSync(inside)).toBe(true);

    // out-of-scope write must fail closed and leave nothing behind
    const esc = runConfined('coder', grants, '/bin/sh', ['-c', `echo nope > ${outside}`]);
    expect(esc.status).not.toBe(0);
    expect(existsSync(outside)).toBe(false);

    // planner has the same fs ceiling — writing to $HOME outside its workdir fails
    const home = path.join(os.homedir(), 'LEGION_SHOULD_NOT_EXIST.txt');
    const ph = runConfined('planner', grants, '/bin/sh', ['-c', `echo nope > ${home}`]);
    expect(ph.status).not.toBe(0);
    expect(existsSync(home)).toBe(false);
  });
});

describe('T79: net:none confinement (connection fails closed)', () => {
  it('a coder cannot reach the network (only the loopback proxy is permitted)', async () => {
    if (!ENFORCES) {
      const sup = new WorkerSupervisor({ pool, workdirRoot: scratch });
      await expect(
        sup.startWorker({ missionId: crypto.randomUUID(), role: 'coder', task: 'noop' }),
      ).rejects.toBeInstanceOf(EnforcementUnavailableError);
      return;
    }
    const work = await mkdtemp(path.join(scratch, 'net-'));
    const grants: ConcreteGrants = { writePaths: [work], readPaths: [work], proxyPort: 1 };
    // numeric IP → no DNS needed; seatbelt denies the connection outright
    const r = runConfined('coder', grants, '/usr/bin/curl', [
      '-sS', '--max-time', '6', 'https://1.1.1.1',
    ]);
    expect(r.status).not.toBe(0); // fails closed
  });
});

describe('T81: CAPABILITY_PROFILE recorded before any work', () => {
  it('every spawned worker records its resolved profile first', async () => {
    const sup = new WorkerSupervisor({ pool, workdirRoot: scratch });
    const missionId = crypto.randomUUID();

    if (!ENFORCES) {
      // cannot spawn confined here → must refuse, never run unconfined
      await expect(
        sup.startWorker({ missionId, role: 'coder', task: 'noop' }),
      ).rejects.toBeInstanceOf(EnforcementUnavailableError);
      return;
    }

    const workerId = await sup.startWorker({
      missionId,
      role: 'coder',
      task: 'Respond with exactly: ok',
    });
    // the profile is appended before spawn; stop the worker, we only need the event
    await sup.stopWorker(workerId, { graceful: false }).catch(() => {});
    await sup.waitForExit(workerId, 30_000).catch(() => {});

    const events = await getWorkerEvents(pool, workerId);
    const idxProfile = events.findIndex((e) => e.type === 'CAPABILITY_PROFILE');
    const idxStarted = events.findIndex((e) => e.type === 'WORKER_STARTED');
    expect(idxProfile).toBeGreaterThanOrEqual(0);
    // recorded BEFORE the process started
    expect(idxStarted === -1 || idxProfile < idxStarted).toBe(true);

    const profile = events[idxProfile]!.payload;
    expect(profile.role).toBe('coder');
    expect(profile.network).toBe('none');
    expect(profile.mechanism).toBe('seatbelt');
    expect(Array.isArray(profile.writePaths)).toBe(true);
  }, 120_000);
});

describe('T84: isolation is enforced by the OS layer, not env/toolset', () => {
  it('a real worker told to write outside its workdir is denied by the kernel', async () => {
    const sup = new WorkerSupervisor({ pool, workdirRoot: scratch });
    const missionId = crypto.randomUUID();
    const escape = path.join(os.homedir(), `LEGION_ESCAPE_${process.pid}.txt`);

    if (!ENFORCES) {
      await expect(
        sup.startWorker({ missionId, role: 'coder', task: 'noop' }),
      ).rejects.toBeInstanceOf(EnforcementUnavailableError);
      return;
    }

    const workerId = await sup.startWorker({
      missionId,
      role: 'coder',
      task:
        `Use the terminal to run exactly this command and then finish: ` +
        `printf legion > ${escape}`,
    });
    await sup.waitForExit(workerId, 120_000).catch(() => {});

    // the kernel denied the out-of-scope write — the file never came to exist
    expect(existsSync(escape)).toBe(false);

    // and the denial surfaced to the worker as an OS error, not a silent pass
    const events = await getWorkerEvents(pool, workerId);
    const denied = events.some(
      (e) =>
        e.type === 'TOOL_RESULT' &&
        /not permitted|Operation not permitted|denied/i.test(
          JSON.stringify(e.payload),
        ),
    );
    expect(denied).toBe(true);
    if (existsSync(escape)) await rm(escape);
  }, 180_000);
});
