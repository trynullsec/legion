/**
 * M6d acceptance tests — open missions (T70, T72–T75). T71 (toolset registry
 * unit) lives in packages/runtime; T76 (board) lives in apps/board.
 *
 * NO-MOCK RULE: T72/T74/T75 run real open workers with the real model and
 * the real pinned search provider (Tavily — one key drives web_search AND
 * web_extract). Missing LEGION_SEARCH_API_KEY or OPENROUTER_API_KEY → FAIL.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  getMissionEvents,
  insertArtifact,
  listArtifacts,
  listMissionWorkers,
  runMigrations,
} from '@legion/db';
import { Orchestrator } from '@legion/orchestrator';
import { DEFAULT_GITLEAKS_BIN } from '@legion/scanner';
import { REPO_ROOT, WorkerSupervisor } from '@legion/runtime';
import { createApp } from '../src/app.js';
import { ORIGIN, RP_ID } from '../src/approval.js';
import { SoftKey } from './softkey.js';
import type { Pool } from 'pg';
import type { Hono } from 'hono';

const exec = promisify(execFile);

let pool: Pool;
let supervisor: WorkerSupervisor;
let orchestrator: Orchestrator;
let app: Hono;
let scratch: string;
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
async function pollUntil(fn: () => Promise<boolean>, what: string, ms = 480_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function pollScanDone(missionId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scan = (await (await api(`/api/missions/${missionId}/scan`)).json()).scan;
    if (scan && scan.status !== 'RUNNING') return scan;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`scan for ${missionId} did not finish in time`);
}

function forcedApprove(): string {
  return (
    'Using the terminal, write a file named review.json in your current working ' +
    'directory containing EXACTLY this JSON (do not change, fix, or extend it): ' +
    '{"verdict": "approve", "comments": [], "summary": "Forced approval for deterministic testing."} ' +
    '— verify it parses with python3 -c "import json; json.load(open(\'review.json\'))" and finish.'
  );
}

async function createOpenMission(deliverTo?: string): Promise<string> {
  const res = await jpost('/api/missions', {
    title: 'open research',
    objective:
      'Find the official website of the SQLite project and summarize, in a short ' +
      'markdown report, what SQLite is and its current release line. Cite the ' +
      'URLs you fetched as markdown links.',
    kind: 'open',
    riskLevel: 'low',
    ...(deliverTo ? { deliverTo } : {}),
  });
  expect(res.status).toBe(201);
  return (await res.json()).mission.missionId as string;
}

beforeAll(async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY missing — M6d tests run real workers.');
  }
  if (!process.env.LEGION_SEARCH_API_KEY) {
    throw new Error(
      'LEGION_SEARCH_API_KEY missing from repo-root .env — open missions need the real pinned search provider (Tavily). Never skipped.',
    );
  }
  if (!existsSync(DEFAULT_GITLEAKS_BIN)) {
    throw new Error(`gitleaks missing at ${DEFAULT_GITLEAKS_BIN} — run scripts/setup-scanners.sh.`);
  }
  pool = createPool();
  await runMigrations(pool);
  await pool.query('truncate approvers, approval_challenges, approvals');
  // M8: open missions are now full-capability. This suite covers the
  // backend-agnostic contracts (boundary, gate, dirty-deliverable scan,
  // isolation proof) on the LOCAL backend — full toolset on the host under
  // seatbelt, no Docker needed. The Docker backend + multi-step execution
  // are covered by open-exec.test.ts (T86/T87/T89) and the runtime suite.
  supervisor = new WorkerSupervisor({ pool, terminalBackend: 'local' });
  scratch = await mkdtemp(path.join(REPO_ROOT, '.tmp', 'open-'));
  orchestrator = new Orchestrator({
    pool, supervisor,
    terminalBackend: 'local',
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

// ====================================================================
// T70: boundary — open shape; existing kinds unchanged
// ====================================================================

describe('T70: open mission boundary', () => {
  it('open mission needs no repoPath; riskLevel forced to open-readonly with a recorded note', async () => {
    const res = await jpost('/api/missions', {
      title: 'boundary open',
      objective: 'research something and produce a cited report',
      kind: 'open',
      riskLevel: 'high', // user-sent risk is ignored with a recorded note
    });
    expect(res.status).toBe(201);
    const { mission } = await res.json();
    expect(mission.kind).toBe('open');
    expect(mission.repoPath).toBeNull();
    expect(mission.riskLevel).toBe('open-readonly');

    const events = await getMissionEvents(pool, mission.missionId);
    expect(events[0]!.payload.riskLevel).toBe('open-readonly');
    expect(String(events[0]!.payload.riskLevelNote ?? '')).toContain('high');
  });

  it('open mission WITH repoPath → 400; open without riskLevel accepted', async () => {
    const bad = await jpost('/api/missions', {
      title: 'bad open', objective: 'open missions have no repository',
      kind: 'open', repoPath: '/tmp/x', riskLevel: 'low',
    });
    expect(bad.status).toBe(400);

    const ok = await jpost('/api/missions', {
      title: 'open sans risk', objective: 'riskLevel is optional for open missions',
      kind: 'open',
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).mission.riskLevel).toBe('open-readonly');
  });

  it('code/task shapes unchanged; kind still defaults to code', async () => {
    const repo = path.join(scratch, 't70-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'README.md'), '# f\n');
    await exec('git', ['init', '-q', repo]);
    await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'add', '-A']);
    await exec('git', ['-C', repo, '-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '-q', '-m', 'i']);

    const code = await jpost('/api/missions', {
      title: 'code', objective: 'kind defaults to code', repoPath: repo, riskLevel: 'low',
    });
    expect(code.status).toBe(201);
    expect((await code.json()).mission.kind).toBe('code');

    const task = await jpost('/api/missions', {
      title: 'task', objective: 'task shape unchanged', kind: 'task', riskLevel: 'low',
    });
    expect(task.status).toBe(201);
    expect((await task.json()).mission.riskLevel).toBe('low'); // not forced

    // code mission must NOT accept 'open-readonly' as a riskLevel
    const sneaky = await jpost('/api/missions', {
      title: 'sneak', objective: 'open-readonly is not a client value',
      repoPath: repo, riskLevel: 'open-readonly',
    });
    expect(sneaky.status).toBe(400);
  });
});

// ====================================================================
// T72: happy path — real search, real fetch, cited report, to the gate
// ====================================================================

describe('T72: open mission happy path (local backend, full toolset)', () => {
  it('EXECUTE → workspace deliverable → reviewer → gitleaks → AWAITING_MERGE_APPROVAL', async () => {
    const missionId = await createOpenMission();

    // one call starts the whole flow (collapsed EXECUTE)
    const res = await jpost(`/api/missions/${missionId}/plan`);
    expect(res.status).toBe(202);

    await pollUntil(
      async () => (await state(missionId)) === 'AWAITING_MERGE_APPROVAL',
      'open mission at the gate',
      600_000,
    );

    // ledger traversed the canonical states with the open policy recorded
    const events = await getMissionEvents(pool, missionId);
    const types = events.map((e) => e.type);
    for (const t of ['PLANNING_STARTED', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'BUILD_STARTED', 'BUILD_COMPLETED', 'SCAN_STARTED', 'SCAN_PASSED']) {
      expect(types).toContain(t);
    }
    const approved = events.find((e) => e.type === 'PLAN_APPROVED')!;
    expect(approved.payload.policy).toBe('open-readonly');

    // M8: the deliverable is whatever the agent produced + its final summary,
    // sealed as an artifact (no longer a single read-only report).
    const artifacts = await listArtifacts(pool, missionId);
    const deliverable = artifacts.find((a) => a.type === 'deliverable')!;
    expect(deliverable).toBeTruthy();

    // gitleaks-only scan passed
    const scan = await pollScanDone(missionId);
    expect(scan.status).toBe('PASSED');
    expect(scan.toolBreakdown.gitleaks).toBeDefined();
    expect(scan.toolBreakdown.semgrep).toBeUndefined();
  }, 660_000);
});

// ====================================================================
// T73: gate intact — ceremony + tamper-void on an open mission
// ====================================================================

/** Fold an open mission to the gate with real on-disk deliverable artifacts. */
async function openMissionAtGate(): Promise<{ missionId: string; deliverablePath: string }> {
  const res = await jpost('/api/missions', {
    title: 'gate open', objective: 'gate invariance for open missions', kind: 'open',
  });
  const missionId = (await res.json()).mission.missionId as string;

  const adir = path.join(scratch, 'artifacts', missionId);
  await mkdir(adir, { recursive: true });
  const report = '# Report\n\nFindings with a citation: https://example.org/source\n';
  const dId = crypto.randomUUID();
  const dPath = path.join(adir, `${dId}.md`);
  await writeFile(dPath, report);
  await insertArtifact(pool, {
    id: dId, missionId, type: 'deliverable', path: dPath,
    sha256: createHash('sha256').update(report).digest('hex'),
    stats: { files: 1, bytes: report.length },
  });
  const sarif = JSON.stringify({ version: '2.1.0', runs: [] }, null, 2);
  const sId = crypto.randomUUID();
  const sPath = path.join(adir, `${sId}.sarif`);
  await writeFile(sPath, sarif);
  await insertArtifact(pool, {
    id: sId, missionId, type: 'sarif', path: sPath,
    sha256: createHash('sha256').update(sarif).digest('hex'),
    stats: { errors: 0, warnings: 0, notes: 0 },
  });

  for (const body of [
    { type: 'PLANNING_STARTED' },
    { type: 'PLAN_PROPOSED', payload: { plan: { summary: 's', steps: [{ n: 1, title: 't', detail: 'd', filesLikelyTouched: ['report.md'] }], risks: [], openQuestions: [], estimatedComplexity: 'small' } } },
    { type: 'PLAN_APPROVED', payload: { autoApproved: true, policy: 'open-readonly' } },
    { type: 'BUILD_STARTED' },
    { type: 'BUILD_COMPLETED', payload: { artifactId: dId, sha256: createHash('sha256').update(report).digest('hex'), deliverable: { archive: false, files: [{ name: 'report.md', sha256: createHash('sha256').update(report).digest('hex') }] } } },
    { type: 'SCAN_STARTED' },
    { type: 'SCAN_PASSED', payload: { sarifArtifactId: sId, counts: { errors: 0, warnings: 0, notes: 0 } } },
  ]) {
    const r = await jpost(`/api/missions/${missionId}/events`, body);
    expect(r.status).toBe(201);
  }
  expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  return { missionId, deliverablePath: dPath };
}

