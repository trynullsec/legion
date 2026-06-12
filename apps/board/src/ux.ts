/**
 * M5.5 presentation helpers — display-only. No API calls, no logic, no state
 * machine. Pure functions that turn raw server data into operator guidance.
 */
import type { WorkerEvent } from './api';

// ---------- errors are sentences ----------

const ERROR_SENTENCES: Record<string, string> = {
  // planning / build / scan concurrency + state
  PLANNING_IN_PROGRESS: 'A planner is already running for this mission.',
  BUILD_IN_PROGRESS: 'A build is already running.',
  SCAN_IN_PROGRESS: 'A scan is already running.',
  INVALID_STATE: 'That action isn’t available in the mission’s current state.',
  // merge gate
  MERGE_BLOCKED_DIRTY:
    'Your repository has uncommitted changes — commit or stash, then approve again.',
  MERGE_CONFLICT:
    'The change no longer applies cleanly to your branch — rebuild to re-clone the moved base, then approve again.',
  NO_WORKSPACE: 'No build workspace was found for this mission.',
  // approval ceremony
  INTEGRITY:
    'The reviewed bytes changed since the challenge was issued — the approval was voided. Reload and approve again.',
  CHALLENGE_INVALID:
    'That approval prompt expired or was already used — start a new one.',
  BAD_SIGNATURE: 'The passkey signature didn’t verify — try the prompt again.',
  UNKNOWN_CREDENTIAL:
    'This passkey isn’t the registered approver for this install.',
  APPROVER_EXISTS: 'An approver is already registered on this install.',
  MALFORMED_CEREMONY: 'The passkey response was malformed — try again.',
  NO_PENDING_REGISTRATION:
    'Registration timed out — start the passkey registration again.',
  // generic
  VALIDATION: 'Some required fields are missing or invalid.',
  NOT_FOUND: 'That mission could not be found.',
};

/**
 * Translate an API error code (or a raw thrown message) into a plain English
 * sentence. Unknown codes degrade to "Something failed (<CODE>)." with the
 * raw string preserved for the optional RAW disclosure.
 */
export function errorSentence(code: string | null | undefined): string {
  if (!code) return 'Something failed.';
  const key = code.trim();
  if (ERROR_SENTENCES[key]) return ERROR_SENTENCES[key];
  // sometimes the caller hands us a thrown Error message rather than a code;
  // try to recover a known UPPER_SNAKE token from it
  const token = key.match(/\b[A-Z][A-Z_]{3,}\b/)?.[0];
  if (token && ERROR_SENTENCES[token]) return ERROR_SENTENCES[token];
  return `Something failed (${key}).`;
}

// ---------- humanized timestamps ----------

export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// ---------- human activity feed (display-only summaries) ----------

export interface FeedLine {
  text: string;
  danger: boolean;
}

