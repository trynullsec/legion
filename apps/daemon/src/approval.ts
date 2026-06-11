import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  claimChallenge,
  countApprovers,
  getApproverByCredentialId,
  insertApproval,
  insertApprover,
  insertChallenge,
  listArtifacts,
  updateApproverCounter,
  type ApprovalRecord,
} from '@legion/db';
import type { Pool } from 'pg';

export const RP_ID = 'localhost';
export const RP_NAME = 'Agent Legion';
export const ORIGIN = 'http://localhost:4242';
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface BoundHashes {
  diff: string;
  sarif: string;
  combined: string;
}

/**
 * Recompute the diff + SARIF artifact hashes FROM DISK and confirm they still
 * match the values stored at creation. Any mismatch (or missing file) means
 * the bytes changed between review and approval → INTEGRITY. This is the
 * binding rule's enforcement point; it runs at both challenge issue and
 * verification.
 */
export async function recomputeBoundHashes(
  pool: Pool,
  missionId: string,
): Promise<BoundHashes> {
  const artifacts = await listArtifacts(pool, missionId);
  const diff = [...artifacts].reverse().find((a) => a.type === 'diff');
  const sarif = [...artifacts].reverse().find((a) => a.type === 'sarif');
  if (!diff || !sarif) {
    throw new IntegrityError('mission is missing a diff and/or SARIF artifact');
  }
  for (const a of [diff, sarif]) {
    let content: Buffer;
    try {
      content = await readFile(a.path);
    } catch {
      throw new IntegrityError(`${a.type} artifact file is missing from disk`);
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== a.sha256) {
      throw new IntegrityError(`${a.type} artifact has been tampered with`);
    }
  }
  return {
    diff: diff.sha256,
    sarif: sarif.sha256,
    combined: `diff:${diff.sha256};sarif:${sarif.sha256}`,
  };
}

/**
 * Challenge = base64url(sha256(missionId | diffSha | sarifSha | serverNonce)).
 * Passed to @simplewebauthn as a string, which it uses verbatim as
 * options.challenge — so the challenge is provably bound to these bytes.
 */
function deriveChallenge(missionId: string, hashes: BoundHashes, nonce: string): string {
  return createHash('sha256')
    .update(`${missionId}|${hashes.diff}|${hashes.sarif}|${nonce}`)
    .digest('base64url');
}

/** Issue an approval challenge bound to the current on-disk artifacts (pin 3). */
export async function buildApprovalOptions(pool: Pool, missionId: string) {
  const hashes = await recomputeBoundHashes(pool, missionId); // throws → INTEGRITY
  const nonce = randomBytes(16).toString('hex');
  const challenge = deriveChallenge(missionId, hashes, nonce);

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    challenge,
    userVerification: 'preferred',
  });

  await insertChallenge(pool, {
    missionId,
    artifactSha256: hashes.combined,
    challenge: options.challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return { options, boundHashes: hashes };
}

export type CeremonyResult =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; status: 401 | 409; error: string };

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientData(response: { response?: { clientDataJSON?: string } }): ClientData | null {
  const b64 = response.response?.clientDataJSON;
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as ClientData;
  } catch {
    return null;
  }
}

/**
 * Verify a signed approve/reject ceremony and, on success, append the
 * cryptographic approval record. Ordering: claim the challenge (single-use,
 * voids it), re-check artifact integrity, then verify the signature.
 */
export async function verifyCeremony(
  pool: Pool,
  missionId: string,
  decision: 'approve' | 'reject',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  reason: string | null,
): Promise<CeremonyResult> {
  const clientData = parseClientData(response);
  if (!clientData) {
    return { ok: false, status: 409, error: 'MALFORMED_CEREMONY' };
  }

  // single-use + TTL guard (atomic): voids the challenge even if later steps fail
  const claimed = await claimChallenge(pool, clientData.challenge);
  if (!claimed || claimed.missionId !== missionId) {
    return { ok: false, status: 409, error: 'CHALLENGE_INVALID' };
  }

  // re-check integrity against the value bound into the challenge
  let hashes: BoundHashes;
  try {
    hashes = await recomputeBoundHashes(pool, missionId);
  } catch {
    return { ok: false, status: 409, error: 'INTEGRITY' };
  }
  if (hashes.combined !== claimed.artifactSha256) {
    return { ok: false, status: 409, error: 'INTEGRITY' };
  }

  const credentialId = response.id as string;
  const approver = await getApproverByCredentialId(pool, credentialId);
  if (!approver) {
    return { ok: false, status: 401, error: 'UNKNOWN_CREDENTIAL' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claimed.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: approver.credentialId,
        publicKey: approver.publicKey as Uint8Array<ArrayBuffer>,
        counter: approver.counter,
      },
    });
  } catch {
    return { ok: false, status: 401, error: 'BAD_SIGNATURE' };
  }
  if (!verification.verified) {
    return { ok: false, status: 401, error: 'BAD_SIGNATURE' };
  }

  await updateApproverCounter(
    pool,
    credentialId,
    verification.authenticationInfo.newCounter,
  );

  const approval = await insertApproval(pool, {
    missionId,
    decision,
    artifactSha256: hashes.combined,
    credentialId,
    clientDataJson: response.response.clientDataJSON,
    authenticatorData: response.response.authenticatorData,
    signature: response.response.signature,
    reason,
  });

  return { ok: true, approval };
}

// ---------- registration (standard @simplewebauthn pair) ----------

export async function buildRegistrationOptions(pool: Pool) {
  if ((await countApprovers(pool)) > 0) {
    return { exists: true as const };
  }
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new Uint8Array(randomBytes(16)) as Uint8Array<ArrayBuffer>,
    userName: 'legion-approver',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  return { exists: false as const, options };
}

export type RegistrationResult =
  | { ok: true }
  | { ok: false; status: 401 | 409; error: string };

export async function verifyRegistration(
  pool: Pool,
  challenge: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  label: string,
): Promise<RegistrationResult> {
  if ((await countApprovers(pool)) > 0) {
    return { ok: false, status: 409, error: 'APPROVER_EXISTS' };
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch {
    return { ok: false, status: 401, error: 'BAD_ATTESTATION' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, status: 401, error: 'BAD_ATTESTATION' };
  }
  const cred = verification.registrationInfo.credential;
  await insertApprover(pool, {
    credentialId: cred.id,
    publicKey: cred.publicKey,
    counter: cred.counter,
    label,
  });
  return { ok: true };
}
