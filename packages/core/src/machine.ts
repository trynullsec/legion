import type {
  EventType,
  FoldEvent,
  MissionCreationPayload,
  MissionSnapshot,
  MissionStateName,
} from './types.js';

export class IllegalTransitionError extends Error {
  readonly missionId: string;
  readonly from: MissionStateName;
  readonly event: EventType;

  constructor(missionId: string, from: MissionStateName, event: EventType) {
    super(
      `illegal transition for mission ${missionId}: event ${event} is not valid in state ${from}`,
    );
    this.name = 'IllegalTransitionError';
    this.missionId = missionId;
    this.from = from;
    this.event = event;
  }
}

export class InvalidEventLogError extends Error {
  readonly missionId: string;

  constructor(missionId: string, reason: string) {
    super(`invalid event log for mission ${missionId}: ${reason}`);
    this.name = 'InvalidEventLogError';
    this.missionId = missionId;
  }
}

/**
 * The lifecycle, encoded as data. MISSION_CREATED never appears here:
 * it is only legal as the first event of a log and is handled by foldMission.
 * Terminal states (MERGED, FAILED, CANCELLED) map to nothing.
 */
export const TRANSITIONS: Record<
  MissionStateName,
  Partial<Record<EventType, MissionStateName>>
> = {
  DRAFT: {
    PLANNING_STARTED: 'PLANNING',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  PLANNING: {
    PLAN_PROPOSED: 'AWAITING_PLAN_APPROVAL',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  AWAITING_PLAN_APPROVAL: {
    PLAN_APPROVED: 'BUILDING',
    PLAN_REJECTED: 'PLANNING',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  BUILDING: {
    BUILD_STARTED: 'BUILDING',
    BUILD_COMPLETED: 'SCANNING',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  SCANNING: {
    SCAN_STARTED: 'SCANNING',
    SCAN_PASSED: 'AWAITING_MERGE_APPROVAL',
    // M4 amendment: scan failures route back to BUILDING for rework;
    // MISSION_FAILED / MISSION_CANCELLED are the only terminal routes.
    SCAN_FAILED: 'BUILDING',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  AWAITING_MERGE_APPROVAL: {
    MERGE_APPROVED: 'MERGED',
    // M5 amendment: a signed rejection routes back to BUILDING for rework;
    // MISSION_FAILED / MISSION_CANCELLED are the only terminal routes.
    MERGE_REJECTED: 'BUILDING',
    MISSION_FAILED: 'FAILED',
    MISSION_CANCELLED: 'CANCELLED',
  },
  MERGED: {},
  FAILED: {},
  CANCELLED: {},
};

/** Apply one event to a state. Throws IllegalTransitionError — no silent coercion. */
export function applyEvent(
  missionId: string,
  from: MissionStateName,
  event: EventType,
): MissionStateName {
  const next = TRANSITIONS[from][event];
  if (next === undefined) {
    throw new IllegalTransitionError(missionId, from, event);
  }
  return next;
}

/** Derive current mission state by folding the full ordered event log. */
export function foldMission(
  missionId: string,
  events: ReadonlyArray<FoldEvent>,
): MissionSnapshot {
  const first = events[0];
  if (!first) {
    throw new InvalidEventLogError(missionId, 'event log is empty');
  }
  if (first.type !== 'MISSION_CREATED') {
    throw new InvalidEventLogError(
      missionId,
      `first event must be MISSION_CREATED, got ${first.type}`,
    );
  }
  const creation = first.payload as MissionCreationPayload;

  let state: MissionStateName = 'DRAFT';
  for (const event of events.slice(1)) {
    state = applyEvent(missionId, state, event.type);
  }

  return {
    missionId,
    state,
    title: creation.title,
    objective: creation.objective,
    // pre-M6a events carry no kind: they are code missions by definition
    kind: creation.kind ?? 'code',
    repoPath: creation.repoPath ?? null,
    deliverTo: creation.deliverTo ?? null,
    riskLevel: creation.riskLevel,
  };
}
