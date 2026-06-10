import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, getMissionEvents, getWorkerEvents, runMigrations } from '@legion/db';
import { PlanSchema, type Plan } from '@legion/core';
import { Orchestrator } from '@legion/orchestrator';
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

const PLANNER_WAIT_MS = 240_000;

const VALID_PLAN: Plan = {
  summary: 'Validate inputs in the math utilities before computing.',
  steps: [
    {
      n: 1,
      title: 'Guard add()',
      detail: 'Reject non-finite inputs in src/math.ts.',
      filesLikelyTouched: ['src/math.ts'],
    },
  ],
  risks: [{ description: 'Behavioural change for NaN inputs.', severity: 'low' }],
  openQuestions: [],
  estimatedComplexity: 'small',
};

// ---------- fixture repo (a real git repo on disk) ----------

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
  const git = (...args: string[]) =>
    exec('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@legion.test', ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  await exec('git', ['init', '-q', dir]);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'fixture: tiny-math');
}

/** content snapshot of the working tree, excluding .git */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (sub: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, sub), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else out[rel] = await readFile(path.join(dir, rel), 'utf8');
    }
  };
  await walk('');
  return out;
}

// ---------- helpers ----------

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

async function createMissionViaApi(objective: string): Promise<string> {
  const res = await jsonPost('/api/missions', {
    title: 'Add input validation to tiny-math',
    objective,
    repoPath: fixtureRepo,
    riskLevel: 'low',
  });
  expect(res.status).toBe(201);
  return (await res.json()).mission.missionId as string;
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `mission ${missionId} did not reach ${target} within ${timeoutMs}ms (state: ${await missionState(missionId)})`,
  );
}

async function lastPlanProposed(missionId: string): Promise<Plan> {
  const events = await getMissionEvents(pool, missionId);
  const proposed = [...events].reverse().find((e) => e.type === 'PLAN_PROPOSED');
  expect(proposed).toBeTruthy();
  return (proposed!.payload as { plan: Plan }).plan;
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is missing from the repo-root .env — the M2 planning ' +
        'tests run a real planner against OpenRouter and cannot run without it.',
    );
  }
  pool = createPool();
  await runMigrations(pool);
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'planning-'));
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
  });
  app = createApp(pool, supervisor, orchestrator);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(fixtureRepo, { recursive: true });
  await createFixtureRepo(fixtureRepo);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T18: full happy path — real planner on a real repo', () => {
  it('DRAFT → POST /plan → real clone + planner → PLAN_PROPOSED → AWAITING_PLAN_APPROVAL', async () => {
    const missionId = await createMissionViaApi(
      'Add input validation to the math utilities: reject non-finite inputs in add() and divide(), and define divide-by-zero behaviour.',
    );
    const before = await snapshotTree(fixtureRepo);

    const res = await jsonPost(`/api/missions/${missionId}/plan`);
    expect(res.status).toBe(202);
    expect((await res.json()).workerId).toBeTruthy();

    // PLANNING_STARTED emitted immediately
    expect(await missionState(missionId)).toBe('PLANNING');

    await pollUntilState(missionId, 'AWAITING_PLAN_APPROVAL', PLANNER_WAIT_MS);

    const plan = await lastPlanProposed(missionId);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.steps.length).toBeGreaterThanOrEqual(1);

    // steps reference real files from the fixture repo
    const touched = plan.steps.flatMap((s) => s.filesLikelyTouched);
    const fixturePaths = Object.keys(FIXTURE_FILES);
    expect(
      touched.some((f) => fixturePaths.includes(f.replace(/^\.\//, ''))),
    ).toBe(true);

    // the user's repository working tree is byte-identical (clone rule)
    const after = await snapshotTree(fixtureRepo);
    expect(after).toEqual(before);
  }, PLANNER_WAIT_MS + 60_000);
});

describe('T19: invalid plan — real worker, malformed plan.json', () => {
  it('mission stays PLANNING; PLAN_INVALID with zod issues; mission_events untouched', async () => {
    const missionId = await createMissionViaApi('Anything — the planner is sabotaged.');

    // a REAL worker deliberately instructed to write a malformed plan
    const { workerId, settled } = await orchestrator.startPlanning(missionId, {
      taskOverride:
        'Using the terminal, write a file named plan.json in your current working ' +
        'directory containing EXACTLY this JSON (do not fix or extend it): ' +
        '{"summary": 42, "steps": []} — then finish.',
    });
    const eventsAfterStart = await getMissionEvents(pool, missionId);

    await settled;

    expect(await missionState(missionId)).toBe('PLANNING');

    const workerEvents = await getWorkerEvents(pool, workerId);
    const invalid = workerEvents.find((e) => e.type === 'PLAN_INVALID');
    expect(invalid).toBeTruthy();
    const issues = invalid!.payload.issues as Array<{ path?: unknown[] }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2); // summary type + empty steps

    // no mission event was emitted by the failed attempt
    const eventsAfterFail = await getMissionEvents(pool, missionId);
    expect(eventsAfterFail.length).toBe(eventsAfterStart.length);
  }, PLANNER_WAIT_MS);
});

