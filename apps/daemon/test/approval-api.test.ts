import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  getWorkerEvents,
  listApprovals,
  listArtifacts,
  runMigrations,
} from '@legion/db';
import { type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import { ORIGIN, RP_ID } from '../src/approval.js';
import { SoftKey } from './softkey.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let app: Hono;
let scratch: string;
let buildsRoot: string;
let artifactsRoot: string;

const PLAN: Plan = {
  summary: 'Add a note file.',
  steps: [{ n: 1, title: 'note', detail: 'add note', filesLikelyTouched: ['legion-note.txt'] }],
  risks: [],
  openQuestions: [],
  estimatedComplexity: 'trivial',
};

async function api(p: string, init?: RequestInit): Promise<Response> {
  return app.request(p, init);
}
async function jpost(p: string, body?: unknown): Promise<Response> {
  return api(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** Build a fresh fixture repo on disk; returns its path. */
async function makeFixtureRepo(name: string): Promise<string> {
  const repo = path.join(scratch, name);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# fixture\n');
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
  await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);
  return repo;
}

/**
 * Drive a mission all the way to AWAITING_MERGE_APPROVAL by writing a real
 * diff + SARIF artifact on disk and folding the events directly (the M2–M4
 * agent paths are exercised in their own suites; here we isolate the M5 gate).
 * The artifacts are REAL files with REAL sha256, and a REAL legion branch with
 * a commit exists in the attempt workspace so the merge has something to fetch.
 */
async function missionAtGate(repoPath: string): Promise<{
  missionId: string;
  diffSha: string;
  sarifSha: string;
  diffPath: string;
  attemptRepo: string;
}> {
  const res = await jpost('/api/missions', {
    title: 'Add note via Legion',
    objective: 'add a note file',
    repoPath,
    riskLevel: 'low',
  });
  const missionId = (await res.json()).mission.missionId as string;

  // a real attempt workspace with a legion branch holding one commit
  const attemptRepo = path.join(buildsRoot, missionId, 'attempt-1', 'repo');
  await mkdir(path.join(buildsRoot, missionId, 'attempt-1', '.tmp'), { recursive: true });
  await exec('git', ['clone', '-q', `file://${path.resolve(repoPath)}`, attemptRepo]);
  await exec('git', ['-C', attemptRepo, 'remote', 'remove', 'origin']);
  const baseSha = (await exec('git', ['-C', attemptRepo, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(buildsRoot, missionId, 'attempt-1', 'base.sha'), `${baseSha}\n`);
  const branch = `legion/${missionId.slice(0, 8)}`;
  await exec('git', ['-C', attemptRepo, 'checkout', '-q', '-b', branch]);
  await writeFile(path.join(attemptRepo, 'legion-note.txt'), 'legion change\n');
  await exec('git', ['-C', attemptRepo, '-c', 'user.name=Legion Coder', '-c', 'user.email=coder@legion.local', 'add', '-A']);
  await exec('git', ['-C', attemptRepo, '-c', 'user.name=Legion Coder', '-c', 'user.email=coder@legion.local', 'commit', '-q', '-m', 'step 1: note']);

  // real artifacts on disk
  const adir = path.join(artifactsRoot, missionId);
  await mkdir(adir, { recursive: true });
  const diff = (await exec('git', ['-C', attemptRepo, 'diff', `${baseSha}..HEAD`])).stdout;
  const { insertArtifact } = await import('@legion/db');
  const diffId = crypto.randomUUID();
  const diffPath = path.join(adir, `${diffId}.diff`);
  await writeFile(diffPath, diff);
  const diffSha = createHash('sha256').update(diff).digest('hex');
  await insertArtifact(pool, { id: diffId, missionId, type: 'diff', path: diffPath, sha256: diffSha, stats: { files: 1, insertions: 1, deletions: 0, commits: 1 } });

  const sarif = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'gitleaks' } }, results: [] }, { tool: { driver: { name: 'Semgrep OSS' } }, results: [] }] }, null, 2);
  const sarifId = crypto.randomUUID();
  const sarifPath = path.join(adir, `${sarifId}.sarif`);
  await writeFile(sarifPath, sarif);
  const sarifSha = createHash('sha256').update(sarif).digest('hex');
  await insertArtifact(pool, { id: sarifId, missionId, type: 'sarif', path: sarifPath, sha256: sarifSha, stats: { errors: 0, warnings: 0, notes: 0 } });

  // fold the lifecycle up to the gate
  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: PLAN } },
    { type: 'PLAN_APPROVED' },
    { type: 'BUILD_STARTED' },
    { type: 'BUILD_COMPLETED', payload: { artifactId: diffId, sha256: diffSha } },
    { type: 'SCAN_STARTED' },
    { type: 'SCAN_PASSED', payload: { sarifArtifactId: sarifId, counts: { errors: 0, warnings: 0, notes: 0 } } },
  ]) {
    const r = await jpost(`/api/missions/${missionId}/events`, body);
    expect(r.status).toBe(201);
  }
  return { missionId, diffSha, sarifSha, diffPath, attemptRepo };
}

