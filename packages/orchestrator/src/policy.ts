/**
 * M6b — risk-proportional pipelines. THE single place where declared risk
 * maps to pipeline policy. THE MERGE GATE IS INVARIANT: nothing here can
 * touch approval or merge/delivery mechanics — this module only decides
 * whether the PLAN gate auto-approves and which scan threshold applies.
 */
import type { EffectiveRiskLevel } from '@legion/core';
import type { FailLevel } from '@legion/scanner';

export interface RiskPolicy {
  /** Auto-emit PLAN_APPROVED {autoApproved, policy} when a valid plan lands. */
  autoApprovePlan: boolean;
  /**
   * Scan threshold forced for this mission; null defers to the global
   * default (LEGION_SCAN_FAIL_LEVEL, then 'error').
   */
  scanFailLevel: FailLevel | null;
  /** Recorded in the ledger when a gate is waived — policy, never silence. */
  policyId: string;
}

const POLICIES: Record<EffectiveRiskLevel, RiskPolicy> = {
  low: { autoApprovePlan: true, scanFailLevel: null, policyId: 'risk:low' },
  medium: { autoApprovePlan: false, scanFailLevel: null, policyId: 'risk:medium' },
  high: { autoApprovePlan: false, scanFailLevel: 'warning', policyId: 'risk:high' },
  // M6d: open missions skip the plan gate entirely (the EXECUTE path records
  // the waiver itself); scan threshold is the default. Read-only toolset.
  'open-readonly': { autoApprovePlan: false, scanFailLevel: null, policyId: 'open-readonly' },
};

export function riskPolicy(risk: EffectiveRiskLevel): RiskPolicy {
  return POLICIES[risk];
}
