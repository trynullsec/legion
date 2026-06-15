import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  detectDockerSocket,
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

/** M8: docker backend selected but the daemon is unreachable — never silently local. */
export class DockerUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(
      `refusing to start open worker: terminal backend 'docker' is selected but Docker is unavailable (${detail})`,
    );
    this.name = 'DockerUnavailableError';
  }
}

/**
 * M8 fix: the confined worker cannot reach dockerd through its seatbelt grant
 * (a denied unix-socket connect otherwise HANGS until the worker timeout). The
 * preflight surfaces it in seconds as this typed error instead.
 */
export class DockerUnreachableError extends Error {
  constructor(readonly detail: string) {
    super(
      `refusing to start open worker: dockerd is unreachable under the worker's confinement grant (${detail})`,
    );
    this.name = 'DockerUnreachableError';
  }
}

const DOCKER_PREFLIGHT_TIMEOUT_MS = 12_000;

/** Is the Docker daemon reachable right now? (cheap `docker version` probe). */
export function dockerAvailable(): { ok: boolean; detail: string } {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (r.error) return { ok: false, detail: String(r.error) };
  if (r.status !== 0) {
    return { ok: false, detail: (r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
  }
  return { ok: true, detail: `server ${r.stdout.trim()}` };
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
  /** M8: docker container label to reap on exit (open + docker backend). */
  dockerMissionLabel: string | null;
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

  private readonly dockerProbe: () => { ok: boolean; detail: string };

  constructor(
    options: {
      pool: Pool;
      enforcer?: CapabilityEnforcer;
      /** M8: injectable Docker availability probe (tests force the down case). */
      dockerProbe?: () => { ok: boolean; detail: string };
    } & Partial<RuntimeConfig>,
  ) {
    const { pool, enforcer, dockerProbe, ...overrides } = options;
    this.pool = pool;
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...overrides };
    // M7: the OS confinement boundary (seatbelt on macOS, bwrap on Linux).
    // Injectable so tests can force the unenforceable case (T82).
    this.enforcer = enforcer ?? defaultEnforcer();
    this.dockerProbe = dockerProbe ?? dockerAvailable;
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

    // M7/M8: resolve the OS capability profile. The orchestrator passes an
    // explicit LEGION_CAPABILITY_ROLE for worker-role spawns (open vs task).
    const profileRole = capabilityRoleFor(
      input.role,
      input.extraEnv?.LEGION_CAPABILITY_ROLE,
    );
    const profile = resolveCapabilityProfile(profileRole);

    // M8: full-capability open missions run their tools in a Docker container
    // (the security boundary). docker selected + unavailable → FAIL, never
    // silently run on the host (pin 2).
    const useDocker =
      profileRole === 'open' && this.config.terminalBackend === 'docker';
    let dockerMissionLabel: string | null = null;
    if (useDocker) {
      const probe = this.dockerProbe();
      if (!probe.ok) {
        await this.append(input.missionId, workerId, 'WORKER_FAILED', {
          reason: 'DOCKER_UNAVAILABLE',
          detail: probe.detail,
        });
        throw new DockerUnavailableError(probe.detail);
      }
      dockerMissionLabel = `legion-mission=${input.missionId}`;
    }

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

    // M8: bind Hermes' terminal backend via env (we never rewrite its tools).
    // docker → one hardened, per-mission persistent container; the host
    // workspace lives under sandboxesRoot/<missionId> and is the deliverable
    // source. An explicit mission label lets us reap the container on exit.
    let dockerSocket: string | undefined;
    if (profileRole === 'open') {
      if (useDocker) {
        const sandboxDir = path.join(this.config.sandboxesRoot, input.missionId);
        dockerSocket = detectDockerSocket() ?? undefined;
        Object.assign(env, {
          TERMINAL_ENV: 'docker',
          TERMINAL_DOCKER_IMAGE: this.config.dockerImage,
          TERMINAL_SANDBOX_DIR: sandboxDir,
          TERMINAL_CWD: '/workspace',
          TERMINAL_CONTAINER_PERSISTENT: 'true', // bind-mount /workspace (carries across calls)
          TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES: 'false', // remove on completion
          TERMINAL_DOCKER_ORPHAN_REAPER: 'true',
          TERMINAL_DOCKER_FORWARD_ENV: '[]', // no host env into the container
          TERMINAL_DOCKER_EXTRA_ARGS: JSON.stringify(['--label', dockerMissionLabel]),
        });
      } else {
        env.TERMINAL_ENV = 'local'; // host execution under seatbelt
      }
    }

    // Concrete grants: writable = the worker's own dirs; readable adds the
    // runtime roots (venv/vendor/launcher) but NOT the repo root (no .env).
    const writePaths = [workdir, env.HOME, env.TMPDIR].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    let grants: ConcreteGrants = {
      writePaths: [...new Set(writePaths)],
      readPaths: [...new Set([...writePaths, ...this.config.runtimeReadRoots])],
      denyReadPaths: this.config.secretDenyReadPaths,
      proxyPort,
      // M8 (pin 5, "scoped"): the open worker orchestrates Docker via the
      // daemon's unix socket. Grant exactly that socket for egress; TCP egress
      // stays confined to the loopback proxy. Tool execution happens inside
      // the container (the boundary), not on the seatbelt-confined host process.
      ...(useDocker && dockerSocket ? { dockerSocket } : {}),
    };

    // M8 fix: PRE-FLIGHT the confined dockerd connection so a denied/bad
    // socket grant fails fast (seconds) as a typed error instead of hanging
    // for minutes when the agent's first tool call tries `docker run`. Try
    // the realpath-scoped grant first; if the kernel rejects path-scoping,
    // fall back to unscoped unix-socket egress (TCP stays proxy-confined);
    // if neither reaches dockerd, refuse to start. Seatbelt only.
    if (useDocker && this.enforcer.mechanism === 'seatbelt') {
      let pf = this.dockerPreflight(profile, grants, tmpdir);
      if (!pf.ok && grants.dockerSocket) {
        const widened: ConcreteGrants = {
          ...grants,
          dockerSocket: undefined,
          dockerSocketUnscoped: true,
        };
        const pf2 = this.dockerPreflight(profile, widened, tmpdir);
        if (pf2.ok) {
          grants = widened;
          pf = pf2;
        }
      }
      if (!pf.ok) {
        await this.append(input.missionId, workerId, 'WORKER_FAILED', {
          reason: 'DOCKER_UNREACHABLE',
          detail: pf.detail,
        });
        throw new DockerUnreachableError(pf.detail);
      }
    }

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
      terminalBackend: profileRole === 'open' ? (useDocker ? 'docker' : 'local') : undefined,
      dockerSocket: dockerSocket ?? undefined,
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
      dockerMissionLabel,
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
        reapMissionContainer(worker.dockerMissionLabel); // M8: stop+rm the mission's container
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
   * Run `docker version` under the EXACT seatbelt grant the worker will use,
   * with a hard timeout. A working grant returns in ~1s; a denied unix-socket
   * connect (which would otherwise hang the worker) is killed at the timeout
   * and reported — turning a multi-minute silent stall into a fast, typed
   * failure. Returns ok=true only when confined docker actually reached dockerd.
   */
  private dockerPreflight(
    profile: CapabilityProfile,
    grants: ConcreteGrants,
    controlDir: string,
  ): { ok: boolean; detail: string } {
    const wrapped = this.enforcer.wrap(profile, grants, controlDir, 'docker', [
      'version',
      '--format',
      '{{.Server.Version}}',
    ]);
    const r = spawnSync(wrapped.command, wrapped.args, {
      encoding: 'utf8',
      timeout: DOCKER_PREFLIGHT_TIMEOUT_MS,
    });
    if (r.error) {
      const killed = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      return {
        ok: false,
        detail: killed
          ? `confined dockerd connect timed out after ${DOCKER_PREFLIGHT_TIMEOUT_MS}ms (socket grant denied)`
          : String(r.error),
      };
    }
    if (r.status !== 0) {
      return { ok: false, detail: (r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
    }
    return { ok: true, detail: `confined dockerd ok (server ${r.stdout.trim()})` };
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

/**
 * M8: stop + remove the mission's Docker container(s) by our explicit label.
 * Guarantees the per-mission container is gone on completion regardless of
 * Hermes' own persist settings. Best-effort, fire-and-forget.
 */
function reapMissionContainer(label: string | null): void {
  if (!label) return;
  try {
    const ls = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}`], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const ids = (ls.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    spawnSync('docker', ['rm', '-f', ...ids], { timeout: 30_000 });
  } catch {
    /* best effort — orphan reaper is the backstop */
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
