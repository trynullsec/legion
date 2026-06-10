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

/** Payload of MISSION_CREATED. Validated with zod at the API boundary; core trusts typed input. */
export interface MissionCreationPayload {
  title: string;
  objective: string;
  repoPath: string;
  riskLevel: RiskLevel;
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
  repoPath: string;
  riskLevel: RiskLevel;
}
