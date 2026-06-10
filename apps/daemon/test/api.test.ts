import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@legion/db';
import { createApp } from '../src/app.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const CREATION = {
  title: 'Canary deploy v2.3 to EU region',
  objective: 'Stage, canary, and roll out v2.3',
  repoPath: '/tmp/repo',
  riskLevel: 'low' as const,
};

const HAPPY_PATH = [
  'PLANNING_STARTED',
  'PLAN_PROPOSED',
  'PLAN_APPROVED',
  'BUILD_STARTED',
  'BUILD_COMPLETED',
  'SCAN_STARTED',
  'SCAN_PASSED',
  'MERGE_APPROVED',
] as const;

let pool: Pool;
let app: Hono;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

async function createMissionViaApi(): Promise<string> {
  const res = await api('/api/missions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREATION),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.mission.missionId as string;
}

async function appendViaApi(
  missionId: string,
  type: string,
): Promise<Response> {
  return api(`/api/missions/${missionId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload: {} }),
  });
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = createApp(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('truncate mission_events');
});

describe('T2 (api): mission creation', () => {
  it('creates a mission, appending MISSION_CREATED with seq=1, folded state DRAFT', async () => {
    const missionId = await createMissionViaApi();

    const res = await api(`/api/missions/${missionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.mission.state).toBe('DRAFT');
    expect(body.mission.title).toBe(CREATION.title);
    expect(body.mission.objective).toBe(CREATION.objective);
    expect(body.mission.repoPath).toBe(CREATION.repoPath);
    expect(body.mission.riskLevel).toBe('low');

    expect(body.events).toHaveLength(1);
    expect(body.events[0].seq).toBe(1);
    expect(body.events[0].type).toBe('MISSION_CREATED');
    expect(body.events[0].payload).toEqual(CREATION);
  });

  it('rejects invalid creation payloads with 400', async () => {
    const res = await api('/api/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '', riskLevel: 'extreme' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('T3: full happy path folds to MERGED', () => {
  it('runs the 8 lifecycle events and ends MERGED with a gapless 9-event timeline', async () => {
    const missionId = await createMissionViaApi();

    for (const type of HAPPY_PATH) {
      const res = await appendViaApi(missionId, type);
      expect(res.status).toBe(201);
    }

    const res = await api(`/api/missions/${missionId}`);
    const body = await res.json();
    expect(body.mission.state).toBe('MERGED');
    expect(body.events).toHaveLength(9);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});

describe('T4 (api): illegal transition returns 409 with typed error body', () => {
  it('rejects SCAN_STARTED on a DRAFT mission', async () => {
    const missionId = await createMissionViaApi();

    const res = await appendViaApi(missionId, 'SCAN_STARTED');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('ILLEGAL_TRANSITION');
    expect(body.missionId).toBe(missionId);
    expect(body.from).toBe('DRAFT');
    expect(body.event).toBe('SCAN_STARTED');

    // the illegal event must not have been appended
    const detail = await (await api(`/api/missions/${missionId}`)).json();
    expect(detail.events).toHaveLength(1);
  });
});

describe('T5: plan rejection returns to PLANNING, then proceeds', () => {
  it('PLAN_REJECTED → PLANNING, second proposal completes the lifecycle', async () => {
    const missionId = await createMissionViaApi();

    for (const type of ['PLANNING_STARTED', 'PLAN_PROPOSED', 'PLAN_REJECTED']) {
      const res = await appendViaApi(missionId, type);
      expect(res.status).toBe(201);
    }

    let body = await (await api(`/api/missions/${missionId}`)).json();
    expect(body.mission.state).toBe('PLANNING');

    for (const type of [
      'PLAN_PROPOSED',
      'PLAN_APPROVED',
      'BUILD_STARTED',
      'BUILD_COMPLETED',
      'SCAN_STARTED',
      'SCAN_PASSED',
      'MERGE_APPROVED',
    ]) {
      const res = await appendViaApi(missionId, type);
      expect(res.status).toBe(201);
    }

    body = await (await api(`/api/missions/${missionId}`)).json();
    expect(body.mission.state).toBe('MERGED');
    expect(body.events).toHaveLength(11);
  });
});

describe('T6: bitemporal state as of recorded_at', () => {
  it('returns the historical state at event 3 after events 4..9 exist', async () => {
    const missionId = await createMissionViaApi();

    // events 2 and 3
    await appendViaApi(missionId, 'PLANNING_STARTED');
    await appendViaApi(missionId, 'PLAN_PROPOSED');

    const detail = await (await api(`/api/missions/${missionId}`)).json();
    const third = detail.events.find((e: { seq: number }) => e.seq === 3);
    const asOf: string = third.recordedAt;

    // ensure later events record strictly after the captured timestamp
    await new Promise((r) => setTimeout(r, 10));

    for (const type of [
      'PLAN_APPROVED',
      'BUILD_STARTED',
      'BUILD_COMPLETED',
      'SCAN_STARTED',
      'SCAN_PASSED',
      'MERGE_APPROVED',
    ]) {
      const res = await appendViaApi(missionId, type);
      expect(res.status).toBe(201);
    }

    const now = await (await api(`/api/missions/${missionId}`)).json();
    expect(now.mission.state).toBe('MERGED');

    const res = await api(
      `/api/missions/${missionId}/state?asOf=${encodeURIComponent(asOf)}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('AWAITING_PLAN_APPROVAL');
    expect(body.missionId).toBe(missionId);
  });

  it('distinguishes two events recorded 1µs apart in the same millisecond', async () => {
    // Build the log with explicit recorded_at values: events 2 and 3 share
    // the same millisecond (.123455 vs .123456) — only microsecond-precision
    // comparison can tell them apart.
    const missionId = crypto.randomUUID();
    const t1 = '2026-01-01T00:00:00.000000Z';
    const t2 = '2026-01-01T00:00:01.123455Z';
    const t3 = '2026-01-01T00:00:01.123456Z';
    const rows: Array<[number, string, string, string]> = [
      [1, 'MISSION_CREATED', JSON.stringify(CREATION), t1],
      [2, 'PLANNING_STARTED', '{}', t2],
      [3, 'PLAN_PROPOSED', '{}', t3],
    ];
    for (const [seq, type, payload, ts] of rows) {
      await pool.query(
        `insert into mission_events (mission_id, seq, type, payload, valid_from, recorded_at)
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
        [missionId, seq, type, payload, ts],
      );
    }

    // as-of event 2's exact timestamp: includes event 2, excludes event 3
    const at2 = await api(
      `/api/missions/${missionId}/state?asOf=${encodeURIComponent(t2)}`,
    );
    expect(at2.status).toBe(200);
    expect((await at2.json()).state).toBe('PLANNING');

    // one microsecond later the third event is visible
    const at3 = await api(
      `/api/missions/${missionId}/state?asOf=${encodeURIComponent(t3)}`,
    );
    expect(at3.status).toBe(200);
    expect((await at3.json()).state).toBe('AWAITING_PLAN_APPROVAL');

    // the API timeline itself must carry full microsecond precision
    const detail = await (await api(`/api/missions/${missionId}`)).json();
    const recorded = detail.events.map(
      (e: { recordedAt: string }) => e.recordedAt,
    );
    expect(recorded).toEqual([t1, t2, t3]);
  });

  it('400s on an invalid asOf and 404s before the mission existed', async () => {
    const missionId = await createMissionViaApi();

    const bad = await api(`/api/missions/${missionId}/state?asOf=not-a-date`);
    expect(bad.status).toBe(400);

    const before = await api(
      `/api/missions/${missionId}/state?asOf=${encodeURIComponent('1990-01-01T00:00:00Z')}`,
    );
    expect(before.status).toBe(404);
  });
});

describe('T8: mission list with folded states', () => {
  it('returns all missions with correct folded current states', async () => {
    const draftId = await createMissionViaApi();

    const planningId = await createMissionViaApi();
    await appendViaApi(planningId, 'PLANNING_STARTED');

    const mergedId = await createMissionViaApi();
    for (const type of HAPPY_PATH) {
      await appendViaApi(mergedId, type);
    }

    const cancelledId = await createMissionViaApi();
    await appendViaApi(cancelledId, 'MISSION_CANCELLED');

    const res = await api('/api/missions');
    expect(res.status).toBe(200);
    const { missions } = await res.json();
    expect(missions).toHaveLength(4);

    const stateOf = (id: string) =>
      missions.find((m: { missionId: string }) => m.missionId === id)?.state;
    expect(stateOf(draftId)).toBe('DRAFT');
    expect(stateOf(planningId)).toBe('PLANNING');
    expect(stateOf(mergedId)).toBe('MERGED');
    expect(stateOf(cancelledId)).toBe('CANCELLED');
  });
});

describe('not-found handling', () => {
  it('404s for an unknown mission id', async () => {
    const res = await api(
      '/api/missions/00000000-0000-0000-0000-00000000dead',
    );
    expect(res.status).toBe(404);
  });

  it('404s when appending to an unknown mission', async () => {
    const res = await appendViaApi(
      '00000000-0000-0000-0000-00000000dead',
      'PLANNING_STARTED',
    );
    expect(res.status).toBe(404);
  });
});
