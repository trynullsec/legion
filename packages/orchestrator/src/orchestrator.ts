import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  IllegalTransitionError,
  PlanSchema,
  ReviewSchema,
  type Plan,
  type Review,
} from '@legion/core';
import {
  appendEvent,
  appendWorkerEvent,
  getArtifact,
  getMission,
  getMissionEvents,
  getWorkerEvents,
  getWorkerRecord,
  insertArtifact,
  insertScanAttempt,
  listMissionWorkers,
  MissionNotFoundError,
  type ArtifactStats,
  type MissionRecord,
} from '@legion/db';
import {
  countFindings,
  listFindings,
  mergeSarif,
  runGitleaks,
  runGitleaksDir,
  runSemgrep,
  ScannerCrashError,
  verdict,
  type FailLevel,
  type SarifDocument,
} from '@legion/scanner';
import type { WorkerSupervisor } from '@legion/runtime';
import type { Pool } from 'pg';
import {
  buildCoderPrompt,
  buildDeliverableReviewerPrompt,
  buildOpenWorkerPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  buildRevisionPrompt,
  buildTaskPlannerPrompt,
  buildTaskRevisionPrompt,
  buildTaskWorkerPrompt,
  type RejectionFeedback,
} from './prompt.js';
import {
  executeDelivery,
  executeMerge,
  reconcileMerges,
  type DeliveryOutcome,
  type MergeOutcome,
} from './merge.js';
import { riskPolicy } from './policy.js';

const exec = promisify(execFile);

export class PlanningStateError extends Error {
  constructor(
    readonly missionId: string,
    readonly state: string,
  ) {
    super(`mission ${missionId} cannot start planning from state ${state}`);
    this.name = 'PlanningStateError';
  }
}

export class PlanningInProgressError extends Error {
  constructor(
    readonly missionId: string,
    readonly workerId: string,
  ) {
    super(`mission ${missionId} already has a live planner (${workerId})`);
    this.name = 'PlanningInProgressError';
  }
}

export type PlanningOutcome =
  | { kind: 'PROPOSED'; plan: Plan }
  | { kind: 'INVALID'; issues: unknown[] }
  | { kind: 'WORKER_DID_NOT_EXIT_CLEANLY'; status: string };

export class BuildStateError extends Error {
  constructor(
    readonly missionId: string,
    readonly state: string,
  ) {
    super(`mission ${missionId} cannot start a build from state ${state}`);
    this.name = 'BuildStateError';
  }
}

export class BuildInProgressError extends Error {
  constructor(readonly missionId: string) {
    super(`mission ${missionId} already has a running build attempt`);
    this.name = 'BuildInProgressError';
  }
}

export type BuildOutcome =
  | { kind: 'COMPLETED'; artifactId: string }
  | { kind: 'ATTEMPT_FAILED'; reason: string };

export class ScanStateError extends Error {
  constructor(
    readonly missionId: string,
    readonly state: string,
  ) {
    super(`mission ${missionId} cannot scan from state ${state}`);
    this.name = 'ScanStateError';
  }
}

export class ScanInProgressError extends Error {
  constructor(readonly missionId: string) {
    super(`mission ${missionId} already has a scan running`);
    this.name = 'ScanInProgressError';
  }
}

export type ScanOutcome =
  | { kind: 'PASSED'; sarifArtifactId: string; counts: { errors: number; warnings: number; notes: number } }
  | { kind: 'FAILED'; sarifArtifactId: string; counts: { errors: number; warnings: number; notes: number } }
  | { kind: 'ATTEMPT_FAILED'; tool: string; error: string };

/** Internal-only scan options for deterministic tests (never over HTTP). */
export interface ScanOverrides {
  gitleaksBin?: string;
  semgrepBin?: string;
  failLevel?: FailLevel;
}

/** Internal-only overrides for deterministic tests (never exposed over HTTP). */
export interface BuildOverrides {
  coderTaskOverride?: string;
  coderRevisionTaskOverride?: string;
  /** One per review cycle (index 0 = first review). */
  reviewerTaskOverrides?: string[];
}

const CODER_GIT_ENV = {
  GIT_AUTHOR_NAME: 'Legion Coder',
  GIT_AUTHOR_EMAIL: 'coder@legion.local',
  GIT_COMMITTER_NAME: 'Legion Coder',
  GIT_COMMITTER_EMAIL: 'coder@legion.local',
};

export interface OrchestratorOptions {
  pool: Pool;
  supervisor: WorkerSupervisor;
  /** Per-role model override; defaults to env LEGION_MODEL_PLANNER, then the M1 default. */
  plannerModel?: string;
  /** Reviewer model; defaults to env LEGION_MODEL_REVIEWER, then the M1 default. */
  reviewerModel?: string;
  /** Coder model; defaults to env LEGION_MODEL_CODER, then the M1 default. */
  coderModel?: string;
  /** Planner hard timeout; defaults to the supervisor's configured timeout. */
  plannerTimeoutMs?: number;
  /** Root for planner workdirs (tests point this into the repo's .tmp). */
  workdirRoot?: string;
  /** Root for build attempt workspaces; default ~/.legion/builds. */
  buildsRoot?: string;
  /** Root for diff artifacts; default ~/.legion/artifacts. */
  artifactsRoot?: string;
  /** M6a: default delivery root for task missions; default ~/.legion/deliveries. */
  deliveriesRoot?: string;
}

/**
 * Owns the "spawn planner for mission" flow: clone, prompt, spawn, validate
 * plan.json, emit mission events. Consumes the M1 supervisor; the daemon
 * stays thin.
 */
