/**
 * M6a acceptance tests — task missions (T48–T54).
 *
 * NO-MOCK RULE: every worker below is a real Hermes agent against the real
 * model. Deterministic cases use documented internal task overrides (T19
 * precedent) — the runtime, collection, scanning, gate, and delivery paths
 * are always the real ones.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  getWorkerEvents,
  listArtifacts,
  runMigrations,
} from '@legion/db';
import { type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
import { DEFAULT_GITLEAKS_BIN } from '@legion/scanner';
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
let approver: SoftKey;

const TASK_PLAN: Plan = {
  summary: 'Write a short summary file as the deliverable.',
  steps: [
    {
      n: 1,
      title: 'Write summary',
      detail: 'Write the requested summary into deliverables/summary.md.',
      // for task missions this field carries expected deliverable filenames (pin 2)
      filesLikelyTouched: ['summary.md'],
    },
  ],
  risks: [],
  openQuestions: [],
  estimatedComplexity: 'trivial',
};

// ---------- deterministic real-worker tasks (documented overrides) ----------

const WRITE_SUMMARY =
  'Using the terminal, run exactly: mkdir -p deliverables && ' +
  'printf \'# Event Sourcing\\n\\nEvent sourcing stores every change as an immutable event. ' +
  'State is derived by folding the log, which gives a complete audit history.\\n\' > deliverables/summary.md ' +
  '— verify with: cat deliverables/summary.md — then finish.';

// a real high-entropy AWS-style key planted in the deliverable (T19/T34 precedent)
const WRITE_DIRTY_SUMMARY =
  'Using the terminal, run exactly: mkdir -p deliverables && ' +
  'printf \'# Config notes\\n\\nUse AWS_ACCESS_KEY_ID=AKIAQ3EGV7DKVPNZX2MJ for the integration.\\n\' > deliverables/summary.md ' +
  '— verify with: cat deliverables/summary.md — then finish.';

const WRITE_NOTHING =
  'Do not create any files. Run exactly: echo "no deliverable produced" — then finish immediately.';

const WRITE_TWO_FILES =
  'Using the terminal, run exactly: mkdir -p deliverables && ' +
  'printf \'# Report\\n\\nThe report body.\\n\' > deliverables/report.md && ' +
  'printf \'metric,value\\nuptime,99.9\\n\' > deliverables/data.csv ' +
  '— verify with: ls deliverables — then finish.';

function forcedApprove(): string {
  return (
    'Using the terminal, write a file named review.json in your current working ' +
    'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
    '{"verdict": "approve", "comments": [], "summary": "Forced approval for deterministic testing."} ' +
    '— verify it parses with python3 -c "import json; json.load(open(\'review.json\'))" and finish.'
  );
}

function forcedRequestChanges(marker: string): string {
  return (
    'Using the terminal, write a file named review.json in your current working ' +
    'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
    `{"verdict": "request_changes", "comments": [{"file": "summary.md", "severity": "must_fix", "body": "${marker}"}], ` +
    '"summary": "Forced change request for deterministic testing."} ' +
    '— verify it parses with python3 -c "import json; json.load(open(\'review.json\'))" and finish.'
  );
}

// ---------- helpers ----------

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

/** Create a task mission and fold it to BUILDING with the fixed plan. */
async function buildingTaskMission(deliverTo?: string): Promise<string> {
  const res = await jpost('/api/missions', {
    title: 'task mission',
    objective: 'Write a 200-word summary of event sourcing to summary.md',
    kind: 'task',
    riskLevel: 'low',
    ...(deliverTo ? { deliverTo } : {}),
  });
  expect(res.status).toBe(201);
  const missionId = (await res.json()).mission.missionId as string;
  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: TASK_PLAN } },
    { type: 'PLAN_APPROVED' },
  ]) {
    const r = await jpost(`/api/missions/${missionId}/events`, body);
    expect(r.status).toBe(201);
  }
  return missionId;
}

/** Run a deterministic real-worker build; retry on stochastic worker failure. */
async function buildTaskWith(
  missionId: string,
  workerTask: string,
  reviewerTasks: string[] = [forcedApprove()],
): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: workerTask,
      reviewerTaskOverrides: reviewerTasks,
    });
    const outcome = await settled;
    if (outcome.kind === 'COMPLETED') return;
    expect(await state(missionId)).toBe('BUILDING');
  }
  throw new Error(`task build did not complete for ${missionId} after 4 attempts`);
}

