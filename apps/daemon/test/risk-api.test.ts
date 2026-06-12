/**
 * M6b acceptance tests — express lane / risk-proportional pipelines
 * (T55–T60). Real planners and builds where the flow requires them
 * (no-mock rule); deterministic worker tasks use the documented internal
 * overrides (T19 precedent).
 */
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  insertArtifact,
  listApprovals,
  runMigrations,
} from '@legion/db';
import { type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
import { DEFAULT_GITLEAKS_BIN, DEFAULT_SEMGREP_BIN } from '@legion/scanner';
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
let fixtureRepo: string;
let approver: SoftKey;

const TASK_PLAN: Plan = {
  summary: 'Write a short note file as the deliverable.',
  steps: [
    {
      n: 1,
      title: 'Write note',
      detail: 'Write the note into deliverables/note.md.',
      filesLikelyTouched: ['note.md'],
    },
  ],
  risks: [],
  openQuestions: [],
  estimatedComplexity: 'trivial',
};

/** Real planner instructed to write a fixed, valid plan.json (T19 precedent). */
const WRITE_VALID_PLAN =
  'Using the terminal, write a file named plan.json in your current working ' +
  'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
  `${JSON.stringify(TASK_PLAN)} ` +
  '— verify it parses with python3 -c "import json; json.load(open(\'plan.json\'))" and finish.';

const WRITE_MALFORMED_PLAN =
  'Using the terminal, write a file named plan.json in your current working ' +
  'directory containing EXACTLY this JSON (do not fix or extend it): ' +
  '{"summary": 42, "steps": []} — then finish.';

/** Warning-level-only tree: matches legion-rules' md5 rule (T36 fixture). */
const COMMIT_WARNING =
  'You are in a git repository on a feature branch. Run these exact shell commands, then finish: ' +
  'printf \'import hashlib\\nh = hashlib.md5(b"x")\\n\' > notes.py && ' +
  'git add notes.py && git commit -m "step 1: notes" --no-verify';

function forcedApprove(): string {
  return (
    'Using the terminal, write a file named review.json in your current working ' +
    'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
    '{"verdict": "approve", "comments": [], "summary": "Forced approval for deterministic testing."} ' +
    '— verify it parses with python3 -c "import json; json.load(open(\'review.json\'))" and finish.'
  );
}

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
async function state(missionId: string): Promise<string> {
  return (await (await api(`/api/missions/${missionId}`)).json()).mission.state;
}

async function createTaskMission(riskLevel: string): Promise<string> {
  const res = await jpost('/api/missions', {
    title: `${riskLevel}-risk task`,
    objective: 'Write a short note to note.md for risk-policy testing.',
    kind: 'task',
    riskLevel,
  });
  expect(res.status).toBe(201);
  return (await res.json()).mission.missionId as string;
}

async function createCodeMission(riskLevel: string): Promise<string> {
  const res = await jpost('/api/missions', {
    title: `${riskLevel}-risk code`,
    objective: 'Add a notes file for risk-policy testing.',
    repoPath: fixtureRepo,
    riskLevel,
  });
  expect(res.status).toBe(201);
  return (await res.json()).mission.missionId as string;
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function stopLiveWorkers(missionId: string): Promise<void> {
  const workers = (await (await api(`/api/missions/${missionId}/workers`)).json())
    .workers as { workerId: string; status: string }[];
  for (const w of workers) {
    if (w.status === 'STARTING' || w.status === 'RUNNING') {
      await supervisor.stopWorker(w.workerId, { graceful: false });
      await supervisor.waitForExit(w.workerId, 30_000).catch(() => {});
    }
  }
}

async function pollScanDone(missionId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = (await (await api(`/api/missions/${missionId}/scan`)).json()).scan;
    if (scan && scan.status !== 'RUNNING') return scan;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`scan for ${missionId} did not finish in time`);
}

/** Deterministic build loop (M4 precedent): real workers, retries on flakes. */
async function buildWith(missionId: string, coderTask: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: coderTask,
      reviewerTaskOverrides: [forcedApprove()],
    });
    const outcome = await settled;
    if (outcome.kind === 'COMPLETED') return;
    expect(await state(missionId)).toBe('BUILDING');
  }
  throw new Error(`build did not complete for ${missionId} after 4 attempts`);
}

