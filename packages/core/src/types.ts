export const MISSION_STATES = [
  'DRAFT',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'BUILDING',
  'SCANNING',
  'AWAITING_MERGE_APPROVAL',
  'MERGED',
  'FAILED',
  'CANCELLED',
] as const;

export type MissionStateName = (typeof MISSION_STATES)[number];

export const TERMINAL_STATES = ['MERGED', 'FAILED', 'CANCELLED'] as const;

export const EVENT_TYPES = [
  'MISSION_CREATED',
  'PLANNING_STARTED',
  'PLAN_PROPOSED',
  'PLAN_APPROVED',
  'PLAN_REJECTED',
  'BUILD_STARTED',
  'BUILD_COMPLETED',
  'SCAN_STARTED',
  'SCAN_PASSED',
  'SCAN_FAILED',
  'MERGE_APPROVED',
  'MERGE_REJECTED',
  'MISSION_FAILED',
  'MISSION_CANCELLED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * M6a: a mission's kind decides what its stages produce. 'code' missions
 * deliver a diff into a git repository; 'task' missions deliver file
 * artifacts (research, writing, analysis). Absent kind = 'code' (back-compat
 * with every pre-M6a ledger).
 */
export const MISSION_KINDS = ['code', 'task'] as const;

export type MissionKind = (typeof MISSION_KINDS)[number];

/** Payload of MISSION_CREATED. Validated with zod at the API boundary; core trusts typed input. */
export interface MissionCreationPayload {
  title: string;
  objective: string;
  riskLevel: RiskLevel;
  /** Absent = 'code' (pre-M6a ledgers). */
  kind?: MissionKind;
  /** Required for kind=code; forbidden for kind=task (boundary-enforced). */
  repoPath?: string;
  /** kind=task only: delivery directory; default ~/.legion/deliveries/<missionId>/. */
  deliverTo?: string;
  /** M6c: id of the schedule that fired this mission, if any. */
  scheduledBy?: string;
}

/** The minimal shape core needs to fold a mission's event log. */
export interface FoldEvent {
  type: EventType;
  payload: unknown;
}

/** Current mission state, derived — never stored. */
export interface MissionSnapshot {
  missionId: string;
  state: MissionStateName;
  title: string;
  objective: string;
  kind: MissionKind;
  /** null for task missions. */
  repoPath: string | null;
  /** null for code missions and task missions using the default. */
  deliverTo: string | null;
  /** M6c: the schedule that created this mission, or null for manual ones. */
  scheduledBy: string | null;
  riskLevel: RiskLevel;
}
