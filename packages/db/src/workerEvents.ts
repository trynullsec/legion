import type { Pool } from 'pg';

export const WORKER_STATUSES = [
  'STARTING',
  'RUNNING',
  'EXITED',
  'KILLED',
  'FAILED',
] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const WORKER_EVENT_TYPES = [
  'WORKER_CREATED',
  'WORKER_STARTED',
  'WORKER_TASK',
  // M7: the OS-enforced capability grant, recorded before any work, and one
  // line per egress request through the per-worker proxy (allowed or blocked).
  'CAPABILITY_PROFILE',
  'NET_REQUEST',
  'PLAN_INVALID',
  'REVIEW_INVALID',
  'REVIEW_RESULT',
  'BUILD_ATTEMPT_FAILED',
  'MERGE_CONFLICT',
  'MERGE_BLOCKED_DIRTY',
  'MODEL_MESSAGE',
  'TOOL_CALL',
  'TOOL_RESULT',
  'AGENT_STATUS',
  'ERROR',
  'WORKER_EXITED',
  'WORKER_KILLED',
  'WORKER_FAILED',
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export interface StoredWorkerEvent {
  id: string;
  missionId: string;
  workerId: string;
  seq: number;
  type: WorkerEventType;
  payload: Record<string, unknown>;
  /** ISO 8601 UTC, microsecond precision — selected as text, never a JS Date. */
  recordedAt: string;
}

export interface WorkerRecord {
  workerId: string;
  missionId: string;
  role: string;
  task: string;
  workdir: string;
  pid: number | null;
  status: WorkerStatus;
  reason: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

interface WorkerEventRow {
  id: string;
  mission_id: string;
  worker_id: string;
  seq: number;
  type: WorkerEventType;
  payload: Record<string, unknown>;
  recorded_at: string;
}

const WORKER_EVENT_COLUMNS = `
  id, mission_id, worker_id, seq, type, payload,
  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at`;

function toStored(row: WorkerEventRow): StoredWorkerEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    workerId: row.worker_id,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    recordedAt: row.recorded_at,
  };
}

/** Derive a worker's current status from its event log. Never stored. */
export function foldWorker(
  workerId: string,
  events: StoredWorkerEvent[],
): WorkerRecord {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last || first.type !== 'WORKER_CREATED') {
    throw new Error(`worker ${workerId}: invalid event log`);
  }

  let status: WorkerStatus = 'STARTING';
  let pid: number | null = null;
  let reason: string | null = null;
  let exitCode: number | null = null;

  for (const e of events) {
    switch (e.type) {
      case 'WORKER_STARTED':
        status = 'RUNNING';
        pid = (e.payload.pid as number) ?? null;
        break;
      case 'WORKER_EXITED':
        status = 'EXITED';
        exitCode = (e.payload.exitCode as number) ?? null;
        break;
      case 'WORKER_KILLED':
        status = 'KILLED';
        break;
      case 'WORKER_FAILED':
        status = 'FAILED';
        reason = (e.payload.reason as string) ?? null;
        exitCode = (e.payload.exitCode as number) ?? null;
        break;
      default:
        break; // trajectory events do not change status
    }
  }

  return {
    workerId,
    missionId: first.missionId,
    role: (first.payload.role as string) ?? '',
    task: (first.payload.task as string) ?? '',
    workdir: (first.payload.workdir as string) ?? '',
    pid,
    status,
    reason,
    exitCode,
    createdAt: first.recordedAt,
    updatedAt: last.recordedAt,
    eventCount: events.length,
  };
}

const MAX_APPEND_ATTEMPTS = 5;

/** Gapless per-worker seq with retry on unique-constraint conflict. */
export async function appendWorkerEvent(
  pool: Pool,
  input: {
    missionId: string;
    workerId: string;
    type: WorkerEventType;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      await pool.query(
        `insert into worker_events (mission_id, worker_id, seq, type, payload)
         values (
           $1, $2,
           (select coalesce(max(seq), 0) + 1 from worker_events where worker_id = $2),
           $3, $4
         )`,
        [input.missionId, input.workerId, input.type, JSON.stringify(input.payload)],
      );
      return;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') continue;
      throw e;
    }
  }
  throw new Error(
    `worker ${input.workerId}: append still conflicting after ${MAX_APPEND_ATTEMPTS} attempts`,
  );
}

export async function getWorkerEvents(
  pool: Pool,
  workerId: string,
): Promise<StoredWorkerEvent[]> {
  const { rows } = await pool.query<WorkerEventRow>(
    `select ${WORKER_EVENT_COLUMNS}
       from worker_events
      where worker_id = $1
      order by seq`,
    [workerId],
  );
  return rows.map(toStored);
}

export async function getWorkerRecord(
  pool: Pool,
  workerId: string,
): Promise<WorkerRecord | null> {
  const events = await getWorkerEvents(pool, workerId);
  if (events.length === 0) return null;
  return foldWorker(workerId, events);
}

export async function listMissionWorkers(
  pool: Pool,
  missionId: string,
): Promise<WorkerRecord[]> {
  const { rows } = await pool.query<WorkerEventRow>(
    `select ${WORKER_EVENT_COLUMNS}
       from worker_events
      where mission_id = $1
      order by worker_id, seq`,
    [missionId],
  );
  return groupAndFold(rows);
}

/** Workers whose folded status is non-terminal — orphan-reconciliation input. */
export async function listLiveWorkers(pool: Pool): Promise<WorkerRecord[]> {
  const { rows } = await pool.query<WorkerEventRow>(
    `select ${WORKER_EVENT_COLUMNS}
       from worker_events
      order by worker_id, seq`,
  );
  return groupAndFold(rows).filter(
    (w) => w.status === 'STARTING' || w.status === 'RUNNING',
  );
}

function groupAndFold(rows: WorkerEventRow[]): WorkerRecord[] {
  const grouped = new Map<string, StoredWorkerEvent[]>();
  for (const row of rows) {
    const list = grouped.get(row.worker_id) ?? [];
    list.push(toStored(row));
    grouped.set(row.worker_id, list);
  }
  const records = [...grouped.entries()]
    // worker_events also carries worker-less audit records (e.g.
    // MERGE_CONFLICT under a synthetic id) — they are not workers and
    // must not crash fold-everything paths like orphan reconciliation
    .filter(([, events]) => events[0]?.type === 'WORKER_CREATED')
    .map(([workerId, events]) => foldWorker(workerId, events));
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records;
}