async function state(missionId: string): Promise<string> {
  return (await (await api(`/api/missions/${missionId}`)).json()).mission.state;
}

let approver: SoftKey;

/** Register the single approver via real attestation. Returns the softkey. */
async function registerApprover(): Promise<SoftKey> {
  const opts = await (await jpost('/api/auth/approver/register-options')).json();
  const key = new SoftKey();
  const attestation = key.createRegistration({
    challenge: opts.options.challenge,
    rpId: RP_ID,
    origin: ORIGIN,
  });
  const reg = await jpost('/api/auth/approver/register', { response: attestation });
  expect(reg.status).toBe(201);
  return key;
}

async function getOptions(missionId: string): Promise<string> {
  const res = await jpost(`/api/missions/${missionId}/approval/options`);
  expect(res.status).toBe(200);
  return (await res.json()).options.challenge as string;
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'approval-'));
  buildsRoot = path.join(scratch, 'builds');
  artifactsRoot = path.join(scratch, 'artifacts');
  orchestrator = new Orchestrator({ pool, supervisor, buildsRoot, artifactsRoot, workdirRoot: path.join(scratch, 'workdirs') });
  app = createApp(pool, supervisor, orchestrator);
}, 60_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T39: approver registration', () => {
  it('GET /status reports false before and true after; nothing sensitive leaks', async () => {
    // before any registration
    const before = await api('/api/auth/approver/status');
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody).toEqual({ registered: false }); // boolean only, no extra keys

    approver = await registerApprover();

    const after = await api('/api/auth/approver/status');
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ registered: true });
  });

  it('options → softkey attestation → stored; second registration → 409', async () => {
    // approver was registered in the status test above
    expect((await (await api('/api/auth/approver')).json()).registered).toBe(true);

    // a second registration attempt is refused
    const opts2 = await jpost('/api/auth/approver/register-options');
    expect(opts2.status).toBe(409);
    expect((await opts2.json()).error).toBe('APPROVER_EXISTS');
  });
});

describe('T40: happy path — the demo (headless)', () => {
  it('clean-scanned mission → ceremony → real merge → MERGED', async () => {
    const repo = await makeFixtureRepo('t40-repo');
    const { missionId, diffSha, sarifSha, attemptRepo } = await missionAtGate(repo);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');

    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.approvalId).toBeTruthy();
    expect(body.mergeCommit).toBeTruthy();

    // a real --no-ff merge commit exists on the fixture repo's branch
    const log = await exec('git', ['-C', repo, 'log', '--oneline', '--merges']);
    expect(log.stdout).toContain(body.mergeCommit.slice(0, 7));
    const msg = (await exec('git', ['-C', repo, 'log', '-1', '--format=%s', body.mergeCommit])).stdout;
    expect(msg).toContain(`approval ${body.approvalId}`);
    expect(msg).toContain(`M-${missionId.slice(0, 8)}`);
    // the change actually landed
    expect((await exec('git', ['-C', repo, 'cat-file', '-e', `${body.mergeCommit}:legion-note.txt`])).stdout).toBe('');

    // MERGE_APPROVED carries approvalId + both hashes; state MERGED
    const events = await getMissionEvents(pool, missionId);
    const merged = events.find((e) => e.type === 'MERGE_APPROVED');
    expect(merged!.payload.approvalId).toBe(body.approvalId);
    expect((merged!.payload.artifactSha256s as { diff: string }).diff).toBe(diffSha);
    expect((merged!.payload.artifactSha256s as { sarif: string }).sarif).toBe(sarifSha);
    expect(merged!.payload.mergeCommit).toBe(body.mergeCommit);
    expect(await state(missionId)).toBe('MERGED');

    // approvals row carries the full ceremony
    const approvals = await listApprovals(pool, missionId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.decision).toBe('approve');
    expect(approvals[0]!.clientDataJson.length).toBeGreaterThan(0);
    expect(approvals[0]!.authenticatorData.length).toBeGreaterThan(0);
    expect(approvals[0]!.signature.length).toBeGreaterThan(0);
    expect(attemptRepo).toBeTruthy();
  });
});

