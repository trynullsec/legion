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
  getArtifact,
  getMission,
  getStateAsOf,
  latestScanAttempt,
  listArtifacts,
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
  BuildInProgressError,
  BuildStateError,
  PlanningInProgressError,
  PlanningStateError,
  ScanInProgressError,
  ScanStateError,
  type Orchestrator,
} from '@legion/orchestrator';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { countApprovers, listApprovals } from '@legion/db';
import {
  buildApprovalOptions,
  buildRegistrationOptions,
  IntegrityError,
  recomputeBoundHashes,
  verifyCeremony,
  verifyRegistration,
} from './approval.js';
import type { Pool } from 'pg';

// Every HTTP boundary schema is strict: unknown keys (e.g. smuggled internal
// overrides like taskOverride) are rejected with 400, never passed through.
const createMissionSchema = z
  .object({
    title: z.string().min(1),
    objective: z.string().min(1),
    repoPath: z.string().min(1),
    riskLevel: z.enum(RISK_LEVELS),
  })
  .strict();

const appendEventSchema = z
  .object({
    type: z.enum(EVENT_TYPES),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

const spawnWorkerSchema = z
  .object({
    role: z.string().min(1),
    task: z.string().min(1),
    workdir: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const stopWorkerSchema = z
  .object({
    graceful: z.boolean(),
  })
  .strict();

const rejectPlanSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

const registerSchema = z
  .object({
    response: z.record(z.unknown()),
    label: z.string().min(1).optional(),
  })
  .strict();

const approveSchema = z
  .object({
    response: z.record(z.unknown()),
  })
  .strict();

const rejectMergeSchema = z
  .object({
    response: z.record(z.unknown()),
    reason: z.string().min(1),
  })
  .strict();

/** Routes that take no body still reject any unknown keys (pin 9). */
const emptyBodySchema = z.object({}).strict();

async function readEmptyBody(c: Context): Promise<boolean> {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  return emptyBodySchema.safeParse(body ?? {}).success;
}

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
    if (!(await readEmptyBody(c))) {
      return c.json(
        { error: 'VALIDATION', message: 'this route accepts no body fields' },
        400,
      );
    }
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

  // ---------- M3: build loop ----------

  app.post('/api/missions/:id/build', async (c) => {
    const orch = requireOrchestrator();
    if (!(await readEmptyBody(c))) {
      return c.json(
        { error: 'VALIDATION', message: 'this route accepts no body fields' },
        400,
      );
    }
    const missionId = c.req.param('id');
    try {
      const { attempt, coderWorkerId, settled } = await orch.startBuild(missionId);
      void settled.catch((e) =>
        console.error(`build attempt for ${missionId} failed:`, e),
      );
      return c.json({ attempt, coderWorkerId }, 202);
    } catch (e) {
      if (e instanceof MissionNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      if (e instanceof BuildStateError) {
        return c.json(
          { error: 'INVALID_STATE', missionId: e.missionId, state: e.state },
          409,
        );
      }
      if (e instanceof BuildInProgressError) {
        return c.json({ error: 'BUILD_IN_PROGRESS' }, 409);
      }
      throw e;
    }
  });

  // ---------- M5: human gate (WebAuthn approval + merge) ----------

  // single-process daemon, single approver: the registration challenge lives
  // only between the options call and its verify (a one-time setup ceremony)
  let pendingRegistrationChallenge: string | null = null;

  app.get('/api/auth/approver', async (c) => {
    const n = await countApprovers(pool);
    return c.json({ registered: n > 0 });
  });

  app.post('/api/auth/approver/register-options', async (c) => {
    const result = await buildRegistrationOptions(pool);
    if (result.exists) {
      return c.json({ error: 'APPROVER_EXISTS' }, 409);
    }
    pendingRegistrationChallenge = result.options.challenge;
    return c.json({ options: result.options });
  });

  app.post('/api/auth/approver/register', async (c) => {
    const parsed = registerSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    if (!pendingRegistrationChallenge) {
      return c.json({ error: 'NO_PENDING_REGISTRATION' }, 409);
    }
    const challenge = pendingRegistrationChallenge;
    pendingRegistrationChallenge = null;
    const result = await verifyRegistration(
      pool,
      challenge,
      parsed.data.response,
      parsed.data.label ?? 'primary approver',
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ registered: true }, 201);
  });

  app.post('/api/missions/:id/approval/options', async (c) => {
    const missionId = c.req.param('id');
    const result = await getMission(pool, missionId);
    if (!result) return c.json({ error: 'NOT_FOUND' }, 404);
    if (result.mission.state !== 'AWAITING_MERGE_APPROVAL') {
      return c.json(
        { error: 'INVALID_STATE', state: result.mission.state },
        409,
      );
    }
    try {
      const { options, boundHashes } = await buildApprovalOptions(pool, missionId);
      return c.json({ options, boundHashes });
    } catch (e) {
      if (e instanceof IntegrityError) {
        return c.json({ error: 'INTEGRITY', message: e.message }, 409);
      }
      throw e;
    }
  });

  app.post('/api/missions/:id/approve', async (c) => {
    const orch = requireOrchestrator();
    const parsed = approveSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    const missionId = c.req.param('id');
    const mission = await getMission(pool, missionId);
    if (!mission) return c.json({ error: 'NOT_FOUND' }, 404);
    if (mission.mission.state !== 'AWAITING_MERGE_APPROVAL') {
      return c.json({ error: 'INVALID_STATE', state: mission.mission.state }, 409);
    }

    const ceremony = await verifyCeremony(pool, missionId, 'approve', parsed.data.response, null);
    if (!ceremony.ok) {
      return c.json({ error: ceremony.error }, ceremony.status);
    }

    // verified approval recorded — now (and only now) execute the merge
    const outcome = await orch.mergeMission(missionId, ceremony.approval.id);
    if (outcome.kind === 'MERGED') {
      return c.json({
        merged: true,
        approvalId: ceremony.approval.id,
        mergeCommit: outcome.mergeCommit,
      });
    }
    if (outcome.kind === 'BLOCKED_DIRTY') {
      return c.json(
        { error: 'MERGE_BLOCKED_DIRTY', approvalId: ceremony.approval.id },
        409,
      );
    }
    if (outcome.kind === 'CONFLICT') {
      return c.json(
        { error: 'MERGE_CONFLICT', approvalId: ceremony.approval.id },
        409,
      );
    }
    return c.json({ error: 'NO_WORKSPACE' }, 409);
  });

  app.post('/api/missions/:id/reject', async (c) => {
    const parsed = rejectMergeSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION', issues: parsed.error.issues }, 400);
    }
    const missionId = c.req.param('id');
    const mission = await getMission(pool, missionId);
    if (!mission) return c.json({ error: 'NOT_FOUND' }, 404);
    if (mission.mission.state !== 'AWAITING_MERGE_APPROVAL') {
      return c.json({ error: 'INVALID_STATE', state: mission.mission.state }, 409);
    }

    const ceremony = await verifyCeremony(
      pool,
      missionId,
      'reject',
      parsed.data.response,
      parsed.data.reason,
    );
    if (!ceremony.ok) {
      return c.json({ error: ceremony.error }, ceremony.status);
    }

    const updated = await appendEvent(pool, missionId, 'MERGE_REJECTED', {
      reason: parsed.data.reason,
      approvalId: ceremony.approval.id,
    });
    return c.json({
      mission: serializeMission(updated),
      approvalId: ceremony.approval.id,
    });
  });

  app.get('/api/missions/:id/approval', async (c) => {
    const missionId = c.req.param('id');
    const mission = await getMission(pool, missionId);
    if (!mission) return c.json({ error: 'NOT_FOUND' }, 404);
    const approvals = await listApprovals(pool, missionId);
    let hashes: { diff: string; sarif: string } | null = null;
    try {
      const b = await recomputeBoundHashes(pool, missionId);
      hashes = { diff: b.diff, sarif: b.sarif };
    } catch {
      hashes = null;
    }
    return c.json({
      approvals: approvals.map((a) => ({
        id: a.id,
        decision: a.decision,
        artifactSha256: a.artifactSha256,
        credentialId: a.credentialId,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
      hashes,
    });
  });

  // ---------- M4: security scan stage ----------

  app.post('/api/missions/:id/scan', async (c) => {
    const orch = requireOrchestrator();
    if (!(await readEmptyBody(c))) {
      return c.json(
        { error: 'VALIDATION', message: 'this route accepts no body fields' },
        400,
      );
    }
    const missionId = c.req.param('id');
    try {
      const { settled } = await orch.startScan(missionId);
      void settled.catch((e) =>
        console.error(`scan for ${missionId} failed:`, e),
      );
      return c.json({ started: true }, 202);
    } catch (e) {
      if (e instanceof MissionNotFoundError) {
        return c.json({ error: 'NOT_FOUND' }, 404);
      }
      if (e instanceof ScanStateError) {
        return c.json(
          { error: 'INVALID_STATE', missionId: e.missionId, state: e.state },
          409,
        );
      }
      if (e instanceof ScanInProgressError) {
        return c.json({ error: 'SCAN_IN_PROGRESS' }, 409);
      }
      throw e;
    }
  });

  app.get('/api/missions/:id/scan', async (c) => {
    const missionId = c.req.param('id');
    const mission = await getMission(pool, missionId);
    if (!mission) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    const scan = await latestScanAttempt(pool, missionId);
    if (!scan) {
      return c.json({ scan: null });
    }
    return c.json({
      scan: {
        id: scan.id,
        status: scan.status,
        counts: scan.counts,
        toolBreakdown: scan.toolBreakdown,
        sarifArtifactId: scan.sarifArtifactId,
        stderrTail: scan.stderrTail,
        createdAt: scan.createdAt,
      },
    });
  });

  app.get('/api/missions/:id/artifacts', async (c) => {
    const artifacts = await listArtifacts(pool, c.req.param('id'));
    return c.json({ artifacts });
  });

  app.get('/api/artifacts/:id', async (c) => {
    const artifact = await getArtifact(pool, c.req.param('id'));
    if (!artifact) {
      return c.json({ error: 'NOT_FOUND' }, 404);
    }
    let content: string;
    try {
      content = await readFile(artifact.path, 'utf8');
    } catch {
      return c.json({ error: 'INTEGRITY', message: 'artifact file missing' }, 409);
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== artifact.sha256) {
      return c.json(
        { error: 'INTEGRITY', expected: artifact.sha256, actual },
        409,
      );
    }
    return c.json({ artifact, content });
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
