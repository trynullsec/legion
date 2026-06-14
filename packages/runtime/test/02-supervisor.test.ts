import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appendWorkerEvent, createMission, createPool, runMigrations } from '@legion/db';
import { REPO_ROOT, WorkerSupervisor } from '../src/index.js';
import type { Pool } from 'pg';

const CREATION = {
  title: 'M1 runtime acceptance',
  objective: 'Spawn and observe real Hermes workers',
  repoPath: '/tmp/repo',
  riskLevel: 'low' as const,
};

let pool: Pool;
let supervisor: WorkerSupervisor;
let missionId: string;
let scratch: string;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is missing from the repo-root .env — the M1 ' +
        'integration tests spawn real Hermes workers against OpenRouter and ' +
        'cannot run without it. Add the key and re-run. (No-mock rule: these ' +
        'tests never skip.)',
    );
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate worker_events');
  supervisor = new WorkerSupervisor({ pool });
  const mission = await createMission(pool, CREATION);
  missionId = mission.missionId;
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'workers-'));
});

afterEach(async () => {
  // No-mock rule: clean up real processes even when assertions fail.
  await supervisor.shutdown();
});

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T10: a real worker completes the trivial task with a coherent trajectory', () => {
  it('writes out.txt and records a gapless trajectory ending in WORKER_EXITED(0)', async () => {
    const workdir = path.join(scratch, `t10-${randomUUID()}`);
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task:
        "Use the terminal to write the exact text 'legion-m1' (without the quotes) " +
        'into a file named out.txt in the current working directory. Create only ' +
        'that one file, then finish.',
      workdir,
    });

    await supervisor.waitForExit(workerId, 220_000);

    const out = await readFile(path.join(workdir, 'out.txt'), 'utf8');
    expect(out.trim()).toBe('legion-m1');

    const worker = await supervisor.getWorker(workerId);
    expect(worker?.status).toBe('EXITED');

    const events = await supervisor.getWorkerEvents(workerId);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'MODEL_MESSAGE').length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === 'TOOL_CALL').length).toBeGreaterThanOrEqual(1);

    const last = events[events.length - 1];
    expect(last?.type).toBe('WORKER_EXITED');
    expect(last?.payload.exitCode).toBe(0);
  });
});

describe('T11: worker environment is an allowlist — DATABASE_URL is invisible', () => {
  it('the worker itself reports its env var names; DATABASE_URL is absent', async () => {
    expect(process.env.DATABASE_URL ?? '').not.toBe(''); // parent HAS it
    const workdir = path.join(scratch, `t11-${randomUUID()}`);
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task:
        'Run this exact shell command in the current working directory: ' +
        'env | cut -d= -f1 | sort > envnames.txt — then finish.',
      workdir,
    });

    await supervisor.waitForExit(workerId, 220_000);

    const file = path.join(workdir, 'envnames.txt');
    expect(existsSync(file)).toBe(true);
    const names = (await readFile(file, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    expect(names).toContain('PATH');
    expect(names).toContain('HOME');
    expect(names).not.toContain('DATABASE_URL');
  });
});

describe('T12: hard stop kills the process and records WORKER_KILLED', () => {
  it('stopWorker(graceful=false) → status KILLED, no orphan PID', async () => {
    const workdir = path.join(scratch, `t12-${randomUUID()}`);
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task: "Run the shell command 'sleep 300' and wait for it to complete.",
      workdir,
    });

    // let it get genuinely running (model call + tool launch)
    await new Promise((r) => setTimeout(r, 8000));
    const before = await supervisor.getWorker(workerId);
    expect(before?.status).toBe('RUNNING');
    const pid = before?.pid;
    expect(pid).toBeTruthy();
    expect(pidAlive(pid!)).toBe(true);

    await supervisor.stopWorker(workerId, { graceful: false });
    await supervisor.waitForExit(workerId, 30_000);

    const after = await supervisor.getWorker(workerId);
    expect(after?.status).toBe('KILLED');

    const events = await supervisor.getWorkerEvents(workerId);
    expect(events.some((e) => e.type === 'WORKER_KILLED')).toBe(true);

    // no orphan process remains
    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(pid!)).toBe(false);
  });
});

