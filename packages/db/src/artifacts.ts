import type { Pool } from 'pg';

export interface ArtifactStats {
  files: number;
  insertions: number;
  deletions: number;
  commits: number;
}

export interface ArtifactRecord {
  id: string;
  missionId: string;
  type: string;
  path: string;
  sha256: string;
  stats: ArtifactStats;
  /** ISO 8601 UTC, microsecond precision text (M0 convention). */
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  mission_id: string;
  type: string;
  path: string;
  sha256: string;
  stats: ArtifactStats;
  created_at: string;
}

const ARTIFACT_COLUMNS = `
  id, mission_id, type, path, sha256, stats,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    type: row.type,
    path: row.path,
    sha256: row.sha256,
    stats: row.stats,
    createdAt: row.created_at,
  };
}

export async function insertArtifact(
  pool: Pool,
  input: {
    id: string;
    missionId: string;
    type: string;
    path: string;
    sha256: string;
    stats: ArtifactStats;
  },
): Promise<ArtifactRecord> {
  const { rows } = await pool.query<ArtifactRow>(
    `insert into artifacts (id, mission_id, type, path, sha256, stats)
     values ($1, $2, $3, $4, $5, $6)
     returning ${ARTIFACT_COLUMNS}`,
    [
      input.id,
      input.missionId,
      input.type,
      input.path,
      input.sha256,
      JSON.stringify(input.stats),
    ],
  );
  return toRecord(rows[0]!);
}

export async function getArtifact(
  pool: Pool,
  id: string,
): Promise<ArtifactRecord | null> {
  const { rows } = await pool.query<ArtifactRow>(
    `select ${ARTIFACT_COLUMNS} from artifacts where id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toRecord(row) : null;
}

export async function listArtifacts(
  pool: Pool,
  missionId: string,
): Promise<ArtifactRecord[]> {
  const { rows } = await pool.query<ArtifactRow>(
    `select ${ARTIFACT_COLUMNS}
       from artifacts
      where mission_id = $1
      order by created_at`,
    [missionId],
  );
  return rows.map(toRecord);
}
