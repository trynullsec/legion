/**
 * T62 — next-run pure function. No timers, no clock: `now` is an argument.
 * UTC-only semantics (v0.1).
 */
import { describe, expect, it } from 'vitest';
import { assertValidCron, InvalidCronError, isDue, nextRunAt } from '../src/schedule.js';

const U = (iso: string) => new Date(iso);

describe('T62: next-run pure function', () => {
  it('hourly — next run is the top of the next hour (UTC)', () => {
    const next = nextRunAt('0 * * * *', U('2026-06-12T08:15:00Z'));
    expect(next.toISOString()).toBe('2026-06-12T09:00:00.000Z');
  });

  it('daily 03:00 — rolls to the next day when already past', () => {
    const next = nextRunAt('0 3 * * *', U('2026-06-12T03:30:00Z'));
    expect(next.toISOString()).toBe('2026-06-13T03:00:00.000Z');
  });

  it('daily 03:00 — same day when before the time', () => {
    const next = nextRunAt('0 3 * * *', U('2026-06-12T01:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-12T03:00:00.000Z');
  });

  it('weekdays 09:00 — Friday rolls to Monday, skipping the weekend', () => {
    // 2026-06-12 is a Friday; next weekday 09:00 after Fri 10:00 is Mon
    const next = nextRunAt('0 9 * * 1-5', U('2026-06-12T10:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-15T09:00:00.000Z'); // Monday
  });

  it('DST-irrelevance — a daily UTC job is exactly 24h apart across a DST boundary', () => {
    // US DST springs forward 2026-03-08. Under UTC there is no shift: the
    // 02:00Z job on the 8th is exactly 24h after the 7th's.
    const a = nextRunAt('0 2 * * *', U('2026-03-07T03:00:00Z'));
    const b = nextRunAt('0 2 * * *', U('2026-03-08T03:00:00Z'));
    expect(a.toISOString()).toBe('2026-03-08T02:00:00.000Z');
    expect(b.toISOString()).toBe('2026-03-09T02:00:00.000Z');
    expect(b.getTime() - a.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('strictly after — a run exactly at `after` returns the following one', () => {
    const next = nextRunAt('0 3 * * *', U('2026-06-12T03:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-13T03:00:00.000Z');
  });

  it('rejects invalid cron with a precise InvalidCronError', () => {
    expect(() => nextRunAt('not a cron', U('2026-06-12T00:00:00Z'))).toThrow(
      InvalidCronError,
    );
    // wrong field count is named precisely
    expect(() => assertValidCron('0 3 * *')).toThrow(/expected 5 fields/);
    expect(() => assertValidCron('')).toThrow(/empty/);
    // out-of-range field
    expect(() => assertValidCron('0 99 * * *')).toThrow(InvalidCronError);
  });

  it('isDue — true once now reaches the next run, false before', () => {
    const created = U('2026-06-12T08:00:00Z');
    expect(isDue('0 * * * *', created, U('2026-06-12T08:59:59Z'))).toBe(false);
    expect(isDue('0 * * * *', created, U('2026-06-12T09:00:00Z'))).toBe(true);
    expect(isDue('0 * * * *', created, U('2026-06-12T09:30:00Z'))).toBe(true);
  });
});
