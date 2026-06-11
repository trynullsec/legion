import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  foldMission,
  IllegalTransitionError,
  InvalidEventLogError,
  TRANSITIONS,
  type EventType,
  type FoldEvent,
  type MissionStateName,
} from '../src/index.js';

const CREATION = {
  title: 'Migrate auth service to passkeys',
  objective: 'Replace password auth with WebAuthn passkeys',
  repoPath: '/tmp/repo',
  riskLevel: 'high' as const,
};

const MISSION_ID = '00000000-0000-0000-0000-000000000001';

function created(): FoldEvent {
  return { type: 'MISSION_CREATED', payload: CREATION };
}

function ev(type: EventType): FoldEvent {
  return { type, payload: {} };
}

describe('transition table', () => {
  it('is encoded as data covering every state', () => {
    const states: MissionStateName[] = [
      'DRAFT',
      'PLANNING',
      'AWAITING_PLAN_APPROVAL',
      'BUILDING',
      'SCANNING',
      'AWAITING_MERGE_APPROVAL',
      'MERGED',
      'FAILED',
      'CANCELLED',
    ];
    for (const s of states) {
      expect(TRANSITIONS[s]).toBeDefined();
    }
    // terminal states allow nothing
    expect(Object.keys(TRANSITIONS.MERGED)).toHaveLength(0);
    expect(Object.keys(TRANSITIONS.FAILED)).toHaveLength(0);
    expect(Object.keys(TRANSITIONS.CANCELLED)).toHaveLength(0);
  });

  it('allows FAILED and CANCELLED from every non-terminal state', () => {
    const nonTerminal: MissionStateName[] = [
      'DRAFT',
      'PLANNING',
      'AWAITING_PLAN_APPROVAL',
      'BUILDING',
      'SCANNING',
      'AWAITING_MERGE_APPROVAL',
    ];
    for (const s of nonTerminal) {
      expect(applyEvent(MISSION_ID, s, 'MISSION_FAILED')).toBe('FAILED');
      expect(applyEvent(MISSION_ID, s, 'MISSION_CANCELLED')).toBe('CANCELLED');
    }
  });
});

describe('T2 (core): creation folds to DRAFT', () => {
  it('folds a single MISSION_CREATED event to DRAFT with the creation payload', () => {
    const snap = foldMission(MISSION_ID, [created()]);
    expect(snap.state).toBe('DRAFT');
    expect(snap.title).toBe(CREATION.title);
    expect(snap.objective).toBe(CREATION.objective);
    expect(snap.repoPath).toBe(CREATION.repoPath);
    expect(snap.riskLevel).toBe('high');
  });

  it('rejects an event log that does not start with MISSION_CREATED', () => {
    expect(() => foldMission(MISSION_ID, [ev('PLANNING_STARTED')])).toThrow(
      InvalidEventLogError,
    );
  });

  it('rejects an empty event log', () => {
    expect(() => foldMission(MISSION_ID, [])).toThrow(InvalidEventLogError);
  });
});

describe('T3 (core): happy path folds to MERGED', () => {
  it('folds the full 9-event happy path to MERGED', () => {
    const events: FoldEvent[] = [
      created(),
      ev('PLANNING_STARTED'),
      ev('PLAN_PROPOSED'),
      ev('PLAN_APPROVED'),
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_PASSED'),
      ev('MERGE_APPROVED'),
    ];
    expect(events).toHaveLength(9);
    const snap = foldMission(MISSION_ID, events);
    expect(snap.state).toBe('MERGED');
  });
});

