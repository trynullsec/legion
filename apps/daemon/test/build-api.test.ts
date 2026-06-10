import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  getWorkerEvents,
  listMissionWorkers,
  runMigrations,
} from '@legion/db';
import { type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);

const BUILD_WAIT_MS = 480_000;

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let app: Hono;
let scratch: string;
let fixtureRepo: string;

// The approved plan targets tiny-math's documented missing-validation flaw.
const APPROVED_PLAN: Plan = {
  summary:
    'Add input validation to tiny-math: add() and divide() must reject non-finite inputs, and divide() must throw a RangeError on division by zero instead of returning Infinity.',
  steps: [
    {
      n: 1,
      title: 'Validate inputs in src/math.ts',
      detail:
        'Add a guard that throws a TypeError when either argument of add() or divide() is not a finite number, and make divide() throw a RangeError when the divisor is 0.',
      filesLikelyTouched: ['src/math.ts'],
    },
    {
      n: 2,
      title: 'Document the new behaviour',
      detail:
        'Update README.md: remove the "Known shortcoming" section and document the validation behaviour.',
      filesLikelyTouched: ['README.md'],
    },
  ],
  risks: [
    {
      description: 'Callers relying on Infinity from divide-by-zero will now see an exception.',
      severity: 'medium',
    },
  ],
  openQuestions: [],
  estimatedComplexity: 'small',
};

const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'tiny-math', version: '1.0.0', type: 'module', main: 'src/index.ts' },
    null,
    2,
  ),
  'README.md': [
    '# tiny-math',
    '',
    'A tiny TypeScript math utility package.',
    '',
    '## Known shortcoming',
    '',
    'The `add()` and `divide()` functions in `src/math.ts` perform **no input',
    'validation**: `divide()` returns `Infinity` on division by zero and both',
    'functions silently propagate `NaN`. Input validation is a known TODO.',
  ].join('\n'),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
  'src/index.ts': "export { add, divide } from './math.js';\n",
  'src/math.ts': [
    '// TODO: validate inputs (no NaN/Infinity handling yet)',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function divide(a: number, b: number): number {',
    '  return a / b; // returns Infinity when b === 0',
    '}',
  ].join('\n'),
  'test/math.test.ts': [
    "import { add, divide } from '../src/math.js';",
    "if (add(1, 2) !== 3) throw new Error('add broken');",
    "if (divide(6, 2) !== 3) throw new Error('divide broken');",
  ].join('\n'),
};

async function createFixtureRepo(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const file = path.join(dir, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await exec('git', ['init', '-q', dir]);
  const git = (...args: string[]) =>
    exec('git', [
      '-C', dir,
      '-c', 'user.name=fixture',
      '-c', 'user.email=fixture@legion.test',
      ...args,
    ]);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'fixture: tiny-math');
}

/** Worktree + refs snapshot: proves the user's repo is untouched. */
async function snapshotRepo(dir: string): Promise<string> {
  const status = await exec('git', ['-C', dir, 'status', '--porcelain']);
  const refs = await exec('git', ['-C', dir, 'for-each-ref']);
  const head = await exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  const tree = await exec('git', ['-C', dir, 'ls-files', '-s']);
  return [status.stdout, refs.stdout, head.stdout, tree.stdout].join('\n---\n');
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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

/** Create a mission and drive it to BUILDING with the approved plan. */
async function buildingMission(): Promise<string> {
  const res = await jsonPost('/api/missions', {
    title: 'Add input validation to tiny-math',
    objective: APPROVED_PLAN.summary,
    repoPath: fixtureRepo,
    riskLevel: 'low',
  });
  expect(res.status).toBe(201);
  const missionId = (await res.json()).mission.missionId as string;
  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: APPROVED_PLAN } },
    { type: 'PLAN_APPROVED' },
  ]) {
    const r = await jsonPost(`/api/missions/${missionId}/events`, body);
    expect(r.status).toBe(201);
  }
  return missionId;
}

async function missionState(missionId: string): Promise<string> {
  const res = await api(`/api/missions/${missionId}`);
  return (await res.json()).mission.state as string;
}

async function pollUntilState(
  missionId: string,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await missionState(missionId)) === target) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `mission ${missionId} did not reach ${target} in time (state: ${await missionState(missionId)})`,
  );
}

// Real-worker override tasks for deterministic paths (T19 precedent).
const TRIVIAL_COMMIT_TASK =
  'You are in a git repository on a feature branch. Run these exact shell commands, then finish: ' +
  'echo legion-build-test > legion-note.txt && git add legion-note.txt && ' +
  'git commit -m "step 1: trivial note" --no-verify';

