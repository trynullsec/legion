import type { Pool } from 'pg';

export interface ApproverRecord {
  id: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  label: string;
  createdAt: string;
}

export interface ApprovalChallengeRecord {
  id: string;
  missionId: string;
  artifactSha256: string;
  challenge: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  missionId: string;
  decision: 'approve' | 'reject';
  artifactSha256: string;
  credentialId: string;
  clientDataJson: string;
  authenticatorData: string;
  signature: string;
  reason: string | null;
  createdAt: string;
}

const TS = (col: string) =>
  `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ---------- approvers ----------

export async function countApprovers(pool: Pool): Promise<number> {
  const { rows } = await pool.query('select count(*)::int as n from approvers');
  return rows[0].n as number;
}

export async function insertApprover(
  pool: Pool,
  input: { credentialId: string; publicKey: Uint8Array; counter: number; label: string },
): Promise<ApproverRecord> {
  const { rows } = await pool.query(
    `insert into approvers (credential_id, public_key, counter, label)
     values ($1, $2, $3, $4)
     returning id, credential_id, public_key, counter, label, ${TS('created_at')} as created_at`,
    [input.credentialId, Buffer.from(input.publicKey), input.counter, input.label],
  );
  return toApprover(rows[0]);
}

export async function getApproverByCredentialId(
  pool: Pool,
  credentialId: string,
): Promise<ApproverRecord | null> {
  const { rows } = await pool.query(
    `select id, credential_id, public_key, counter, label, ${TS('created_at')} as created_at
       from approvers where credential_id = $1`,
    [credentialId],
  );
  return rows[0] ? toApprover(rows[0]) : null;
}

export async function updateApproverCounter(
  pool: Pool,
  credentialId: string,
  counter: number,
): Promise<void> {
  await pool.query('update approvers set counter = $2 where credential_id = $1', [
    credentialId,
    counter,
  ]);
}

function toApprover(row: {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  label: string;
  created_at: string;
}): ApproverRecord {
  return {
    id: row.id,
    credentialId: row.credential_id,
    publicKey: new Uint8Array(row.public_key),
    counter: Number(row.counter),
    label: row.label,
    createdAt: row.created_at,
  };
}

// ---------- challenges ----------

export async function insertChallenge(
  pool: Pool,
  input: {
    missionId: string;
    artifactSha256: string;
    challenge: string;
    expiresAt: Date;
  },
): Promise<ApprovalChallengeRecord> {
  const { rows } = await pool.query(
    `insert into approval_challenges (mission_id, artifact_sha256, challenge, expires_at)
     values ($1, $2, $3, $4)
     returning id, mission_id, artifact_sha256, challenge,
       ${TS('expires_at')} as expires_at, ${TS('used_at')} as used_at, ${TS('created_at')} as created_at`,
    [input.missionId, input.artifactSha256, input.challenge, input.expiresAt.toISOString()],
  );
  return toChallenge(rows[0]);
}

export async function getChallenge(
  pool: Pool,
  challenge: string,
): Promise<ApprovalChallengeRecord | null> {
  const { rows } = await pool.query(
    `select id, mission_id, artifact_sha256, challenge,
       ${TS('expires_at')} as expires_at, ${TS('used_at')} as used_at, ${TS('created_at')} as created_at
       from approval_challenges where challenge = $1`,
    [challenge],
  );
  return rows[0] ? toChallenge(rows[0]) : null;
}

/**
 * Atomically claim a challenge: marks used_at only if it is unused and not
 * expired. Returns the claimed row, or null if already used / expired /
 * unknown. This is the single-use + TTL guard (T42), race-safe.
 */
export async function claimChallenge(
  pool: Pool,
  challenge: string,
): Promise<ApprovalChallengeRecord | null> {
  const { rows } = await pool.query(
    `update approval_challenges
        set used_at = now()
      where challenge = $1 and used_at is null and expires_at > now()
      returning id, mission_id, artifact_sha256, challenge,
        ${TS('expires_at')} as expires_at, ${TS('used_at')} as used_at, ${TS('created_at')} as created_at`,
    [challenge],
  );
  return rows[0] ? toChallenge(rows[0]) : null;
}

function toChallenge(row: {
  id: string;
  mission_id: string;
  artifact_sha256: string;
  challenge: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}): ApprovalChallengeRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    artifactSha256: row.artifact_sha256,
    challenge: row.challenge,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

// ---------- approvals (append-only crypto record) ----------

export async function insertApproval(
  pool: Pool,
  input: {
    missionId: string;
    decision: 'approve' | 'reject';
    artifactSha256: string;
    credentialId: string;
    clientDataJson: string;
    authenticatorData: string;
    signature: string;
    reason?: string | null;
  },
): Promise<ApprovalRecord> {
  const { rows } = await pool.query(
    `insert into approvals
       (mission_id, decision, artifact_sha256, credential_id,
        client_data_json, authenticator_data, signature, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, mission_id, decision, artifact_sha256, credential_id,
       client_data_json, authenticator_data, signature, reason, ${TS('created_at')} as created_at`,
    [
      input.missionId,
      input.decision,
      input.artifactSha256,
      input.credentialId,
      input.clientDataJson,
      input.authenticatorData,
      input.signature,
      input.reason ?? null,
    ],
  );
  return toApproval(rows[0]);
}

export async function getApproval(
  pool: Pool,
  id: string,
): Promise<ApprovalRecord | null> {
  const { rows } = await pool.query(
    `select id, mission_id, decision, artifact_sha256, credential_id,
       client_data_json, authenticator_data, signature, reason, ${TS('created_at')} as created_at
       from approvals where id = $1`,
    [id],
  );
  return rows[0] ? toApproval(rows[0]) : null;
}

export async function listApprovals(
  pool: Pool,
  missionId: string,
): Promise<ApprovalRecord[]> {
  const { rows } = await pool.query(
    `select id, mission_id, decision, artifact_sha256, credential_id,
       client_data_json, authenticator_data, signature, reason, ${TS('created_at')} as created_at
       from approvals where mission_id = $1 order by created_at`,
    [missionId],
  );
  return rows.map(toApproval);
}

function toApproval(row: {
  id: string;
  mission_id: string;
  decision: string;
  artifact_sha256: string;
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
  reason: string | null;
  created_at: string;
}): ApprovalRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    decision: row.decision as 'approve' | 'reject',
    artifactSha256: row.artifact_sha256,
    credentialId: row.credential_id,
    clientDataJson: row.client_data_json,
    authenticatorData: row.authenticator_data,
    signature: row.signature,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
