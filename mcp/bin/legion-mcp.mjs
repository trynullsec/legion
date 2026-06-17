#!/usr/bin/env node
/**
 * @trynullsec/legion-mcp — a Model Context Protocol server for Nullsec Legion.
 *
 * It is a THIN translation layer over the Legion daemon's HTTP API
 * (default http://localhost:4242): each MCP tool wraps one endpoint. It adds
 * no business logic and changes no contract.
 *
 * Deliberate boundary: the merge/delivery gate is a human passkey (WebAuthn)
 * ceremony in the board. An MCP client cannot sign, so there is NO approve tool.
 * Instead, tools SURFACE when a mission is awaiting your approval and point you
 * to the board. Read-only + non-gated write actions only.
 *
 * Transport: stdio (for local clients like Cursor and Claude Desktop).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.LEGION_API_URL || 'http://localhost:4242').replace(/\/+$/, '');
const TOKEN = process.env.LEGION_API_TOKEN || ''; // optional bearer, if the daemon is fronted by one

// ---------------------------------------------------------------------------
// daemon HTTP client
// ---------------------------------------------------------------------------
class DaemonError extends Error {
  constructor(status, code, raw) {
    super(code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

async function api(method, route, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  let res;
  try {
    res = await fetch(`${BASE}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Connection refused etc. — the daemon almost certainly isn't running.
    throw new DaemonError(0, 'DAEMON_UNREACHABLE', String(e?.message || e));
  }

  const raw = await res.text();
  if (!res.ok) {
    let code = null;
    try {
      code = JSON.parse(raw)?.error ?? null;
    } catch {
      /* non-JSON body */
    }
    throw new DaemonError(res.status, code, raw);
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Wrap a tool handler: turn any result into MCP content, errors into clear text. */
function tool(run) {
  return async (args) => {
    try {
      const data = await run(args ?? {});
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      let msg;
      if (e instanceof DaemonError) {
        msg =
          e.code === 'DAEMON_UNREACHABLE'
            ? `Could not reach the Legion daemon at ${BASE}. Is it running? (pnpm dev) — ${e.raw}`
            : `Legion API error (${e.status}${e.code ? ` ${e.code}` : ''}): ${e.raw || e.message}`;
      } else {
        msg = `Unexpected error: ${e?.message || String(e)}`;
      }
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  };
}

// ---------------------------------------------------------------------------
// presentation helpers (kept identical in spirit to the board's guidance)
// ---------------------------------------------------------------------------
const GATE_STATES = new Set(['AWAITING_PLAN_APPROVAL', 'AWAITING_MERGE_APPROVAL']);

/** A short, human next-step for a mission state — surfaces the human gate. */
function nextAction(m) {
  switch (m.state) {
    case 'DRAFT':
      return 'Draft. Use start_planning to begin.';
    case 'PLANNING':
      return 'A planner agent is drafting the plan. Check back shortly.';
    case 'AWAITING_PLAN_APPROVAL':
      return 'Plan ready for your review. Use approve_plan / reject_plan (no passkey needed for the plan gate).';
    case 'BUILDING':
      return 'An agent is doing the work (build / research).';
    case 'SCANNING':
      return 'Security scanning the result (gitleaks / semgrep).';
    case 'AWAITING_MERGE_APPROVAL':
      return `Awaiting YOUR passkey approval. This is a human gate — open the board at ${BASE} to sign. An AI client cannot approve a merge.`;
    case 'MERGED':
      return 'Done — merged / delivered.';
    case 'FAILED':
      return 'Failed. Inspect the mission events for the reason.';
    case 'CANCELLED':
      return 'Cancelled.';
    default:
      return m.state;
  }
}

function missionSummary(m) {
  return {
    missionId: m.missionId,
    title: m.title,
    kind: m.kind,
    state: m.state,
    riskLevel: m.riskLevel,
    repoPath: m.repoPath,
    deliverTo: m.deliverTo,
    scheduledBy: m.scheduledBy,
    updatedAt: m.updatedAt,
    nextAction: nextAction(m),
    atHumanGate: GATE_STATES.has(m.state),
  };
}

// ---------------------------------------------------------------------------
// server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'legion-mcp', version: '0.1.0' });

server.registerTool(
  'list_missions',
  {
    title: 'List missions',
    description:
      'List all Legion missions with their state and the recommended next action. Use to see what is in flight and what awaits your approval.',
    inputSchema: {
      state: z
        .string()
        .optional()
        .describe('Optional exact state filter, e.g. AWAITING_MERGE_APPROVAL'),
      kind: z.enum(['code', 'task', 'open']).optional().describe('Optional kind filter'),
    },
  },
  tool(async ({ state, kind }) => {
    const { missions } = await api('GET', '/api/missions');
    let list = missions;
    if (state) list = list.filter((m) => m.state === state);
    if (kind) list = list.filter((m) => m.kind === kind);
    return {
      count: list.length,
      missions: list.map(missionSummary),
    };
  }),
);

server.registerTool(
  'get_mission',
  {
    title: 'Get mission detail',
    description:
      'Fetch one mission: its full state, the next action, and its recent event ledger (plan, build, scan, approval events).',
    inputSchema: {
      missionId: z.string().describe('The mission id (uuid)'),
      eventLimit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('How many of the most recent events to include (default 25)'),
    },
  },
  tool(async ({ missionId, eventLimit }) => {
    const { mission, events } = await api('GET', `/api/missions/${missionId}`);
    const limit = eventLimit ?? 25;
    const recent = (events ?? []).slice(-limit).map((e) => ({
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      recordedAt: e.recordedAt,
    }));
    return { ...missionSummary(mission), objective: mission.objective, recentEvents: recent };
  }),
);

server.registerTool(
  'create_mission',
  {
    title: 'Create a mission',
    description:
      "Create a new Legion mission. kind='code' implements a diff in a repo (requires repoPath, no deliverTo). kind='task' produces a file deliverable (no repoPath). kind='open' is a full-capability web/research/exec mission (no repoPath, risk forced to open-readonly). riskLevel is required for code/task (low|medium|high) and ignored for open. The mission does NOT auto-start planning unless you set autoStart.",
    inputSchema: {
      title: z.string().min(1),
      objective: z.string().min(1).describe('What the mission should accomplish'),
      kind: z.enum(['code', 'task', 'open']).default('code'),
      repoPath: z.string().optional().describe('Absolute repo path — required for code, forbidden otherwise'),
      deliverTo: z.string().optional().describe('Output dir — task/open only'),
      riskLevel: z.enum(['low', 'medium', 'high']).optional().describe('Required for code/task; ignored for open'),
      autoStart: z.boolean().optional().describe('Immediately start planning after creation'),
    },
  },
  tool(async ({ title, objective, kind, repoPath, deliverTo, riskLevel, autoStart }) => {
    const payload = { title, objective, kind };
    if (repoPath) payload.repoPath = repoPath;
    if (deliverTo) payload.deliverTo = deliverTo;
    if (kind !== 'open' && riskLevel) payload.riskLevel = riskLevel;

    const { mission } = await api('POST', '/api/missions', payload);
    let started = false;
    if (autoStart) {
      await api('POST', `/api/missions/${mission.missionId}/plan`);
      started = true;
    }
    return {
      created: missionSummary(mission),
      planningStarted: started,
      hint: started
        ? 'Planning started. Poll get_mission for the plan, then approve_plan.'
        : 'Created. Call start_planning when ready.',
    };
  }),
);

server.registerTool(
  'start_planning',
  {
    title: 'Start planning',
    description: 'Kick off the planner agent for a mission (code/task). Open missions begin execution.',
    inputSchema: { missionId: z.string() },
  },
  tool(async ({ missionId }) => {
    await api('POST', `/api/missions/${missionId}/plan`);
    return { ok: true, missionId, hint: 'Poll get_mission for the proposed plan.' };
  }),
);

server.registerTool(
  'approve_plan',
  {
    title: 'Approve the plan',
    description:
      'Approve a mission\'s proposed plan so the build can start. This is the PLAN gate (not the merge gate) and needs no passkey.',
    inputSchema: { missionId: z.string() },
  },
  tool(async ({ missionId }) => {
    await api('POST', `/api/missions/${missionId}/plan/approve`);
    return { ok: true, missionId, hint: 'Build will start. Poll get_mission for progress.' };
  }),
);

server.registerTool(
  'reject_plan',
  {
    title: 'Reject the plan',
    description: 'Reject a proposed plan with a reason; the reason is fed back to the next planning attempt verbatim.',
    inputSchema: {
      missionId: z.string(),
      reason: z.string().min(1).describe('Why the plan is rejected — carried forward to the replan'),
    },
  },
  tool(async ({ missionId, reason }) => {
    await api('POST', `/api/missions/${missionId}/plan/reject`, { reason });
    return { ok: true, missionId, hint: 'Mission will replan with your reason.' };
  }),
);

server.registerTool(
  'get_scan',
  {
    title: 'Get the security scan',
    description: 'Fetch the latest scan verdict for a mission: pass/fail, per-tool finding counts (gitleaks/semgrep).',
    inputSchema: { missionId: z.string() },
  },
  tool(async ({ missionId }) => {
    const { scan } = await api('GET', `/api/missions/${missionId}/scan`);
    return scan ?? { scan: null, hint: 'No scan recorded yet.' };
  }),
);

server.registerTool(
  'get_deliverable',
  {
    title: 'Get the deliverable preview',
    description:
      'For task/open missions: fetch the produced deliverable — its sha256 and a preview of each file (markdown/text/csv/json). Returns null before a deliverable exists.',
    inputSchema: { missionId: z.string() },
  },
  tool(async ({ missionId }) => {
    const { deliverable } = await api('GET', `/api/missions/${missionId}/deliverable`);
    if (!deliverable) return { deliverable: null, hint: 'No deliverable yet.' };
    return deliverable;
  }),
);

server.registerTool(
  'get_approval_status',
  {
    title: 'Get approval status',
    description:
      'Show whether a mission is awaiting the human passkey merge gate, the bound artifact hashes, and any recorded approvals/rejections. The merge itself is signed in the board — this tool only reports.',
    inputSchema: { missionId: z.string() },
  },
  tool(async ({ missionId }) => {
    const { mission } = await api('GET', `/api/missions/${missionId}`);
    const approval = await api('GET', `/api/missions/${missionId}/approval`);
    return {
      state: mission.state,
      atMergeGate: mission.state === 'AWAITING_MERGE_APPROVAL',
      boundHashes: approval.hashes,
      approvals: approval.approvals,
      action:
        mission.state === 'AWAITING_MERGE_APPROVAL'
          ? `Open ${BASE} and approve with your passkey. An AI client cannot sign this gate.`
          : 'Not at the merge gate.',
    };
  }),
);

server.registerTool(
  'list_schedules',
  {
    title: 'List schedules',
    description: 'List recurring mission schedules (cron templates) with next run time and last outcome.',
    inputSchema: {},
  },
  tool(async () => {
    const { schedules } = await api('GET', '/api/schedules');
    return { count: schedules.length, schedules };
  }),
);

server.registerTool(
  'run_schedule_now',
  {
    title: 'Run a schedule now',
    description: 'Manually fire a schedule once (subject to the one-in-flight guard).',
    inputSchema: { scheduleId: z.string() },
  },
  tool(async ({ scheduleId }) => {
    await api('POST', `/api/schedules/${scheduleId}/run-now`);
    return { ok: true, scheduleId, hint: 'Fired (if the guard allowed it). Check list_missions.' };
  }),
);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to log on for stdio servers (stdout is the protocol channel).
  process.stderr.write(`legion-mcp connected (daemon: ${BASE})\n`);
}

main().catch((e) => {
  process.stderr.write(`legion-mcp failed to start: ${e?.message || e}\n`);
  process.exit(1);
});
