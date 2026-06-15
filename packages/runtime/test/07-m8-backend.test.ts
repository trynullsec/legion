/**
 * M8 — full-capability open missions. Runtime-level acceptance:
 *   T85 toolset expansion (full Hermes core), unit via the real venv resolver
 *   T88 backend resolution + docker-unavailable → typed fail (deterministic via
 *       injected probe), local backend resolves
 *   T86 docker lifecycle — AUTO-DETECTING: real container if Docker is up
 *       (asserts hardening flags + persistent /workspace + state carry + reap),
 *       else asserts refuse-to-start (DockerUnavailableError), never silent.
 *   T89 host safety — AUTO-DETECTING: real out-of-/workspace write blocked by
 *       the container boundary, host untouched; else covered by T88's refuse.
 * Profile shape + seatbelt docker-socket grant are asserted as unit facts.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, getWorkerEvents, runMigrations } from '@legion/db';
import { resolveCapabilityProfile } from '@legion/core';
import {
  DEFAULT_RUNTIME_CONFIG,
  detectDockerSocket,
  dockerAvailable,
  DockerUnavailableError,
  dockerWorkspaceDir,
  resolveTerminalBackend,
  WorkerSupervisor,
} from '../src/index.js';
import { buildSeatbeltProfile } from '../src/seatbelt.js';
import type { Pool } from 'pg';

const exec = promisify(execFile);
const DOCKER = dockerAvailable().ok;

// ---------- T85: toolset expansion (unit, real venv toolset resolver) ----------

const VENV_PYTHON = path.join(DEFAULT_RUNTIME_CONFIG.venvPython);
const VENDOR = DEFAULT_RUNTIME_CONFIG.vendorDir;

async function resolveToolset(name: string): Promise<string[]> {
  const { stdout } = await exec(
    VENV_PYTHON,
    [
      '-c',
      'import json, sys\n' +
        'from toolsets import resolve_multiple_toolsets\n' +
        'print(json.dumps(sorted(resolve_multiple_toolsets([sys.argv[1]]))))',
      name,
    ],
    { env: { ...process.env, PYTHONPATH: VENDOR } },
  );
  return JSON.parse(stdout.trim()) as string[];
}

describe('T85: open worker toolset is the full Hermes core', () => {
  it('the configured open toolset contains terminal, code, file, browser, web, todo', async () => {
    const tools = await resolveToolset(DEFAULT_RUNTIME_CONFIG.openMissionToolset);
    for (const expected of [
      'terminal',
      'execute_code',
      'read_file',
      'write_file',
      'patch',
      'browser_navigate',
      'web_search',
      'web_extract',
      'todo',
    ]) {
      expect(tools, `${expected} present`).toContain(expected);
    }
    // and it is strictly larger than the M6d read-only set
    expect(tools.length).toBeGreaterThan(2);
  });
});

// ---------- T88: backend resolution + docker-unavailable fail ----------

describe('T88: terminal backend resolution', () => {
  it('defaults to docker, accepts local, rejects invalid', () => {
    expect(resolveTerminalBackend({})).toBe('docker');
    expect(resolveTerminalBackend({ LEGION_TERMINAL_BACKEND: 'docker' })).toBe('docker');
    expect(resolveTerminalBackend({ LEGION_TERMINAL_BACKEND: 'local' })).toBe('local');
    expect(() => resolveTerminalBackend({ LEGION_TERMINAL_BACKEND: 'vm' })).toThrow();
  });

  let pool: Pool;
  let scratch: string;
  beforeAll(async () => {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY missing — M8 runtime tests run real workers.');
    }
    pool = createPool();
    await runMigrations(pool);
    scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-m8-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await pool.end();
  });

  it('docker selected + Docker unavailable → DockerUnavailableError, recorded, no run', async () => {
    const sup = new WorkerSupervisor({
      pool,
      terminalBackend: 'docker',
      workdirRoot: scratch,
      // force the down case regardless of the host's real Docker
      dockerProbe: () => ({ ok: false, detail: 'forced down for test' }),
    });
    const missionId = crypto.randomUUID();
    await expect(
      sup.startWorker({
        missionId,
        role: 'worker',
        task: 'noop',
        extraEnv: { LEGION_CAPABILITY_ROLE: 'open' },
      }),
    ).rejects.toBeInstanceOf(DockerUnavailableError);

    const workers = await sup.listWorkers(missionId);
    expect(workers).toHaveLength(1);
    const events = await getWorkerEvents(pool, workers[0]!.workerId);
    const types = events.map((e) => e.type);
    expect(types).toContain('WORKER_FAILED');
    expect(types).not.toContain('WORKER_STARTED');
    expect(events.find((e) => e.type === 'WORKER_FAILED')!.payload.reason).toBe(
      'DOCKER_UNAVAILABLE',
    );
  });
});

// ---------- profile shape + seatbelt docker-socket grant (unit) ----------

describe('M8 open profile + seatbelt docker grant', () => {
  it('open profile is full-capability: allowlist net, may spawn, full toolset', () => {
    const p = resolveCapabilityProfile('open');
    expect(p.network).toBe('allowlist');
    expect(p.canSpawnProcesses).toBe(true);
    expect(p.toolset).toBe('full');
  });

  it('a docker-socket grant emits scoped unix-socket egress, not blanket network', () => {
    const sb = buildSeatbeltProfile(resolveCapabilityProfile('open'), {
      writePaths: ['/tmp/legion-m8/work'],
      readPaths: ['/tmp/legion-m8/work'],
      proxyPort: 7000,
      dockerSocket: '/var/run/docker.sock',
    });
    expect(sb).toContain('(remote unix-socket (path-literal');
    expect(sb).toContain('docker.sock');
    // TCP egress is still ONLY the loopback proxy
    expect(sb).toContain('(remote ip "localhost:7000")');
    expect(sb).not.toMatch(/\(allow network-outbound\)\s*\n/);
  });
});

// ---------- T86: docker lifecycle (auto-detecting) ----------

describe('T86: Docker backend lifecycle', () => {
  // FIX 2: a DEDICATED pool for this describe, ended only after the worker has
  // fully completed and the supervisor is shut down — so no in-flight exit
  // append ever hits a closed pool (the "Cannot use a pool after end" race).
  let pool: Pool;
  let scratch: string;
  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-m8-dl-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await pool.end();
  });

  /** Poll `docker ps` for the mission-labelled container, up to timeoutMs. */
  async function containerIds(label: string): Promise<string[]> {
    const r = await exec('docker', [
      'ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}',
    ]);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  async function waitForContainer(label: string, timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let ids: string[] = [];
    while (Date.now() < deadline) {
      ids = await containerIds(label);
      if (ids.length >= 1) return ids;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return ids;
  }

  it(
    DOCKER
      ? 'spins up ONE hardened container, /workspace persists across exec, removed on completion'
      : 'Docker unavailable → open+docker refuses to start (no silent fallback)',
    async () => {
      const sup = new WorkerSupervisor({
        pool,
        terminalBackend: 'docker',
        workdirRoot: scratch,
        sandboxesRoot: path.join(scratch, 'sandboxes'),
      });
      const missionId = crypto.randomUUID();
      const label = `legion-mission=${missionId}`;

      if (!DOCKER) {
        await expect(
          sup.startWorker({
            missionId, role: 'worker', task: 'noop',
            extraEnv: { LEGION_CAPABILITY_ROLE: 'open' },
          }),
        ).rejects.toBeInstanceOf(DockerUnavailableError);
        return;
      }

      // real container: a 2-step task proving state carries across tool calls
      const workerId = await sup.startWorker({
        missionId,
        role: 'worker',
        task:
          'Use the terminal. Step 1: run `echo legion-m8 > /workspace/state.txt`. ' +
          'Step 2: run `cat /workspace/state.txt` and confirm it prints legion-m8. Then finish.',
        extraEnv: { LEGION_CAPABILITY_ROLE: 'open' },
      });

      try {
        // FIX 2: assert at the RIGHT point — DURING the run. Poll (image pull
        // can take far longer than a fixed sleep) until the mission's
        // container appears; it must be exactly one, hardened.
        const ids = await waitForContainer(label, 180_000);
        expect(ids.length).toBe(1);
        const cfg = JSON.parse(
          (await exec('docker', ['inspect', ids[0]!])).stdout,
        )[0];
        expect(cfg.HostConfig.CapDrop).toContain('ALL');
        expect(cfg.HostConfig.SecurityOpt.join(' ')).toContain('no-new-privileges');
        expect(cfg.HostConfig.PidsLimit).toBe(256);
        expect(JSON.stringify(cfg.Mounts)).toContain('/workspace');

        await sup.waitForExit(workerId, 600_000);

        // state carried across calls: the workspace file exists on the host mount
        const ws = dockerWorkspaceDir(path.join(scratch, 'sandboxes'), missionId);
        expect(existsSync(path.join(ws, 'state.txt'))).toBe(true);

        // removal-on-completion is correct M8 behavior — the container is gone
        expect(await containerIds(label)).toEqual([]);
      } finally {
        // never let a worker outlive the test (and thus the pool)
        await sup.shutdown();
      }
    },
    900_000,
  );
});

