import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { IllegalTransitionError } from '@legion/core';
import {
  appendEvent,
  appendWorkerEvent,
  getMission,
  getMissionEvents,
  listApprovals,
  listArtifacts,
} from '@legion/db';
import type { Pool } from 'pg';

const exec = promisify(execFile);

export type MergeOutcome =
  | { kind: 'MERGED'; mergeCommit: string; approvalId: string }
  | { kind: 'BLOCKED_DIRTY' }
  | { kind: 'CONFLICT' }
  | { kind: 'NO_WORKSPACE' };

async function git(cwd: string, ...args: string[]) {
  return exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await git(cwd, ...args);
    return { ok: true, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const f = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
}

async function latestAttemptRepo(
  buildsRoot: string,
  missionId: string,
): Promise<string | null> {
  const dir = path.join(buildsRoot, missionId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const attempts = entries
    .filter((d) => d.startsWith('attempt-'))
    .map((d) => Number(d.slice('attempt-'.length)))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (attempts[0] === undefined) return null;
  return path.join(dir, `attempt-${attempts[0]}`, 'repo');
}

async function repoSnapshot(repoDir: string): Promise<string> {
  const head = (await git(repoDir, 'rev-parse', 'HEAD')).stdout.trim();
  const status = (await git(repoDir, 'status', '--porcelain')).stdout;
  const refs = (await git(repoDir, 'for-each-ref')).stdout;
  return `${head}\n---\n${status}\n---\n${refs}`;
}

async function artifactHashes(
  pool: Pool,
  missionId: string,
): Promise<{ diff: string | null; sarif: string | null }> {
  const artifacts = await listArtifacts(pool, missionId);
  const latestOf = (type: string) =>
    [...artifacts].reverse().find((a) => a.type === type)?.sha256 ?? null;
  return { diff: latestOf('diff'), sarif: latestOf('sarif') };
}

/**
 * Execute the merge after a verified approval (pin 5). The user's repository
 * is only ever touched here, and only after the approval row exists.
 */
export async function executeMerge(
  pool: Pool,
  opts: { missionId: string; approvalId: string; buildsRoot: string },
): Promise<MergeOutcome> {
  const { missionId, approvalId, buildsRoot } = opts;
  const result = await getMission(pool, missionId);
  if (!result) return { kind: 'NO_WORKSPACE' };
  const mission = result.mission;
  const userRepo = path.resolve(mission.repoPath);

  const attemptRepo = await latestAttemptRepo(buildsRoot, missionId);
  if (!attemptRepo) return { kind: 'NO_WORKSPACE' };
  const branch = `legion/${missionId.slice(0, 8)}`;

  const recordWorkerEvent = (type: 'MERGE_CONFLICT' | 'MERGE_BLOCKED_DIRTY', payload: Record<string, unknown>) =>
    appendWorkerEvent(pool, {
      missionId,
      workerId: randomUUID(), // worker_events-style record, not a mission event
      type,
      payload: { approvalId, ...payload },
    });

  // (a) preconditions: user repo working tree must be clean
  const dirty = (await git(userRepo, 'status', '--porcelain')).stdout.trim();
  if (dirty.length > 0) {
    await recordWorkerEvent('MERGE_BLOCKED_DIRTY', { dirty });
    return { kind: 'BLOCKED_DIRTY' };
  }

  const before = await repoSnapshot(userRepo);

  // (b) fetch the legion branch from the attempt workspace, merge --no-ff
  const fetched = await tryGit(userRepo, 'fetch', attemptRepo, branch);
  if (!fetched.ok) {
    await recordWorkerEvent('MERGE_CONFLICT', { stage: 'fetch', stderr: fetched.stderr.slice(-2000) });
    return { kind: 'CONFLICT' };
  }

  const message = `legion: ${mission.title} (M-${missionId.slice(0, 8)}, approval ${approvalId})`;
  const merged = await tryGit(
    userRepo,
    '-c', 'user.name=Legion',
    '-c', 'user.email=legion@legion.local',
    'merge', '--no-ff', 'FETCH_HEAD', '-m', message,
  );

  if (!merged.ok) {
    // (c) conflict → abort cleanly, verify byte-identical, record, stay
    await tryGit(userRepo, 'merge', '--abort');
    const after = await repoSnapshot(userRepo);
    await recordWorkerEvent('MERGE_CONFLICT', {
      stderr: merged.stderr.slice(-2000),
      restored: after === before,
    });
    return { kind: 'CONFLICT' };
  }

  const mergeCommit = (await git(userRepo, 'rev-parse', 'HEAD')).stdout.trim();

  // (d) emit MERGE_APPROVED ONLY after the merge commit exists
  const hashes = await artifactHashes(pool, missionId);
  await emitMergeApproved(pool, missionId, {
    approvalId,
    artifactSha256s: hashes,
    mergeCommit,
  });

  return { kind: 'MERGED', mergeCommit, approvalId };
}

async function emitMergeApproved(
  pool: Pool,
  missionId: string,
  payload: {
    approvalId: string;
    artifactSha256s: { diff: string | null; sarif: string | null };
    mergeCommit: string;
  },
): Promise<boolean> {
  try {
    await appendEvent(pool, missionId, 'MERGE_APPROVED', payload);
    return true;
  } catch (e) {
    // already MERGED (idempotent reconciliation) — swallow the illegal transition
    if (e instanceof IllegalTransitionError) return false;
    throw e;
  }
}

/**
 * Crash reconciliation (pin 5d): a merge commit may exist in the user repo
 * while the daemon died before emitting MERGE_APPROVED. On boot, for every
 * mission still at AWAITING_MERGE_APPROVAL whose approved merge commit is
 * present (its message names the approval id), emit MERGE_APPROVED exactly
 * once. Idempotent.
 */
export async function reconcileMerges(
  pool: Pool,
  opts: { buildsRoot: string },
): Promise<string[]> {
  const { rows } = await pool.query<{ mission_id: string }>(
    `select distinct mission_id from approvals where decision = 'approve'`,
  );
  const reconciled: string[] = [];

  for (const { mission_id: missionId } of rows) {
    const result = await getMission(pool, missionId);
    if (!result || result.mission.state !== 'AWAITING_MERGE_APPROVAL') continue;

    const userRepo = path.resolve(result.mission.repoPath);
    const approvals = (await listApprovals(pool, missionId)).filter(
      (a) => a.decision === 'approve',
    );

    for (const approval of approvals) {
      // is there a merge commit in the user repo naming this approval?
      const found = await tryGit(
        userRepo,
        'log',
        '--all',
        '--grep',
        `approval ${approval.id}`,
        '--format=%H',
      );
      const mergeCommit = found.stdout.trim().split('\n').filter(Boolean)[0];
      if (!mergeCommit) continue;

      // double-check the mission hasn't been MERGED in the meantime
      const events = await getMissionEvents(pool, missionId);
      if (events.some((e) => e.type === 'MERGE_APPROVED')) break;

      const hashes = await artifactHashes(pool, missionId);
      const emitted = await emitMergeApproved(pool, missionId, {
        approvalId: approval.id,
        artifactSha256s: hashes,
        mergeCommit,
      });
      if (emitted) reconciled.push(missionId);
      break;
    }
  }
  return reconciled;
}