async function latestScan(missionId: string) {
  const res = await api(`/api/missions/${missionId}/scan`);
  expect(res.status).toBe(200);
  return (await res.json()).scan;
}

async function pollScanDone(missionId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = await latestScan(missionId);
    if (scan && scan.status !== 'RUNNING') return scan;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`scan for ${missionId} did not finish in time`);
}

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

async function getChallenge(missionId: string): Promise<string> {
  const res = await jpost(`/api/missions/${missionId}/approval/options`);
  expect(res.status).toBe(200);
  return (await res.json()).options.challenge as string;
}

async function approveTask(missionId: string): Promise<Record<string, unknown>> {
  const challenge = await getChallenge(missionId);
  const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
  const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing from repo-root .env — M6a tests run real workers.');
  }
  if (!existsSync(DEFAULT_GITLEAKS_BIN)) {
    throw new Error(
      `gitleaks missing at ${DEFAULT_GITLEAKS_BIN} — run scripts/setup-scanners.sh first (never skip).`,
    );
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'task-'));
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
    deliveriesRoot: path.join(scratch, 'deliveries'),
  });
  app = createApp(pool, supervisor, orchestrator);
  approver = await registerApprover();
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

// ====================================================================
// T48: boundary — kind discrimination at the API edge
// ====================================================================

