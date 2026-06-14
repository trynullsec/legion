import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  capabilityRoleFor,
  resolveCapabilityProfile,
  type CapabilityProfile,
} from '@legion/core';
import {
  appendWorkerEvent,
  getWorkerEvents,
  getWorkerRecord,
  listLiveWorkers,
  listMissionWorkers,
  type StoredWorkerEvent,
  type WorkerEventType,
  type WorkerRecord,
} from '@legion/db';
import type { Pool } from 'pg';
import {
  DEFAULT_RUNTIME_CONFIG,
  modelHostFromBaseUrl,
  type RuntimeConfig,
} from './config.js';
import { defaultEnforcer, type CapabilityEnforcer } from './enforcer.js';
import { EgressProxy, buildEgressPolicy } from './egressProxy.js';
import type { ConcreteGrants } from './seatbelt.js';

export class EnforcementUnavailableError extends Error {
  constructor(
    readonly role: string,
    readonly reason: string,
  ) {
    super(
      `refusing to start ${role} worker: capability enforcement unavailable (${reason})`,
    );
    this.name = 'EnforcementUnavailableError';
  }
}

export class WorkerNotFoundError extends Error {
  constructor(readonly workerId: string) {
    super(`worker ${workerId} not found`);
    this.name = 'WorkerNotFoundError';
  }
}

export class WorkerNotRunningError extends Error {
  constructor(readonly workerId: string) {
    super(`worker ${workerId} is not running in this supervisor`);
    this.name = 'WorkerNotRunningError';
  }
}

export interface StartWorkerInput {
  missionId: string;
  role: string;
  task: string;
  /** Defaults to <workdirRoot>/<missionId>/<workerId> — always created fresh. */
  workdir?: string;
  /** Overrides the configured hard timeout for this worker. */
  timeoutMs?: number;
  /** Per-role model override (additive; defaults to the configured model). */
  model?: string;
  /** Extra allowlisted env vars (e.g. git identity for coder workers). */
  extraEnv?: Record<string, string>;
  /** Per-worker model-iteration budget (defaults to the configured maxTurns). */
  maxTurns?: number;
}

interface LiveWorker {
  child: ChildProcess;
  pid: number;
  stderrTail: string[];
  appendQueue: Promise<void>;
  timeoutTimer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
  stopRequested: {
    graceful: boolean;
    graceMs: number;
    requestedAt: number;
    /** Descendant PIDs snapshotted before signalling — Hermes setsids task
     *  processes out of our group, so the group alone can't be trusted. */
    descendants: number[];
  } | null;
  timedOut: boolean;
  exited: Promise<void>;
  /** M7: per-worker egress chokepoint; closed when the worker exits. */
  proxy: EgressProxy | null;
}

const STDERR_TAIL_LINES = 60;

/**
 * One OS process per worker. All durable state lives in worker_events; this
 * class only holds transient process handles, fully rebuildable from the DB
 * (orphan reconciliation) after a daemon restart.
 */
export class WorkerSupervisor {
  private readonly pool: Pool;
  private readonly config: RuntimeConfig;
  private readonly enforcer: CapabilityEnforcer;
  private readonly live = new Map<string, LiveWorker>();