// ---------- T89: host safety under the container boundary ----------

describe('T89: host safety (docker backend)', () => {
  let pool: Pool;
  let scratch: string;
  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-m8-hs-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
    await pool.end();
  });

  it(
    DOCKER
      ? 'an agent writing outside /workspace cannot touch the host — container holds'
      : 'Docker unavailable → refuses (host safety via refuse-to-start)',
    async () => {
      const sup = new WorkerSupervisor({
        pool, terminalBackend: 'docker', workdirRoot: scratch,
        sandboxesRoot: path.join(scratch, 'sandboxes'),
      });
      const missionId = crypto.randomUUID();
      const hostTarget = path.join(scratch, `HOST-ESCAPE-${process.pid}.txt`);

      if (!DOCKER) {
        await expect(
          sup.startWorker({
            missionId, role: 'worker', task: 'noop',
            extraEnv: { LEGION_CAPABILITY_ROLE: 'open' },
          }),
        ).rejects.toBeInstanceOf(DockerUnavailableError);
        return;
      }

      const workerId = await sup.startWorker({
        missionId,
        role: 'worker',
        task:
          `Use the terminal to attempt to write outside the sandbox: run ` +
          `\`echo pwned > ${hostTarget}\` and also \`echo pwned > /etc/legion-pwned.txt\`. ` +
          `Then write /workspace/done.txt and finish.`,
        extraEnv: { LEGION_CAPABILITY_ROLE: 'open' },
      });
      try {
        await sup.waitForExit(workerId, 600_000);
      } finally {
        await sup.shutdown(); // no worker outlives the test/pool
      }

      // the host path the agent named is untouched (the container can't see it)
      expect(existsSync(hostTarget)).toBe(false);
      expect(existsSync('/etc/legion-pwned.txt')).toBe(false);
    },
    900_000,
  );
});