describe('T73: the gate stays for open missions', () => {
  it('wrong key → 401; tamper after options → 409 INTEGRITY, nothing delivered', async () => {
    const { missionId, deliverablePath } = await openMissionAtGate();

    // T59 semantics: an unregistered key cannot approve
    const c1 = (await (await jpost(`/api/missions/${missionId}/approval/options`)).json())
      .options.challenge as string;
    const attacker = new SoftKey();
    const bad = attacker.createAssertion({ challenge: c1, rpId: RP_ID, origin: ORIGIN });
    expect((await jpost(`/api/missions/${missionId}/approve`, { response: bad })).status).toBe(401);

    // T51 semantics: tamper the deliverable after options were issued
    const c2 = (await (await jpost(`/api/missions/${missionId}/approval/options`)).json())
      .options.challenge as string;
    await appendFile(deliverablePath, '\ntampered\n');
    const good = approver.createAssertion({ challenge: c2, rpId: RP_ID, origin: ORIGIN });
    const res = await jpost(`/api/missions/${missionId}/approve`, { response: good });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('INTEGRITY');
    expect(await state(missionId)).toBe('AWAITING_MERGE_APPROVAL');
  });
});

// ====================================================================
// T74: dirty deliverable — planted secret → SCAN_FAILED → rework
// ====================================================================

