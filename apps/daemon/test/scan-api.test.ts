import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  getWorkerEvents,
  runMigrations,
} from '@legion/db';
import { type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
import {
  DEFAULT_GITLEAKS_BIN,
  DEFAULT_SEMGREP_BIN,
} from '@legion/scanner';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let app: Hono;
let scratch: string;
let fixtureRepo: string;

const PLAN: Plan = {
  summary: 'Add a note file to tiny-math.',
  steps: [
    {
      n: 1,
      title: 'Add note',
      detail: 'Create legion-note.txt.',
      filesLikelyTouched: ['legion-note.txt'],
    },
  ],
  risks: [],
  openQuestions: [],
  estimatedComplexity: 'trivial',
};

const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'tiny-math', version: '1.0.0', type: 'module' },
    null,
    2,
  ),
  'README.md': '# tiny-math\n\nA tiny fixture package.\n',
  'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
};

// real workers, deterministic tasks (T19/M3 precedent)
const COMMIT_CLEAN =
  'You are in a git repository on a feature branch. Run these exact shell commands, then finish: ' +
  'echo legion-clean > legion-note.txt && git add legion-note.txt && ' +
  'git commit -m "step 1: note" --no-verify';

// a real high-entropy AWS-style key planted on the attempt branch
const COMMIT_SECRET =
  'You are in a git repository on a feature branch. Run these exact shell commands in order, then finish: ' +
  'echo \'const AWS_ACCESS_KEY_ID = "AKIAQ3EGV7DKVPNZX2MJ";\' > config.ts && ' +
  'git add config.ts && git commit -m "step 1: config" --no-verify';

// warning-level only: matches legion-rules' md5 rule, no secrets
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

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return app.request(pathname, init);
}

async function jsonPost(pathname: string, body?: unknown): Promise<Response> {
  return api(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function buildingMission(): Promise<string> {
  const res = await jsonPost('/api/missions', {
    title: 'scan-stage mission',
    objective: PLAN.summary,
    repoPath: fixtureRepo,
    riskLevel: 'low',
  });
  const missionId = (await res.json()).mission.missionId as string;
  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: PLAN } },
    { type: 'PLAN_APPROVED' },
  ]) {
    await jsonPost(`/api/missions/${missionId}/events`, body);
  }
  return missionId;
}

/**
 * Run a deterministic build (real workers) whose scan outcome we control.
 * The coder runs a fixed shell task, but it's still a real stochastic model;
 * an occasional failed attempt leaves the mission at BUILDING, so we retry.
 * This isolates these scan tests from coder flakiness (build reliability is
 * covered by the M3 suite).
 */
async function buildWith(missionId: string, coderTask: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: coderTask,
      reviewerTaskOverrides: [forcedApprove()],
    });
    const outcome = await settled;
    if (outcome.kind === 'COMPLETED') return;
    expect(await missionState(missionId)).toBe('BUILDING'); // failed attempt stays BUILDING
  }
  throw new Error(`build did not complete for ${missionId} after 4 attempts`);
}

async function missionState(missionId: string): Promise<string> {
  const res = await api(`/api/missions/${missionId}`);
  return (await res.json()).mission.state as string;
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

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing from repo-root .env — M4 tests run real workers.');
  }
  for (const [bin, name] of [
    [DEFAULT_GITLEAKS_BIN, 'gitleaks'],
    [DEFAULT_SEMGREP_BIN, 'semgrep'],
  ] as const) {
    if (!existsSync(bin)) {
      throw new Error(
        `${name} missing at ${bin} — run scripts/setup-scanners.sh first (M4 tests never skip).`,
      );
    }
  }
  pool = createPool();
  await runMigrations(pool);
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'scan-'));
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
  });
  app = createApp(pool, supervisor, orchestrator);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(path.join(fixtureRepo, 'src'), { recursive: true });
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    await writeFile(path.join(fixtureRepo, rel), content);
  }
  await exec('git', ['init', '-q', fixtureRepo]);
  await exec('git', [
    '-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f',
    'add', '-A',
  ]);
  await exec('git', [
    '-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f',
    'commit', '-q', '-m', 'fixture',
  ]);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T33: clean path — auto scan passes', () => {
  it('build completes → SCAN_STARTED auto-emitted → SCAN_PASSED → AWAITING_MERGE_APPROVAL', async () => {
    const missionId = await buildingMission();
    await buildWith(missionId, COMMIT_CLEAN);

    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('PASSED');
    expect(scan.counts.errors).toBe(0);
    expect(scan.sarifArtifactId).toBeTruthy();
    expect(scan.toolBreakdown.gitleaks).toBeDefined();
    expect(scan.toolBreakdown.semgrep).toBeDefined();

    const events = await getMissionEvents(pool, missionId);
    const types = events.map((e) => e.type);
    expect(types).toContain('SCAN_STARTED');
    expect(types).toContain('SCAN_PASSED');
    const passed = events.find((e) => e.type === 'SCAN_PASSED');
    expect(passed?.payload.sarifArtifactId).toBe(scan.sarifArtifactId);
    // mission_events carry only artifact id + counts — never SARIF bodies
    expect(JSON.stringify(passed?.payload)).not.toContain('runs');

    expect(await missionState(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  }, 300_000);
});

