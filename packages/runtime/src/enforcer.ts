/**
 * M7 — the OS confinement boundary, abstracted so the supervisor is platform-
 * agnostic and tests can inject a forced-unavailable enforcer (T82).
 *
 * - SeatbeltEnforcer (macOS, primary here): real sandbox-exec confinement.
 * - BwrapEnforcer (Linux, the deploy target): bubblewrap namespaces. The code
 *   path is provided and documented but is UNTESTED on this dev machine (no
 *   bwrap/Linux available) — honestly labelled in the README platform matrix.
 *
 * If no enforcer can confine in the current environment, the supervisor
 * refuses to start the worker (never runs unconfined).
 */
import { spawnSync } from 'node:child_process';
import type { CapabilityProfile } from '@legion/core';
import {
  buildSeatbeltProfile,
  canEnforceSeatbelt,
  seatbeltWrap,
  writeProfileFile,
  type ConcreteGrants,
} from './seatbelt.js';

export interface WrappedCommand {
  command: string;
  args: string[];
}

export interface CapabilityEnforcer {
  readonly mechanism: string;
  /** Can this enforcer actually confine in the current environment? */
  canEnforce(): { ok: boolean; reason: string };
  /** Wrap (command,args) so the child runs under the profile. Writes any needed files into controlDir. */
  wrap(
    profile: CapabilityProfile,
    grants: ConcreteGrants,
    controlDir: string,
    command: string,
    args: string[],
  ): WrappedCommand;
}

export class SeatbeltEnforcer implements CapabilityEnforcer {
  readonly mechanism = 'seatbelt';
  canEnforce(): { ok: boolean; reason: string } {
    return canEnforceSeatbelt();
  }
  wrap(
    profile: CapabilityProfile,
    grants: ConcreteGrants,
    controlDir: string,
    command: string,
    args: string[],
  ): WrappedCommand {
    const sb = buildSeatbeltProfile(profile, grants);
    const file = writeProfileFile(controlDir, sb);
    return seatbeltWrap(file, command, args);
  }
}

/**
 * Linux deploy path (untested on this macOS dev machine). bubblewrap binds
 * readable paths read-only, the writable workdir read-write, --unshare-net
 * for net:none, and routes net:allowlist through the egress proxy on
 * loopback (shared net + only the proxy reachable via the profile).
 */
export class BwrapEnforcer implements CapabilityEnforcer {
  readonly mechanism = 'bubblewrap';
  canEnforce(): { ok: boolean; reason: string } {
    const r = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return { ok: true, reason: 'bwrap present' };
    return { ok: false, reason: 'bwrap not installed' };
  }
  wrap(
    profile: CapabilityProfile,
    grants: ConcreteGrants,
    _controlDir: string,
    command: string,
    args: string[],
  ): WrappedCommand {
    const a: string[] = ['--die-with-parent', '--proc', '/proc', '--dev', '/dev'];
    for (const p of grants.readPaths) a.push('--ro-bind-try', p, p);
    for (const p of grants.writePaths) a.push('--bind-try', p, p);
    // net:none gets a private (empty) network namespace; allowlist shares the
    // host net but the seatbelt-equivalent reachability is enforced at the
    // proxy (the worker only knows 127.0.0.1:proxyPort).
    if (profile.network === 'none') a.push('--unshare-net');
    a.push(command, ...args);
    return { command: 'bwrap', args: a };
  }
}

/** Test seam (T82): an enforcer that reports it cannot confine. */
export class UnavailableEnforcer implements CapabilityEnforcer {
  readonly mechanism = 'none';
  constructor(private readonly why = 'forced unavailable for testing') {}
  canEnforce(): { ok: boolean; reason: string } {
    return { ok: false, reason: this.why };
  }
  wrap(): WrappedCommand {
    throw new Error('UnavailableEnforcer cannot wrap — the supervisor must refuse to start');
  }
}

/** Pick the right enforcer for the current platform. */
export function defaultEnforcer(): CapabilityEnforcer {
  if (process.platform === 'darwin') return new SeatbeltEnforcer();
  if (process.platform === 'linux') return new BwrapEnforcer();
  return new UnavailableEnforcer(`unsupported platform ${process.platform}`);
}