  constructor(
    options: { pool: Pool; enforcer?: CapabilityEnforcer } & Partial<RuntimeConfig>,
  ) {
    const { pool, enforcer, ...overrides } = options;
    this.pool = pool;
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...overrides };
    // M7: the OS confinement boundary (seatbelt on macOS, bwrap on Linux).
    // Injectable so tests can force the unenforceable case (T82).
    this.enforcer = enforcer ?? defaultEnforcer();
  }

  /**
   * Mark workers that the database believes are live but whose process no
   * longer exists (e.g. the previous daemon died). Call on boot.
   */
  async reconcileOrphans(): Promise<string[]> {
    const liveRows = await listLiveWorkers(this.pool);
    const orphaned: string[] = [];
    for (const worker of liveRows) {
      if (this.live.has(worker.workerId)) continue; // ours, genuinely running
      const alive = worker.pid !== null && pidAlive(worker.pid);
      if (alive) {
        // process exists but no supervisor owns it — unmanageable, kill + mark
        try {
          process.kill(-worker.pid!, 'SIGKILL');
        } catch {
          try {
            process.kill(worker.pid!, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      await appendWorkerEvent(this.pool, {
        missionId: worker.missionId,
        workerId: worker.workerId,
        type: 'WORKER_FAILED',
        payload: { reason: 'ORPHANED' },
      });
      orphaned.push(worker.workerId);
    }
    return orphaned;
  }

  async startWorker(input: StartWorkerInput): Promise<string> {
    const workerId = randomUUID();
    const workdir =
      input.workdir ??
      path.join(this.config.workdirRoot, input.missionId, workerId);
    const tmpdir = path.join(workdir, '.tmp');
    await mkdir(tmpdir, { recursive: true });

    const model = input.model ?? this.config.model;
    await this.append(input.missionId, workerId, 'WORKER_CREATED', {
      role: input.role,
      task: input.task,
      workdir,
      model,
    });

    // M7: resolve the OS capability profile for this worker's role.
    const profileRole = capabilityRoleFor(input.role, input.extraEnv?.LEGION_TOOLSET);
    const profile = resolveCapabilityProfile(profileRole);

    // Refuse to start unconfined (pin 2/5, T82). If the OS layer cannot apply
    // the profile here, the worker never spawns — recorded, then thrown.
    const enforce = this.enforcer.canEnforce();
    if (!enforce.ok) {
      await this.append(input.missionId, workerId, 'WORKER_FAILED', {
        reason: 'ENFORCEMENT_UNAVAILABLE',
        mechanism: this.enforcer.mechanism,
        detail: enforce.reason,
      });
      throw new EnforcementUnavailableError(profileRole, enforce.reason);
    }

    // Minimal env allowlist. The parent environment is NOT inherited:
    // no DATABASE_URL, no shell exports, nothing beyond this list.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workdir,
      TMPDIR: tmpdir,
      PYTHONPATH: this.config.vendorDir,
      PYTHONUNBUFFERED: '1',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
      LEGION_TASK: input.task,
      LEGION_MODEL: model,
      LEGION_BASE_URL: this.config.baseUrl,
      LEGION_MAX_TURNS: String(input.maxTurns ?? this.config.maxTurns),
      ...input.extraEnv,
    };

    // M7: per-worker egress chokepoint. seatbelt lets the worker reach ONLY
    // this proxy on loopback; the proxy enforces the per-role allowlist
    // (model-only for net:none; model + SSRF-filtered web for open) and logs
    // every request as a NET_REQUEST event.
    const proxy = new EgressProxy(
      buildEgressPolicy(profile.network, modelHostFromBaseUrl(this.config.baseUrl)),
      (entry) => {
        const w = this.live.get(workerId);
        if (w) this.enqueue(w, input.missionId, workerId, 'NET_REQUEST', { ...entry });
      },
    );
    const proxyPort = await proxy.start();
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
    // the worker reaches the model through the proxy by hostname; it never
    // resolves DNS or opens sockets itself (net is otherwise denied)
    env.NO_PROXY = '';
    env.no_proxy = '';

    // Concrete grants: writable = the worker's own dirs; readable adds the
    // runtime roots (venv/vendor/launcher) but NOT the repo root (no .env).
    const writePaths = [workdir, env.HOME, env.TMPDIR].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    const grants: ConcreteGrants = {
      writePaths: [...new Set(writePaths)],
      readPaths: [...new Set([...writePaths, ...this.config.runtimeReadRoots])],
      denyReadPaths: this.config.secretDenyReadPaths,
      proxyPort,
    };

    // Record the resolved profile BEFORE any work (pin 4 / T81).
    await this.append(input.missionId, workerId, 'CAPABILITY_PROFILE', {
      role: profileRole,
      mechanism: this.enforcer.mechanism,
      network: profile.network,
      canSpawnProcesses: profile.canSpawnProcesses,
      toolset: profile.toolset,
      writePaths: grants.writePaths,
      readPaths: grants.readPaths,
      proxyPort,
    });

    // Wrap the spawn in the OS confinement layer.
    const wrapped = this.enforcer.wrap(
      profile,
      grants,
      tmpdir,
      this.config.venvPython,
      [this.config.launcherPath],
    );

    const child = spawn(wrapped.command, wrapped.args, {
      cwd: workdir,
      env,
      detached: true, // own process group → we can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutMs = input.timeoutMs ?? this.config.timeoutMs;

    let resolveExited!: () => void;
    const exited = new Promise<void>((r) => {
      resolveExited = r;
    });

    const worker: LiveWorker = {
      child,
      pid: child.pid ?? -1,
      stderrTail: [],
      appendQueue: Promise.resolve(),
      timeoutTimer: setTimeout(() => this.onTimeout(workerId), timeoutMs),
      graceTimer: null,
      stopRequested: null,
      timedOut: false,
      exited,
      proxy,
    };
    this.live.set(workerId, worker);

    child.on('error', (err) => {
      void worker.proxy?.stop();
      this.enqueue(worker, input.missionId, workerId, 'WORKER_FAILED', {
        reason: 'CRASH',
        error: String(err),
      });
    });

    if (child.pid) {
      await this.append(input.missionId, workerId, 'WORKER_STARTED', {
        pid: child.pid,
      });
    }

    // stream stdout JSONL → trajectory events
    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const event = parseLauncherLine(line);
        if (event) {
          this.enqueue(worker, input.missionId, workerId, event.type, event.payload);
        }
      });
    }

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        worker.stderrTail.push(line);
        if (worker.stderrTail.length > STDERR_TAIL_LINES) {
          worker.stderrTail.shift();
        }
      });
    }

    child.on('exit', (code, signal) => {
      clearTimeout(worker.timeoutTimer);

      const finalize = (
        type: WorkerEventType,
        payload: Record<string, unknown>,
      ) => {
        if (worker.graceTimer) clearTimeout(worker.graceTimer);
        void worker.proxy?.stop(); // close the egress chokepoint
        this.enqueue(worker, input.missionId, workerId, type, payload);
        // resolve the exit promise only after every queued append has landed
        void worker.appendQueue.then(() => {
          this.live.delete(workerId);
          resolveExited();
        });
      };

      if (worker.timedOut) {
        finalize('WORKER_FAILED', {
          reason: 'TIMEOUT',
          signal,
          lastStderr: worker.stderrTail.join('\n').slice(-4000),
        });
      } else if (worker.stopRequested?.graceful) {
        // The launcher exited on SIGTERM, but TERM-resistant task processes
        // may survive in the group. Hold the SIGKILL escalation to the
        // deadline, then record whether it was needed.
        void this.finishGracefulStop(worker, signal, finalize);
      } else if (worker.stopRequested) {
        finalize('WORKER_KILLED', {
          graceful: false,
          signal,
          escalated: false,
        });
      } else if (code === 0) {
        finalize('WORKER_EXITED', { exitCode: 0 });
      } else {
        finalize('WORKER_FAILED', {
          reason: 'CRASH',
          exitCode: code,
          signal,
          lastStderr: worker.stderrTail.join('\n').slice(-4000),
        });
      }
    });

    return workerId;
  }

  /**
   * Graceful stop = SIGTERM now, SIGKILL of the whole process group at the
   * escalation deadline (default 10s; configurable via constructor
   * `killGraceMs` or per call). Semantics are unchanged — the deadline kill
   * also reaps TERM-resistant survivors in the group.
   */
  async stopWorker(
    workerId: string,
    options: { graceful: boolean; graceMs?: number },
  ): Promise<void> {
    const worker = this.live.get(workerId);
    if (!worker) {
      const record = await getWorkerRecord(this.pool, workerId);
      if (!record) throw new WorkerNotFoundError(workerId);
      throw new WorkerNotRunningError(workerId);
    }
    const graceMs = options.graceMs ?? this.config.killGraceMs;
    // Snapshot the descendant tree before signalling: Hermes launches task
    // processes in their own sessions (os.setsid), outside our group.
    const descendants = await listDescendants(worker.pid);
    worker.stopRequested = {
      graceful: options.graceful,
      graceMs,
      requestedAt: Date.now(),
      descendants,
    };
    if (options.graceful) {
      killTree(worker.pid, 'SIGTERM');
      for (const pid of descendants) killTree(pid, 'SIGTERM');
      worker.graceTimer = setTimeout(() => {
        killTree(worker.pid, 'SIGKILL');
        for (const pid of descendants) killTree(pid, 'SIGKILL');
      }, graceMs);
    } else {
      killTree(worker.pid, 'SIGKILL');
      for (const pid of descendants) killTree(pid, 'SIGKILL');
    }
  }

  private async finishGracefulStop(
    worker: LiveWorker,
    signal: NodeJS.Signals | null,
    finalize: (type: WorkerEventType, payload: Record<string, unknown>) => void,
  ): Promise<void> {
    const stop = worker.stopRequested!;
    let escalated = signal === 'SIGKILL'; // the leader itself resisted TERM
    const surviving = () => [
      ...new Set([
        ...stop.descendants.filter(pidAlive),
        // anything still in the worker's own group
      ]),
    ];
    let survivors = [...surviving(), ...(await listGroupPids(worker.pid))];

    if (survivors.length > 0) {
      // wait out the remainder of the escalation window, then SIGKILL
      const remaining = Math.max(0, stop.requestedAt + stop.graceMs - Date.now());
      await new Promise((r) => setTimeout(r, remaining));
      killTree(worker.pid, 'SIGKILL');
      for (const pid of survivors) killTree(pid, 'SIGKILL');
      escalated = true;
      await new Promise((r) => setTimeout(r, 250)); // let the kill settle
      survivors = [...surviving(), ...(await listGroupPids(worker.pid))];
    }

    finalize('WORKER_KILLED', {
      graceful: true,
      signal,
      escalated,
      survivorsRemaining: survivors.length,
    });
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    return getWorkerRecord(this.pool, workerId);
  }

  async listWorkers(missionId: string): Promise<WorkerRecord[]> {
    return listMissionWorkers(this.pool, missionId);
  }

  async getWorkerEvents(workerId: string): Promise<StoredWorkerEvent[]> {
    return getWorkerEvents(this.pool, workerId);
  }

  /** Resolves when the worker's process has exited and its log is flushed. */
  async waitForExit(workerId: string, timeoutMs: number): Promise<void> {
    const worker = this.live.get(workerId);
    if (!worker) return; // already gone
    await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`worker ${workerId}: waitForExit timed out`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /** Kill every live child (test cleanup / daemon shutdown). */
  async shutdown(): Promise<void> {
    const pending = [...this.live.entries()].map(async ([workerId, worker]) => {
      const descendants = await listDescendants(worker.pid);
      worker.stopRequested ??= {
        graceful: false,
        graceMs: this.config.killGraceMs,
        requestedAt: Date.now(),
        descendants,
      };
      killTree(worker.pid, 'SIGKILL');
      for (const pid of descendants) killTree(pid, 'SIGKILL');
      try {
        await this.waitForExit(workerId, 15_000);
      } catch {
        /* best effort */
      }
    });
    await Promise.all(pending);
  }

  private onTimeout(workerId: string): void {
    const worker = this.live.get(workerId);
    if (!worker) return;
    worker.timedOut = true;
    void listDescendants(worker.pid).then((descendants) => {
      killTree(worker.pid, 'SIGKILL');
      for (const pid of descendants) killTree(pid, 'SIGKILL');
    });
  }

  private async append(
    missionId: string,
    workerId: string,
    type: WorkerEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await appendWorkerEvent(this.pool, { missionId, workerId, type, payload });
  }

  /** Serialize appends per worker so seq stays ordered and gapless. */
  private enqueue(
    worker: LiveWorker,
    missionId: string,
    workerId: string,
    type: WorkerEventType,
    payload: Record<string, unknown>,
  ): void {
    worker.appendQueue = worker.appendQueue.then(() =>
      this.append(missionId, workerId, type, payload).catch((err) => {
        console.error(`worker ${workerId}: failed to append ${type}:`, err);
      }),
    );
  }
}

