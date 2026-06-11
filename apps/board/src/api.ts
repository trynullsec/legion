export type MissionState =
  | 'DRAFT'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'BUILDING'
  | 'SCANNING'
  | 'AWAITING_MERGE_APPROVAL'
  | 'MERGED'
  | 'FAILED'
  | 'CANCELLED';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface Mission {
  missionId: string;
  state: MissionState;
  title: string;
  objective: string;
  repoPath: string;
  riskLevel: RiskLevel;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export interface MissionEvent {
  id: string;
  missionId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  validFrom: string;
  recordedAt: string;
}

export interface NewMission {
  title: string;
  objective: string;
  repoPath: string;
  riskLevel: RiskLevel;
}

/** Thrown for non-2xx responses; carries the server's error code + raw body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly raw: string,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const raw = await res.text();
    let code: string | null = null;
    try {
      code = (JSON.parse(raw) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, code, raw);
  }
  return (await res.json()) as T;
}

export async function fetchMissions(): Promise<Mission[]> {
  const data = await asJson<{ missions: Mission[] }>(
    await fetch('/api/missions'),
  );
  return data.missions;
}

export async function fetchMission(
  id: string,
): Promise<{ mission: Mission; events: MissionEvent[] }> {
  return asJson(await fetch(`/api/missions/${id}`));
}

export type WorkerStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'EXITED'
  | 'KILLED'
  | 'FAILED';

export interface Worker {
  workerId: string;
  missionId: string;
  role: string;
  task: string;
  workdir: string;
  pid: number | null;
  status: WorkerStatus;
  reason: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
}

export interface WorkerEvent {
  id: string;
  missionId: string;
  workerId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  recordedAt: string;
}

export async function fetchWorkers(missionId: string): Promise<Worker[]> {
  const data = await asJson<{ workers: Worker[] }>(
    await fetch(`/api/missions/${missionId}/workers`),
  );
  return data.workers;
}

export async function fetchWorkerEvents(
  workerId: string,
): Promise<WorkerEvent[]> {
  const res = await fetch(`/api/workers/${workerId}/events`);
  if (res.status === 404) return [];
  const data = await asJson<{ events: WorkerEvent[] }>(res);
  return data.events;
}

export interface PlanStep {
  n: number;
  title: string;
  detail: string;
  filesLikelyTouched: string[];
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  risks: { description: string; severity: 'low' | 'medium' | 'high' }[];
  openQuestions: string[];
  estimatedComplexity: 'trivial' | 'small' | 'medium' | 'large';
}

export async function startPlanning(missionId: string): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/plan`, { method: 'POST' }),
  );
}

export async function approvePlan(missionId: string): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/plan/approve`, { method: 'POST' }),
  );
}

export async function rejectPlan(
  missionId: string,
  reason: string,
): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/plan/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
  );
}

export interface Artifact {
  id: string;
  missionId: string;
  type: string;
  path: string;
  sha256: string;
  stats: { files: number; insertions: number; deletions: number; commits: number };
  createdAt: string;
}

export interface ReviewResult {
  verdict: 'approve' | 'request_changes';
  comments: { file: string | null; severity: string; body: string }[];
  summary: string;
  cycle?: number;
}

export async function startBuild(missionId: string): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/build`, { method: 'POST' }),
  );
}

export async function fetchArtifacts(missionId: string): Promise<Artifact[]> {
  const data = await asJson<{ artifacts: Artifact[] }>(
    await fetch(`/api/missions/${missionId}/artifacts`),
  );
  return data.artifacts;
}

export async function fetchArtifactContent(
  id: string,
): Promise<{ artifact: Artifact; content: string }> {
  return asJson(await fetch(`/api/artifacts/${id}`));
}

export interface ScanCounts {
  errors: number;
  warnings: number;
  notes: number;
}

export interface ScanInfo {
  id: string;
  status: 'PASSED' | 'FAILED' | 'ATTEMPT_FAILED';
  counts: ScanCounts;
  toolBreakdown: Record<string, ScanCounts>;
  sarifArtifactId: string | null;
  stderrTail: string | null;
  createdAt: string;
}

export interface ScanFinding {
  tool: string;
  ruleId: string;
  level: string;
  file: string | null;
  line: number | null;
  message: string;
}

export async function fetchScan(missionId: string): Promise<ScanInfo | null> {
  const data = await asJson<{ scan: ScanInfo | null }>(
    await fetch(`/api/missions/${missionId}/scan`),
  );
  return data.scan;
}

export async function startScan(missionId: string): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/scan`, { method: 'POST' }),
  );
}

/** Flatten a merged SARIF document into board-renderable findings. */
export function parseSarifFindings(content: string): ScanFinding[] {
  const doc = JSON.parse(content) as {
    runs: Array<{
      tool: { driver: { name: string } };
      results?: Array<{
        ruleId?: string;
        level?: string;
        message?: { text?: string };
        locations?: Array<{
          physicalLocation?: {
            artifactLocation?: { uri?: string };
            region?: { startLine?: number };
          };
        }>;
      }>;
    }>;
  };
  const findings: ScanFinding[] = [];
  for (const run of doc.runs) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      findings.push({
        tool: run.tool.driver.name,
        ruleId: r.ruleId ?? '(unknown)',
        level: r.level ?? 'warning',
        file: loc?.artifactLocation?.uri ?? null,
        line: loc?.region?.startLine ?? null,
        message: r.message?.text ?? '',
      });
    }
  }
  return findings;
}

export interface ApprovalInfo {
  approvals: {
    id: string;
    decision: 'approve' | 'reject';
    artifactSha256: string;
    reason: string | null;
    createdAt: string;
  }[];
  hashes: { diff: string; sarif: string } | null;
}

export async function isApproverRegistered(): Promise<boolean> {
  const data = await asJson<{ registered: boolean }>(
    await fetch('/api/auth/approver/status'),
  );
  return data.registered;
}

export async function fetchApproval(missionId: string): Promise<ApprovalInfo> {
  return asJson(await fetch(`/api/missions/${missionId}/approval`));
}

export async function approvalOptions(missionId: string): Promise<unknown> {
  const data = await asJson<{ options: unknown }>(
    await fetch(`/api/missions/${missionId}/approval/options`, { method: 'POST' }),
  );
  return data.options;
}

export async function submitApprove(
  missionId: string,
  response: unknown,
): Promise<{ mergeCommit?: string; error?: string }> {
  const res = await fetch(`/api/missions/${missionId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response }),
  });
  return (await res.json()) as { mergeCommit?: string; error?: string };
}

export async function submitReject(
  missionId: string,
  response: unknown,
  reason: string,
): Promise<void> {
  await asJson(
    await fetch(`/api/missions/${missionId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response, reason }),
    }),
  );
}

export async function postMission(input: NewMission): Promise<Mission> {
  const data = await asJson<{ mission: Mission }>(
    await fetch('/api/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  return data.mission;
}
