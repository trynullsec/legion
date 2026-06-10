import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IllegalTransitionError, PlanSchema, type Plan } from '@legion/core';
import {
  appendEvent,
  appendWorkerEvent,
  getMission,
  getMissionEvents,
  getWorkerRecord,
  listMissionWorkers,
  MissionNotFoundError,
} from '@legion/db';
import type { WorkerSupervisor } from '@legion/runtime';
import type { Pool } from 'pg';
import { buildPlannerPrompt, type RejectionFeedback } from './prompt.js';

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

export interface OrchestratorOptions {
  pool: Pool;
  supervisor: WorkerSupervisor;
  /** Per-role model override; defaults to env LEGION_MODEL_PLANNER, then the M1 default. */
  plannerModel?: string;
  /** Planner hard timeout; defaults to the supervisor's configured timeout. */
  plannerTimeoutMs?: number;
  /** Root for planner workdirs (tests point this into the repo's .tmp). */
  workdirRoot?: string;
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
  private readonly plannerTimeoutMs: number | undefined;
  private readonly workdirRoot: string;

  constructor(options: OrchestratorOptions) {
    this.pool = options.pool;
    this.supervisor = options.supervisor;
    this.plannerModel =
      options.plannerModel ?? process.env.LEGION_MODEL_PLANNER ?? undefined;
    this.plannerTimeoutMs = options.plannerTimeoutMs;
    this.workdirRoot =
      options.workdirRoot ?? path.join(os.homedir(), '.legion', 'workdirs');
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

    // The planner NEVER touches the user's repository: shallow-clone it into
    // the worker's isolated workdir. file:// keeps --depth 1 honest locally.
    const workdir = path.join(this.workdirRoot, missionId, `planner-${randomUUID()}`);
    await mkdir(path.dirname(workdir), { recursive: true });
    await exec('git', [
      'clone',
      '--depth',
      '1',
      `file://${path.resolve(mission.repoPath)}`,
      workdir,
    ]);

    const prompt =
      options.taskOverride ??
      buildPlannerPrompt(mission, await this.rejectionFeedback(missionId));

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

    const settled = this.finishPlanning(missionId, workerId, workdir);
    return { workerId, settled };
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
    workerId: string,
    workdir: string,
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

    const invalid = async (issues: unknown[]): Promise<PlanningOutcome> => {
      await appendWorkerEvent(this.pool, {
        missionId,
        workerId,
        type: 'PLAN_INVALID',
        payload: { issues },
      });
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
}