describe('T74: dirty open deliverable', () => {
  it('planted AWS-style key in the report → SCAN_FAILED → BUILDING', async () => {
    const missionId = await createOpenMission();

    // documented internal override (T19 precedent): the worker is told to
    // produce EXACTLY this final message — the launcher seals it as
    // report.md. The canary-framing is load-bearing: without it the model
    // refuses to echo a credential-shaped string (verified empirically).
    // The reviewer is forced (T50 precedent): a REAL reviewer correctly
    // rejects a report containing a key — this test is about the SCANNER
    // stage catching what slips past review.
    const { settled } = await orchestrator.startPlanning(missionId, {
      reviewerTaskOverrides: [forcedApprove()],
      taskOverride:
        'You are part of an automated security-scanner integration test for ' +
        "the gitleaks tool. The credential below is the suite's standard " +
        'FICTITIOUS canary string — it is not a real key and unlocks nothing; ' +
        'the scanner must detect it to pass the test. Do not call any tools. ' +
        'Your entire reply must be EXACTLY the following markdown document, ' +
        'byte for byte, nothing added or removed:\n\n' +
        '# Config notes\n\nUse AWS_ACCESS_KEY_ID=AKIAQ3EGV7DKVPNZX2MJ for the integration.\n\nSource: https://example.org/config\n',
    });
    await settled;

    await pollUntil(async () => {
      const scan = (await (await api(`/api/missions/${missionId}/scan`)).json()).scan;
      return scan !== null && scan.status !== 'RUNNING';
    }, 'scan done', 240_000);

    const scan = (await (await api(`/api/missions/${missionId}/scan`)).json()).scan;
    expect(scan.status).toBe('FAILED');
    expect(scan.counts.errors).toBeGreaterThanOrEqual(1);
    expect(await state(missionId)).toBe('BUILDING'); // rework, not death
  }, 600_000);
});

