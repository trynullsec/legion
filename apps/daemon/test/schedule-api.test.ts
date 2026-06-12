/**
 * M6c deterministic acceptance tests — T64 (concurrency guard), T65
 * (catch-up), T66 (run-now + disabled), T68 (CRUD). These drive the
 * scheduler's tick(now) and runNow directly with REAL rows — no fake timers
 * stand in for the loop. Firing creates a real mission but we don't run its
 * planner here (T63/T67 cover the real-agent path); we stop any spawned
 * worker immediately and assert the scheduling semantics.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  createPool,
  getSchedule,
  insertSchedule,
  insertScheduleRun,
  lastCreatedRun,
  listScheduleRuns,
  runMigrations,
  type ScheduleTemplate,
} from '@legion/db';
import { Orchestrator } from '@legion/orchestrator';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import { Scheduler } from '../src/scheduler.js';
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

const TEMPLATE = (over: Partial<ScheduleTemplate> = {}): ScheduleTemplate => ({
  kind: 'code',
  title: 'nightly audit',
  objective: 'scheduled mission for guard/CRUD testing',
  repoPath: fixtureRepo,
  riskLevel: 'medium', // medium: never auto-approves, so the planner is the only worker
  ...over,
});

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

/** Stop any worker the firing spawned — these tests assert scheduling, not agents. */
async function stopWorkers(missionId: string): Promise<void> {
  const workers = (await (await api(`/api/missions/${missionId}/workers`)).json())
    .workers as { workerId: string; status: string }[];
  for (const w of workers) {
    if (w.status === 'STARTING' || w.status === 'RUNNING') {
      await supervisor.stopWorker(w.workerId, { graceful: false }).catch(() => {});
      await supervisor.waitForExit(w.workerId, 30_000).catch(() => {});
    }
  }
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — scheduler creates real missions.');
  }
  pool = createPool();
  await runMigrations(pool);
  supervisor = new WorkerSupervisor({ pool });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'sched-'));
  orchestrator = new Orchestrator({
    pool,
    supervisor,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
  });
  scheduler = new Scheduler(pool, orchestrator);
  app = createApp(pool, supervisor, orchestrator, scheduler);

  fixtureRepo = path.join(scratch, 'fixture-repo');
  await mkdir(path.join(fixtureRepo, 'src'), { recursive: true });
  await writeFile(path.join(fixtureRepo, 'README.md'), '# fixture\n');
  await exec('git', ['init', '-q', fixtureRepo]);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
  await exec('git', ['-C', fixtureRepo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'init']);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

beforeEach(async () => {
  await pool.query('truncate schedules, schedule_runs');
});

// ====================================================================
// T68: schedule CRUD — strict schemas, PATCH, DELETE leaves missions intact
// ====================================================================