describe('T4 (core): illegal transitions throw IllegalTransitionError', () => {
  it('throws with {missionId, from, event} when SCAN_STARTED is applied to DRAFT', () => {
    expect(() => applyEvent(MISSION_ID, 'DRAFT', 'SCAN_STARTED')).toThrow(
      IllegalTransitionError,
    );
    try {
      applyEvent(MISSION_ID, 'DRAFT', 'SCAN_STARTED');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as IllegalTransitionError;
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect(err.missionId).toBe(MISSION_ID);
      expect(err.from).toBe('DRAFT');
      expect(err.event).toBe('SCAN_STARTED');
    }
  });

  it('throws when MISSION_CREATED is applied to an existing mission', () => {
    expect(() => applyEvent(MISSION_ID, 'DRAFT', 'MISSION_CREATED')).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws on any event applied to a terminal state', () => {
    expect(() => applyEvent(MISSION_ID, 'MERGED', 'PLANNING_STARTED')).toThrow(
      IllegalTransitionError,
    );
    expect(() => applyEvent(MISSION_ID, 'CANCELLED', 'MISSION_FAILED')).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('T5 (core): plan rejection loops back to PLANNING', () => {
  it('PLAN_REJECTED returns to PLANNING and a second proposal proceeds', () => {
    const events: FoldEvent[] = [
      created(),
      ev('PLANNING_STARTED'),
      ev('PLAN_PROPOSED'),
      ev('PLAN_REJECTED'),
    ];
    expect(foldMission(MISSION_ID, events).state).toBe('PLANNING');

    const resumed: FoldEvent[] = [
      ...events,
      ev('PLAN_PROPOSED'),
      ev('PLAN_APPROVED'),
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_PASSED'),
      ev('MERGE_APPROVED'),
    ];
    expect(foldMission(MISSION_ID, resumed).state).toBe('MERGED');
  });
});

describe('T31: scan failure routes back to BUILDING (M4 amendment)', () => {
  it('SCANNING -SCAN_FAILED-> BUILDING is encoded in the transition table', () => {
    expect(TRANSITIONS.SCANNING.SCAN_FAILED).toBe('BUILDING');
  });

  it('the old SCAN_FAILED route to FAILED is gone — only MISSION_FAILED/CANCELLED terminate from SCANNING', () => {
    const scanning = TRANSITIONS.SCANNING;
    const toFailed = Object.entries(scanning)
      .filter(([, to]) => to === 'FAILED')
      .map(([event]) => event);
    expect(toFailed).toEqual(['MISSION_FAILED']);
    expect(scanning.MISSION_CANCELLED).toBe('CANCELLED');
  });

  it('SCAN_FAILED folds to BUILDING, and the rework loop completes to MERGED', () => {
    const reworked: FoldEvent[] = [
      created(),
      ev('PLANNING_STARTED'),
      ev('PLAN_PROPOSED'),
      ev('PLAN_APPROVED'),
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_FAILED'),
    ];
    expect(foldMission(MISSION_ID, reworked).state).toBe('BUILDING');

    const completed: FoldEvent[] = [
      ...reworked,
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_PASSED'),
      ev('MERGE_APPROVED'),
    ];
    expect(foldMission(MISSION_ID, completed).state).toBe('MERGED');
  });
});

describe('T44: merge rejection routes back to BUILDING (M5 amendment)', () => {
  it('AWAITING_MERGE_APPROVAL -MERGE_REJECTED-> BUILDING is encoded in the table', () => {
    expect(TRANSITIONS.AWAITING_MERGE_APPROVAL.MERGE_REJECTED).toBe('BUILDING');
  });

  it('only MISSION_FAILED terminates from AWAITING_MERGE_APPROVAL', () => {
    const gate = TRANSITIONS.AWAITING_MERGE_APPROVAL;
    const toFailed = Object.entries(gate)
      .filter(([, to]) => to === 'FAILED')
      .map(([event]) => event);
    expect(toFailed).toEqual(['MISSION_FAILED']);
    expect(gate.MISSION_CANCELLED).toBe('CANCELLED');
  });

  it('MERGE_REJECTED folds to BUILDING, and the rework loop completes to MERGED', () => {
    const reworked: FoldEvent[] = [
      created(),
      ev('PLANNING_STARTED'),
      ev('PLAN_PROPOSED'),
      ev('PLAN_APPROVED'),
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_PASSED'),
      ev('MERGE_REJECTED'),
    ];
    expect(foldMission(MISSION_ID, reworked).state).toBe('BUILDING');

    const completed: FoldEvent[] = [
      ...reworked,
      ev('BUILD_STARTED'),
      ev('BUILD_COMPLETED'),
      ev('SCAN_STARTED'),
      ev('SCAN_PASSED'),
      ev('MERGE_APPROVED'),
    ];
    expect(foldMission(MISSION_ID, completed).state).toBe('MERGED');
  });
});
