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

  it('open: allowlist net, NO subprocess, web toolset', () => {
    const p = resolveCapabilityProfile('open');
    expect(p.network).toBe('allowlist');
    expect(p.canSpawnProcesses).toBe(false);
    expect(p.toolset).toBe('web');
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

  it('capabilityRoleFor maps (role, toolset) to the profile key', () => {
    expect(capabilityRoleFor('planner')).toBe('planner');
    expect(capabilityRoleFor('coder')).toBe('coder');
    expect(capabilityRoleFor('reviewer')).toBe('reviewer');
    expect(capabilityRoleFor('worker')).toBe('task'); // task deliverable worker
    expect(capabilityRoleFor('worker', 'web')).toBe('open'); // open research worker
  });
});
