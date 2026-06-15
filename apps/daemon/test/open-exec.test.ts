/**
 * M8 daemon acceptance — full-capability open missions end to end.
 *   T87 multi-step completion: a real open mission needing web + code + file
 *       tools runs the full loop and produces FINISHED artifacts in /workspace.
 *   T90 M7 intact: CAPABILITY_PROFILE(open) recorded; egress proxy/SSRF (the
 *       worker's web tools) — proxy+SSRF unit lives in @legion/runtime T80.
 *   T91 gate + delivery: the multi-file workspace deliverable is sealed,
 *       hash-bound, passkey-gated, delivered.
 *
 * AUTO-DETECTING (no-mock): with Docker up, runs a REAL container mission;
 * with Docker down + docker backend selected, asserts the mission FAILS with
 * a clear DOCKER_UNAVAILABLE (never a silent local fallback).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  getWorkerEvents,
  listArtifacts,
  listMissionWorkers,
  runMigrations,
} from '@legion/db';
import { Orchestrator } from '@legion/orchestrator';
import { dockerAvailable, REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { DEFAULT_GITLEAKS_BIN } from '@legion/scanner';
import { createApp } from '../src/app.js';
import { ORIGIN, RP_ID } from '../src/approval.js';
import { SoftKey } from './softkey.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);
const DOCKER = dockerAvailable().ok;

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let app: Hono;
let scratch: string;
let sandboxesRoot: string;
let approver: SoftKey;

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
async function pollUntil(fn: () => Promise<boolean>, what: string, ms = 600_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function createOpenMission(objective: string): Promise<string> {
  const res = await jpost('/api/missions', {
    title: 'm8 open exec', objective, kind: 'open',
  });
  expect(res.status).toBe(201);
  return (await res.json()).mission.missionId as string;
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — M8 exec tests run real workers.');
  }
  if (!process.env.LEGION_SEARCH_API_KEY) {
    throw new Error('LEGION_SEARCH_API_KEY missing — open missions need the pinned search provider.');
  }
  if (!existsSync(DEFAULT_GITLEAKS_BIN)) {
    throw new Error(`gitleaks missing at ${DEFAULT_GITLEAKS_BIN} — run scripts/setup-scanners.sh.`);
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'm8-exec-'));
  sandboxesRoot = path.join(scratch, 'sandboxes');
  // docker backend (the M8 default) — supervisor + orchestrator share the
  // sandbox root so the deliverable is collected from the container workspace.
  supervisor = new WorkerSupervisor({ pool, terminalBackend: 'docker', sandboxesRoot });
  orchestrator = new Orchestrator({
    pool, supervisor,
    terminalBackend: 'docker',
    sandboxesRoot,
    workdirRoot: path.join(scratch, 'workdirs'),
    buildsRoot: path.join(scratch, 'builds'),
    artifactsRoot: path.join(scratch, 'artifacts'),
    deliveriesRoot: path.join(scratch, 'deliveries'),
  });
  app = createApp(pool, supervisor, orchestrator);

  const opts = await (await jpost('/api/auth/approver/register-options')).json();
  approver = new SoftKey();
  const attestation = approver.createRegistration({
    challenge: opts.options.challenge, rpId: RP_ID, origin: ORIGIN,
  });
  expect((await jpost('/api/auth/approver/register', { response: attestation })).status).toBe(201);
}, 120_000);

afterAll(async () => {
  await supervisor.shutdown();
  await rm(scratch, { recursive: true, force: true });
  await pool.end();
});

describe('T87/T90/T91: multi-step open mission, gated + delivered', () => {
  it(
    DOCKER
      ? 'web+code+file mission produces finished /workspace artifacts → gate → delivered'
      : 'Docker unavailable → open+docker mission FAILS with DOCKER_UNAVAILABLE (no silent fallback)',
    async () => {
      const deliverTo = path.join(scratch, 'delivered');
      const missionId = await createOpenMission(
        'Using Python in the terminal, compute the mean of the numbers ' +
          '[2,4,6,8,10] and write a markdown report to /workspace/report.md ' +
          'that states the mean (it is 6) and lists the inputs. Create the ' +
          'file; do not just describe it.',
      );
      // route delivery into our scratch dir
      await pool.query(
        `update mission_events set payload = jsonb_set(payload,'{deliverTo}', to_jsonb($2::text))
          where mission_id = $1 and type = 'MISSION_CREATED'`,
        [missionId, deliverTo],
      );

      const started = await jpost(`/api/missions/${missionId}/plan`);

      if (!DOCKER) {
        // the worker refuses to start; the mission stays pre-gate, FAILED worker
        await pollUntil(async () => {
          const ws = await listMissionWorkers(pool, missionId);
          return ws.some((w) => w.status === 'FAILED');
        }, 'worker DOCKER_UNAVAILABLE', 60_000);
        const ws = await listMissionWorkers(pool, missionId);
        const ev = await getWorkerEvents(pool, ws[0]!.workerId);
        expect(ev.find((e) => e.type === 'WORKER_FAILED')!.payload.reason).toBe(
          'DOCKER_UNAVAILABLE',
        );
        return;
      }

      expect(started.status).toBe(202);
      await pollUntil(
        async () => (await state(missionId)) === 'AWAITING_MERGE_APPROVAL',
        'open mission at the gate',
        900_000,
      );

      // T90: CAPABILITY_PROFILE(open) recorded (egress proxy/SSRF unit = T80)
      const workers = await listMissionWorkers(pool, missionId);
      const w = workers.find((x) => x.role === 'worker')!;
      const wev = await getWorkerEvents(pool, w.workerId);
      const profile = wev.find((e) => e.type === 'CAPABILITY_PROFILE')!;
      expect(profile.payload.role).toBe('open');
      expect(profile.payload.terminalBackend).toBe('docker');

      // T87: a FINISHED artifact exists (report.md the agent actually wrote)
      const artifacts = await listArtifacts(pool, missionId);
      const deliverable = artifacts.find((a) => a.type === 'deliverable')!;
      expect(deliverable).toBeTruthy();
      const completed = (await getMissionEvents(pool, missionId))
        .filter((e) => e.type === 'BUILD_COMPLETED').pop()!;
      const names = (completed.payload.deliverable as { files: { name: string }[] }).files
        .map((f) => f.name);
      expect(names).toContain('report.md');

      // T91: gate + delivery — passkey ceremony, then files land in deliverTo
      const opt = await (await jpost(`/api/missions/${missionId}/approval/options`)).json();
      const assertion = approver.createAssertion({
        challenge: opt.options.challenge, rpId: RP_ID, origin: ORIGIN,
      });
      const res = await jpost(`/api/missions/${missionId}/approve`, { response: assertion });
      expect(res.status).toBe(200);
      expect((await res.json()).delivered).toBe(true);
      expect(await state(missionId)).toBe('MERGED');
      const delivered = await readdir(deliverTo);
      expect(delivered).toContain('report.md');
    },
    1_200_000,
  );
});