/** Fold a code mission to the merge gate with real on-disk artifacts (M5 helper). */
async function missionAtGate(riskLevel: string): Promise<{
  missionId: string;
  diffPath: string;
  repo: string;
}> {
  // a private fixture repo per call so merges/tampering don't interfere
  const repo = path.join(scratch, `gate-repo-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# fixture\n');
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
  await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);

  const res = await jpost('/api/missions', {
    title: 'gate mission',
    objective: 'risk-policy gate invariance',
    repoPath: repo,
    riskLevel,
  });
  const missionId = (await res.json()).mission.missionId as string;

  const attemptRepo = path.join(buildsRoot, missionId, 'attempt-1', 'repo');
  await mkdir(path.join(buildsRoot, missionId, 'attempt-1', '.tmp'), { recursive: true });
  await exec('git', ['clone', '-q', `file://${path.resolve(repo)}`, attemptRepo]);
  await exec('git', ['-C', attemptRepo, 'remote', 'remove', 'origin']);
  const baseSha = (await exec('git', ['-C', attemptRepo, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(path.join(buildsRoot, missionId, 'attempt-1', 'base.sha'), `${baseSha}\n`);
  await exec('git', ['-C', attemptRepo, 'checkout', '-q', '-b', `legion/${missionId.slice(0, 8)}`]);
  await writeFile(path.join(attemptRepo, 'legion-note.txt'), 'legion change\n');
  await exec('git', ['-C', attemptRepo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'add', '-A']);
  await exec('git', ['-C', attemptRepo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'note']);

  const adir = path.join(artifactsRoot, missionId);
  await mkdir(adir, { recursive: true });
  const diff = (await exec('git', ['-C', attemptRepo, 'diff', `${baseSha}..HEAD`])).stdout;
  const diffId = crypto.randomUUID();
  const diffPath = path.join(adir, `${diffId}.diff`);
  await writeFile(diffPath, diff);
  await insertArtifact(pool, {
    id: diffId, missionId, type: 'diff', path: diffPath,
    sha256: createHash('sha256').update(diff).digest('hex'),
    stats: { files: 1, insertions: 1, deletions: 0, commits: 1 },
  });
  const sarif = JSON.stringify({ version: '2.1.0', runs: [] }, null, 2);
  const sarifId = crypto.randomUUID();
  const sarifPath = path.join(adir, `${sarifId}.sarif`);
  await writeFile(sarifPath, sarif);
  await insertArtifact(pool, {
    id: sarifId, missionId, type: 'sarif', path: sarifPath,
    sha256: createHash('sha256').update(sarif).digest('hex'),
    stats: { errors: 0, warnings: 0, notes: 0 },
  });

  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: TASK_PLAN } },
    { type: 'PLAN_APPROVED' },
    { type: 'BUILD_STARTED' },
    { type: 'BUILD_COMPLETED', payload: { artifactId: diffId } },
    { type: 'SCAN_STARTED' },
    { type: 'SCAN_PASSED', payload: { sarifArtifactId: sarifId, counts: { errors: 0, warnings: 0, notes: 0 } } },
  ]) {
    const r = await jpost(`/api/missions/${missionId}/events`, body);
    expect(r.status).toBe(201);
  }
  expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  return { missionId, diffPath, repo };
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — M6b tests run real workers.');
  }
  for (const bin of [DEFAULT_GITLEAKS_BIN, DEFAULT_SEMGREP_BIN]) {
    if (!existsSync(bin)) {
      throw new Error(`scanner missing at ${bin} — run scripts/setup-scanners.sh (never skip).`);
    }
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'risk-'));
  buildsRoot = path.join(scratch, 'builds');
  artifactsRoot = path.join(scratch, 'artifacts');
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot,
    artifactsRoot,
    deliveriesRoot: path.join(scratch, 'deliveries'),
  });
  app = createApp(pool, supervisor, orchestrator);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(path.join(fixtureRepo, 'src'), { recursive: true });
  await writeFile(path.join(fixtureRepo, 'README.md'), '# tiny fixture\n');
  await writeFile(path.join(fixtureRepo, 'src', 'a.ts'), 'export const a = 1;\n');
  await exec('git', ['init', '-q', fixtureRepo]);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);

  // register the single approver (real softkey attestation)
  const opts = await (await jpost('/api/auth/approver/register-options')).json();
  approver = new SoftKey();
  const attestation = approver.createRegistration({
    challenge: opts.options.challenge, rpId: RP_ID, origin: ORIGIN,
  });
  expect((await jpost('/api/auth/approver/register', { response: attestation })).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

// ====================================================================
// T55: low risk — plan auto-approval, build auto-start, ledger record
// ====================================================================

describe('T55: low-risk express lane', () => {
  it('PLAN_PROPOSED → auto PLAN_APPROVED {autoApproved, policy} → build auto-starts; gapless ledger', async () => {
    const missionId = await createTaskMission('low');

    const { settled } = await orchestrator.startPlanning(missionId, {
      taskOverride: WRITE_VALID_PLAN,
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('PROPOSED');

    // the policy fires without any human API call
    await pollUntil(async () => {
      const events = await getMissionEvents(pool, missionId);
      return events.some((e) => e.type === 'PLAN_APPROVED');
    }, 'auto plan approval');

    const events = await getMissionEvents(pool, missionId);
    const approved = events.find((e) => e.type === 'PLAN_APPROVED')!;
    expect(approved.payload.autoApproved).toBe(true);
    expect(approved.payload.policy).toBe('risk:low');
    // gapless seq, PLAN_PROPOSED immediately before PLAN_APPROVED
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const proposedSeq = events.find((e) => e.type === 'PLAN_PROPOSED')!.seq;
    expect(approved.seq).toBe(proposedSeq + 1);

    // the build attempt auto-started: BUILD_STARTED emitted, a worker spawned
    await pollUntil(async () => {
      const evs = await getMissionEvents(pool, missionId);
      return evs.some((e) => e.type === 'BUILD_STARTED');
    }, 'auto build start');
    expect(await state(missionId)).toBe('BUILDING');
    await pollUntil(async () => {
      const ws = (await (await api(`/api/missions/${missionId}/workers`)).json())
        .workers as { role: string }[];
      return ws.some((w) => w.role === 'worker');
    }, 'auto-spawned task worker');

    // don't burn model time: kill the auto-build worker; attempt fails honestly
    await stopLiveWorkers(missionId);
  }, 360_000);
});

// ====================================================================
// T56: medium risk — today's flow, unchanged
// ====================================================================

describe('T56: medium risk parks at the plan gate', () => {
  it('PLAN_PROPOSED → AWAITING_PLAN_APPROVAL; no auto events, no workers beyond the planner', async () => {
    const missionId = await createTaskMission('medium');

    const { settled } = await orchestrator.startPlanning(missionId, {
      taskOverride: WRITE_VALID_PLAN,
    });
    expect((await settled).kind).toBe('PROPOSED');

    expect(await state(missionId)).toBe('AWAITING_PLAN_APPROVAL');
    // give any (buggy) auto-policy a moment to fire, then assert it didn't
    await new Promise((r) => setTimeout(r, 2500));
    const events = await getMissionEvents(pool, missionId);
    expect(events.some((e) => e.type === 'PLAN_APPROVED')).toBe(false);
    expect(events.some((e) => e.type === 'BUILD_STARTED')).toBe(false);
    expect(await state(missionId)).toBe('AWAITING_PLAN_APPROVAL');
  }, 360_000);
});

// ====================================================================
// T57: high risk — warnings block the scan for THIS mission only
// ====================================================================

describe('T57: high risk forces the warning threshold', () => {
  it('warning-only tree: high → SCAN_FAILED → BUILDING; medium → PASSED; env untouched', async () => {
    expect(process.env.LEGION_SCAN_FAIL_LEVEL).toBeUndefined();

    // high-risk mission with a warning-level-only finding
    const high = await createCodeMission('high');
    for (const body of [
      { type: 'PLANNING_STARTED' },
      { type: 'PLAN_PROPOSED', payload: { plan: TASK_PLAN } },
      { type: 'PLAN_APPROVED' },
    ]) {
      await jpost(`/api/missions/${high}/events`, body);
    }
    await buildWith(high, COMMIT_WARNING);
    const highScan = await pollScanDone(high);
    expect(highScan.status).toBe('FAILED');
    expect(highScan.counts.warnings).toBeGreaterThanOrEqual(1);
    expect(highScan.counts.errors).toBe(0);
    expect(await state(high)).toBe('BUILDING');

    // the same tree on a medium mission passes at the default threshold
    const medium = await createCodeMission('medium');
    for (const body of [
      { type: 'PLANNING_STARTED' },
      { type: 'PLAN_PROPOSED', payload: { plan: TASK_PLAN } },
      { type: 'PLAN_APPROVED' },
    ]) {
      await jpost(`/api/missions/${medium}/events`, body);
    }
    await buildWith(medium, COMMIT_WARNING);
    const mediumScan = await pollScanDone(medium);
    expect(mediumScan.status).toBe('PASSED');
    expect(mediumScan.counts.warnings).toBeGreaterThanOrEqual(1);
    expect(await state(medium)).toBe('AWAITING_MERGE_APPROVAL');

    // the global env default was never touched
    expect(process.env.LEGION_SCAN_FAIL_LEVEL).toBeUndefined();
  }, 900_000);
});

// ====================================================================
// T58: invalid plan on low risk — no auto-approval fired
// ====================================================================

describe('T58: invalid plan on low risk', () => {
  it('PLAN_INVALID → stays PLANNING, no PLAN_APPROVED, retry behavior unchanged', async () => {
    const missionId = await createTaskMission('low');

    const { settled } = await orchestrator.startPlanning(missionId, {
      taskOverride: WRITE_MALFORMED_PLAN,
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('INVALID');

    expect(await state(missionId)).toBe('PLANNING');
    const events = await getMissionEvents(pool, missionId);
    expect(events.some((e) => e.type === 'PLAN_APPROVED')).toBe(false);
    expect(events.some((e) => e.type === 'BUILD_STARTED')).toBe(false);
  }, 600_000);
});

// ====================================================================
// T59: merge gate invariance on low risk
// ====================================================================

describe('T59: the merge gate never scales away', () => {
  it('low-risk mission: wrong key → 401; T41 tamper case → 409 INTEGRITY', async () => {
    const { missionId, diffPath, repo } = await missionAtGate('low');
    const before = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

    // wrong key
    const c1 = (await (await jpost(`/api/missions/${missionId}/approval/options`)).json())
      .options.challenge as string;
    const attacker = new SoftKey();
    const bad = attacker.createAssertion({ challenge: c1, rpId: RP_ID, origin: ORIGIN });
    expect((await jpost(`/api/missions/${missionId}/approve`, { response: bad })).status).toBe(401);
    expect(await listApprovals(pool, missionId)).toHaveLength(0);

    // T41 tamper case, unchanged on a low-risk mission
    const c2 = (await (await jpost(`/api/missions/${missionId}/approval/options`)).json())
      .options.challenge as string;
    await appendFile(diffPath, '\n# tampered\n');
    const good = approver.createAssertion({ challenge: c2, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: good });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('INTEGRITY');

    expect((await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  }, 120_000);
});

// ====================================================================
// T60: riskLevel immutability
// ====================================================================

describe('T60: riskLevel is immutable after creation', () => {
  it('any event payload carrying riskLevel → 400', async () => {
    const missionId = await createTaskMission('medium');

    for (const body of [
      { type: 'PLANNING_STARTED', payload: { riskLevel: 'high' } },
      { type: 'PLAN_PROPOSED', payload: { plan: TASK_PLAN, riskLevel: 'low' } },
      { type: 'MISSION_CANCELLED', payload: { riskLevel: 'low' } },
    ]) {
      const res = await jpost(`/api/missions/${missionId}/events`, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('VALIDATION');
    }

    // the mission is untouched and still operable
    const events = await getMissionEvents(pool, missionId);
    expect(events).toHaveLength(1);
    expect(
      (await jpost(`/api/missions/${missionId}/events`, { type: 'PLANNING_STARTED' })).status,
    ).toBe(201);
  });
});
