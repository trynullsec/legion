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
  buildPlannerPrompt,
  buildReviewerPrompt,
  buildRevisionPrompt,
  type RejectionFeedback,
} from './prompt.js';
import { executeMerge, reconcileMerges, type MergeOutcome } from './merge.js';

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
  }

  /**
   * Start one planning attempt. Emits PLANNING_STARTED when the mission is
   * still DRAFT; spawns a real planner on a fresh `git clone --depth 1` of
   * the mission repo. Returns immediately; `settled` resolves when the
   * attempt has been fully processed.
   */
  async startPlanning(
    missionId: string,
    options: { taskOverride?: string } = {},
  ): Promise<{ workerId: string; settled: Promise<PlanningOutcome> }> {
    const result = await getMission(this.pool, missionId);
    if (!result) throw new MissionNotFoundError(missionId);
    const mission = result.mission;

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

    const prompt =
      options.taskOverride ??
      buildPlannerPrompt(mission, await this.rejectionFeedback(missionId));

    const spawned = await this.spawnPlanner(missionId, mission.repoPath, prompt);
    const settled = this.finishPlanning(
      missionId, mission.repoPath, spawned.workerId, spawned.workdir, prompt, 1,
    );
    return { workerId: spawned.workerId, settled };
  }

  /**
   * Clone the mission repo into a fresh isolated workdir and spawn a planner.
   * The planner NEVER touches the user's repository — file:// shallow clone.
   */
  private async spawnPlanner(
    missionId: string,
    repoPath: string,
    prompt: string,
  ): Promise<{ workerId: string; workdir: string }> {
    const workdir = path.join(this.workdirRoot, missionId, `planner-${randomUUID()}`);
    await mkdir(path.dirname(workdir), { recursive: true });
    await exec('git', [
      'clone',
      '--depth',
      '1',
      `file://${path.resolve(repoPath)}`,
      workdir,
    ]);

    const workerId = await this.supervisor.startWorker({
      missionId,
      role: 'planner',
      task: prompt,
      workdir,
      timeoutMs: this.plannerTimeoutMs,
      model: this.plannerModel,
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
    repoPath: string,
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
        const next = await this.spawnPlanner(missionId, repoPath, prompt);
        return this.finishPlanning(
          missionId, repoPath, next.workerId, next.workdir, prompt, run + 1,
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
    return { kind: 'PROPOSED', plan: validated.data };
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
        (w.role === 'coder' || w.role === 'reviewer') &&
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
    const repoDir = path.join(attemptDir, 'repo');
    await mkdir(path.join(attemptDir, '.tmp'), { recursive: true });

    // full local clone; the user's repo is never written
    await exec('git', ['clone', `file://${path.resolve(mission.repoPath)}`, repoDir]);
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

    // Rework feedback precedence: a merge rejection (M5) or scan failure (M4)
    // is more recent than any review summary (M3). The next coder prompt
    // carries whichever triggered this build.
    const mergeRejection = await this.lastMergeRejectionReason(missionId);
    const scanFindings = await this.lastScanFailureFindings(missionId);
    let priorFailure: string | null;
    if (mergeRejection !== null) {
      priorFailure = `the human reviewer rejected the previous merge. Reason: ${mergeRejection}`;
    } else if (scanFindings !== null) {
      priorFailure = `the previous build failed the security scan. Fix these findings:\n${scanFindings}`;
    } else {
      priorFailure = await this.lastAttemptFailureSummary(missionId);
    }

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
    role: 'coder' | 'reviewer',
    task: string,
    workdir: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const workerId = await this.supervisor.startWorker({
      missionId,
      role,
      task,
      workdir,
      extraEnv,
      model: role === 'coder' ? this.coderModel : this.reviewerModel,
      // implementing a plan takes far more tool iterations than a review
      maxTurns: role === 'coder' ? 40 : undefined,
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
    const repoDir = path.join(attemptDir, 'repo');
    const baseSha = (await readFile(path.join(attemptDir, 'base.sha'), 'utf8')).trim();

    this.activeScans.add(missionId);
    await appendEvent(this.pool, missionId, 'SCAN_STARTED', { attempt: latest });

    const settled = this.runScan(missionId, repoDir, baseSha, overrides).finally(
      () => {
        this.activeScans.delete(missionId);
      },
    );
    return { settled };
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

  /** Run the merge after a verified approval. Consumed by the daemon. */
  async mergeMission(missionId: string, approvalId: string): Promise<MergeOutcome> {
    return executeMerge(this.pool, {
      missionId,
      approvalId,
      buildsRoot: this.buildsRoot,
    });
  }

  /** Boot-time crash reconciliation for merges (pin 5d). */
  async reconcileMerges(): Promise<string[]> {
    return reconcileMerges(this.pool, { buildsRoot: this.buildsRoot });
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
