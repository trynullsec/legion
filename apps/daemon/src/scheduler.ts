/**
 * M6c — the scheduler. A 30s tick fires due, enabled schedules; each firing
 * creates a mission (payload carries {scheduledBy}) and immediately starts
 * planning, after which the M6b risk policy governs the flow. One mission per
 * schedule in flight, ever. THE MERGE GATE IS INVARIANT — a scheduled
 * mission parks at AWAITING_MERGE_APPROVAL exactly like any other.
 *
 * The next-run computation is the pure function in @legion/core; this module
 * is the IO shell around it (db + orchestrator). Tests drive `tick(now)` and
 * `runNow` directly with real rows — no fake timers stand in for the loop.
 */
import { nextRunAt, TERMINAL_STATES, type MissionStateName } from '@legion/core';
import {
  createMission,
  getMission,
  insertScheduleRun,
  lastCreatedRun,
  listEnabledSchedules,
  getSchedule,
  type ScheduleRecord,
  type ScheduleRunOutcome,
} from '@legion/db';
import type { Orchestrator } from '@legion/orchestrator';
import type { Pool } from 'pg';

const TICK_MS = 30_000;
const MAX_CATCHUP_SCAN = 1000; // bound the missed-interval counter

export interface FireResult {
  scheduleId: string;
  outcome: ScheduleRunOutcome;
  missionId?: string;
  detail?: string;
}

function isTerminal(state: MissionStateName): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly orchestrator: Orchestrator,
  ) {}

  /** Start the 30s loop; fires an immediate catch-up tick on boot (pin 5). */
  start(): void {
    if (this.timer) return;
    void this.tick().catch((e) => console.error('scheduler boot tick failed:', e));
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('scheduler tick failed:', e));
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass over every enabled schedule. Disabled schedules are invisible. */
  async tick(now: Date = new Date()): Promise<FireResult[]> {
    const schedules = await listEnabledSchedules(this.pool);
    const results: FireResult[] = [];
    for (const schedule of schedules) {
      const due = await this.dueState(schedule, now);
      if (due.missed < 1) continue; // not due yet
      results.push(await this.fireGuarded(schedule, now, due.missed));
    }
    return results;
  }

  /**
   * Explicit manual fire (pin 6 / T66). Disabled schedules are NOT silently
   * ignored here: the attempt records SKIPPED_DISABLED and the caller maps it
   * to 409. Otherwise it fires under the same concurrency guard as a tick.
   */
  async runNow(scheduleId: string, now: Date = new Date()): Promise<FireResult | null> {
    const schedule = await getSchedule(this.pool, scheduleId);
    if (!schedule) return null;
    if (!schedule.enabled) {
      await insertScheduleRun(this.pool, {
        scheduleId,
        outcome: 'SKIPPED_DISABLED',
        detail: 'run-now on a disabled schedule',
        firedAt: now,
      });
      return { scheduleId, outcome: 'SKIPPED_DISABLED', detail: 'disabled' };
    }
    return this.fireGuarded(schedule, now, 1, 'manual run-now');
  }

  /**
   * Anchor next-run on the last CREATED run (or the schedule's creation time
   * if it never fired), then count how many cron points have elapsed by
   * `now`. >=1 means due; >1 means missed intervals (catch-up).
   */
  private async dueState(
    schedule: ScheduleRecord,
    now: Date,
  ): Promise<{ missed: number; anchor: Date }> {
    const last = await lastCreatedRun(this.pool, schedule.id);
    const anchor = last ? new Date(last.firedAt) : new Date(schedule.createdAt);
    let missed = 0;
    let cursor = anchor;
    while (missed < MAX_CATCHUP_SCAN) {
      const next = nextRunAt(schedule.cron, cursor);
      if (next.getTime() <= now.getTime()) {
        missed++;
        cursor = next;
      } else {
        break;
      }
    }
    return { missed, anchor };
  }

  /**
   * Fire under the concurrency guard (pin 4): never while the most recent
   * created mission is non-terminal. Missed intervals collapse into EXACTLY
   * ONE mission (pin 5); the catch-up is noted in detail.
   */
  private async fireGuarded(
    schedule: ScheduleRecord,
    now: Date,
    missed: number,
    reason?: string,
  ): Promise<FireResult> {
    const last = await lastCreatedRun(this.pool, schedule.id);
    if (last?.missionId) {
      const result = await getMission(this.pool, last.missionId);
      if (result && !isTerminal(result.mission.state)) {
        await insertScheduleRun(this.pool, {
          scheduleId: schedule.id,
          outcome: 'SKIPPED_ACTIVE',
          detail: `mission ${last.missionId} still ${result.mission.state}`,
          firedAt: now,
        });
        return { scheduleId: schedule.id, outcome: 'SKIPPED_ACTIVE' };
      }
    }

    const detailParts: string[] = [];
    if (reason) detailParts.push(reason);
    if (missed > 1) {
      detailParts.push(`catch-up: ${missed} intervals missed, fired once`);
    }

    try {
      const mission = await createMission(this.pool, {
        ...schedule.template,
        scheduledBy: schedule.id,
      });
      await insertScheduleRun(this.pool, {
        scheduleId: schedule.id,
        outcome: 'CREATED',
        missionId: mission.missionId,
        detail: detailParts.join('; ') || null,
        firedAt: now,
      });
      // start planning; from here the M6b risk policy governs the flow. The
      // attempt processes in the background — outcomes land in the ledger.
      const { settled } = await this.orchestrator.startPlanning(mission.missionId);
      void settled.catch((e) =>
        console.error(`scheduled planning for ${mission.missionId} failed:`, e),
      );
      return {
        scheduleId: schedule.id,
        outcome: 'CREATED',
        missionId: mission.missionId,
        detail: detailParts.join('; ') || undefined,
      };
    } catch (e) {
      await insertScheduleRun(this.pool, {
        scheduleId: schedule.id,
        outcome: 'ERROR',
        detail: String((e as Error).message ?? e).slice(0, 500),
        firedAt: now,
      });
      return { scheduleId: schedule.id, outcome: 'ERROR' };
    }
  }
}