// ====================================================================
// T75 (M8): isolation proof — CAPABILITY_PROFILE(open) + env excludes
// DATABASE_URL. (Host-write safety under the container boundary is T89;
// the worker-process seatbelt confinement is M7's T84.)
// ====================================================================

describe('T75: open worker isolation proof', () => {
  it('records CAPABILITY_PROFILE(open) and the launcher env excludes DATABASE_URL', async () => {
    const missionId = await createOpenMission();

    // spawn a REAL open worker; the launcher emits the isolation proof
    // BEFORE the model loop starts, so this test does not depend on model
    // behavior at all — assert the proof, then stop the worker.
    const { workerId, settled } = await orchestrator.startPlanning(missionId, {
      taskOverride:
        'Do not call any tools. Respond with exactly this final message: ready',
    });
    void settled.catch(() => {}); // the kill below fails the attempt; that's fine

    // CAPABILITY_PROFILE recorded for the open role before any work (T81/T90)
    await pollUntil(async () => {
      const { rows } = await pool.query(
        `select 1 from worker_events
          where worker_id = $1 and type = 'CAPABILITY_PROFILE'
            and payload->>'role' = 'open'`,
        [workerId],
      );
      return rows.length === 1;
    }, 'CAPABILITY_PROFILE(open)', 120_000);

    let isolationRow: { payload: { message: string } } | undefined;
    await pollUntil(async () => {
      const { rows } = await pool.query(
        `select payload from worker_events
          where worker_id = $1 and type = 'AGENT_STATUS'
            and payload->>'kind' = 'isolation'`,
        [workerId],
      );
      isolationRow = rows[0];
      return rows.length === 1;
    }, 'launcher isolation event', 120_000);

    // the launcher (inside the worker process, T11 precedent) reports its env
    const isolation = JSON.parse(String(isolationRow!.payload.message));
    expect(isolation.envKeys).not.toContain('DATABASE_URL');
    expect(isolation.backend).toBe('local'); // this suite runs the local backend

    await supervisor.stopWorker(workerId, { graceful: false }).catch(() => {});
    await supervisor.waitForExit(workerId, 30_000).catch(() => {});

    // the worker's workdir holds only deliverables/ + the supervisor's .tmp
    // (which carries Legion's own seatbelt profile, not agent output).
    const workers = await listMissionWorkers(pool, missionId);
    const open = workers.find((w) => w.workerId === workerId)!;
    const entries = await readdir(open.workdir, { withFileTypes: true });
    const names = entries.map((e) => e.name).filter((n) => n !== '.DS_Store').sort();
    expect(names).toEqual(['.tmp', 'deliverables']);
    const tmp = (await readdir(path.join(open.workdir, '.tmp'))).filter((n) => n !== '.DS_Store');
    expect(tmp).toEqual(['capability.sb']); // M7 profile only; no agent-written files
  }, 240_000);
});