describe('T48: mission kind boundary', () => {
  it('task without repoPath accepted; deliverTo recorded', async () => {
    const deliverTo = path.join(scratch, 't48-deliveries');
    const res = await jpost('/api/missions', {
      title: 'boundary task',
      objective: 'produce a small document deliverable',
      kind: 'task',
      riskLevel: 'low',
      deliverTo,
    });
    expect(res.status).toBe(201);
    const { mission } = await res.json();
    expect(mission.kind).toBe('task');
    expect(mission.repoPath).toBeNull();
    expect(mission.deliverTo).toBe(deliverTo);
  });

  it('task WITH repoPath → 400', async () => {
    const res = await jpost('/api/missions', {
      title: 'bad task',
      objective: 'task missions must not name a repository',
      kind: 'task',
      repoPath: '/tmp/some-repo',
      riskLevel: 'low',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('VALIDATION');
  });

  it('code without repoPath → 400 (explicit and defaulted kind)', async () => {
    for (const body of [
      { title: 'bad code', objective: 'code requires a repository', kind: 'code', riskLevel: 'low' },
      { title: 'bad code', objective: 'code requires a repository', riskLevel: 'low' },
    ]) {
      const res = await jpost('/api/missions', body);
      expect(res.status).toBe(400);
    }
  });

  it('kind defaults to code when absent (back-compat)', async () => {
    const repo = path.join(scratch, 't48-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await exec('git', ['init', '-q', repo]);
    await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
    await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);

    const res = await jpost('/api/missions', {
      title: 'legacy-shaped mission',
      objective: 'a mission created without kind is a code mission',
      repoPath: repo,
      riskLevel: 'low',
    });
    expect(res.status).toBe(201);
    const { mission } = await res.json();
    expect(mission.kind).toBe('code');
    expect(mission.repoPath).toBe(repo);

    // deliverTo on a code mission is rejected
    const bad = await jpost('/api/missions', {
      title: 'bad code',
      objective: 'deliverTo belongs to task missions only',
      repoPath: repo,
      riskLevel: 'low',
      deliverTo: '/tmp/x',
    });
    expect(bad.status).toBe(400);
  });
});

// ====================================================================
// T49: happy path — plan → build → review → scan → gate → delivery
// ====================================================================

describe('T49: task mission happy path', () => {
  it('real worker writes summary.md → gitleaks-only scan → ceremony → delivered → MERGED', async () => {
    const deliverTo = path.join(scratch, 't49-deliveries');
    const missionId = await buildingTaskMission(deliverTo);

    await buildTaskWith(missionId, WRITE_SUMMARY);

    // build produced a 'deliverable' artifact, referenced from the event
    const events = await getMissionEvents(pool, missionId);
    const completed = events.filter((e) => e.type === 'BUILD_COMPLETED').pop()!;
    expect(completed.payload.artifactId).toBeTruthy();
    const files = completed.payload.deliverable as { files: { name: string; sha256: string }[] };
    expect(files.files.map((f) => f.name)).toEqual(['summary.md']);
    const artifacts = await listArtifacts(pool, missionId);
    const deliverable = artifacts.find((a) => a.type === 'deliverable');
    expect(deliverable).toBeTruthy();

    // gitleaks-only scan passed (pin 4): per-tool breakdown shows gitleaks alone
    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('PASSED');
    expect(scan.toolBreakdown.gitleaks).toBeDefined();
    expect(scan.toolBreakdown.semgrep).toBeUndefined();
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');

    // gate: bound hashes reflect the deliverable + sarif artifacts
    const optRes = await jpost(`/api/missions/${missionId}/approval/options`);
    expect(optRes.status).toBe(200);
    const opt = await optRes.json();
    expect(opt.boundHashes.diff).toBe(deliverable!.sha256);

    // a fresh challenge for the actual ceremony (the one above stays unused)
    const body = await approveTask(missionId);
    expect(body.delivered).toBe(true);
    expect(body.deliveredTo).toBe(deliverTo);

    // the file landed; copy hash verified against the artifact
    const landed = await readFile(path.join(deliverTo, 'summary.md'));
    expect(createHash('sha256').update(landed).digest('hex')).toBe(deliverable!.sha256);

    // MERGED with deliveredTo in the event (pin 6; event names canonical, pin 8)
    const after = await getMissionEvents(pool, missionId);
    const merged = after.find((e) => e.type === 'MERGE_APPROVED')!;
    expect(merged.payload.deliveredTo).toBe(deliverTo);
    expect(merged.payload.approvalId).toBe(body.approvalId);
    expect(await state(missionId)).toBe('MERGED');
  }, 600_000);
});

// ====================================================================
// T50: dirty deliverable — planted key fails the scan, findings fed forward
// ====================================================================

describe('T50: dirty deliverable', () => {
  it('AWS-style key in the deliverable → SCAN_FAILED → BUILDING; finding in next WORKER_TASK', async () => {
    const missionId = await buildingTaskMission();
    await buildTaskWith(missionId, WRITE_DIRTY_SUMMARY);

    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('FAILED');
    expect(scan.counts.errors).toBeGreaterThanOrEqual(1);
    expect(scan.toolBreakdown.gitleaks.errors).toBeGreaterThanOrEqual(1);
    expect(await state(missionId)).toBe('BUILDING');

    // next attempt's WORKER_TASK contains the finding
    const res = await jpost(`/api/missions/${missionId}/build`);
    expect(res.status).toBe(202);
    const { coderWorkerId } = await res.json();
    const workerEvents = await getWorkerEvents(pool, coderWorkerId);
    const task = workerEvents.find((e) => e.type === 'WORKER_TASK');
    const prompt = String(task!.payload.prompt);
    expect(prompt.toLowerCase()).toContain('security scan');
    expect(prompt).toContain('summary.md');

    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    await supervisor.waitForExit(coderWorkerId, 30_000);
  }, 600_000);
});

// ====================================================================
// T51: binding — tampered deliverable voids the ceremony
// ====================================================================

describe('T51: deliverable binding', () => {
  it('tamper after options issued → 409 INTEGRITY, nothing delivered', async () => {
    const deliverTo = path.join(scratch, 't51-deliveries');
    const missionId = await buildingTaskMission(deliverTo);
    await buildTaskWith(missionId, WRITE_SUMMARY);
    expect((await pollScanDone(missionId)).status).toBe('PASSED');

    const challenge = await getChallenge(missionId);
    // tamper the deliverable artifact on disk AFTER the challenge was issued
    const artifacts = await listArtifacts(pool, missionId);
    const deliverable = artifacts.find((a) => a.type === 'deliverable')!;
    await appendFile(deliverable.path, '\ntampered\n');

    const assertion = approver.createAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('INTEGRITY');

    // nothing was delivered; mission stays at the gate
    expect(existsSync(path.join(deliverTo, 'summary.md'))).toBe(false);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  }, 600_000);
});

// ====================================================================
// T52: EMPTY_DELIVERABLE — clean exit with nothing produced fails the attempt
// ====================================================================

describe('T52: empty deliverable', () => {
  it('worker exits 0 with empty deliverables/ → attempt failed, still BUILDING, retry allowed', async () => {
    const missionId = await buildingTaskMission();

    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: WRITE_NOTHING,
      reviewerTaskOverrides: [forcedApprove()],
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');
    if (outcome.kind === 'ATTEMPT_FAILED') {
      expect(outcome.reason).toBe('EMPTY_DELIVERABLE');
    }
    expect(await state(missionId)).toBe('BUILDING');

    // the failure is recorded worker_events-style with the canonical reason
    const { rows } = await pool.query(
      `select 1 from worker_events
        where mission_id = $1 and type = 'BUILD_ATTEMPT_FAILED'
          and payload->>'reason' = 'EMPTY_DELIVERABLE'`,
      [missionId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // a retry is allowed and completes
    await buildTaskWith(missionId, WRITE_SUMMARY);
    expect((await pollScanDone(missionId)).status).toBe('PASSED');
  }, 600_000);
});

// ====================================================================
// T53: multi-file deliverable — tar artifact, intact delivery
// ====================================================================

describe('T53: multi-file deliverable', () => {
  it('two files → tar artifact; gate lists both; delivery unpacks intact with verified hashes', async () => {
    const deliverTo = path.join(scratch, 't53-deliveries');
    const missionId = await buildingTaskMission(deliverTo);
    await buildTaskWith(missionId, WRITE_TWO_FILES);

    // event payload lists both files with their hashes; the artifact is a tar
    const events = await getMissionEvents(pool, missionId);
    const completed = events.filter((e) => e.type === 'BUILD_COMPLETED').pop()!;
    const deliverableInfo = completed.payload.deliverable as {
      files: { name: string; sha256: string }[];
      archive: boolean;
    };
    expect(deliverableInfo.archive).toBe(true);
    expect(deliverableInfo.files.map((f) => f.name).sort()).toEqual(['data.csv', 'report.md']);

    expect((await pollScanDone(missionId)).status).toBe('PASSED');

    await approveTask(missionId);

    // both files landed intact — per-file hashes match the build-time record
    for (const f of deliverableInfo.files) {
      const landed = await readFile(path.join(deliverTo, f.name));
      expect(createHash('sha256').update(landed).digest('hex')).toBe(f.sha256);
    }
    expect(await state(missionId)).toBe('MERGED');
  }, 600_000);
});

// ====================================================================
// T54: reviewer loop on task deliverables
// ====================================================================

describe('T54: reviewer loop for task missions', () => {
  it('forced request_changes → revision carries the comments → approve', async () => {
    const missionId = await buildingTaskMission();
    const marker = 'TASK-REVIEW-MARKER-7741: expand the summary with one concrete example.';

    await buildTaskWith(missionId, WRITE_SUMMARY, [
      forcedRequestChanges(marker),
      forcedApprove(),
    ]);

    // the revision worker's WORKER_TASK carries the reviewer's comment verbatim
    const { rows } = await pool.query(
      `select payload from worker_events
        where mission_id = $1 and type = 'WORKER_TASK'
        order by recorded_at`,
      [missionId],
    );
    const prompts = rows.map((r: { payload: { prompt?: string } }) => String(r.payload.prompt ?? ''));
    expect(prompts.some((p) => p.includes(marker))).toBe(true);
    expect(await state(missionId)).not.toBe('BUILDING'); // attempt completed
  }, 600_000);

  it('2-cycle exhaustion → attempt failed, mission stays BUILDING', async () => {
    const missionId = await buildingTaskMission();
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: WRITE_SUMMARY,
      coderRevisionTaskOverride: WRITE_SUMMARY,
      reviewerTaskOverrides: [
        forcedRequestChanges('first pass: not good enough'),
        forcedRequestChanges('second pass: still not good enough'),
      ],
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');
    if (outcome.kind === 'ATTEMPT_FAILED') {
      expect(outcome.reason).toBe('REVIEW_EXHAUSTED');
    }
    expect(await state(missionId)).toBe('BUILDING');
  }, 600_000);
});