describe('T34: dirty path — planted secret fails the scan and feeds the rework prompt', () => {
  it('SCAN_FAILED with errors ≥1 from gitleaks → BUILDING; next build prompt carries the finding', async () => {
    const missionId = await buildingMission();
    await buildWith(missionId, COMMIT_SECRET);

    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('FAILED');
    expect(scan.counts.errors).toBeGreaterThanOrEqual(1);
    expect(scan.toolBreakdown.gitleaks.errors).toBeGreaterThanOrEqual(1);
    expect(await missionState(missionId)).toBe('BUILDING');

    // the finding is attributable to gitleaks' run in the merged SARIF
    const art = await (await api(`/api/artifacts/${scan.sarifArtifactId}`)).json();
    const sarif = JSON.parse(art.content);
    const glRun = sarif.runs.find((r: { tool: { driver: { name: string } } }) =>
      r.tool.driver.name.toLowerCase().includes('gitleaks'),
    );
    expect(glRun).toBeTruthy();
    expect(glRun.results.length).toBeGreaterThanOrEqual(1);
    const finding = glRun.results[0];
    expect(finding.level).toBe('error');

    // next POST /build: coder WORKER_TASK contains rule + file of the finding
    const res = await jsonPost(`/api/missions/${missionId}/build`);
    expect(res.status).toBe(202);
    const { coderWorkerId } = await res.json();
    const workerEvents = await getWorkerEvents(pool, coderWorkerId);
    const task = workerEvents.find((e) => e.type === 'WORKER_TASK');
    const prompt = String(task!.payload.prompt);
    expect(prompt).toContain(finding.ruleId);
    expect(prompt).toContain('config.ts');
    expect(prompt.toLowerCase()).toContain('security scan');

    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    await supervisor.waitForExit(coderWorkerId, 30_000);
  }, 300_000);
});

/** Park a built mission back at SCANNING (workspace persists) for re-scanning. */
async function reenterScanning(missionId: string): Promise<void> {
  // a FAILED auto-scan already moved us to BUILDING; BUILD_COMPLETED → SCANNING
  expect(await missionState(missionId)).toBe('BUILDING');
  const r = await jsonPost(`/api/missions/${missionId}/events`, {
    type: 'BUILD_COMPLETED',
    payload: {},
  });
  expect(r.status).toBe(201);
  expect(await missionState(missionId)).toBe('SCANNING');
}

describe('T35: a scanner crash never passes a mission', () => {
  it('gitleaks crash and semgrep crash each → SCAN_ATTEMPT_FAILED, still SCANNING; good retry runs', async () => {
    const crashBin = path.join(scratch, 'crash-scanner.sh');
    await writeFile(crashBin, '#!/bin/sh\necho "induced scanner explosion" >&2\nexit 2\n');
    await exec('chmod', ['+x', crashBin]);

    // build a secret → auto-scan FAILED → BUILDING; the attempt workspace persists
    const missionId = await buildingMission();
    await buildWith(missionId, COMMIT_SECRET);
    expect((await pollScanDone(missionId)).status).toBe('FAILED');

    // gitleaks crash
    await reenterScanning(missionId);
    let outcome = await (await orchestrator.startScan(missionId, { gitleaksBin: crashBin })).settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');
    if (outcome.kind === 'ATTEMPT_FAILED') expect(outcome.tool).toBe('gitleaks');
    let scan = await latestScan(missionId);
    expect(scan.status).toBe('ATTEMPT_FAILED');
    expect(scan.stderrTail).toContain('induced scanner explosion');
    expect(await missionState(missionId)).toBe('SCANNING'); // never moved

    // semgrep crash
    outcome = await (await orchestrator.startScan(missionId, { semgrepBin: crashBin })).settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');
    if (outcome.kind === 'ATTEMPT_FAILED') expect(outcome.tool).toBe('semgrep');
    expect(await missionState(missionId)).toBe('SCANNING');

    // retry with the good binaries runs end-to-end (the planted secret is still
    // in history → an honest FAILED, proving the scan actually executed)
    outcome = await (await orchestrator.startScan(missionId)).settled;
    expect(outcome.kind).toBe('FAILED');
    expect(await missionState(missionId)).toBe('BUILDING');
  }, 360_000);
});

