/**
 * T77 — capability profile resolution. Each role maps to its pinned profile;
 * an unknown role throws (never a permissive default).
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityRoleFor,
  resolveCapabilityProfile,
  UnknownCapabilityRoleError,
} from '../src/capability.js';

describe('T77: capability profile resolution', () => {
  it('planner: no net, no write outside workdir, may spawn, terminal toolset', () => {
    const p = resolveCapabilityProfile('planner');
    expect(p.network).toBe('none');
    expect(p.canSpawnProcesses).toBe(true);
    expect(p.toolset).toBe('terminal');
    expect(p.filesystem.writeWorkdir).toBe(true);
    expect(p.filesystem.readWorkdirOnly).toBe(true);
  });

  it('coder: no net, writes its workspace, may spawn', () => {
    const p = resolveCapabilityProfile('coder');
    expect(p.network).toBe('none');
    expect(p.canSpawnProcesses).toBe(true);
    expect(p.toolset).toBe('terminal');
  });

  it('reviewer: no net, may spawn (writes review.json to its workdir)', () => {
    const p = resolveCapabilityProfile('reviewer');
    expect(p.network).toBe('none');
    expect(p.canSpawnProcesses).toBe(true);
  });

  it('task: no net, may spawn, terminal toolset', () => {
    const p = resolveCapabilityProfile('task');
    expect(p.network).toBe('none');
    expect(p.canSpawnProcesses).toBe(true);
    expect(p.toolset).toBe('terminal');
  });

  it('open (M8 full-capability): allowlist net, MAY spawn, full toolset', () => {
    const p = resolveCapabilityProfile('open');
    expect(p.network).toBe('allowlist');
    expect(p.canSpawnProcesses).toBe(true); // M8: full execution (was read-only in M6d)
    expect(p.toolset).toBe('full');
  });

  it('every profile reports its own role id', () => {
    for (const role of ['planner', 'coder', 'reviewer', 'task', 'open']) {
      expect(resolveCapabilityProfile(role).role).toBe(role);
    }
  });

  it('an unknown role throws — never a permissive default', () => {
    expect(() => resolveCapabilityProfile('hacker')).toThrow(
      UnknownCapabilityRoleError,
    );
    expect(() => resolveCapabilityProfile('')).toThrow(UnknownCapabilityRoleError);
    // no profile silently grants everything
    expect(() => resolveCapabilityProfile('admin')).toThrow(/refusing a permissive default/);
  });

  it('capabilityRoleFor maps (role, explicit capability hint) to the profile key', () => {
    expect(capabilityRoleFor('planner')).toBe('planner');
    expect(capabilityRoleFor('coder')).toBe('coder');
    expect(capabilityRoleFor('reviewer')).toBe('reviewer');
    expect(capabilityRoleFor('worker')).toBe('task'); // task deliverable worker
    // M8: open is marked by an explicit capability role (toolset is no longer 'web')
    expect(capabilityRoleFor('worker', 'open')).toBe('open');
  });
});