describe('T13: hard timeout kills the worker and marks FAILED/TIMEOUT', () => {
  it('a 15s-timeout worker on an endless task dies at the deadline', async () => {
    const workdir = path.join(scratch, `t13-${randomUUID()}`);
    const started = Date.now();
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task:
        "Run the shell command 'sleep 1000' and wait for it to finish completely " +
        'before responding. Do not stop early.',
      workdir,
      timeoutMs: 15_000,
    });

    await supervisor.waitForExit(workerId, 60_000);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(55_000);

    const worker = await supervisor.getWorker(workerId);
    expect(worker?.status).toBe('FAILED');
    expect(worker?.reason).toBe('TIMEOUT');

    const events = await supervisor.getWorkerEvents(workerId);
    const failed = events.find((e) => e.type === 'WORKER_FAILED');
    expect(failed?.payload.reason).toBe('TIMEOUT');
    if (worker?.pid) {
      await new Promise((r) => setTimeout(r, 500));
      expect(pidAlive(worker.pid)).toBe(false);
    }
  });
});

async function groupPids(pgid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const p = spawn('pgrep', ['-g', String(pgid)]);
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.on('exit', () =>
      resolve(
        out
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
    p.on('error', () => resolve([]));
  });
}

async function waitForToolCall(
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await supervisor.getWorkerEvents(workerId);
    if (events.some((e) => e.type === 'TOOL_CALL')) return;
    if (events.some((e) => ['WORKER_EXITED', 'WORKER_FAILED', 'WORKER_KILLED'].includes(e.type))) {
      throw new Error(`worker ${workerId} terminated before issuing a tool call`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`worker ${workerId}: no TOOL_CALL within ${timeoutMs}ms`);
}

describe('T16: graceful stop — SIGTERM first, SIGKILL only at the deadline', () => {
  it('T16a: a cooperative worker exits on SIGTERM well inside the window', async () => {
    const workdir = path.join(scratch, `t16a-${randomUUID()}`);
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task: "Run the shell command 'sleep 300' and wait for it to complete.",
      workdir,
    });

    await waitForToolCall(workerId, 90_000);
    const running = await supervisor.getWorker(workerId);
    expect(running?.status).toBe('RUNNING');
    const pid = running!.pid!;

    const stoppedAt = Date.now();
    await supervisor.stopWorker(workerId, { graceful: true });
    await supervisor.waitForExit(workerId, 30_000);
    const elapsed = Date.now() - stoppedAt;

    // cooperative exit: well before the 10s escalation deadline
    expect(elapsed).toBeLessThan(8_000);

    const worker = await supervisor.getWorker(workerId);
    expect(worker?.status).toBe('KILLED'); // graceful stops fold to KILLED in our status model

    const events = await supervisor.getWorkerEvents(workerId);
    const killed = events.find((e) => e.type === 'WORKER_KILLED');
    expect(killed).toBeTruthy();
    expect(killed?.payload.graceful).toBe(true);
    expect(killed?.payload.signal).toBe('SIGTERM'); // SIGTERM ended it, not SIGKILL
    expect(killed?.payload.escalated).toBe(false);

    await new Promise((r) => setTimeout(r, 500));
    expect(pidAlive(pid)).toBe(false);
    expect(await groupPids(pid)).toEqual([]);
  });

  it('T16b: a SIGTERM-resistant task is SIGKILLed at the configured deadline', async () => {
    const workdir = path.join(scratch, `t16b-${randomUUID()}`);
    const workerId = await supervisor.startWorker({
      missionId,
      role: 'coder',
      task:
        'Run this exact shell command and wait for it to finish completely: ' +
        'bash -c \'trap "" TERM; sleep 600\'',
      workdir,
    });

    try {
      await waitForToolCall(workerId, 90_000);
      // TOOL_CALL fires before the subprocess exists — wait until the
      // TERM-resistant shell is genuinely alive, or the scenario is void.
      const resistantAlive = async (): Promise<boolean> =>
        new Promise((resolve) => {
          const p = spawn('pgrep', ['-f', 'trap "" TERM; sleep 600']);
          p.on('exit', (code) => resolve(code === 0));
          p.on('error', () => resolve(false));
        });
      const spawnDeadline = Date.now() + 30_000;
      while (!(await resistantAlive())) {
        if (Date.now() > spawnDeadline) {
          throw new Error('resistant shell never spawned');
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const running = await supervisor.getWorker(workerId);
      const pid = running!.pid!;
      const groupBefore = await groupPids(pid);
      expect(groupBefore.length).toBeGreaterThanOrEqual(1);

      const stoppedAt = Date.now();
      await supervisor.stopWorker(workerId, { graceful: true, graceMs: 2_000 });
      await supervisor.waitForExit(workerId, 30_000);
      const elapsed = Date.now() - stoppedAt;

      // the SIGKILL escalation fires at (not before) the ~2s deadline
      expect(elapsed).toBeGreaterThanOrEqual(1_800);
      expect(elapsed).toBeLessThan(15_000);

      const worker = await supervisor.getWorker(workerId);
      expect(worker?.status).toBe('KILLED');

      const events = await supervisor.getWorkerEvents(workerId);
      const killed = events.find((e) => e.type === 'WORKER_KILLED');
      expect(killed?.payload.graceful).toBe(true);
      expect(killed?.payload.escalated).toBe(true); // the escalation is recorded

      // nothing from the worker's process group survives
      await new Promise((r) => setTimeout(r, 500));
      expect(pidAlive(pid)).toBe(false);
      expect(await groupPids(pid)).toEqual([]);

      // and the TERM-resistant shell itself is dead, wherever it ended up
      const strays = await new Promise<string>((resolve) => {
        const p = spawn('pgrep', ['-f', 'trap "" TERM; sleep 600']);
        let out = '';
        p.stdout.on('data', (d) => (out += String(d)));
        p.on('exit', () => resolve(out.trim()));
        p.on('error', () => resolve(''));
      });
      expect(strays).toBe('');
    } finally {
      // belt-and-braces cleanup even on failure: reap any stray trap shell
      spawn('pkill', ['-9', '-f', 'trap "" TERM; sleep 600']);
    }
  });
});

describe('T14: orphan reconciliation on daemon restart', () => {
  it('a RUNNING row whose process is gone is marked FAILED/ORPHANED', async () => {
    // a real process that has genuinely exited — its pid is real but dead
    const dead = spawn('true');
    const deadPid: number = await new Promise((resolve, reject) => {
      dead.on('exit', () => resolve(dead.pid!));
      dead.on('error', reject);
    });
    expect(pidAlive(deadPid)).toBe(false);

    const workerId = randomUUID();
    await appendWorkerEvent(pool, {
      missionId,
      workerId,
      type: 'WORKER_CREATED',
      payload: { role: 'ghost', task: 'left over from a previous daemon', workdir: scratch },
    });
    await appendWorkerEvent(pool, {
      missionId,
      workerId,
      type: 'WORKER_STARTED',
      payload: { pid: deadPid },
    });

    // simulate daemon restart: a brand-new supervisor against the same DB
    const reborn = new WorkerSupervisor({ pool });
    const orphaned = await reborn.reconcileOrphans();
    expect(orphaned).toContain(workerId);

    const worker = await reborn.getWorker(workerId);
    expect(worker?.status).toBe('FAILED');
    expect(worker?.reason).toBe('ORPHANED');

    const events = await reborn.getWorkerEvents(workerId);
    const failed = events.find((e) => e.type === 'WORKER_FAILED');
    expect(failed?.payload.reason).toBe('ORPHANED');
  });
});