describe('T20: approval gate', () => {
  it('approve from AWAITING_PLAN_APPROVAL → BUILDING; from any other state → 409', async () => {
    const missionId = await createMissionViaApi('Approve-path mission.');

    // a fresh DRAFT mission cannot be approved
    expect((await jsonPost(`/api/missions/${missionId}/plan/approve`)).status).toBe(409);

    // drive to AWAITING_PLAN_APPROVAL via the public events API
    await jsonPost(`/api/missions/${missionId}/events`, { type: 'PLANNING_STARTED' });
    await jsonPost(`/api/missions/${missionId}/events`, {
      type: 'PLAN_PROPOSED',
      payload: { plan: VALID_PLAN },
    });
    expect(await missionState(missionId)).toBe('AWAITING_PLAN_APPROVAL');

    const res = await jsonPost(`/api/missions/${missionId}/plan/approve`);
    expect(res.status).toBe(200);
    expect((await res.json()).mission.state).toBe('BUILDING');

    // approving again (now BUILDING) → 409; planning a BUILDING mission → 409
    expect((await jsonPost(`/api/missions/${missionId}/plan/approve`)).status).toBe(409);
    expect((await jsonPost(`/api/missions/${missionId}/plan`)).status).toBe(409);
  });
});

describe('T21: rejection loop feeds the next planner prompt', () => {
  it('reject → PLANNING; second attempt prompt carries reason + prior summary; second proposal lands', async () => {
    const missionId = await createMissionViaApi(
      'Add input validation to the math utilities in src/math.ts.',
    );
    await jsonPost(`/api/missions/${missionId}/events`, { type: 'PLANNING_STARTED' });
    await jsonPost(`/api/missions/${missionId}/events`, {
      type: 'PLAN_PROPOSED',
      payload: { plan: VALID_PLAN },
    });

    const reason = 'Too shallow: it must also cover divide-by-zero semantics explicitly.';
    const rej = await jsonPost(`/api/missions/${missionId}/plan/reject`, { reason });
    expect(rej.status).toBe(200);
    expect(await missionState(missionId)).toBe('PLANNING');

    // second, REAL planning attempt
    const res = await jsonPost(`/api/missions/${missionId}/plan`);
    expect(res.status).toBe(202);
    const { workerId } = await res.json();

    // the exact prompt is recorded and carries the feedback
    const workerEvents = await getWorkerEvents(pool, workerId);
    const taskEvent = workerEvents.find((e) => e.type === 'WORKER_TASK');
    expect(taskEvent).toBeTruthy();
    const prompt = String(taskEvent!.payload.prompt);
    expect(prompt).toContain(reason);
    expect(prompt).toContain(VALID_PLAN.summary);

    await pollUntilState(missionId, 'AWAITING_PLAN_APPROVAL', PLANNER_WAIT_MS);
    const plan = await lastPlanProposed(missionId);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  }, PLANNER_WAIT_MS + 60_000);
});

describe('T22: concurrency guard', () => {
  it('a second POST /plan while a planner is RUNNING → 409, no second worker', async () => {
    const missionId = await createMissionViaApi(
      'Add input validation to the math utilities.',
    );

    const first = await jsonPost(`/api/missions/${missionId}/plan`);
    expect(first.status).toBe(202);
    const { workerId } = await first.json();

    const second = await jsonPost(`/api/missions/${missionId}/plan`);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('PLANNING_IN_PROGRESS');

    const workersRes = await api(`/api/missions/${missionId}/workers`);
    const { workers } = await workersRes.json();
    expect(workers).toHaveLength(1);

    // clean up the running planner
    await supervisor.stopWorker(workerId, { graceful: false });
    await supervisor.waitForExit(workerId, 30_000);
    expect(await missionState(missionId)).toBe('PLANNING');

    // a third attempt is allowed once the worker is gone
    const third = await jsonPost(`/api/missions/${missionId}/plan`);
    expect(third.status).toBe(202);
    const t = await third.json();
    await supervisor.stopWorker(t.workerId, { graceful: false });
    await supervisor.waitForExit(t.workerId, 30_000);
  }, 120_000);
});

describe('plan route validation', () => {
  it('404s for unknown missions; reject requires a reason', async () => {
    const ghost = '00000000-0000-0000-0000-00000000dead';
    expect((await jsonPost(`/api/missions/${ghost}/plan`)).status).toBe(404);
    expect((await jsonPost(`/api/missions/${ghost}/plan/approve`)).status).toBe(404);

    const missionId = await createMissionViaApi('Validation mission.');
    expect(
      (await jsonPost(`/api/missions/${missionId}/plan/reject`, {})).status,
    ).toBe(400);
  });
});