function forcedReviewTask(review: unknown): string {
  return (
    'Using the terminal, write a file named review.json in your current working ' +
    'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
    JSON.stringify(JSON.stringify(review)).slice(1, -1) +
    ' — verify it parses with python3 -c "import json; json.load(open(\'review.json\'))" and finish.'
  );
}

const FORCED_APPROVE = forcedReviewTask({
  verdict: 'approve',
  comments: [],
  summary: 'Forced approval for deterministic testing.',
});

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is missing from the repo-root .env — the M3 build ' +
        'tests run real coder/reviewer agents and cannot run without it.',
    );
  }
  pool = createPool();
  await runMigrations(pool);
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'build-'));
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
  });
  app = createApp(pool, supervisor, orchestrator);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(fixtureRepo, { recursive: true });
  await createFixtureRepo(fixtureRepo);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  // build workspaces persist by design (pin 7); remove only our scratch root
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T24: happy path — real coder implements the plan, real reviewer approves', () => {
  it('POST /build → commits on a branch → approved → diff artifact → SCANNING', async () => {
    const missionId = await buildingMission();
    const before = await snapshotRepo(fixtureRepo);
    const eventsBefore = await getMissionEvents(pool, missionId);

    const res = await jsonPost(`/api/missions/${missionId}/build`);
    expect(res.status).toBe(202);
    const { attempt, coderWorkerId } = await res.json();
    expect(attempt).toBe(1);
    expect(coderWorkerId).toBeTruthy();

    // BUILD_STARTED emitted when the first coder spawned
    const eventsAfterStart = await getMissionEvents(pool, missionId);
    expect(
      eventsAfterStart.filter((e) => e.type === 'BUILD_STARTED').length,
    ).toBe(eventsBefore.filter((e) => e.type === 'BUILD_STARTED').length + 1);

    await pollUntilState(missionId, 'SCANNING', BUILD_WAIT_MS);

    const events = await getMissionEvents(pool, missionId);
    const completed = events.find((e) => e.type === 'BUILD_COMPLETED');
    expect(completed).toBeTruthy();
    const payload = completed!.payload as {
      artifactId: string;
      sha256: string;
      stats: { files: number; insertions: number; deletions: number; commits: number };
      reviewSummary: string;
    };
    expect(payload.artifactId).toBeTruthy();
    expect(payload.reviewSummary).toBeTruthy();
    // mission_events never carry diff bodies
    expect(JSON.stringify(payload)).not.toContain('diff --git');

    // artifact integrity on disk
    const artRes = await api(`/api/artifacts/${payload.artifactId}`);
    expect(artRes.status).toBe(200);
    const art = await artRes.json();
    expect(sha256(art.content)).toBe(payload.sha256);
    expect(art.artifact.sha256).toBe(payload.sha256);

    // the diff is real and touches the plan's target files
    expect(art.content).toContain('diff --git');
    expect(art.content).toContain('src/math.ts');

    // stats match git's own accounting
    expect(payload.stats.commits).toBeGreaterThanOrEqual(1);
    expect(payload.stats.files).toBeGreaterThanOrEqual(1);
    expect(payload.stats.insertions).toBeGreaterThan(0);

    // real commits exist in the workspace on the legion branch
    const workspace = path.join(
      scratch, 'builds', missionId, 'attempt-1', 'repo',
    );
    const branch = await exec('git', ['-C', workspace, 'branch', '--show-current']);
    expect(branch.stdout.trim()).toBe(`legion/${missionId.slice(0, 8)}`);
    const log = await exec('git', ['-C', workspace, 'log', '--oneline']);
    expect(log.stdout.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2);

    // shortstat cross-check
    const base = (
      await exec('git', ['-C', workspace, 'rev-list', '--max-parents=0', 'HEAD'])
    ).stdout.trim();
    const shortstat = await exec('git', [
      '-C', workspace, 'diff', '--shortstat', `${base}..HEAD`,
    ]);
    const m = shortstat.stdout.match(/(\d+) files? changed/);
    expect(Number(m?.[1])).toBe(payload.stats.files);

    // the user's repository is byte-identical: worktree AND refs
    expect(await snapshotRepo(fixtureRepo)).toBe(before);

    // both agent roles ran
    const workers = await listMissionWorkers(pool, missionId);
    expect(workers.some((w) => w.role === 'coder')).toBe(true);
    expect(workers.some((w) => w.role === 'reviewer')).toBe(true);
  }, BUILD_WAIT_MS + 60_000);
});

