import { randomUUID } from 'node:crypto';
import {
  applyEvent,
  foldMission,
  type EventType,
  type FoldEvent,
  type MissionCreationPayload,
  type MissionSnapshot,
  type MissionStateName,
} from '@legion/core';
import type { Pool } from 'pg';

export class MissionNotFoundError extends Error {
  readonly missionId: string;

  constructor(missionId: string) {
    super(`mission ${missionId} not found`);
    this.name = 'MissionNotFoundError';
    this.missionId = missionId;
  }
}

export class AppendConflictError extends Error {
  readonly missionId: string;

  constructor(missionId: string, attempts: number) {
    super(
      `mission ${missionId}: append still conflicting after ${attempts} attempts`,
    );
    this.name = 'AppendConflictError';
    this.missionId = missionId;
  }
}

export interface StoredEvent {
  id: string;
  missionId: string;
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  /** ISO 8601 UTC with full microsecond precision; never round-tripped through a JS Date. */
  validFrom: string;
  /** ISO 8601 UTC with full microsecond precision; never round-tripped through a JS Date. */
  recordedAt: string;
}

export interface MissionRecord extends MissionSnapshot {
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

interface EventRow {
  id: string;
  mission_id: string;
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  valid_from: string;
  recorded_at: string;
}

/**
 * Timestamps are selected as text at full microsecond precision (fixed-width
 * UTC, lexicographically sortable). node-pg would otherwise coerce them into
 * JS Dates and silently truncate to milliseconds.
 */
const EVENT_COLUMNS = `
  id, mission_id, seq, type, payload,
  to_char(valid_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as valid_from,
  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at`;

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    validFrom: row.valid_from,
    recordedAt: row.recorded_at,
  };
}

function toRecord(missionId: string, events: StoredEvent[]): MissionRecord {
  const folds: FoldEvent[] = events.map((e) => ({
    type: e.type,
    payload: e.payload,
  }));
  const snapshot = foldMission(missionId, folds);
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) {
    throw new MissionNotFoundError(missionId);
  }
  return {
    ...snapshot,
    createdAt: first.recordedAt,
    updatedAt: last.recordedAt,
    eventCount: events.length,
  };
}

export async function getMissionEvents(
  pool: Pool,
  missionId: string,
): Promise<StoredEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from mission_events
      where mission_id = $1
      order by seq`,
    [missionId],
  );
  return rows.map(toStoredEvent);
}

export async function createMission(
  pool: Pool,
  input: MissionCreationPayload,
): Promise<MissionRecord> {
  const missionId = randomUUID();
  await pool.query(
    `insert into mission_events (mission_id, seq, type, payload)
     values ($1, 1, 'MISSION_CREATED', $2)`,
    [missionId, JSON.stringify(input)],
  );
  const events = await getMissionEvents(pool, missionId);
  return toRecord(missionId, events);
}

const MAX_APPEND_ATTEMPTS = 5;

/**
 * Optimistic append: fold the current log, validate the transition, insert
 * with the next gapless seq. A concurrent writer surfaces as a unique
 * violation (23505) on (mission_id, seq); we refold and retry, so the state
 * machine is always validated against the log that actually won.
 */
export async function appendEvent(
  pool: Pool,
  missionId: string,
  type: EventType,
  payload: Record<string, unknown> = {},
): Promise<MissionRecord> {
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    const events = await getMissionEvents(pool, missionId);
    if (events.length === 0) {
      throw new MissionNotFoundError(missionId);
    }

    const folds: FoldEvent[] = events.map((e) => ({
      type: e.type,
      payload: e.payload,
    }));
    const snapshot = foldMission(missionId, folds);
    // throws IllegalTransitionError on an invalid event for the current state
    applyEvent(missionId, snapshot.state, type);

    const nextSeq = events.length + 1;
    try {
      await pool.query(
        `insert into mission_events (mission_id, seq, type, payload)
         values ($1, $2, $3, $4)`,
        [missionId, nextSeq, type, JSON.stringify(payload)],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        continue; // retryable conflict: another append won this seq
      }
      throw e;
    }

    const updated = await getMissionEvents(pool, missionId);
    return toRecord(missionId, updated);
  }
  throw new AppendConflictError(missionId, MAX_APPEND_ATTEMPTS);
}

export async function getMission(
  pool: Pool,
  missionId: string,
): Promise<{ mission: MissionRecord; events: StoredEvent[] } | null> {
  const events = await getMissionEvents(pool, missionId);
  if (events.length === 0) return null;
  return { mission: toRecord(missionId, events), events };
}

export async function listMissions(pool: Pool): Promise<MissionRecord[]> {
  const { rows } = await pool.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from mission_events
      order by mission_id, seq`,
  );
  const grouped = new Map<string, StoredEvent[]>();
  for (const row of rows) {
    const list = grouped.get(row.mission_id) ?? [];
    list.push(toStoredEvent(row));
    grouped.set(row.mission_id, list);
  }
  const records = [...grouped.entries()].map(([missionId, events]) =>
    toRecord(missionId, events),
  );
  // createdAt is fixed-width UTC text, so lexicographic order is chronological
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records;
}

/**
 * Bitemporal read: fold only the events recorded at or before `asOf`.
 * The comparison runs at native microsecond precision — `asOf` is passed as
 * text and cast by Postgres, never round-tripped through a JS Date. seq
 * tie-breaks true simultaneity.
 */
export async function getStateAsOf(
  pool: Pool,
  missionId: string,
  asOf: string,
): Promise<MissionStateName | null> {
  const { rows } = await pool.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from mission_events
      where mission_id = $1 and recorded_at <= $2::timestamptz
      order by recorded_at, seq`,
    [missionId, asOf],
  );
  if (rows.length === 0) return null;
  const folds: FoldEvent[] = rows.map((r) => ({
    type: r.type,
    payload: r.payload,
  }));
  return foldMission(missionId, folds).state;
}