/** All descendant PIDs of `root` (breadth-first via pgrep -P). */
async function listDescendants(root: number): Promise<number[]> {
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = await new Promise<number[]>((resolve) => {
      const p = spawn('pgrep', ['-P', String(parent)]);
      let out = '';
      p.stdout?.on('data', (d) => {
        out += String(d);
      });
      p.on('exit', () => {
        resolve(
          out
            .split('\n')
            .map((l) => Number(l.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
      });
      p.on('error', () => resolve([]));
    });
    for (const child of children) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** PIDs still alive in the worker's process group (macOS/Linux pgrep). */
function listGroupPids(pgid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const p = spawn('pgrep', ['-g', String(pgid)]);
    let out = '';
    p.stdout?.on('data', (d) => {
      out += String(d);
    });
    p.on('exit', () => {
      resolve(
        out
          .split('\n')
          .map((l) => Number(l.trim()))
          .filter((n) => Number.isFinite(n) && n > 0),
      );
    });
    p.on('error', () => resolve([]));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the worker's whole process group; fall back to the single pid. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

const TRAJECTORY_TYPES = new Set<WorkerEventType>([
  'MODEL_MESSAGE',
  'TOOL_CALL',
  'TOOL_RESULT',
  'AGENT_STATUS',
  'ERROR',
]);

function parseLauncherLine(
  line: string,
): { type: WorkerEventType; payload: Record<string, unknown> } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = parsed.type as WorkerEventType;
    if (!TRAJECTORY_TYPES.has(type)) return null;
    const { type: _drop, ...payload } = parsed;
    return { type, payload };
  } catch {
    return null; // non-JSON stdout noise is not a meaningful unit
  }
}