describe('T25: revision loop — review comments feed the second coder cycle', () => {
  it('request_changes → revision coder gets the comments → approve → 2+2 workers', async () => {
    const missionId = await buildingMission();
    const comments = [
      {
        file: 'src/math.ts',
        severity: 'must_fix',
        body: 'REVISION-MARKER-7741: divide() must also reject a divisor of zero with a RangeError.',
      },
    ];
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: TRIVIAL_COMMIT_TASK,
      reviewerTaskOverrides: [
        forcedReviewTask({
          verdict: 'request_changes',
          comments,
          summary: 'Needs divide-by-zero handling.',
        }),
        FORCED_APPROVE,
      ],
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('COMPLETED');

    const workers = await listMissionWorkers(pool, missionId);
    const coders = workers.filter((w) => w.role === 'coder');
    const reviewers = workers.filter((w) => w.role === 'reviewer');
    expect(coders).toHaveLength(2);
    expect(reviewers).toHaveLength(2);

    // the revision coder's recorded prompt embeds the review comments
    const secondCoder = coders[1]!;
    const events = await getWorkerEvents(pool, secondCoder.workerId);
    const task = events.find((e) => e.type === 'WORKER_TASK');
    expect(task).toBeTruthy();
    const prompt = String(task!.payload.prompt);
    expect(prompt).toContain('REVISION-MARKER-7741');
    expect(prompt).toContain('must_fix');

    expect(await missionState(missionId)).toBe('SCANNING');
  }, BUILD_WAIT_MS + 120_000);
});

describe('T26: exhaustion — two rejections fail the attempt; attempt-2 learns from it', () => {
  it('BUILD_ATTEMPT_FAILED recorded, no BUILD_COMPLETED, fresh attempt references the summary', async () => {
    const missionId = await buildingMission();
    const failSummary = 'EXHAUST-MARKER-3317: still missing zero-divisor handling.';
    const rc = (n: number) =>
      forcedReviewTask({
        verdict: 'request_changes',
        comments: [
          { file: 'src/math.ts', severity: 'must_fix', body: `cycle ${n}: not fixed.` },
        ],
        summary: failSummary,
      });

    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: TRIVIAL_COMMIT_TASK,
      coderRevisionTaskOverride: TRIVIAL_COMMIT_TASK,
      reviewerTaskOverrides: [rc(1), rc(2)],
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');

    // recorded in worker_events, not mission_events
    const workers = await listMissionWorkers(pool, missionId);
    let attemptFailed = false;
    for (const w of workers) {
      const events = await getWorkerEvents(pool, w.workerId);
      if (events.some((e) => e.type === 'BUILD_ATTEMPT_FAILED')) attemptFailed = true;
    }
    expect(attemptFailed).toBe(true);

    const missionEvents = await getMissionEvents(pool, missionId);
    expect(missionEvents.some((e) => e.type === 'BUILD_COMPLETED')).toBe(false);
    expect(await missionState(missionId)).toBe('BUILDING');

    // attempt 2: fresh workspace, real coder prompt references the failed summary
    const res = await jsonPost(`/api/missions/${missionId}/build`);
    expect(res.status).toBe(202);
    const { attempt, coderWorkerId } = await res.json();
    expect(attempt).toBe(2);
    expect(
      existsSync(path.join(scratch, 'builds', missionId, 'attempt-2', 'repo')),
    ).toBe(true);

    const events = await getWorkerEvents(pool, coderWorkerId);
    const task = events.find((e) => e.type === 'WORKER_TASK');
    expect(String(task!.payload.prompt)).toContain('EXHAUST-MARKER-3317');

    // stop attempt 2 — we only needed its prompt
    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    await supervisor.waitForExit(coderWorkerId, 30_000);
    await new Promise((r) => setTimeout(r, 1500)); // let the attempt settle
    expect(await missionState(missionId)).toBe('BUILDING');
  }, BUILD_WAIT_MS + 120_000);
});

describe('T27: coder killed mid-attempt', () => {
  it('attempt fails, mission stays BUILDING, no artifact, retry allowed', async () => {
    const missionId = await buildingMission();
    const { coderWorkerId, settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: "Run the shell command 'sleep 300' and wait for it to complete.",
    });

    await new Promise((r) => setTimeout(r, 8000));
    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    const outcome = await settled;
    expect(outcome.kind).toBe('ATTEMPT_FAILED');

    expect(await missionState(missionId)).toBe('BUILDING');
    const artifacts = await (
      await api(`/api/missions/${missionId}/artifacts`)
    ).json();
    expect(artifacts.artifacts).toHaveLength(0);

    // retry allowed
    const retry = await jsonPost(`/api/missions/${missionId}/build`);
    expect(retry.status).toBe(202);
    const r = await retry.json();
    expect(r.attempt).toBe(2);
    await supervisor.stopWorker(r.coderWorkerId, { graceful: false });
    await supervisor.waitForExit(r.coderWorkerId, 30_000);
  }, 180_000);
});

