/**
 * M7 — runtime capability scoping. A CapabilityProfile is the per-role grant,
 * declared here and enforced at the OS boundary by the supervisor (seatbelt
 * on macOS, bubblewrap on Linux). This module is pure policy: which role gets
 * which grant. It can only ever REDUCE what a worker may do.
 *
 * THE GRANT IS THE CEILING. Filesystem write/read are allowlists (everything
 * else denied). Network is a coarse egress mode enforced by the per-worker
 * egress proxy + the OS net layer:
 *   - 'none'      : no worker-initiated egress. The agent runtime still
 *                   reaches the LLM control-plane endpoint (it cannot think
 *                   otherwise) THROUGH the proxy, which allows only that host.
 *   - 'allowlist' : the LLM endpoint + general web, every request routed and
 *                   logged through the proxy, SSRF ranges blocked.
 *   - 'open'      : unused by any role today; reserved.
 */

export const CAPABILITY_ROLES = [
  'planner',
  'coder',
  'reviewer',
  'task',
  'open',
] as const;

export type CapabilityRole = (typeof CAPABILITY_ROLES)[number];

export type NetworkPolicy = 'none' | 'allowlist' | 'open';

export interface CapabilityProfile {
  /** The resolved profile id (one of CAPABILITY_ROLES). */
  role: CapabilityRole;
  /** Egress mode, enforced by the OS net layer + the egress proxy. */
  network: NetworkPolicy;
  /** May the worker spawn subprocesses? Code-side roles + full-exec open need a shell. */
  canSpawnProcesses: boolean;
  /**
   * The tool surface descriptor. 'terminal' = code/task workers; 'full' = M8
   * full-capability open missions (terminal, code, files, browser, web). The
   * concrete vendored toolset name is configured in the runtime, not here.
   */
  toolset: 'terminal' | 'full';
  /**
   * Logical filesystem grants. The supervisor maps these to concrete,
   * realpath-resolved subtrees at spawn (the worker's own workdir tree, plus
   * the read-only system runtime roots every process needs to exec at all).
   * Everything outside the resolved allowlists is denied by the OS.
   */
  filesystem: {
    /** May write its own isolated workdir subtree (plan.json / commits / review.json / deliverables). */
    writeWorkdir: boolean;
    /** Reads are confined to the workdir tree + system runtime roots; no broad read. */
    readWorkdirOnly: boolean;
  };
}

export class UnknownCapabilityRoleError extends Error {
  constructor(readonly requested: string) {
    super(
      `no capability profile for role "${requested}" — refusing a permissive default`,
    );
    this.name = 'UnknownCapabilityRoleError';
  }
}

const PROFILES: Record<CapabilityRole, CapabilityProfile> = {
  // reads its disposable clone, writes plan.json into its own workdir, no net
  planner: {
    role: 'planner',
    network: 'none',
    canSpawnProcesses: true,
    toolset: 'terminal',
    filesystem: { writeWorkdir: true, readWorkdirOnly: true },
  },
  // implements on a branch in its workspace clone; writes there only; no net
  coder: {
    role: 'coder',
    network: 'none',
    canSpawnProcesses: true,
    toolset: 'terminal',
    filesystem: { writeWorkdir: true, readWorkdirOnly: true },
  },
  // reads the diff/clone, writes review.json into its own workdir, no net
  reviewer: {
    role: 'reviewer',
    network: 'none',
    canSpawnProcesses: true,
    toolset: 'terminal',
    filesystem: { writeWorkdir: true, readWorkdirOnly: true },
  },
  // task deliverable worker: writes its workdir/deliverables, no net
  task: {
    role: 'task',
    network: 'none',
    canSpawnProcesses: true,
    toolset: 'terminal',
    filesystem: { writeWorkdir: true, readWorkdirOnly: true },
  },
  // M8: full-capability open worker — terminal, code, files, browser, web.
  // It spawns subprocesses (docker orchestration, or host tools on the local
  // backend). Web egress still routes through the proxy (allowlist + SSRF).
  // With the docker backend, the agent's tools execute INSIDE a hardened
  // container (the security boundary); the worker process stays seatbelt-wrapped.
  open: {
    role: 'open',
    network: 'allowlist',
    canSpawnProcesses: true,
    toolset: 'full',
    filesystem: { writeWorkdir: true, readWorkdirOnly: true },
  },
};

/**
 * Resolve the role's pinned CapabilityProfile. An unknown role throws —
 * there is NO permissive default (pin 1 / T77).
 */
export function resolveCapabilityProfile(role: string): CapabilityProfile {
  const profile = PROFILES[role as CapabilityRole];
  if (!profile) throw new UnknownCapabilityRoleError(role);
  return profile;
}

/**
 * Map a worker's (role, explicit capability hint) to its profile key. Open and
 * task missions both spawn role 'worker'; the orchestrator passes an explicit
 * `capabilityRole` ('open') to distinguish them (M8: the open toolset is no
 * longer 'web', so it can't be inferred from the toolset string).
 */
export function capabilityRoleFor(role: string, capabilityRole?: string): string {
  if (capabilityRole) return capabilityRole; // explicit wins (open vs task)
  if (role === 'worker') return 'task';
  return role; // planner | coder | reviewer
}