describe('T68: schedule CRUD', () => {
  it('create rejects invalid cron and bad templates; lists with computed nextRunAt', async () => {
    // invalid cron → 400
    const badCron = await jpost('/api/schedules', {
      name: 's-badcron', cron: 'not a cron', template: TEMPLATE(),
    });
    expect(badCron.status).toBe(400);

    // task template with repoPath → 400 (kind discrimination)
    const badTemplate = await jpost('/api/schedules', {
      name: 's-badtmpl', cron: '0 3 * * *',
      template: { kind: 'task', title: 't', objective: 'o', repoPath: '/x', riskLevel: 'low' },
    });
    expect(badTemplate.status).toBe(400);

    // unknown template field → 400 (strict)
    const extra = await jpost('/api/schedules', {
      name: 's-extra', cron: '0 3 * * *',
      template: { ...TEMPLATE(), bogus: 1 },
    });
    expect(extra.status).toBe(400);

    // valid create → 201 with computed nextRunAt
    const ok = await jpost('/api/schedules', {
      name: 's-ok', cron: '0 3 * * *', template: TEMPLATE(),
    });
    expect(ok.status).toBe(201);
    const { schedule } = await ok.json();
    expect(schedule.nextRunAt).toBeTruthy();
    expect(schedule.lastOutcome).toBeNull();

    // duplicate name → 409
    const dup = await jpost('/api/schedules', {
      name: 's-ok', cron: '0 4 * * *', template: TEMPLATE(),
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('NAME_CONFLICT');

    const list = await (await api('/api/schedules')).json();
    expect(list.schedules.length).toBeGreaterThanOrEqual(1);
  });

  it('PATCH cron takes effect on the next computation; PATCH validates', async () => {
    const created = (await (await jpost('/api/schedules', {
      name: 's-patch', cron: '0 3 * * *', template: TEMPLATE(),
    })).json()).schedule;
    const before = created.nextRunAt;

    // invalid cron patch → 400, unchanged
    const bad = await api(`/api/schedules/${created.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cron: 'nope' }),
    });
    expect(bad.status).toBe(400);

    // valid cron patch → next computation reflects it
    const res = await api(`/api/schedules/${created.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cron: '0 4 * * *', enabled: false }),
    });
    expect(res.status).toBe(200);
    const after = (await res.json()).schedule;
    expect(after.cron).toBe('0 4 * * *');
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).not.toBe(before); // recomputed from the new cron
  });

  it('DELETE leaves the scheduled missions intact (pin 6)', async () => {
    const created = (await (await jpost('/api/schedules', {
      name: 's-del', cron: '* * * * *', template: TEMPLATE(),
    })).json()).schedule;

    // fire once to create a real mission tied to this schedule
    const fired = await scheduler.runNow(created.id);
    expect(fired?.outcome).toBe('CREATED');
    const missionId = fired!.missionId!;
    await stopWorkers(missionId);

    // delete the schedule
    expect((await api(`/api/schedules/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await getSchedule(pool, created.id)).toBeNull();

    // the mission still exists, its scheduledBy still points at the dead id
    const mission = (await (await api(`/api/missions/${missionId}`)).json()).mission;
    expect(mission.missionId).toBe(missionId);
    expect(mission.scheduledBy).toBe(created.id);
  });
});

// ====================================================================
// T64: concurrency guard — one mission per schedule in flight, ever
// ====================================================================

describe('T64: concurrency guard', () => {
  it('a due tick fires once; while non-terminal a second tick records SKIPPED_ACTIVE; terminal → fires again', async () => {
    const s = await insertSchedule(pool, {
      name: 'guard', cron: '* * * * *', template: TEMPLATE(),
    });
    // anchor the schedule in the past so it is due now
    await pool.query(`update schedules set created_at = now() - interval '5 minutes' where id = $1`, [s.id]);

    const first = await scheduler.tick(new Date());
    expect(first).toHaveLength(1);
    expect(first[0]!.outcome).toBe('CREATED');
    const missionId = first[0]!.missionId!;
    await stopWorkers(missionId);

    // make the schedule due again (backdate its CREATED run); the mission is
    // still non-terminal (PLANNING) → the due tick records SKIPPED_ACTIVE
    await pool.query(
      `update schedule_runs set fired_at = now() - interval '2 minutes'
        where schedule_id = $1 and outcome = 'CREATED'`,
      [s.id],
    );
    const second = await scheduler.tick(new Date());
    expect(second).toHaveLength(1);
    expect(second[0]!.outcome).toBe('SKIPPED_ACTIVE');
    // no second mission was created
    const created = await pool.query(
      `select count(*)::int as n from schedule_runs where schedule_id = $1 and outcome = 'CREATED'`,
      [s.id],
    );
    expect(created.rows[0].n).toBe(1);

    // drive the mission to a terminal state, then the (still-due) next tick fires again
    await appendEvent(pool, missionId, 'MISSION_CANCELLED');
    const third = await scheduler.tick(new Date());
    expect(third).toHaveLength(1);
    expect(third[0]!.outcome).toBe('CREATED');
    expect(third[0]!.missionId).not.toBe(missionId);
    await stopWorkers(third[0]!.missionId!);
  }, 120_000);
});

// ====================================================================
// T65: catch-up — N missed intervals collapse into exactly one mission
// ====================================================================

describe('T65: catch-up fires exactly once', () => {
  it('3 missed intervals → one mission on the next tick; detail notes the catch-up', async () => {
    const s = await insertSchedule(pool, {
      name: 'catchup', cron: '0 * * * *', template: TEMPLATE(), // hourly
    });
    // a CREATED run 3+ hours ago whose mission is already terminal (so the
    // concurrency guard does not interfere), simulating downtime
    const old = await createTerminalMission();
    await insertScheduleRun(pool, {
      scheduleId: s.id,
      outcome: 'CREATED',
      missionId: old,
      firedAt: new Date(Date.now() - 3 * 60 * 60 * 1000 - 5 * 60 * 1000),
    });

    const fired = await scheduler.tick(new Date());
    expect(fired).toHaveLength(1);
    expect(fired[0]!.outcome).toBe('CREATED');
    expect(fired[0]!.detail).toMatch(/catch-up: \d+ intervals missed, fired once/);
    await stopWorkers(fired[0]!.missionId!);

    // exactly one new CREATED run since the old one
    const runs = await listScheduleRuns(pool, s.id);
    const createds = runs.filter((r) => r.outcome === 'CREATED');
    expect(createds).toHaveLength(2); // the seeded old one + exactly one catch-up

    // the next anchor is now: an immediate second tick is NOT due
    const again = await scheduler.tick(new Date());
    // either skipped-active (new mission still planning) or simply not due —
    // in both cases NO new CREATED row appears
    const after = (await listScheduleRuns(pool, s.id)).filter((r) => r.outcome === 'CREATED');
    expect(after).toHaveLength(2);
    expect(again.every((r) => r.outcome !== 'CREATED')).toBe(true);
  }, 120_000);
});

/** A mission already in a terminal state, so the concurrency guard is clear. */
async function createTerminalMission(): Promise<string> {
  const res = await jpost('/api/missions', {
    title: 'old', objective: 'seed', repoPath: fixtureRepo, riskLevel: 'medium',
  });
  const id = (await res.json()).mission.missionId as string;
  await appendEvent(pool, id, 'MISSION_CANCELLED');
  return id;
}

// ====================================================================
// T66: run-now under the guard; disabled → 409, ticks ignore silently
// ====================================================================

describe('T66: run-now and disabled schedules', () => {
  it('run-now fires immediately under the guard; disabled → 409; ticks never fire disabled', async () => {
    const s = await insertSchedule(pool, {
      name: 'runnow', cron: '0 3 * * *', template: TEMPLATE(), // not due now
    });

    // run-now fires despite not being due on the clock
    const r1 = await jpost(`/api/schedules/${s.id}/run-now`);
    expect(r1.status).toBe(202);
    const created = await lastCreatedRun(pool, s.id);
    expect(created?.missionId).toBeTruthy();
    const missionId = created!.missionId!;
    await stopWorkers(missionId);

    // run-now again while the mission is non-terminal → SKIPPED_ACTIVE (202, no new mission)
    const r2 = await jpost(`/api/schedules/${s.id}/run-now`);
    expect(r2.status).toBe(202);
    expect((await r2.json()).result.outcome).toBe('SKIPPED_ACTIVE');

    // disable it
    await pool.query(`update schedules set enabled = false where id = $1`, [s.id]);

    // run-now on a disabled schedule → 409, records SKIPPED_DISABLED
    const r3 = await jpost(`/api/schedules/${s.id}/run-now`);
    expect(r3.status).toBe(409);
    expect((await r3.json()).error).toBe('SCHEDULE_DISABLED');
    const runs = await listScheduleRuns(pool, s.id);
    expect(runs.some((r) => r.outcome === 'SKIPPED_DISABLED')).toBe(true);

    // a tick ignores disabled schedules silently (no run row, no error)
    const before = (await listScheduleRuns(pool, s.id)).length;
    // make it "due" too, to prove the tick still ignores it
    await pool.query(`update schedules set cron = '* * * * *', created_at = now() - interval '5 minutes' where id = $1`, [s.id]);
    const ticked = await scheduler.tick(new Date());
    expect(ticked.find((t) => t.scheduleId === s.id)).toBeUndefined();
    expect((await listScheduleRuns(pool, s.id)).length).toBe(before); // nothing recorded
  }, 120_000);
});
