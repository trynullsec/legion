import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '@legion/core';
import {
  appendEvent,
  createMission,
  createPool,
  getMissionEvents,
  runMigrations,
} from '../src/index.js';
import type { Pool } from 'pg';

const CREATION = {
  title: 'Patch JSON-RPC batch validation',
  objective: 'Reject malformed batch frames before dispatch',
  repoPath: '/tmp/repo',
  riskLevel: 'medium' as const,
};

let pool: Pool;

beforeAll(async () => {
  pool = createPool();
  // T1 precondition: a genuinely fresh database surface.
  await pool.query('drop table if exists mission_events cascade');
  await pool.query('drop table if exists worker_events cascade');
  await pool.query('drop table if exists artifacts cascade');
  await pool.query('drop table if exists schema_migrations cascade');
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query('truncate mission_events');
});

describe('T1: migrations apply cleanly and schema matches the spec', () => {
  it('applies idempotently on a second run', async () => {
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });

  it('creates mission_events with the exact §3 columns', async () => {
    const { rows } = await pool.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_name = 'mission_events'
        order by ordinal_position`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    expect(byName.id.data_type).toBe('uuid');
    expect(byName.id.column_default).toContain('gen_random_uuid');
    expect(byName.mission_id.data_type).toBe('uuid');
    expect(byName.mission_id.is_nullable).toBe('NO');
    expect(byName.seq.data_type).toBe('integer');
    expect(byName.seq.is_nullable).toBe('NO');
    expect(byName.type.data_type).toBe('text');
    expect(byName.type.is_nullable).toBe('NO');
    expect(byName.payload.data_type).toBe('jsonb');
    expect(byName.payload.is_nullable).toBe('NO');
    expect(byName.valid_from.data_type).toBe('timestamp with time zone');
    expect(byName.valid_from.is_nullable).toBe('NO');
    expect(byName.recorded_at.data_type).toBe('timestamp with time zone');
    expect(byName.recorded_at.is_nullable).toBe('NO');
  });

  it('enforces unique(mission_id, seq) and pk on id', async () => {
    const { rows } = await pool.query(
      `select tc.constraint_type, array_agg(kcu.column_name::text order by kcu.ordinal_position) cols
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name
        where tc.table_name = 'mission_events'
          and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
        group by tc.constraint_name, tc.constraint_type`,
    );
    const pk = rows.find((r) => r.constraint_type === 'PRIMARY KEY');
    const uq = rows.find((r) => r.constraint_type === 'UNIQUE');
    expect(pk?.cols).toEqual(['id']);
    expect(uq?.cols).toEqual(['mission_id', 'seq']);
  });
});

describe('T2 (db): mission creation', () => {
  it('appends MISSION_CREATED with seq=1 and folds to DRAFT with the payload', async () => {
    const mission = await createMission(pool, CREATION);

    const events = await getMissionEvents(pool, mission.missionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.type).toBe('MISSION_CREATED');
    expect(events[0]?.payload).toEqual(CREATION);

    expect(mission.state).toBe('DRAFT');
    expect(mission.title).toBe(CREATION.title);
    expect(mission.objective).toBe(CREATION.objective);
    expect(mission.repoPath).toBe(CREATION.repoPath);
    expect(mission.riskLevel).toBe('medium');
  });
});

describe('T7: concurrent appends cannot create duplicate seq', () => {
  it('serializes parallel identical appends: exactly one wins, log stays gapless', async () => {
    const mission = await createMission(pool, CREATION);

    const results = await Promise.allSettled([
      appendEvent(pool, mission.missionId, 'MISSION_CANCELLED', {}),
      appendEvent(pool, mission.missionId, 'MISSION_CANCELLED', {}),
      appendEvent(pool, mission.missionId, 'MISSION_CANCELLED', {}),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      // losers surface as domain conflicts after retry, never as raw PG errors
      expect(r.reason).toBeInstanceOf(IllegalTransitionError);
    }

    const events = await getMissionEvents(pool, mission.missionId);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1]?.type).toBe('MISSION_CANCELLED');
  });

  it('unique constraint surfaces as a retryable conflict: one wins, one retries successfully', async () => {
    const mission = await createMission(pool, CREATION);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // Both clients read the same max(seq) before either writes — a guaranteed collision.
      const nextOf = async (c: typeof a) => {
        const r = await c.query(
          'select coalesce(max(seq), 0) + 1 as next from mission_events where mission_id = $1',
          [mission.missionId],
        );
        return Number(r.rows[0].next);
      };
      const seqA = await nextOf(a);
      const seqB = await nextOf(b);
      expect(seqA).toBe(seqB);

      await a.query(
        `insert into mission_events (mission_id, seq, type, payload) values ($1, $2, 'PLANNING_STARTED', '{}')`,
        [mission.missionId, seqA],
      );

      // B loses with a unique violation — the retryable conflict.
      let code: string | undefined;
      try {
        await b.query(
          `insert into mission_events (mission_id, seq, type, payload) values ($1, $2, 'PLAN_PROPOSED', '{}')`,
          [mission.missionId, seqB],
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe('23505');

      // B retries: recompute seq against the new log and succeed.
      const retrySeq = await nextOf(b);
      expect(retrySeq).toBe(seqA + 1);
      await b.query(
        `insert into mission_events (mission_id, seq, type, payload) values ($1, $2, 'PLAN_PROPOSED', '{}')`,
        [mission.missionId, retrySeq],
      );

      const events = await getMissionEvents(pool, mission.missionId);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    } finally {
      a.release();
      b.release();
    }
  });
});