export class Orchestrator {
  private readonly pool: Pool;
  private readonly supervisor: WorkerSupervisor;
  private readonly plannerModel: string | undefined;
  private readonly reviewerModel: string | undefined;
  private readonly coderModel: string | undefined;
  private readonly plannerTimeoutMs: number | undefined;
  private readonly workdirRoot: string;
  private readonly buildsRoot: string;
  private readonly artifactsRoot: string;
  private readonly deliveriesRoot: string;
  private readonly activeBuilds = new Set<string>();
  private readonly activeScans = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.pool = options.pool;
    this.supervisor = options.supervisor;
    // Planning must reliably *produce* plan.json. gpt-oss-120b frequently
    // returns empty/thinking-only responses and exits without writing the
    // file; qwen3-coder is dependable at this agentic file work (proven by
    // the M3 coder). Documented in the README.
    this.plannerModel =
      options.plannerModel ?? process.env.LEGION_MODEL_PLANNER ?? 'qwen/qwen3-coder';
    // Pin 4: reviewer default = planner default (both produce a JSON file).
    this.reviewerModel =
      options.reviewerModel ??
      process.env.LEGION_MODEL_REVIEWER ??
      this.plannerModel;
    // The coder default differs from the M1 general default: gpt-oss-120b
    // reliably *reads* but often stops without acting on multi-step coding
    // tasks. Qwen3 Coder is purpose-built for agentic coding and cheap.
    this.coderModel =
      options.coderModel ?? process.env.LEGION_MODEL_CODER ?? 'qwen/qwen3-coder';
    this.plannerTimeoutMs = options.plannerTimeoutMs;
    this.workdirRoot =
      options.workdirRoot ?? path.join(os.homedir(), '.legion', 'workdirs');
    this.buildsRoot =
      options.buildsRoot ?? path.join(os.homedir(), '.legion', 'builds');
    this.artifactsRoot =
      options.artifactsRoot ?? path.join(os.homedir(), '.legion', 'artifacts');
    this.deliveriesRoot =
      options.deliveriesRoot ?? path.join(os.homedir(), '.legion', 'deliveries');
  }

  /**
   * Start one planning attempt. Emits PLANNING_STARTED when the mission is
   * still DRAFT; spawns a real planner on a fresh `git clone --depth 1` of
   * the mission repo. Returns immediately; `settled` resolves when the
   * attempt has been fully processed.
   */
  async startPlanning(
    missionId: string,
    options: {
      taskOverride?: string;
      /** M6d, internal-only (T74): reviewer overrides for the open EXECUTE. */
      reviewerTaskOverrides?: string[];
    } = {},
  ): Promise<{ workerId: string; settled: Promise<PlanningOutcome | BuildOutcome> }> {
    const result = await getMission(this.pool, missionId);
    if (!result) throw new MissionNotFoundError(missionId);
    const mission = result.mission;

    // M6d (pin 2): open missions have no plan gate — planning/building
    // collapse into a single EXECUTE. The same canonical states are
    // traversed; the waiver is recorded as declared policy, never silently.
    if (mission.kind === 'open') {
      return this.startOpenExecute(missionId, mission, options);
    }

    if (mission.state !== 'DRAFT' && mission.state !== 'PLANNING') {
      throw new PlanningStateError(missionId, mission.state);
    }

    // concurrency guard: one live planner per mission
    const workers = await listMissionWorkers(this.pool, missionId);
    const live = workers.find(
      (w) =>
        w.role === 'planner' &&
        (w.status === 'STARTING' || w.status === 'RUNNING'),
    );
    if (live) throw new PlanningInProgressError(missionId, live.workerId);

    if (mission.state === 'DRAFT') {
      await appendEvent(this.pool, missionId, 'PLANNING_STARTED');
    }

    const feedback = await this.rejectionFeedback(missionId);
    const prompt =
      options.taskOverride ??
      (mission.kind === 'task'
        ? buildTaskPlannerPrompt(mission, feedback)
        : buildPlannerPrompt(mission, feedback));

    const spawned = await this.spawnPlanner(missionId, mission, prompt);
    const settled = this.finishPlanning(
      missionId, mission, spawned.workerId, spawned.workdir, prompt, 1,
    );
    return { workerId: spawned.workerId, settled };
  }

  /**
   * Spawn a planner in a fresh isolated workdir. Code missions get a shallow
   * file:// clone (the planner NEVER touches the user's repository); task
   * missions get an empty directory — there is nothing to clone (pin 2).
   */
  private async spawnPlanner(
    missionId: string,
    mission: MissionRecord,
    prompt: string,
  ): Promise<{ workerId: string; workdir: string }> {
    const workdir = path.join(this.workdirRoot, missionId, `planner-${randomUUID()}`);
    await mkdir(path.dirname(workdir), { recursive: true });
    if (mission.kind === 'task') {
      await mkdir(workdir, { recursive: true });
    } else {
      await exec('git', [
        'clone',
        '--depth',
        '1',
        `file://${path.resolve(mission.repoPath!)}`,
        workdir,
      ]);
    }

    const workerId = await this.supervisor.startWorker({
      missionId,
      role: 'planner',
      task: prompt,
      workdir,
      timeoutMs: this.plannerTimeoutMs,
      model: this.plannerModel,
      // robustness: if the model loops trying to write plan.json via the
      // shell, the launcher seals its final message as plan.json instead.
      extraEnv: { LEGION_SEAL_FILE: 'plan.json' },
    });

    // record the exact prompt for auditability (asserted by T21)
    await appendWorkerEvent(this.pool, {
      missionId,
      workerId,
      type: 'WORKER_TASK',
      payload: { prompt, role: 'planner' },
    });

    return { workerId, workdir };
  }

  private async rejectionFeedback(
    missionId: string,
  ): Promise<RejectionFeedback | null> {
    const events = await getMissionEvents(this.pool, missionId);
    const lastRejection = [...events]
      .reverse()
      .find((e) => e.type === 'PLAN_REJECTED');
    if (!lastRejection) return null;
    const priorProposal = [...events]
      .filter((e) => e.type === 'PLAN_PROPOSED' && e.seq < lastRejection.seq)
      .pop();
    return {
      priorSummary:
        ((priorProposal?.payload.plan as Plan | undefined)?.summary ??
          '(no prior summary recorded)'),
      reason: (lastRejection.payload.reason as string) ?? '(no reason recorded)',
    };
  }

  private async finishPlanning(
    missionId: string,
    mission: MissionRecord,
    workerId: string,
    workdir: string,
    prompt: string,
    run: number,
  ): Promise<PlanningOutcome> {
    const timeout = (this.plannerTimeoutMs ?? 10 * 60 * 1000) + 60_000;
    try {
      await this.supervisor.waitForExit(workerId, timeout);
    } catch {
      /* fall through — status decides */
    }
    const worker = await getWorkerRecord(this.pool, workerId);
    if (worker?.status !== 'EXITED') {
      // crash / kill / timeout: planning attempt failed, mission stays PLANNING
      return {
        kind: 'WORKER_DID_NOT_EXIT_CLEANLY',
        status: worker?.status ?? 'UNKNOWN',
      };
    }

    const MAX_PLANNER_RUNS = 3;
    const invalid = async (issues: unknown[]): Promise<PlanningOutcome> => {
      await appendWorkerEvent(this.pool, {
        missionId,
        workerId,
        type: 'PLAN_INVALID',
        payload: { issues, run },
      });
      // One deterministic retry per attempt: a planner occasionally exits
      // cleanly without writing plan.json. The failed run keeps its
      // PLAN_INVALID record; one more real planner gets a chance.
      if (run < MAX_PLANNER_RUNS) {
        const next = await this.spawnPlanner(missionId, mission, prompt);
        return this.finishPlanning(
          missionId, mission, next.workerId, next.workdir, prompt, run + 1,
        );
      }
      return { kind: 'INVALID', issues };
    };

    let raw: string;
    try {
      raw = await readFile(path.join(workdir, 'plan.json'), 'utf8');
    } catch {
      return invalid([{ message: 'plan.json missing from workdir root' }]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return invalid([{ message: `plan.json is not valid JSON: ${String(e)}` }]);
    }

    const validated = PlanSchema.safeParse(parsed);
    if (!validated.success) {
      return invalid(validated.error.issues);
    }

    try {
      await appendEvent(this.pool, missionId, 'PLAN_PROPOSED', {
        plan: validated.data,
      });
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        return invalid([
          { message: `mission left PLANNING before the proposal landed (${e.from})` },
        ]);
      }
      throw e;
    }

    // M6b (pin 1): low-risk express lane — the plan gate auto-approves BY
    // DECLARED POLICY, recorded in the ledger, and the build starts
    // immediately. Only the PLAN gate scales; the merge gate is invariant.
    const policy = riskPolicy(mission.riskLevel);
    if (policy.autoApprovePlan) {
      try {
        await appendEvent(this.pool, missionId, 'PLAN_APPROVED', {
          autoApproved: true,
          policy: policy.policyId,
        });
        const { settled } = await this.startBuild(missionId);
        void settled.catch((e) =>
          console.error(`auto-build for ${missionId} failed:`, e),
        );
      } catch (e) {
        // the proposal stands even if auto-approval/auto-build hit a race;
        // the mission simply parks where it is
        console.error(`express-lane policy for ${missionId} failed:`, e);
      }
    }

    return { kind: 'PROPOSED', plan: validated.data };
  }

  // ====================================================================
  // M6d: open missions — collapsed EXECUTE (read-only web research)
  // ====================================================================

  /**
   * Open missions skip the plan gate by declared policy: emit the synthetic
   * PLANNING_STARTED → PLAN_PROPOSED → PLAN_APPROVED sequence (the machine
   * is untouched; the ledger records the waiver), then run a deliverable
   * build attempt whose worker has the read-only web toolset.
   */
  private async startOpenExecute(
    missionId: string,
    mission: MissionRecord,
    options: { taskOverride?: string; reviewerTaskOverrides?: string[] },
  ): Promise<{ workerId: string; settled: Promise<BuildOutcome> }> {
    if (mission.state !== 'DRAFT' && mission.state !== 'BUILDING') {
      throw new PlanningStateError(missionId, mission.state);
    }

    if (mission.state === 'DRAFT') {
      const syntheticPlan: Plan = {
        summary: mission.objective,
        steps: [
          {
            n: 1,
            title: 'Research and report',
            detail: mission.objective,
            filesLikelyTouched: ['report.md'],
          },
        ],
        risks: [],
        openQuestions: [],
        estimatedComplexity: 'small',
      };
      await appendEvent(this.pool, missionId, 'PLANNING_STARTED', {
        policy: 'open-readonly',
      });
      await appendEvent(this.pool, missionId, 'PLAN_PROPOSED', {
        plan: syntheticPlan,
        synthetic: true,
        policy: 'open-readonly',
      });
      await appendEvent(this.pool, missionId, 'PLAN_APPROVED', {
        autoApproved: true,
        policy: 'open-readonly',
      });
    }

    const { coderWorkerId, settled } = await this.startBuild(missionId, {
      coderTaskOverride: options.taskOverride,
      reviewerTaskOverrides: options.reviewerTaskOverrides,
    });
    return { workerId: coderWorkerId, settled };
  }

  /**
   * Env for an open worker: same allowlist + isolated HOME as every worker,
   * plus the read-only web toolset and the pinned search provider key.
   * Tavily is the single supported provider (one key drives BOTH web_search
   * and web_extract in the vendored runtime).
   */
  private openWorkerEnv(attemptDir: string): Record<string, string> {
    const provider = process.env.LEGION_SEARCH_PROVIDER ?? 'tavily';
    if (provider !== 'tavily') {
      throw new Error(
        `LEGION_SEARCH_PROVIDER=${provider} is not supported — 'tavily' is the pinned provider in v0.1`,
      );
    }
    const key = process.env.LEGION_SEARCH_API_KEY;
    if (!key) {
      throw new Error(
        'LEGION_SEARCH_API_KEY is not set — open missions need the pinned search provider',
      );
    }
    return {
      HOME: attemptDir,
      TMPDIR: path.join(attemptDir, '.tmp'),
      LEGION_TOOLSET: 'web',
      TAVILY_API_KEY: key,
    };
  }

  // ====================================================================
  // M3: build loop
  // ====================================================================

  /**
   * Start one build attempt: clone the mission repo into a fresh attempt
   * workspace, branch, spawn the coder. Returns once the first coder is
   * running; `settled` resolves when the whole attempt (coder → review →
   * optional revision → artifact) is processed.
   */
  async startBuild(
    missionId: string,
    overrides: BuildOverrides = {},
  ): Promise<{ attempt: number; coderWorkerId: string; settled: Promise<BuildOutcome> }> {
    const result = await getMission(this.pool, missionId);
    if (!result) throw new MissionNotFoundError(missionId);
    const mission = result.mission;
    if (mission.state !== 'BUILDING') {
      throw new BuildStateError(missionId, mission.state);
    }

    if (this.activeBuilds.has(missionId)) {
      throw new BuildInProgressError(missionId);
    }
    const workers = await listMissionWorkers(this.pool, missionId);
    const liveBuilder = workers.find(
      (w) =>
        (w.role === 'coder' || w.role === 'reviewer' || w.role === 'worker') &&
        (w.status === 'STARTING' || w.status === 'RUNNING'),
    );
    if (liveBuilder) throw new BuildInProgressError(missionId);

    const plan = await this.approvedPlan(missionId);

    // attempt numbering from the filesystem (workspaces persist by design)
    const missionBuilds = path.join(this.buildsRoot, missionId);
    await mkdir(missionBuilds, { recursive: true });
    const existing = (await readdir(missionBuilds)).filter((d) =>
      d.startsWith('attempt-'),
    );
    const attempt = existing.length + 1;
    const attemptDir = path.join(missionBuilds, `attempt-${attempt}`);
    await mkdir(path.join(attemptDir, '.tmp'), { recursive: true });

    // M6a/M6d: task and open missions execute in an isolated workdir with a
    // deliverables/ contract instead of a git clone
    if (mission.kind === 'task' || mission.kind === 'open') {
      return this.startTaskBuild({ missionId, mission, plan, overrides, attempt, attemptDir });
    }

    const repoDir = path.join(attemptDir, 'repo');

    // full local clone; the user's repo is never written
    await exec('git', ['clone', `file://${path.resolve(mission.repoPath!)}`, repoDir]);
    // sever the link back to the user's repo so a push is impossible
    await exec('git', ['-C', repoDir, 'remote', 'remove', 'origin']);
    const baseSha = (
      await exec('git', ['-C', repoDir, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const branch = `legion/${missionId.slice(0, 8)}`;
    await exec('git', ['-C', repoDir, 'checkout', '-q', '-b', branch]);
    // keep runtime droppings out of git's view of the worktree
    await writeFile(path.join(repoDir, '.git', 'info', 'exclude'), '.tmp/\n');
    // recorded for the scan stage: the diff/scan base of this attempt
    await writeFile(path.join(attemptDir, 'base.sha'), `${baseSha}\n`);

    const priorFailure = await this.reworkFeedback(missionId);

    this.activeBuilds.add(missionId);
    try {
      await appendEvent(this.pool, missionId, 'BUILD_STARTED', { attempt });

      const coderEnv = {
        ...CODER_GIT_ENV,
        HOME: attemptDir, // hermes state lands outside the repo worktree
        TMPDIR: path.join(attemptDir, '.tmp'),
      };
      const coderTask =
        overrides.coderTaskOverride ??
        buildCoderPrompt(mission, plan, priorFailure);
      const coderWorkerId = await this.spawnBuildWorker(
        missionId, 'coder', coderTask, repoDir, coderEnv,
      );

      const settled = this.runBuildAttempt({
        missionId, mission, plan, overrides,
        attempt, attemptDir, repoDir, baseSha,
        firstCoderId: coderWorkerId, coderEnv,
      }).finally(() => {
        this.activeBuilds.delete(missionId);
      });

      return { attempt, coderWorkerId, settled };
    } catch (e) {
      this.activeBuilds.delete(missionId);
      throw e;
    }
  }

  private async spawnBuildWorker(
    missionId: string,
    role: 'coder' | 'reviewer' | 'worker',
    task: string,
    workdir: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const doing = role === 'coder' || role === 'worker';
    // M6d: open workers (read-only web research) get a tighter turn budget —
    // search+fetch+report fits comfortably in 16 turns, and a confused model
    // looping searches is bounded instead of burning 40 × provider latency.
    const open = extraEnv?.LEGION_TOOLSET === 'web';
    const workerId = await this.supervisor.startWorker({
      missionId,
      role,
      task,
      workdir,
      // robustness (M2/M3-fix): the reviewer writes review.json; if the model
      // loops on the shell write, the launcher seals its final message there.
      extraEnv:
        role === 'reviewer'
          ? { ...extraEnv, LEGION_SEAL_FILE: 'review.json' }
          : extraEnv,
      model: doing ? this.coderModel : this.reviewerModel,
      // implementing a plan takes far more tool iterations than a review
      maxTurns: open ? 16 : doing ? 40 : undefined,
    });
    await appendWorkerEvent(this.pool, {
      missionId,
      workerId,
      type: 'WORKER_TASK',
      payload: { prompt: task, role },
    });
    return workerId;
  }

  private async runBuildAttempt(ctx: {
    missionId: string;
    mission: MissionRecord;
    plan: Plan;
    overrides: BuildOverrides;
    attempt: number;
    attemptDir: string;
    repoDir: string;
    baseSha: string;
    firstCoderId: string;
    coderEnv: Record<string, string>;
  }): Promise<BuildOutcome> {
    const { missionId, mission, plan, overrides, attempt, attemptDir, repoDir, baseSha } = ctx;

    let lastWorkerId = ctx.firstCoderId;
    let review: Review | null = null;

    const fail = async (reason: string): Promise<BuildOutcome> => {
      await appendWorkerEvent(this.pool, {
        missionId,
        workerId: lastWorkerId,
        type: 'BUILD_ATTEMPT_FAILED',
        payload: {
          attempt,
          reason,
          ...(review ? { reviewSummary: review.summary } : {}),
        },
      });
      return { kind: 'ATTEMPT_FAILED', reason };
    };

    const MAX_CODER_CYCLES = 2;
    for (let cycle = 1; cycle <= MAX_CODER_CYCLES; cycle++) {
      let coderId = ctx.firstCoderId;
      if (cycle > 1) {
        const task =
          overrides.coderRevisionTaskOverride ??
          buildRevisionPrompt(mission, plan, review!.comments, review!.summary);
        coderId = await this.spawnBuildWorker(
          missionId, 'coder', task, repoDir, ctx.coderEnv,
        );
      }
      lastWorkerId = coderId;

      await this.waitForWorker(coderId);
      const coder = await getWorkerRecord(this.pool, coderId);
      if (coder?.status !== 'EXITED') {
        return fail(`CODER_${coder?.status ?? 'UNKNOWN'}`);
      }

      const diff = (
        await exec('git', ['-C', repoDir, 'diff', `${baseSha}..HEAD`], {
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout;
      const commits = (
        await exec('git', ['-C', repoDir, 'log', '--oneline', `${baseSha}..HEAD`])
      ).stdout;

      // A coder that exits cleanly but commits nothing produced no reviewable
      // work — fail fast instead of burning a review cycle on an empty diff.
      if (diff.trim().length === 0) {
        return fail('EMPTY_DIFF');
      }

      const reviewerTask =
        overrides.reviewerTaskOverrides?.[cycle - 1] ??
        buildReviewerPrompt(plan, diff, commits);

      // One deterministic retry per review cycle: a reviewer occasionally
      // answers in chat instead of writing review.json. The failed run keeps
      // its REVIEW_INVALID record; a second real reviewer gets one chance.
      let parsed:
        | { ok: true; review: Review }
        | { ok: false; issues: unknown[] }
        | null = null;
      const MAX_REVIEWER_RUNS = 2;
      for (let run = 1; run <= MAX_REVIEWER_RUNS; run++) {
        const reviewDir = path.join(
          attemptDir,
          `review-${cycle}${run > 1 ? `-retry${run - 1}` : ''}`,
        );
        await mkdir(reviewDir, { recursive: true });
        const reviewerId = await this.spawnBuildWorker(
          missionId, 'reviewer', reviewerTask, reviewDir,
        );
        lastWorkerId = reviewerId;

        await this.waitForWorker(reviewerId);
        const reviewer = await getWorkerRecord(this.pool, reviewerId);
        if (reviewer?.status !== 'EXITED') {
          return fail(`REVIEWER_${reviewer?.status ?? 'UNKNOWN'}`);
        }

        parsed = await this.readReview(path.join(reviewDir, 'review.json'));
        if (parsed.ok) {
          review = parsed.review;
          // persist the verdict for the board
          await appendWorkerEvent(this.pool, {
            missionId,
            workerId: reviewerId,
            type: 'REVIEW_RESULT',
            payload: { ...review, cycle },
          });
          break;
        }
        await appendWorkerEvent(this.pool, {
          missionId,
          workerId: reviewerId,
          type: 'REVIEW_INVALID',
          payload: { issues: parsed.issues, run },
        });
      }
      if (!parsed?.ok || !review) {
        return fail('REVIEW_INVALID');
      }

      if (review.verdict === 'approve') {
        const artifactId = await this.publishArtifact(
          missionId, repoDir, baseSha, diff, review.summary,
        );
        return { kind: 'COMPLETED', artifactId };
      }
    }

    return fail('REVIEW_EXHAUSTED');
  }

  private async waitForWorker(workerId: string): Promise<void> {
    const timeout = (this.plannerTimeoutMs ?? 10 * 60 * 1000) + 60_000;
    try {
      await this.supervisor.waitForExit(workerId, timeout);
    } catch {
      /* status decides */
    }
  }

  private async readReview(
    file: string,
  ): Promise<{ ok: true; review: Review } | { ok: false; issues: unknown[] }> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return { ok: false, issues: [{ message: 'review.json missing from workdir root' }] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, issues: [{ message: `review.json is not valid JSON: ${String(e)}` }] };
    }
    const validated = ReviewSchema.safeParse(parsed);
    if (!validated.success) return { ok: false, issues: validated.error.issues };
    return { ok: true, review: validated.data };
  }

  private async publishArtifact(
    missionId: string,
    repoDir: string,
    baseSha: string,
    diff: string,
    reviewSummary: string,
  ): Promise<string> {
    const shortstat = (
      await exec('git', ['-C', repoDir, 'diff', '--shortstat', `${baseSha}..HEAD`])
    ).stdout;
    const stats: ArtifactStats = {
      files: Number(shortstat.match(/(\d+) files? changed/)?.[1] ?? 0),
      insertions: Number(shortstat.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
      deletions: Number(shortstat.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
      commits: Number(
        (
          await exec('git', ['-C', repoDir, 'rev-list', '--count', `${baseSha}..HEAD`])
        ).stdout.trim(),
      ),
    };

    const artifactId = randomUUID();
    const dir = path.join(this.artifactsRoot, missionId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${artifactId}.diff`);
    await writeFile(filePath, diff);
    const sha256 = createHash('sha256').update(diff).digest('hex');

    await insertArtifact(this.pool, {
      id: artifactId,
      missionId,
      type: 'diff',
      path: filePath,
      sha256,
      stats: { ...stats },
    });

    // mission_events carry the artifact reference, never the diff body
    await appendEvent(this.pool, missionId, 'BUILD_COMPLETED', {
      artifactId,
      sha256,
      stats,
      reviewSummary,
    });

    // M4: entering SCANNING auto-starts the scan. Failures here are the
    // scan's own concern (SCAN_ATTEMPT_FAILED) — never the build's.
    try {
      const { settled } = await this.startScan(missionId);
      void settled.catch((e) =>
        console.error(`auto-scan for ${missionId} failed:`, e),
      );
    } catch (e) {
      console.error(`auto-scan for ${missionId} could not start:`, e);
    }
    return artifactId;
  }

  // ====================================================================
  // M4: security scan stage
  // ====================================================================

  /**
   * Run both scanners against the latest build attempt workspace. Auto-runs
   * after BUILD_COMPLETED; POST /scan retriggers manually (e.g. after a
   * scanner crash). One scan at a time per mission.
   */
  async startScan(
    missionId: string,
    overrides: ScanOverrides = {},
  ): Promise<{ settled: Promise<ScanOutcome> }> {
    const result = await getMission(this.pool, missionId);
    if (!result) throw new MissionNotFoundError(missionId);
    if (result.mission.state !== 'SCANNING') {
      throw new ScanStateError(missionId, result.mission.state);
    }
    if (this.activeScans.has(missionId)) {
      throw new ScanInProgressError(missionId);
    }

    // latest attempt workspace + its recorded scan base
    const missionBuilds = path.join(this.buildsRoot, missionId);
    const attempts = (await readdir(missionBuilds))
      .filter((d) => d.startsWith('attempt-'))
      .map((d) => Number(d.slice('attempt-'.length)))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    const latest = attempts[0];
    if (latest === undefined) {
      throw new ScanStateError(missionId, 'SCANNING (no build workspace found)');
    }
    const attemptDir = path.join(missionBuilds, `attempt-${latest}`);

    // M6b (pin 1): high risk forces the warning threshold FOR THIS MISSION;
    // the env var stays the global default for everything else. An explicit
    // internal override (tests) still wins.
    const effective: ScanOverrides = {
      ...overrides,
      failLevel:
        overrides.failLevel ??
        riskPolicy(result.mission.riskLevel).scanFailLevel ??
        undefined,
    };

    // M6a/M6d (pin 4): task and open missions scan the deliverables with
    // gitleaks only (an agent can paste a fetched secret into a report)
    if (result.mission.kind !== 'code') {
      const deliverablesDir = path.join(attemptDir, 'work', 'deliverables');
      this.activeScans.add(missionId);
      await appendEvent(this.pool, missionId, 'SCAN_STARTED', { attempt: latest });
      const settled = this.runTaskScan(missionId, deliverablesDir, effective).finally(
        () => {
          this.activeScans.delete(missionId);
        },
      );
      return { settled };
    }

    const repoDir = path.join(attemptDir, 'repo');
    const baseSha = (await readFile(path.join(attemptDir, 'base.sha'), 'utf8')).trim();

    this.activeScans.add(missionId);
    await appendEvent(this.pool, missionId, 'SCAN_STARTED', { attempt: latest });

    const settled = this.runScan(missionId, repoDir, baseSha, effective).finally(
      () => {
        this.activeScans.delete(missionId);
      },
    );
    return { settled };
  }

  /**
   * M6a (pin 4): gitleaks-only scan over a task mission's deliverables.
   * semgrep is skipped for non-code; the per-tool breakdown shows gitleaks
   * alone. Threshold semantics, SARIF artifact, and SCAN_FAILED→BUILDING
   * rework are identical to the code path.
   */
  private async runTaskScan(
    missionId: string,
    deliverablesDir: string,
    overrides: ScanOverrides,
  ): Promise<ScanOutcome> {
    const failLevel: FailLevel =
      overrides.failLevel ??
      (process.env.LEGION_SCAN_FAIL_LEVEL === 'warning' ? 'warning' : 'error');

    let gitleaksDoc: SarifDocument;
    try {
      gitleaksDoc = await runGitleaksDir(deliverablesDir, {
        gitleaksBin: overrides.gitleaksBin,
      });
    } catch (e) {
      const tool = e instanceof ScannerCrashError ? e.tool : 'scanner';
      const stderrTail =
        e instanceof ScannerCrashError ? e.stderrTail : String(e);
      await insertScanAttempt(this.pool, {
        missionId,
        status: 'ATTEMPT_FAILED',
        stderrTail: `${tool}: ${stderrTail}`.slice(-4000),
      });
      return { kind: 'ATTEMPT_FAILED', tool, error: stderrTail };
    }

    const merged = mergeSarif([gitleaksDoc]);
    const counts = countFindings(merged);
    const toolBreakdown = {
      gitleaks: countFindings(gitleaksDoc),
    };

    const artifactId = randomUUID();
    const dir = path.join(this.artifactsRoot, missionId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${artifactId}.sarif`);
    const body = JSON.stringify(merged, null, 2);
    await writeFile(filePath, body);
    await insertArtifact(this.pool, {
      id: artifactId,
      missionId,
      type: 'sarif',
      path: filePath,
      sha256: createHash('sha256').update(body).digest('hex'),
      stats: { ...counts },
    });

    const passed = verdict(counts, failLevel) === 'pass';
    await insertScanAttempt(this.pool, {
      missionId,
      status: passed ? 'PASSED' : 'FAILED',
      counts,
      toolBreakdown,
      sarifArtifactId: artifactId,
    });
    await appendEvent(
      this.pool,
      missionId,
      passed ? 'SCAN_PASSED' : 'SCAN_FAILED',
      { sarifArtifactId: artifactId, counts },
    );

    return passed
      ? { kind: 'PASSED', sarifArtifactId: artifactId, counts }
      : { kind: 'FAILED', sarifArtifactId: artifactId, counts };
  }

  private async runScan(
    missionId: string,
    repoDir: string,
    baseSha: string,
    overrides: ScanOverrides,
  ): Promise<ScanOutcome> {
    const failLevel: FailLevel =
      overrides.failLevel ??
      (process.env.LEGION_SCAN_FAIL_LEVEL === 'warning' ? 'warning' : 'error');

    // Both scanners must succeed — a partial scan never passes a mission.
    let gitleaksDoc: SarifDocument;
    let semgrepDoc: SarifDocument;
    try {
      gitleaksDoc = await runGitleaks(repoDir, baseSha, {
        gitleaksBin: overrides.gitleaksBin,
      });
      semgrepDoc = await runSemgrep(repoDir, undefined, {
        semgrepBin: overrides.semgrepBin,
      });
    } catch (e) {
      const tool = e instanceof ScannerCrashError ? e.tool : 'scanner';
      const stderrTail =
        e instanceof ScannerCrashError ? e.stderrTail : String(e);
      await insertScanAttempt(this.pool, {
        missionId,
        status: 'ATTEMPT_FAILED',
        stderrTail: `${tool}: ${stderrTail}`.slice(-4000),
      });
      return { kind: 'ATTEMPT_FAILED', tool, error: stderrTail };
    }

    const merged = mergeSarif([gitleaksDoc, semgrepDoc]);
    const counts = countFindings(merged);
    const toolBreakdown = {
      gitleaks: countFindings(gitleaksDoc),
      semgrep: countFindings(semgrepDoc),
    };

    // merged SARIF is a first-class artifact with the same integrity rules
    const artifactId = randomUUID();
    const dir = path.join(this.artifactsRoot, missionId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${artifactId}.sarif`);
    const body = JSON.stringify(merged, null, 2);
    await writeFile(filePath, body);
    await insertArtifact(this.pool, {
      id: artifactId,
      missionId,
      type: 'sarif',
      path: filePath,
      sha256: createHash('sha256').update(body).digest('hex'),
      stats: { ...counts },
    });

    const passed = verdict(counts, failLevel) === 'pass';
    await insertScanAttempt(this.pool, {
      missionId,
      status: passed ? 'PASSED' : 'FAILED',
      counts,
      toolBreakdown,
      sarifArtifactId: artifactId,
    });
    // mission_events carry only the artifact id + counts (pin 5)
    await appendEvent(
      this.pool,
      missionId,
      passed ? 'SCAN_PASSED' : 'SCAN_FAILED',
      { sarifArtifactId: artifactId, counts },
    );

    return passed
      ? { kind: 'PASSED', sarifArtifactId: artifactId, counts }
      : { kind: 'FAILED', sarifArtifactId: artifactId, counts };
  }

  // ====================================================================
  // M5: merge execution
  // ====================================================================

  /**
   * Rework feedback precedence: a merge rejection (M5) or scan failure (M4)
   * is more recent than any review summary (M3). The next attempt's prompt
   * carries whichever triggered this build. Shared by code and task paths.
   */
  private async reworkFeedback(missionId: string): Promise<string | null> {
    const mergeRejection = await this.lastMergeRejectionReason(missionId);
    if (mergeRejection !== null) {
      return `the human reviewer rejected the previous merge. Reason: ${mergeRejection}`;
    }
    const scanFindings = await this.lastScanFailureFindings(missionId);
    if (scanFindings !== null) {
      return `the previous build failed the security scan. Fix these findings:\n${scanFindings}`;
    }
    return this.lastAttemptFailureSummary(missionId);
  }

  // ====================================================================
  // M6a: task missions — deliverable production (pin 3)
  // ====================================================================

  private async startTaskBuild(ctx: {
    missionId: string;
    mission: MissionRecord;
    plan: Plan;
    overrides: BuildOverrides;
    attempt: number;
    attemptDir: string;
  }): Promise<{ attempt: number; coderWorkerId: string; settled: Promise<BuildOutcome> }> {
    const { missionId, mission, plan, overrides, attempt, attemptDir } = ctx;

    const workDir = path.join(attemptDir, 'work');
    await mkdir(path.join(workDir, 'deliverables'), { recursive: true });

    const priorFailure = await this.reworkFeedback(missionId);
    const open = mission.kind === 'open';

    this.activeBuilds.add(missionId);
    try {
      await appendEvent(this.pool, missionId, 'BUILD_STARTED', { attempt });

      // M6d: open workers get the read-only web toolset + pinned search key;
      // task workers keep the default (terminal) toolset.
      const workerEnv = open
        ? this.openWorkerEnv(attemptDir)
        : {
            HOME: attemptDir, // hermes state lands outside the deliverables tree
            TMPDIR: path.join(attemptDir, '.tmp'),
          };
      const task =
        overrides.coderTaskOverride ??
        (open
          ? buildOpenWorkerPrompt(mission, priorFailure)
          : buildTaskWorkerPrompt(mission, plan, priorFailure));
      const workerId = await this.spawnBuildWorker(
        missionId, 'worker', task, workDir, workerEnv,
      );

      const settled = this.runTaskBuildAttempt({
        missionId, mission, plan, overrides,
        attempt, attemptDir, workDir,
        firstWorkerId: workerId, workerEnv,
      }).finally(() => {
        this.activeBuilds.delete(missionId);
      });

      return { attempt, coderWorkerId: workerId, settled };
    } catch (e) {
      this.activeBuilds.delete(missionId);
      throw e;
    }
  }

  /** Every regular file under deliverables/, with content hashes. */
  private async collectDeliverables(
    workDir: string,
  ): Promise<{ name: string; absPath: string; sha256: string }[]> {
    const root = path.join(workDir, 'deliverables');
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const files: { name: string; absPath: string; sha256: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absPath = path.join(entry.parentPath ?? root, entry.name);
      const name = path.relative(root, absPath);
      const content = await readFile(absPath);
      files.push({
        name,
        absPath,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }

  private async runTaskBuildAttempt(ctx: {
    missionId: string;
    mission: MissionRecord;
    plan: Plan;
    overrides: BuildOverrides;
    attempt: number;
    attemptDir: string;
    workDir: string;
    firstWorkerId: string;
    workerEnv: Record<string, string>;
  }): Promise<BuildOutcome> {
    const { missionId, mission, plan, overrides, attempt, attemptDir, workDir } = ctx;

    let lastWorkerId = ctx.firstWorkerId;
    let review: Review | null = null;

    const fail = async (reason: string): Promise<BuildOutcome> => {
      await appendWorkerEvent(this.pool, {
        missionId,
        workerId: lastWorkerId,
        type: 'BUILD_ATTEMPT_FAILED',
        payload: {
          attempt,
          reason,
          ...(review ? { reviewSummary: review.summary } : {}),
        },
      });
      return { kind: 'ATTEMPT_FAILED', reason };
    };

    const open = mission.kind === 'open';
    const MAX_WORKER_CYCLES = 2;
    for (let cycle = 1; cycle <= MAX_WORKER_CYCLES; cycle++) {
      let workerId = ctx.firstWorkerId;
      if (cycle > 1) {
        const task =
          overrides.coderRevisionTaskOverride ??
          (open
            ? buildOpenWorkerPrompt(
                mission,
                `the reviewer requested changes. Review summary: ${review!.summary} — ` +
                  `comments: ${review!.comments.map((c) => c.body).join('; ')}`,
              )
            : buildTaskRevisionPrompt(mission, plan, review!.comments, review!.summary));
        workerId = await this.spawnBuildWorker(
          missionId, 'worker', task, workDir, ctx.workerEnv,
        );
      }
      lastWorkerId = workerId;

      await this.waitForWorker(workerId);
      const worker = await getWorkerRecord(this.pool, workerId);
      if (worker?.status !== 'EXITED') {
        return fail(`WORKER_${worker?.status ?? 'UNKNOWN'}`);
      }

      // A worker that exits cleanly without producing files made nothing
      // reviewable — fail fast (EMPTY_DELIVERABLE mirrors EMPTY_DIFF).
      const files = await this.collectDeliverables(workDir);
      if (files.length === 0) {
        return fail('EMPTY_DELIVERABLE');
      }

      const contents = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          content: await readFile(f.absPath, 'utf8'),
        })),
      );
      const reviewerTask =
        overrides.reviewerTaskOverrides?.[cycle - 1] ??
        buildDeliverableReviewerPrompt(plan, contents, { requireCitations: open });

      // Same deterministic reviewer retry as the code path: a reviewer
      // occasionally answers in chat instead of writing review.json.
      let parsed:
        | { ok: true; review: Review }
        | { ok: false; issues: unknown[] }
        | null = null;
      const MAX_REVIEWER_RUNS = 2;
      for (let run = 1; run <= MAX_REVIEWER_RUNS; run++) {
        const reviewDir = path.join(
          attemptDir,
          `review-${cycle}${run > 1 ? `-retry${run - 1}` : ''}`,
        );
        await mkdir(reviewDir, { recursive: true });
        const reviewerId = await this.spawnBuildWorker(
          missionId, 'reviewer', reviewerTask, reviewDir,
        );
        lastWorkerId = reviewerId;

        await this.waitForWorker(reviewerId);
        const reviewer = await getWorkerRecord(this.pool, reviewerId);
        if (reviewer?.status !== 'EXITED') {
          return fail(`REVIEWER_${reviewer?.status ?? 'UNKNOWN'}`);
        }

        parsed = await this.readReview(path.join(reviewDir, 'review.json'));
        if (parsed.ok) {
          review = parsed.review;
          await appendWorkerEvent(this.pool, {
            missionId,
            workerId: reviewerId,
            type: 'REVIEW_RESULT',
            payload: { ...review, cycle },
          });
          break;
        }
        await appendWorkerEvent(this.pool, {
          missionId,
          workerId: reviewerId,
          type: 'REVIEW_INVALID',
          payload: { issues: parsed.issues, run },
        });
      }
      if (!parsed?.ok || !review) {
        return fail('REVIEW_INVALID');
      }

      if (review.verdict === 'approve') {
        const artifactId = await this.publishDeliverableArtifact(
          missionId, workDir, files, review.summary,
        );
        return { kind: 'COMPLETED', artifactId };
      }
    }

    return fail('REVIEW_EXHAUSTED');
  }

  /**
   * Collect deliverables/ into ONE hash-sealed artifact (pin 3): a single
   * file is stored as-is; multiple files become a tar. Per-file hashes ride
   * in the BUILD_COMPLETED payload so delivery can verify the unpacked copy.
   */
  private async publishDeliverableArtifact(
    missionId: string,
    workDir: string,
    files: { name: string; absPath: string; sha256: string }[],
    reviewSummary: string,
  ): Promise<string> {
    const artifactId = randomUUID();
    const dir = path.join(this.artifactsRoot, missionId);
    await mkdir(dir, { recursive: true });

    const archive = files.length > 1;
    let filePath: string;
    let body: Buffer;
    if (archive) {
      filePath = path.join(dir, `${artifactId}.tar`);
      await exec('tar', [
        '-cf', filePath,
        '-C', path.join(workDir, 'deliverables'),
        ...files.map((f) => f.name),
      ]);
      body = await readFile(filePath);
    } else {
      const only = files[0]!;
      filePath = path.join(dir, `${artifactId}${path.extname(only.name) || '.out'}`);
      body = await readFile(only.absPath);
      await writeFile(filePath, body);
    }
    const sha256 = createHash('sha256').update(body).digest('hex');

    const stats = {
      files: files.length,
      bytes: body.byteLength,
    };
    await insertArtifact(this.pool, {
      id: artifactId,
      missionId,
      type: 'deliverable',
      path: filePath,
      sha256,
      stats,
    });

    // mission_events carry the artifact reference + file manifest, never bodies
    await appendEvent(this.pool, missionId, 'BUILD_COMPLETED', {
      artifactId,
      sha256,
      stats,
      reviewSummary,
      deliverable: {
        archive,
        files: files.map((f) => ({ name: f.name, sha256: f.sha256 })),
      },
    });

    try {
      const { settled } = await this.startScan(missionId);
      void settled.catch((e) =>
        console.error(`auto-scan for ${missionId} failed:`, e),
      );
    } catch (e) {
      console.error(`auto-scan for ${missionId} could not start:`, e);
    }
    return artifactId;
  }

  /** Run the merge after a verified approval. Consumed by the daemon. */
  async mergeMission(missionId: string, approvalId: string): Promise<MergeOutcome> {
    return executeMerge(this.pool, {
      missionId,
      approvalId,
      buildsRoot: this.buildsRoot,
    });
  }

  /** M6a (pin 6): run the delivery after a verified approval (task missions). */
  async deliverMission(missionId: string, approvalId: string): Promise<DeliveryOutcome> {
    return executeDelivery(this.pool, {
      missionId,
      approvalId,
      deliveriesRoot: this.deliveriesRoot,
    });
  }

  /** Boot-time crash reconciliation for merges and deliveries (pin 5d / M6a pin 6). */
  async reconcileMerges(): Promise<string[]> {
    return reconcileMerges(this.pool, {
      buildsRoot: this.buildsRoot,
      deliveriesRoot: this.deliveriesRoot,
    });
  }

  /** Reason of the latest signed merge rejection, if it triggered this build. */
  private async lastMergeRejectionReason(missionId: string): Promise<string | null> {
    const events = await getMissionEvents(this.pool, missionId);
    const lastRejected = [...events].reverse().find((e) => e.type === 'MERGE_REJECTED');
    if (!lastRejected) return null;
    // only relevant if no build has completed since the rejection
    const lastBuildCompleted = [...events].reverse().find((e) => e.type === 'BUILD_COMPLETED');
    if (lastBuildCompleted && lastBuildCompleted.seq > lastRejected.seq) return null;
    return (lastRejected.payload.reason as string) ?? '(no reason recorded)';
  }

  /**
   * Findings summary of the latest failed scan — embedded in the next build
   * attempt's coder prompt (pin 3, M2/M3 prompt-feedback precedent).
   */
  private async lastScanFailureFindings(missionId: string): Promise<string | null> {
    const events = await getMissionEvents(this.pool, missionId);
    const lastScanFailed = [...events].reverse().find((e) => e.type === 'SCAN_FAILED');
    if (!lastScanFailed) return null;
    // only relevant if no successful scan happened after it
    const lastScanPassed = [...events].reverse().find((e) => e.type === 'SCAN_PASSED');
    if (lastScanPassed && lastScanPassed.seq > lastScanFailed.seq) return null;

    const artifactId = lastScanFailed.payload.sarifArtifactId as string | undefined;
    if (!artifactId) return null;
    const artifact = await getArtifact(this.pool, artifactId);
    if (!artifact) return null;
    try {
      const doc = JSON.parse(await readFile(artifact.path, 'utf8')) as SarifDocument;
      const findings = listFindings(doc).slice(0, 20);
      const lines = findings.map(
        (f) =>
          `- [${f.level}] ${f.tool} ${f.ruleId} at ${f.file ?? '?'}:${f.line ?? '?'} — ${f.message.slice(0, 200)}`,
      );
      return lines.join('\n');
    } catch {
      const counts = lastScanFailed.payload.counts as Record<string, number>;
      return `security scan failed with ${counts?.errors ?? '?'} error-level finding(s); the SARIF report is unavailable`;
    }
  }

  private async approvedPlan(missionId: string): Promise<Plan> {
    const events = await getMissionEvents(this.pool, missionId);
    const proposed = [...events].reverse().find((e) => e.type === 'PLAN_PROPOSED');
    if (!proposed) {
      throw new BuildStateError(missionId, 'BUILDING (no approved plan found)');
    }
    return (proposed.payload as { plan: Plan }).plan;
  }

  /** Latest BUILD_ATTEMPT_FAILED review summary across the mission's workers. */
  private async lastAttemptFailureSummary(missionId: string): Promise<string | null> {
    const workers = await listMissionWorkers(this.pool, missionId);
    let latest: { at: string; summary: string } | null = null;
    for (const w of workers) {
      const events = await getWorkerEvents(this.pool, w.workerId);
      for (const e of events) {
        if (e.type !== 'BUILD_ATTEMPT_FAILED') continue;
        const summary = e.payload.reviewSummary as string | undefined;
        if (!summary) continue;
        if (!latest || e.recordedAt > latest.at) {
          latest = { at: e.recordedAt, summary };
        }
      }
    }
    return latest?.summary ?? null;
  }
}