function firstLine(s: string, max = 120): string {
  const line = s.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function parseToolArgs(raw: unknown): { command?: string } {
  if (typeof raw !== 'string') return (raw as { command?: string }) ?? {};
  try {
    return JSON.parse(raw) as { command?: string };
  } catch {
    return { command: raw };
  }
}

/** A terminal command → one plain sentence about what the agent did. */
function describeCommand(command: string): string {
  const cmd = command.trim();
  const commitMsg = cmd.match(/git commit[^\n]*-m\s+['"]?([^'"\n]+)/i);
  if (commitMsg) return `Committed: ${firstLine(commitMsg[1]!, 80)}`;
  if (/\bgit commit\b/.test(cmd)) return 'Committed changes';
  if (/\bgit add\b/.test(cmd)) return 'Staged changes';
  if (/\bgit (status|log|diff|rev-parse|branch)\b/.test(cmd))
    return 'Inspected git state';
  if (/\bgit apply\b/.test(cmd) || /\bapply_patch\b/.test(cmd))
    return 'Applied a patch';
  const read = cmd.match(/\b(?:cat|sed -n[^|]*|head|less|tail)\s+([^\s|&;]+)/);
  if (read) return `Read ${read[1]}`;
  const wrote = cmd.match(/(?:cat\s*>|tee|>)\s*([^\s|&;]+)/);
  if (wrote && />/.test(cmd)) return `Edited ${wrote[1]}`;
  if (/\bls\b/.test(cmd)) return 'Listed files';
  if (/\bmkdir\b/.test(cmd)) return 'Created a directory';
  if (/\b(npm|pnpm|yarn|node|python3?|pytest|vitest|tsc)\b/.test(cmd))
    return `Ran ${firstLine(cmd, 60)}`;
  return `Ran ${firstLine(cmd, 60)}`;
}

/**
 * One plain sentence per meaningful worker event. Returns null for events we
 * don't surface in the human feed (they remain in RAW). Display-only.
 */
export function summarizeEvent(e: WorkerEvent): FeedLine | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'WORKER_CREATED':
      return { text: `Started ${String(p.role ?? 'worker')}`, danger: false };
    case 'TOOL_CALL': {
      const tool = String(p.tool ?? '');
      if (tool === 'terminal' || tool === 'process') {
        const { command } = parseToolArgs(p.args);
        return { text: describeCommand(command ?? ''), danger: false };
      }
      return { text: `Used ${tool}`, danger: false };
    }
    case 'MODEL_MESSAGE': {
      const text = firstLine(String(p.text ?? ''), 120);
      return text ? { text: `Agent: ${text}`, danger: false } : null;
    }
    case 'AGENT_STATUS': {
      const msg = String(p.message ?? '');
      // surface only human-meaningful lifecycle lines, skip chatter
      if (/task started/i.test(msg)) return { text: 'Began working', danger: false };
      return null;
    }
    case 'WORKER_EXITED': {
      const code = Number(p.exitCode ?? 0);
      return code === 0
        ? { text: 'Finished', danger: false }
        : { text: `Exited with code ${code}`, danger: true };
    }
    case 'WORKER_KILLED':
      return { text: 'Stopped', danger: true };
    case 'WORKER_FAILED':
      return {
        text: `Failed: ${String(p.reason ?? 'unknown')}`,
        danger: true,
      };
    case 'REVIEW_RESULT':
      return {
        text:
          p.verdict === 'approve'
            ? 'Reviewer approved the work'
            : 'Reviewer requested changes',
        danger: p.verdict !== 'approve',
      };
    case 'REVIEW_INVALID':
      return { text: 'Reviewer output was unreadable', danger: true };
    case 'PLAN_INVALID':
      return { text: 'Plan output was unreadable', danger: true };
    case 'BUILD_ATTEMPT_FAILED':
      return {
        text: `Build attempt failed: ${String(p.reason ?? 'unknown')}`,
        danger: true,
      };
    case 'WORKER_TASK':
    case 'WORKER_STARTED':
    case 'TOOL_RESULT':
      return null; // useful in RAW, noise in the human feed
    default:
      return null;
  }
}

// ---------- one-next-action guidance (display-only mapping) ----------

export interface LiveWorkerInfo {
  hasLivePlanner: boolean;
  hasLiveCoder: boolean;
  hasLiveReviewer: boolean;
  /** M6a: 'worker' role agents on task missions. */
  hasLiveTaskWorker: boolean;
}

export type NextAction =
  | { kind: 'button'; label: string; help: string; action: 'plan' | 'build' }
  | { kind: 'scrollButton'; label: string; help: string; target: string }
  | { kind: 'status'; text: string; spinning: boolean }
  | { kind: 'done'; text: string }
  | { kind: 'none' };

/**
 * The single next human step for a mission state. Pure mapping over state +
 * kind + which workers are live — it renders guidance, it does not gate the
 * API (the server remains the source of truth). M6a: copy adapts by kind;
 * states and event names stay canonical (pin 8).
 */
export function nextAction(
  state: string,
  live: LiveWorkerInfo,
  kind: 'code' | 'task' = 'code',
  riskLevel: 'low' | 'medium' | 'high' = 'medium',
): NextAction {
  const task = kind === 'task';
  // M6b: a low-risk mission flows from "Start planning" straight through
  // live status lines until the merge gate — the plan gate auto-approves.
  if (state === 'AWAITING_PLAN_APPROVAL' && riskLevel === 'low') {
    return {
      kind: 'status',
      text: 'Express policy is approving the plan…',
      spinning: true,
    };
  }
  switch (state) {
    case 'DRAFT':
      return {
        kind: 'button',
        label: 'Start planning',
        help: task
          ? 'An agent will plan the deliverable from your objective.'
          : 'Agents will read your repo and propose a plan.',
        action: 'plan',
      };
    case 'PLANNING':
      return live.hasLivePlanner
        ? {
            kind: 'status',
            text: task
              ? 'Planner is shaping the deliverable…'
              : 'Planner is reading your repository…',
            spinning: true,
          }
        : {
            kind: 'button',
            label: 'Start planning',
            help: task
              ? 'An agent will plan the deliverable from your objective.'
              : 'Agents will read your repo and propose a plan.',
            action: 'plan',
          };
    case 'AWAITING_PLAN_APPROVAL':
      return {
        kind: 'scrollButton',
        label: 'Review plan ↓',
        help: 'Approve the proposed plan, or reject it with a reason.',
        target: 'plan-section',
      };
    case 'BUILDING':
      if (live.hasLiveTaskWorker)
        return {
          kind: 'status',
          text: 'Agent is working on your deliverable…',
          spinning: true,
        };
      if (live.hasLiveCoder)
        return { kind: 'status', text: 'Coder is implementing the plan…', spinning: true };
      if (live.hasLiveReviewer)
        return {
          kind: 'status',
          text: task
            ? 'Reviewer is reading the deliverable…'
            : 'Reviewer is reading the diff…',
          spinning: true,
        };
      return {
        kind: 'button',
        label: task ? 'Start work' : 'Start build',
        help: task
          ? 'An agent produces the deliverable files per the approved plan.'
          : 'A coder agent implements the approved plan on a branch.',
        action: 'build',
      };
    case 'SCANNING':
      return {
        kind: 'status',
        text: task
          ? 'Scanning the deliverable for secrets…'
          : 'Scanning for secrets and unsafe patterns…',
        spinning: true,
      };
    case 'AWAITING_MERGE_APPROVAL':
      return {
        kind: 'scrollButton',
        label: 'Review & approve ↓',
        help: task
          ? 'Inspect the deliverable and approve delivery with your passkey.'
          : 'Inspect the diff and approve the merge with your passkey.',
        target: 'gate-section',
      };
    case 'MERGED':
      return {
        kind: 'done',
        text: task ? 'Delivered.' : 'Merged into your repository.',
      };
    case 'FAILED':
      return { kind: 'done', text: 'This mission failed.' };
    case 'CANCELLED':
      return { kind: 'done', text: 'This mission was cancelled.' };
    default:
      return { kind: 'none' };
  }
}