describe('T36: threshold semantics', () => {
  it('warning-only findings pass at the error threshold (default)', async () => {
    const missionId = await buildingMission();
    await buildWith(missionId, COMMIT_WARNING);
    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('PASSED');
    expect(scan.counts.warnings).toBeGreaterThanOrEqual(1);
    expect(scan.counts.errors).toBe(0);
    expect(await missionState(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  }, 300_000);

  it('warning-only findings FAIL at the warning threshold', async () => {
    process.env.LEGION_SCAN_FAIL_LEVEL = 'warning';
    try {
      const missionId = await buildingMission();
      await buildWith(missionId, COMMIT_WARNING);
      const scan = await pollScanDone(missionId);
      expect(scan.status).toBe('FAILED');
      expect(scan.counts.warnings).toBeGreaterThanOrEqual(1);
      expect(scan.counts.errors).toBe(0);
      expect(await missionState(missionId)).toBe('BUILDING');
    } finally {
      delete process.env.LEGION_SCAN_FAIL_LEVEL;
    }
  }, 300_000);

  it('secret-level findings FAIL under both thresholds (pin 4 error-mapping)', async () => {
    // default (error) threshold
    const m1 = await buildingMission();
    await buildWith(m1, COMMIT_SECRET);
    const s1 = await pollScanDone(m1);
    expect(s1.status).toBe('FAILED');
    expect(s1.counts.errors).toBeGreaterThanOrEqual(1);
    expect(await missionState(m1)).toBe('BUILDING');

    // warning threshold (still fails — a secret is never a warning)
    process.env.LEGION_SCAN_FAIL_LEVEL = 'warning';
    try {
      const m2 = await buildingMission();
      await buildWith(m2, COMMIT_SECRET);
      const s2 = await pollScanDone(m2);
      expect(s2.status).toBe('FAILED');
      expect(s2.counts.errors).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.LEGION_SCAN_FAIL_LEVEL;
    }
  }, 360_000);
});

describe('T37: SARIF artifact integrity', () => {
  it('GET parses as valid SARIF with verified hash; tamper → 409 INTEGRITY', async () => {
    const missionId = await buildingMission();
    await buildWith(missionId, COMMIT_CLEAN);
    const scan = await pollScanDone(missionId);

    const res = await api(`/api/artifacts/${scan.sarifArtifactId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifact.type).toBe('sarif');
    const sarif = JSON.parse(body.content);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(2);
    expect(
      createHash('sha256').update(body.content).digest('hex'),
    ).toBe(body.artifact.sha256);

    await appendFile(body.artifact.path, '\n');
    const tampered = await api(`/api/artifacts/${scan.sarifArtifactId}`);
    expect(tampered.status).toBe(409);
    expect((await tampered.json()).error).toBe('INTEGRITY');
  }, 300_000);
});

describe('T38: POST /scan guards', () => {
  it('409 when not SCANNING; 409 mid-scan; strict schema rejects smuggled options', async () => {
    // not SCANNING
    const draft = await jsonPost('/api/missions', {
      title: 'x', objective: 'y', repoPath: fixtureRepo, riskLevel: 'low',
    });
    const draftId = (await draft.json()).mission.missionId;
    expect((await jsonPost(`/api/missions/${draftId}/scan`)).status).toBe(409);

    // smuggled options rejected before anything runs
    const smuggled = await jsonPost(`/api/missions/${draftId}/scan`, {
      gitleaksBin: '/tmp/evil',
    });
    expect(smuggled.status).toBe(400);

    // unknown mission
    expect(
      (await jsonPost('/api/missions/00000000-0000-0000-0000-00000000dead/scan')).status,
    ).toBe(404);

    // mid-scan 409: park a built mission at SCANNING, hold the scan open with
    // a slow-but-real scanner wrapper, then POST /scan
    const missionId = await buildingMission();
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: COMMIT_SECRET,
      reviewerTaskOverrides: [forcedApprove()],
    });
    await settled;
    await pollScanDone(missionId); // auto-scan FAILED → BUILDING
    await jsonPost(`/api/missions/${missionId}/events`, { type: 'BUILD_STARTED' });
    await jsonPost(`/api/missions/${missionId}/events`, { type: 'BUILD_COMPLETED', payload: {} });

    const slow = path.join(scratch, 'slow-gitleaks.sh');
    await writeFile(
      slow,
      `#!/bin/sh\nsleep 6\nexec "${DEFAULT_GITLEAKS_BIN}" "$@"\n`,
    );
    await exec('chmod', ['+x', slow]);
    const { settled: slowScan } = await orchestrator.startScan(missionId, {
      gitleaksBin: slow,
    });
    const second = await jsonPost(`/api/missions/${missionId}/scan`);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('SCAN_IN_PROGRESS');
    await slowScan;
  }, 300_000);
});