describe('T41: binding — tamper between options and click → INTEGRITY', () => {
  it('tampering the diff artifact after options voids the ceremony, no merge', async () => {
    const repo = await makeFixtureRepo('t41-repo');
    const { missionId, diffPath } = await missionAtGate(repo);
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

    const challenge = await getOptions(missionId);
    // tamper the diff on disk AFTER the challenge was issued
    await appendFile(diffPath, '\n# tampered\n');

    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('INTEGRITY');

    // no merge, repo untouched, mission still at the gate
    expect((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
    expect(await listApprovals(pool, missionId)).toHaveLength(0);

    // the challenge is voided — replaying it now also 409s
    const replay = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(replay.status).toBe(409);
  });
});

describe('T42: replay + expiry', () => {
  it('the same assertion cannot be used twice; exactly one merge commit', async () => {
    const repo = await makeFixtureRepo('t42-repo');
    const { missionId } = await missionAtGate(repo);
    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });

    const first = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(first.status).toBe(200);
    const second = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(second.status).toBe(409);

    const merges = await exec('git', ['-C', repo, 'log', '--oneline', '--merges']);
    expect(merges.stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('an expired challenge is rejected', async () => {
    const repo = await makeFixtureRepo('t42b-repo');
    const { missionId } = await missionAtGate(repo);
    const challenge = await getOptions(missionId);
    // force the challenge past its TTL
    await pool.query(
      `update approval_challenges set expires_at = now() - interval '1 minute' where challenge = $1`,
      [challenge],
    );
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(409);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  });
});

describe('T43: wrong key → 401', () => {
  it('an assertion from a different softkey fails, no approval, no merge', async () => {
    const repo = await makeFixtureRepo('t43-repo');
    const { missionId } = await missionAtGate(repo);
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

    const challenge = await getOptions(missionId);
    const attacker = new SoftKey(); // never registered
    const assertion = attacker.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(401);

    expect(await listApprovals(pool, missionId)).toHaveLength(0);
    expect((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  });
});

describe('T44: signed rejection routes back to BUILDING', () => {
  it('reject with reason → approvals(reject), MERGE_REJECTED → BUILDING; next build prompt carries the reason', async () => {
    const repo = await makeFixtureRepo('t44-repo');
    const { missionId } = await missionAtGate(repo);
    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });

    const reason = 'REJECT-MARKER-9931: the note belongs in docs/, not the root.';
    const res = await jpost(`/api/missions/${missionId}/reject`, { response: assertion, reason });
    expect(res.status).toBe(200);
    expect((await res.json()).mission.state).toBe('BUILDING');

    const approvals = await listApprovals(pool, missionId);
    expect(approvals.some((a) => a.decision === 'reject' && a.reason === reason)).toBe(true);

    // the rejection is part of the cryptographic record
    const rej = approvals.find((a) => a.decision === 'reject')!;
    expect(rej.signature.length).toBeGreaterThan(0);

    // next build's coder WORKER_TASK carries the rejection reason
    const build = await jpost(`/api/missions/${missionId}/build`);
    expect(build.status).toBe(202);
    const { coderWorkerId } = await build.json();
    const events = await getWorkerEvents(pool, coderWorkerId);
    const task = events.find((e) => e.type === 'WORKER_TASK');
    expect(String(task!.payload.prompt)).toContain(reason);

    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    await supervisor.waitForExit(coderWorkerId, 30_000);
  }, 120_000);
});

describe('T45: dirty tree blocks the merge', () => {
  it('ceremony verifies but merge refuses; clean and retry merges', async () => {
    const repo = await makeFixtureRepo('t45-repo');
    const { missionId } = await missionAtGate(repo);

    // uncommitted change in the user repo
    await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 999;\n');

    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('MERGE_BLOCKED_DIRTY');

    // approval row kept, mission stays at the gate
    expect((await listApprovals(pool, missionId)).length).toBeGreaterThanOrEqual(1);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');

    // clean the tree, retry with a fresh challenge → merges
    await exec('git', ['-C', repo, 'checkout', '--', 'src/a.ts']);
    const challenge2 = await getOptions(missionId);
    const assertion2 = approver.createAssertion({ challenge: challenge2, rpId: RP_ID, origin: ORIGIN });
    const res2 = await jpost(`/api/missions/${missionId}/approve`, { response: assertion2 });
    expect(res2.status).toBe(200);
    expect((await res2.json()).merged).toBe(true);
    expect(await state(missionId)).toBe('MERGED');
  });
});

describe('T46: conflicting target branch aborts the merge cleanly', () => {
  it('merge aborts, repo byte-identical, MERGE_CONFLICT recorded, mission stays at gate', async () => {
    const repo = await makeFixtureRepo('t46-repo');
    const { missionId } = await missionAtGate(repo);

    // commit a conflicting change to the same file the legion branch touches
    await writeFile(path.join(repo, 'legion-note.txt'), 'conflicting content\n');
    await exec('git', ['-C', repo, '-c', 'user.name=u', '-c', 'user.email=u@u', 'add', '-A']);
    await exec('git', ['-C', repo, '-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-q', '-m', 'conflict']);
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const beforeStatus = (await exec('git', ['-C', repo, 'status', '--porcelain'])).stdout;

    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('MERGE_CONFLICT');

    // repo byte-identical to pre-merge-attempt; mission stays at the gate
    expect((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
    expect((await exec('git', ['-C', repo, 'status', '--porcelain'])).stdout).toBe(beforeStatus);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');

    // MERGE_CONFLICT recorded worker_events-style (not a mission event)
    const missionEvents = await getMissionEvents(pool, missionId);
    expect(missionEvents.some((e) => e.type === 'MERGE_APPROVED')).toBe(false);
    const { rows } = await pool.query(
      `select 1 from worker_events where mission_id = $1 and type = 'MERGE_CONFLICT'`,
      [missionId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('T47: crash reconciliation (pin 5d)', () => {
  it('a merge commit with no MERGE_APPROVED event → reconciled exactly once → MERGED', async () => {
    const repo = await makeFixtureRepo('t47-repo');
    const { missionId } = await missionAtGate(repo);

    // record a verified approval, then perform the merge OUT OF BAND (as if the
    // daemon merged then crashed before emitting MERGE_APPROVED)
    const challenge = await getOptions(missionId);
    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    // verify the ceremony directly to get a real approval row without merging
    const { verifyCeremony } = await import('../src/approval.js');
    const ceremony = await verifyCeremony(pool, missionId, 'approve', assertion, null);
    expect(ceremony.ok).toBe(true);
    const approvalId = ceremony.ok ? ceremony.approval.id : '';

    // perform the real merge by hand, message naming the approval (pin 5b)
    const attemptRepo = path.join(buildsRoot, missionId, 'attempt-1', 'repo');
    const branch = `legion/${missionId.slice(0, 8)}`;
    await exec('git', ['-C', repo, 'fetch', attemptRepo, branch]);
    await exec('git', [
      '-C', repo, '-c', 'user.name=Legion', '-c', 'user.email=legion@legion.local',
      'merge', '--no-ff', 'FETCH_HEAD', '-m',
      `legion: x (M-${missionId.slice(0, 8)}, approval ${approvalId})`,
    ]);
    // event intentionally NOT emitted — mission still at the gate
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');

    // fresh supervisor+orchestrator against the same DB = daemon reboot
    const reborn = new Orchestrator({ pool, supervisor, buildsRoot, artifactsRoot, workdirRoot: path.join(scratch, 'workdirs') });
    const reconciled = await reborn.reconcileMerges();
    expect(reconciled).toContain(missionId);
    expect(await state(missionId)).toBe('MERGED');

    // idempotent: a second reconcile emits nothing further
    const again = await reborn.reconcileMerges();
    expect(again).not.toContain(missionId);
    const merges = await getMissionEvents(pool, missionId);
    expect(merges.filter((e) => e.type === 'MERGE_APPROVED')).toHaveLength(1);
  });
});
