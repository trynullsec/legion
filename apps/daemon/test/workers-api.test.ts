import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@legion/db';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const CREATION = {
  title: 'M1 worker API round-trip',
  objective: 'Spawn, observe, stop via HTTP',
  repoPath: '/tmp/repo',
  riskLevel: 'low' as const,
};

let pool: Pool;
let supervisor: WorkerSupervisor;
let app: Hono;
let scratch: string;

async function api(pathname: string, init?: RequestInit): Promise<Response> {
  return app.request(pathname, init);
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is missing from the repo-root .env — T15 spawns a ' +
        'real Hermes worker over the API and cannot run without it.',
    );
  }
  pool = createPool();
  await runMigrations(pool);
  supervisor = new WorkerSupervisor({ pool });
  app = createApp(pool, supervisor);
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'workers-api-'));
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T15: API round-trip leaves mission_events untouched', () => {
  it('spawn via POST, observe via GET, stop via POST', async () => {
    // create a mission over the API
    const createRes = await api('/api/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CREATION),
    });
    expect(createRes.status).toBe(201);
    const missionId = (await createRes.json()).mission.missionId as string;

    const missionEventCount = async (): Promise<number> => {
      const r = await pool.query(
        'select count(*)::int as n from mission_events where mission_id = $1',
        [missionId],
      );
      return r.rows[0].n as number;
    };
    const baseline = await missionEventCount();

    // spawn a long-running worker via POST
    const spawnRes = await api(`/api/missions/${missionId}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // M7: workers run under an OS capability profile keyed by role — use a
        // canonical role so the profile resolves (an unknown role refuses).
        role: 'coder',
        task: "Run the shell command 'sleep 300' and wait for it to complete.",
        workdir: path.join(scratch, `t15-${randomUUID()}`),
      }),
    });
    expect(spawnRes.status).toBe(201);
    const workerId = (await spawnRes.json()).worker.workerId as string;

    // worker listed for the mission with a live status
    const listRes = await api(`/api/missions/${missionId}/workers`);
    expect(listRes.status).toBe(200);
    const { workers } = await listRes.json();
    const listed = workers.find(
      (w: { workerId: string }) => w.workerId === workerId,
    );
    expect(listed).toBeTruthy();
    expect(['STARTING', 'RUNNING']).toContain(listed.status);

    // give it time to produce real trajectory, then observe via GET
    await new Promise((r) => setTimeout(r, 10_000));
    const eventsRes = await api(`/api/workers/${workerId}/events`);
    expect(eventsRes.status).toBe(200);
    const { events } = await eventsRes.json();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const seqs = events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(events[0].type).toBe('WORKER_CREATED');

    // stop via POST
    const stopRes = await api(`/api/workers/${workerId}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graceful: false }),
    });
    expect(stopRes.status).toBe(200);
    await supervisor.waitForExit(workerId, 30_000);

    const finalRes = await api(`/api/missions/${missionId}/workers`);
    const final = (await finalRes.json()).workers.find(
      (w: { workerId: string }) => w.workerId === workerId,
    );
    expect(final.status).toBe('KILLED');

    // mission_events untouched by all worker activity
    expect(await missionEventCount()).toBe(baseline);
  }, 240_000);

  it('404s for workers on an unknown mission and unknown worker ids', async () => {
    const ghost = '00000000-0000-0000-0000-00000000dead';
    expect(
      (
        await api(`/api/missions/${ghost}/workers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'x', task: 'y' }),
        })
      ).status,
    ).toBe(404);
    expect((await api(`/api/workers/${ghost}/events`)).status).toBe(404);
    expect(
      (
        await api(`/api/workers/${ghost}/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ graceful: true }),
        })
      ).status,
    ).toBe(404);
  });
});