describe('T28: artifact integrity', () => {
  it('GET returns the diff with a matching hash; tampering → 409 INTEGRITY', async () => {
    const missionId = await buildingMission();
    const { settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: TRIVIAL_COMMIT_TASK,
      reviewerTaskOverrides: [FORCED_APPROVE],
    });
    const outcome = await settled;
    expect(outcome.kind).toBe('COMPLETED');

    const list = await (await api(`/api/missions/${missionId}/artifacts`)).json();
    expect(list.artifacts).toHaveLength(1);
    const meta = list.artifacts[0];

    const res = await api(`/api/artifacts/${meta.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(sha256(body.content)).toBe(meta.sha256);
    expect(body.content).toContain('legion-note.txt');

    // tamper with the file on disk → integrity failure on read
    await appendFile(meta.path, '\n# tampered\n');
    const tampered = await api(`/api/artifacts/${meta.id}`);
    expect(tampered.status).toBe(409);
    expect((await tampered.json()).error).toBe('INTEGRITY');
  }, 240_000);
});

describe('T29: build concurrency guard', () => {
  it('second POST /build during a running attempt → 409, one attempt only', async () => {
    const missionId = await buildingMission();
    const { coderWorkerId, settled } = await orchestrator.startBuild(missionId, {
      coderTaskOverride: "Run the shell command 'sleep 300' and wait for it to complete.",
    });

    const second = await jsonPost(`/api/missions/${missionId}/build`);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('BUILD_IN_PROGRESS');

    const workers = await listMissionWorkers(pool, missionId);
    expect(workers.filter((w) => w.role === 'coder')).toHaveLength(1);

    await supervisor.stopWorker(coderWorkerId, { graceful: false });
    await settled;
  }, 120_000);

  it('POST /build on a non-BUILDING mission → 409', async () => {
    const res = await jsonPost('/api/missions', {
      title: 'draft', objective: 'x', repoPath: fixtureRepo, riskLevel: 'low',
    });
    const missionId = (await res.json()).mission.missionId;
    expect((await jsonPost(`/api/missions/${missionId}/build`)).status).toBe(409);
  });
});

describe('T30: internal overrides cannot be smuggled over HTTP (pin 9)', () => {
  it('rejects taskOverride and friends on every spawn-capable route', async () => {
    const missionId = await buildingMission();

    // /plan — mission is BUILDING so state would 409 anyway; use a fresh DRAFT
    const draftRes = await jsonPost('/api/missions', {
      title: 'smuggle', objective: 'x', repoPath: fixtureRepo, riskLevel: 'low',
    });
    const draftId = (await draftRes.json()).mission.missionId;

    const planSmuggle = await jsonPost(`/api/missions/${draftId}/plan`, {
      taskOverride: 'SMUGGLED-EVIL-PROMPT',
    });
    expect(planSmuggle.status).toBe(400);

    const buildSmuggle = await jsonPost(`/api/missions/${missionId}/build`, {
      coderTaskOverride: 'SMUGGLED-EVIL-PROMPT',
    });
    expect(buildSmuggle.status).toBe(400);

    const buildSmuggle2 = await jsonPost(`/api/missions/${missionId}/build`, {
      reviewerTaskOverrides: ['SMUGGLED-EVIL-PROMPT'],
    });
    expect(buildSmuggle2.status).toBe(400);

    const workerSmuggle = await jsonPost(`/api/missions/${missionId}/workers`, {
      role: 'coder',
      task: 'legit task',
      taskOverride: 'SMUGGLED-EVIL-PROMPT',
    });
    expect(workerSmuggle.status).toBe(400);

    // nothing got spawned anywhere, and no prompt contains the marker
    for (const id of [missionId, draftId]) {
      const workers = await listMissionWorkers(pool, id);
      for (const w of workers) {
        const events = await getWorkerEvents(pool, w.workerId);
        for (const e of events) {
          expect(JSON.stringify(e.payload)).not.toContain('SMUGGLED-EVIL-PROMPT');
        }
      }
    }
    const draftWorkers = await listMissionWorkers(pool, draftId);
    expect(draftWorkers).toHaveLength(0);
  });
});
