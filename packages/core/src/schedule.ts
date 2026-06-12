/**
 * M6c — scheduled missions. Pure next-run computation: no clock, no IO, no
 * timers. It takes `now` as an argument so it is unit-testable directly.
 *
 * v0.1 is UTC-only. Standard 5-field cron (minute hour day-of-month month
 * day-of-week). croner is the single pinned cron dependency.
 */
import { Cron } from 'croner';

export class InvalidCronError extends Error {
  constructor(
    readonly cron: string,
    reason: string,
  ) {
    super(`invalid cron "${cron}": ${reason}`);
    this.name = 'InvalidCronError';
  }
}

/** Reject anything that is not exactly five whitespace-separated fields. */
function assertFiveFields(cron: string): void {
  const trimmed = cron.trim();
  if (trimmed.length === 0) {
    throw new InvalidCronError(cron, 'expression is empty');
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronError(
      cron,
      `expected 5 fields (min hour dom month dow), got ${fields.length}`,
    );
  }
}

/**
 * Validate a 5-field UTC cron expression, throwing InvalidCronError with a
 * precise reason if it cannot be parsed.
 */
export function assertValidCron(cron: string): void {
  assertFiveFields(cron);
  try {
    // constructing validates the pattern; UTC fixes the field semantics
    new Cron(cron, { timezone: 'UTC' });
  } catch (e) {
    throw new InvalidCronError(cron, (e as Error).message);
  }
}

/**
 * The first scheduled instant strictly after `after`, in UTC. Because the
 * schedule is anchored to UTC (which has no daylight-saving shifts), a daily
 * job is always exactly 24h apart in wall-clock terms — DST never moves it.
 */
export function nextRunAt(cron: string, after: Date): Date {
  assertValidCron(cron);
  const next = new Cron(cron, { timezone: 'UTC' }).nextRun(after);
  if (!next) {
    // a finite cron (e.g. a specific past date) with nothing left to fire
    throw new InvalidCronError(cron, 'expression has no future run');
  }
  return next;
}

/**
 * Is a run due as of `now`, given the last time the schedule fired (or its
 * creation time if it never has)? Pure — the daemon tick passes both in.
 */
export function isDue(cron: string, lastFiredOrCreated: Date, now: Date): boolean {
  return nextRunAt(cron, lastFiredOrCreated).getTime() <= now.getTime();
}
