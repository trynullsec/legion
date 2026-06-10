import type { Pool } from 'pg';

export type ScanStatus = 'PASSED' | 'FAILED' | 'ATTEMPT_FAILED';

export interface ScanCounts {
  errors: number;
  warnings: number;
  notes: number;
}

export interface ScanAttemptRecord {
  id: string;
  missionId: string;
  status: ScanStatus;
  counts: ScanCounts;
  toolBreakdown: Record<string, ScanCounts>;
  sarifArtifactId: string | null;
  stderrTail: string | null;
  createdAt: string;
}

interface ScanAttemptRow {
  id: string;
  mission_id: string;
  status: ScanStatus;
  counts: ScanCounts;
  tool_breakdown: Record<string, ScanCounts>;
  sarif_artifact_id: string | null;
  stderr_tail: string | null;
  created_at: string;
}

const SCAN_COLUMNS = `
  id, mission_id, status, counts, tool_breakdown, sarif_artifact_id, stderr_tail,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

function toRecord(row: ScanAttemptRow): ScanAttemptRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    status: row.status,
    counts: row.counts,
    toolBreakdown: row.tool_breakdown,
    sarifArtifactId: row.sarif_artifact_id,
    stderrTail: row.stderr_tail,
    createdAt: row.created_at,
  };
}

export async function insertScanAttempt(
  pool: Pool,
  input: {
    missionId: string;
    status: ScanStatus;
    counts?: ScanCounts;
    toolBreakdown?: Record<string, ScanCounts>;
    sarifArtifactId?: string | null;
    stderrTail?: string | null;
  },
): Promise<ScanAttemptRecord> {
  const { rows } = await pool.query<ScanAttemptRow>(
    `insert into scan_attempts
       (mission_id, status, counts, tool_breakdown, sarif_artifact_id, stderr_tail)
     values ($1, $2, $3, $4, $5, $6)
     returning ${SCAN_COLUMNS}`,
    [
      input.missionId,
      input.status,
      JSON.stringify(input.counts ?? { errors: 0, warnings: 0, notes: 0 }),
      JSON.stringify(input.toolBreakdown ?? {}),
      input.sarifArtifactId ?? null,
      input.stderrTail ?? null,
    ],
  );
  return toRecord(rows[0]!);
}

export async function latestScanAttempt(
  pool: Pool,
  missionId: string,
): Promise<ScanAttemptRecord | null> {
  const { rows } = await pool.query<ScanAttemptRow>(
    `select ${SCAN_COLUMNS}
       from scan_attempts
      where mission_id = $1
      order by created_at desc
      limit 1`,
    [missionId],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}
