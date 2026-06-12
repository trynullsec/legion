import type { Pool } from 'pg';

export interface ScheduleTemplate {
  kind: 'code' | 'task';
  title: string;
  objective: string;
  repoPath?: string;
  deliverTo?: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ScheduleRecord {
  id: string;
  name: string;
  cron: string;
  template: ScheduleTemplate;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleRunOutcome =
  | 'CREATED'
  | 'SKIPPED_ACTIVE'
  | 'SKIPPED_DISABLED'
  | 'ERROR';

export interface ScheduleRunRecord {
  id: string;
  scheduleId: string;
  firedAt: string;
  outcome: ScheduleRunOutcome;
  missionId: string | null;
  detail: string | null;
}

const TS = (col: string) =>
  `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SCHEDULE_COLS = `
  id, name, cron, template, enabled,
  ${TS('created_at')} as created_at, ${TS('updated_at')} as updated_at`;

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  template: ScheduleTemplate;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function toSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    template: row.template,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ScheduleNameConflictError extends Error {
  readonly scheduleName: string;
  constructor(scheduleName: string) {
    super(`a schedule named "${scheduleName}" already exists`);
    this.name = 'ScheduleNameConflictError';
    this.scheduleName = scheduleName;
  }
}

export async function insertSchedule(
  pool: Pool,
  input: { name: string; cron: string; template: ScheduleTemplate; enabled?: boolean },
): Promise<ScheduleRecord> {
  try {
    const { rows } = await pool.query<ScheduleRow>(
      `insert into schedules (name, cron, template, enabled)
       values ($1, $2, $3, $4)
       returning ${SCHEDULE_COLS}`,
      [input.name, input.cron, JSON.stringify(input.template), input.enabled ?? true],
    );
    return toSchedule(rows[0]!);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ScheduleNameConflictError(input.name);
    }
    throw e;
  }
}

export async function listSchedules(pool: Pool): Promise<ScheduleRecord[]> {
  const { rows } = await pool.query<ScheduleRow>(
    `select ${SCHEDULE_COLS} from schedules order by created_at`,
  );
  return rows.map(toSchedule);
}

/** Enabled schedules only — the tick never considers disabled ones. */
export async function listEnabledSchedules(pool: Pool): Promise<ScheduleRecord[]> {
  const { rows } = await pool.query<ScheduleRow>(
    `select ${SCHEDULE_COLS} from schedules where enabled = true order by created_at`,
  );
  return rows.map(toSchedule);
}

export async function getSchedule(
  pool: Pool,
  id: string,
): Promise<ScheduleRecord | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `select ${SCHEDULE_COLS} from schedules where id = $1`,
    [id],
  );
  return rows[0] ? toSchedule(rows[0]) : null;
}

export async function updateSchedule(
  pool: Pool,
  id: string,
  patch: {
    name?: string;
    cron?: string;
    template?: ScheduleTemplate;
    enabled?: boolean;
  },
): Promise<ScheduleRecord | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) { sets.push(`name = $${i++}`); vals.push(patch.name); }
  if (patch.cron !== undefined) { sets.push(`cron = $${i++}`); vals.push(patch.cron); }
  if (patch.template !== undefined) {
    sets.push(`template = $${i++}`);
    vals.push(JSON.stringify(patch.template));
  }
  if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
  if (sets.length === 0) return getSchedule(pool, id);
  sets.push(`updated_at = now()`);
  vals.push(id);
  try {
    const { rows } = await pool.query<ScheduleRow>(
      `update schedules set ${sets.join(', ')} where id = $${i} returning ${SCHEDULE_COLS}`,
      vals,
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ScheduleNameConflictError(patch.name ?? '');
    }
    throw e;
  }
}

/** Deleting a schedule never touches its missions (pin 6). */
export async function deleteSchedule(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from schedules where id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

// ---------- schedule_runs ----------

const RUN_COLS = `
  id, schedule_id, ${TS('fired_at')} as fired_at, outcome, mission_id, detail`;

interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  fired_at: string;
  outcome: ScheduleRunOutcome;
  mission_id: string | null;
  detail: string | null;
}

function toRun(row: ScheduleRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    firedAt: row.fired_at,
    outcome: row.outcome,
    missionId: row.mission_id,
    detail: row.detail,
  };
}

export async function insertScheduleRun(
  pool: Pool,
  input: {
    scheduleId: string;
    outcome: ScheduleRunOutcome;
    missionId?: string | null;
    detail?: string | null;
    firedAt?: Date;
  },
): Promise<ScheduleRunRecord> {
  const { rows } = await pool.query<ScheduleRunRow>(
    `insert into schedule_runs (schedule_id, outcome, mission_id, detail, fired_at)
     values ($1, $2, $3, $4, coalesce($5, now()))
     returning ${RUN_COLS}`,
    [
      input.scheduleId,
      input.outcome,
      input.missionId ?? null,
      input.detail ?? null,
      input.firedAt ?? null,
    ],
  );
  return toRun(rows[0]!);
}

export async function listScheduleRuns(
  pool: Pool,
  scheduleId: string,
  limit = 20,
): Promise<ScheduleRunRecord[]> {
  const { rows } = await pool.query<ScheduleRunRow>(
    `select ${RUN_COLS} from schedule_runs
      where schedule_id = $1 order by fired_at desc limit $2`,
    [scheduleId, limit],
  );
  return rows.map(toRun);
}

/** Most recent CREATED run (anchors next-run computation + concurrency). */
export async function lastCreatedRun(
  pool: Pool,
  scheduleId: string,
): Promise<ScheduleRunRecord | null> {
  const { rows } = await pool.query<ScheduleRunRow>(
    `select ${RUN_COLS} from schedule_runs
      where schedule_id = $1 and outcome = 'CREATED'
      order by fired_at desc limit 1`,
    [scheduleId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}

export async function latestRun(
  pool: Pool,
  scheduleId: string,
): Promise<ScheduleRunRecord | null> {
  const { rows } = await pool.query<ScheduleRunRow>(
    `select ${RUN_COLS} from schedule_runs
      where schedule_id = $1 order by fired_at desc limit 1`,
    [scheduleId],
  );
  return rows[0] ? toRun(rows[0]) : null;
}
