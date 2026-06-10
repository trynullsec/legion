import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  EVENT_TYPES,
  IllegalTransitionError,
  RISK_LEVELS,
} from '@legion/core';
import {
  appendEvent,
  createMission,
  getMission,
  getStateAsOf,
  listMissions,
  MissionNotFoundError,
  type MissionRecord,
  type StoredEvent,
} from '@legion/db';
import {
  WorkerNotFoundError,
  WorkerNotRunningError,
  type WorkerSupervisor,
} from '@legion/runtime';
import {
  PlanningInProgressError,
  PlanningStateError,
  type Orchestrator,
} from '@legion/orchestrator';
import type { Pool } from 'pg';

const createMissionSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  repoPath: z.string().min(1),
  riskLevel: z.enum(RISK_LEVELS),
});

const appendEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.unknown()).optional(),
});

const spawnWorkerSchema = z.object({
  role: z.string().min(1),
  task: z.string().min(1),
  workdir: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const stopWorkerSchema = z.object({
  graceful: z.boolean(),
});

const rejectPlanSchema = z.object({
  reason: z.string().min(1),
});

// Timestamps arrive from @legion/db as microsecond-precision UTC strings and
// are passed through untouched — never round-tripped through a JS Date.
function serializeMission(m: MissionRecord) {
  return {
    missionId: m.missionId,
    state: m.state,
    title: m.title,
    objective: m.objective,
    repoPath: m.repoPath,
    riskLevel: m.riskLevel,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    eventCount: m.eventCount,
  };
}

function serializeEvent(e: StoredEvent) {
  return {
    id: e.id,
    missionId: e.missionId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    validFrom: e.validFrom,
    recordedAt: e.recordedAt,
  };
}

export function createApp(
  pool: Pool,
  supervisor?: WorkerSupervisor,
  orchestrator?: Orchestrator,
): Hono {
  const app = new Hono();

  app.post('/api/missions', async (c) => {
    const parsed = createMissionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION', issues: parsed.error.issues },
        400,
      );
    }
    const mission = await createMission(pool, parsed.data);
    return c.json({ mission: serializeMission(mission) }, 201);
  });

  app.get('/api/missions', async (c) => {
    const missions = await listMissions(pool);
    return c.json({ missions: missions.map(serializeMission) });
  });

  app.get('/api/missions/:id', async (c) => {
    const result = await getMission(pool, c.req.param('id'));
    if (!result) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    return c.json({
      mission: serializeMission(result.mission),
      events: result.events.map(serializeEvent),
    });
  });

  app.post('/api/missions/:id/events', async (c) => {
    const parsed = appendEventSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION', issues: parsed.error.issues },
        400,
      );
    }
    const missionId = c.req.param('id');
    try {
      const mission = await appendEvent(
        pool,
        missionId,
        parsed.data.type,
        parsed.data.payload ?? {},
      );
      return c.json({ mission: serializeMission(mission) }, 201);
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        return c.json(
          {
            error: 'ILLEGAL_TRANSITION',
            missionId: e.missionId,
            from: e.from,
            event: e.event,
          },
          409,
        );
      }
      if (e instanceof MissionNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      throw e;
    }
  });

  app.get('/api/missions/:id/state', async (c) => {
    const raw = c.req.query('asOf');
    if (!raw) {
      return c.json({ error: 'VALIDATION', message: 'asOf is required' }, 400);
    }
    // Sanity-check only — the raw string goes to Postgres untruncated, so
    // microsecond precision survives. Date.parse is never used as the value.
    if (Number.isNaN(Date.parse(raw))) {
      return c.json(
        { error: 'VALIDATION', message: 'asOf must be a valid timestamp' },
        400,
      );
    }
    const missionId = c.req.param('id');
    let state;
    try {
      state = await getStateAsOf(pool, missionId, raw);
    } catch (e) {
      if ((e as { code?: string }).code === '22007') {
        return c.json(
          { error: 'VALIDATION', message: 'asOf must be a valid timestamp' },
          400,
        );
      }
      throw e;
    }
    if (state === null) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    return c.json({ missionId, asOf: raw, state });
  });

  // ---------- M2: planning loop ----------

  const requireOrchestrator = () => {
    if (!orchestrator) throw new Error('orchestrator is not configured');
    return orchestrator;
  };

  app.post('/api/missions/:id/plan', async (c) => {
    const orch = requireOrchestrator();
    const missionId = c.req.param('id');
    try {
      const { workerId, settled } = await orch.startPlanning(missionId);
      // process the attempt in the background; outcomes land in the event logs
      void settled.catch((e) =>
        console.error(`planning attempt for ${missionId} failed:`, e),
      );
      return c.json({ workerId }, 202);
    } catch (e) {
      if (e instanceof MissionNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      if (e instanceof PlanningStateError) {
        return c.json(
          { error: 'INVALID_STATE', missionId: e.missionId, state: e.state },
          409,
        );
      }
      if (e instanceof PlanningInProgressError) {
        return c.json(
          { error: 'PLANNING_IN_PROGRESS', workerId: e.workerId },
          409,
        );
      }
      throw e;
    }
  });

  const planDecision = async (
    c: Context,
    type: 'PLAN_APPROVED' | 'PLAN_REJECTED',
    payload: Record<string, unknown>,
  ) => {
    const missionId = c.req.param('id') ?? '';
    try {
      const mission = await appendEvent(pool, missionId, type, payload);
      return c.json({ mission: serializeMission(mission) });
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        return c.json(
          {
            error: 'ILLEGAL_TRANSITION',
            missionId: e.missionId,
            from: e.from,
            event: e.event,
          },
          409,
        );
      }
      if (e instanceof MissionNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      throw e;
    }
  };

  app.post('/api/missions/:id/plan/approve', (c) =>
    planDecision(c, 'PLAN_APPROVED', {}),
  );

  app.post('/api/missions/:id/plan/reject', async (c) => {
    const parsed = rejectPlanSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    return planDecision(c, 'PLAN_REJECTED', { reason: parsed.data.reason });
  });

  // ---------- M1: worker runtime ----------

  const requireSupervisor = () => {
    if (!supervisor) {
      throw new Error('worker supervisor is not configured');
    }
    return supervisor;
  };

  app.post('/api/missions/:id/workers', async (c) => {
    const sup = requireSupervisor();
    const parsed = spawnWorkerSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    const missionId = c.req.param('id');
    const mission = await getMission(pool, missionId);
    if (!mission) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    const workerId = await sup.startWorker({
      missionId,
      role: parsed.data.role,
      task: parsed.data.task,
      workdir: parsed.data.workdir,
      timeoutMs: parsed.data.timeoutMs,
    });
    const worker = await sup.getWorker(workerId);
    return c.json({ worker }, 201);
  });

  app.get('/api/missions/:id/workers', async (c) => {
    const sup = requireSupervisor();
    const workers = await sup.listWorkers(c.req.param('id'));
    return c.json({ workers });
  });

  app.post('/api/workers/:id/stop', async (c) => {
    const sup = requireSupervisor();
    const parsed = stopWorkerSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    try {
      await sup.stopWorker(c.req.param('id'), {
        graceful: parsed.data.graceful,
      });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof WorkerNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      if (e instanceof WorkerNotRunningError) {
        return c.json({ error: 'NOT_RUNNING', workerId: e.workerId }, 409);
      }
      throw e;
    }
  });

  app.get('/api/workers/:id/events', async (c) => {
    const sup = requireSupervisor();
    const workerId = c.req.param('id');
    const events = await sup.getWorkerEvents(workerId);
    if (events.length === 0) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        missionId: e.missionId,
        workerId: e.workerId,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        recordedAt: e.recordedAt,
      })),
    });
  });

  return app;
}
