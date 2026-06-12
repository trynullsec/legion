/**
 * M6c real-agent acceptance tests — T63 (a due schedule fires a real mission
 * with a real planner) and T67 (a low-risk scheduled task mission flows
 * hands-free to the merge gate and waits). No mocks: the scheduler calls the
 * real orchestrator, which runs real workers against the real model.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  insertSchedule,
  lastCreatedRun,
  listMissionWorkers,
  runMigrations,
  type ScheduleTemplate,
} from '@legion/db';
import { Orchestrator } from '@legion/orchestrator';
import { DEFAULT_GITLEAKS_BIN } from '@legion/scanner';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import { ORIGIN, RP_ID } from '../src/approval.js';
import { Scheduler } from '../src/scheduler.js';
import { SoftKey } from './softkey.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let scheduler: Scheduler;
let app: Hono;
let scratch: string;
let fixtureRepo: string;

async function api(p: string, init?: RequestInit): Promise<Response> {
  return app.request(p, init);
}
async function jpost(p: string, body?: unknown): Promise<Response> {
  return api(p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
async function state(missionId: string): Promise<string> {
  return (await (await api(`/api/missions/${missionId}`)).json()).mission.state;
}
async function stopWorkers(missionId: string): Promise<void> {
  for (const w of await listMissionWorkers(pool, missionId)) {
    if (w.status === 'STARTING' || w.status === 'RUNNING') {
      await supervisor.stopWorker(w.workerId, { graceful: false }).catch(() => {});
      await supervisor.waitForExit(w.workerId, 30_000).catch(() => {});
    }
  }
}
async function pollUntil(fn: () => Promise<boolean>, what: string, ms = 480_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — M6c agent tests run real workers.');
  }
  if (!existsSync(DEFAULT_GITLEAKS_BIN)) {
    throw new Error(`gitleaks missing at ${DEFAULT_GITLEAKS_BIN} — run scripts/setup-scanners.sh.`);
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  await pool.query('truncate schedules, schedule_runs');
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'sched-agent-'));
  orchestrator = new Orchestrator({
    pool, supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
    deliveriesRoot: path.join(scratch, 'deliveries'),
  });
  scheduler = new Scheduler(pool, orchestrator);
  app = createApp(pool, supervisor, orchestrator, scheduler);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(path.join(fixtureRepo, 'src'), { recursive: true });
  await writeFile(path.join(fixtureRepo, 'README.md'), '# tiny fixture\n');
  await writeFile(path.join(fixtureRepo, 'src', 'math.ts'), 'export const add = (a:number,b:number)=>a+b;\n');
  await exec('git', ['init', '-q', fixtureRepo]);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

// ====================================================================
// T63: a due schedule fires a real mission with a real planner
// ====================================================================

describe('T63: due schedule fires', () => {
  it('creates a mission {scheduledBy}, planning auto-starts, schedule_runs records CREATED', async () => {
    const s = await insertSchedule(pool, {
      name: 't63',
      cron: '* * * * *',
      template: {
        kind: 'code',
        title: 'scheduled audit',
        objective: 'Add a one-line comment to src/math.ts explaining the add function.',
        repoPath: fixtureRepo,
        riskLevel: 'medium', // parks at the plan gate — keeps this test short
      } satisfies ScheduleTemplate,
    });
    await pool.query(`update schedules set created_at = now() - interval '5 minutes' where id = $1`, [s.id]);

    const fired = await scheduler.tick(new Date());
    expect(fired).toHaveLength(1);
    expect(fired[0]!.outcome).toBe('CREATED');
    const missionId = fired[0]!.missionId!;

    // mission carries {scheduledBy} in its MISSION_CREATED payload
    const events = await getMissionEvents(pool, missionId);
    expect(events[0]!.type).toBe('MISSION_CREATED');
    expect(events[0]!.payload.scheduledBy).toBe(s.id);
    expect((await (await api(`/api/missions/${missionId}`)).json()).mission.scheduledBy).toBe(s.id);

    // planning auto-started: PLANNING_STARTED + a live planner worker
    await pollUntil(async () => {
      const evs = await getMissionEvents(pool, missionId);
      return evs.some((e) => e.type === 'PLANNING_STARTED');
    }, 'PLANNING_STARTED', 60_000);
    await pollUntil(async () => {
      const ws = await listMissionWorkers(pool, missionId);
      return ws.some((w) => w.role === 'planner');
    }, 'planner worker', 60_000);

    // schedule_runs recorded CREATED with the mission id
    const created = await lastCreatedRun(pool, s.id);
    expect(created?.missionId).toBe(missionId);

    await stopWorkers(missionId);
  }, 180_000);
});

// ====================================================================
// T67: hands-free low-risk task mission flows to the gate and waits
// ====================================================================

describe('T67: hands-free to the gate', () => {
  it('low-risk scheduled task: planner → auto-approve → worker → scan → AWAITING_MERGE_APPROVAL; gate still demands the ceremony', async () => {
    const s = await insertSchedule(pool, {
      name: 't67',
      cron: '* * * * *',
      template: {
        kind: 'task',
        title: 'nightly summary',
        objective:
          'Write a two-sentence summary of what event sourcing is into summary.md. ' +
          'Do not include any credentials or secrets.',
        riskLevel: 'low', // express lane: plan auto-approves, flows hands-free
      } satisfies ScheduleTemplate,
    });
    await pool.query(`update schedules set created_at = now() - interval '5 minutes' where id = $1`, [s.id]);

    const fired = await scheduler.tick(new Date());
    expect(fired[0]!.outcome).toBe('CREATED');
    const missionId = fired[0]!.missionId!;

    // hands-free: the mission reaches the merge gate with NO human API call.
    // The only calls this test makes are tick() and read-only GETs.
    await pollUntil(
      async () => (await state(missionId)) === 'AWAITING_MERGE_APPROVAL',
      'AWAITING_MERGE_APPROVAL (hands-free)',
      540_000,
    );

    // the ledger proves the plan gate was waived by policy, not by a human
    const events = await getMissionEvents(pool, missionId);
    const approved = events.find((e) => e.type === 'PLAN_APPROVED')!;
    expect(approved.payload.autoApproved).toBe(true);
    expect(approved.payload.policy).toBe('risk:low');
    // no rejection/human plan decision events exist
    expect(events.some((e) => e.type === 'PLAN_REJECTED')).toBe(false);

    // T59 invariance: the gate still demands the full ceremony. An approval
    // attempt with an unregistered key → 401, nothing delivered.
    const opts = await (await jpost(`/api/missions/${missionId}/approval/options`)).json();
    const attacker = new SoftKey(); // never registered
    const assertion = attacker.createAssertion({
      challenge: opts.options.challenge, rpId: RP_ID, origin: ORIGIN,
    });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
    expect(res.status).toBe(401);
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL'); // still parked
  }, 600_000);
});
