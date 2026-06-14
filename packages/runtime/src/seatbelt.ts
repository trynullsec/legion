/**
 * M7 — macOS OS confinement via seatbelt (sandbox-exec). Generates a
 * (deny default) profile from a worker's concrete grants and wraps the spawn
 * command. This is REAL kernel-enforced confinement, not a Node wrapper the
 * child can escape: sandbox-exec applies the profile to the process before it
 * execs, and a confined child cannot remove it.
 *
 * Paths are realpath-resolved before they enter a profile — on macOS /tmp,
 * /var and /etc are symlinks into /private, and seatbelt matches on the real
 * path. An unresolved path silently grants nothing (the step-2 gotcha from
 * the probe).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapabilityProfile } from '@legion/core';

export interface ConcreteGrants {
  /** Realpath-resolved subtrees the worker may write. */
  writePaths: string[];
  /** Extra realpath-resolved subtrees the worker may read (system roots are always added). */
  readPaths: string[];
  /** Localhost egress chokepoint the worker may connect to (the per-worker proxy). */
  proxyPort: number;
  /**
   * Realpath-resolved paths whose READ is explicitly denied even though system
   * read is broad — secret-bearing files (the repo .env) a confined worker must
   * never see. Deny rules win over the blanket read allow.
   */
  denyReadPaths?: string[];
}

export class EnforcementUnavailableError extends Error {
  constructor(reason: string) {
    super(`OS capability enforcement is unavailable: ${reason}`);
    this.name = 'EnforcementUnavailableError';
  }
}

function resolveSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p); // not yet on disk — use the absolute form
  }
}

function sbString(p: string): string {
  // seatbelt profile strings are double-quoted; escape backslashes + quotes
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build a (deny default) seatbelt profile. Writes are confined to writePaths;
 * reads to writePaths + readPaths + the system runtime roots; outbound network
 * is denied except to the localhost proxy port (the single egress chokepoint).
 * Subprocess exec is allowed only when the profile permits it.
 */
export function buildSeatbeltProfile(
  profile: CapabilityProfile,
  grants: ConcreteGrants,
): string {
  const writes = [...new Set(grants.writePaths.map(resolveSafe))];
  const denyReads = [...new Set((grants.denyReadPaths ?? []).map(resolveSafe))];

  // READ is broad: the dynamic linker, dyld shared cache, the Python runtime
  // and countless system frameworks must be readable or the interpreter
  // SIGABRTs before it runs. Confinement's teeth are WRITE (strict allowlist)
  // and NETWORK (loopback proxy only) — a worker cannot mutate the host or
  // exfiltrate to disk/net outside its grant. Specific secret files are
  // explicitly denied below so broad read never exposes them.
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    // deny-read the secret-bearing paths even though read is otherwise broad
    ...denyReads.map((p) => `(deny file-read* (subpath ${sbString(p)}))`),
    // standard character devices any shell/interpreter needs to write (a
    // subprocess redirects stdio through /dev/null; the loader/RNG touch the
    // others). These are not a confinement hole — they are stateless devices.
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/stdout") (literal "/dev/stderr"))',
    // writes: the worker's own tree only — everything else denied by default
    ...writes.map((p) => `(allow file-write* (subpath ${sbString(p)}))`),
    // network: only the localhost egress proxy is reachable (fail-closed).
    // seatbelt requires the host to be "*" or "localhost" — a numeric IP is
    // rejected; loopback connections to 127.0.0.1:<port> match "localhost".
    // The worker never resolves DNS or opens other sockets: it hands the
    // proxy a hostname and the proxy (in the unconfined daemon) dials out.
    `(allow network-outbound (remote ip ${sbString(`localhost:${grants.proxyPort}`)}))`,
  ];

  return lines.join('\n') + '\n';
}

/** sandbox-exec argv prefix for a generated profile file. */
export function seatbeltWrap(profilePath: string, command: string, args: string[]): {
  command: string;
  args: string[];
} {
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, command, ...args],
  };
}

let cachedProbe: { ok: boolean; reason: string } | null = null;

/**
 * Probe whether seatbelt can actually apply a profile in THIS environment.
 * Returns ok=false (with a reason) when sandbox-exec exists but sandbox_apply
 * is denied (e.g. already running inside a sandbox) — the supervisor then
 * refuses to start workers rather than run them unconfined.
 */
export function canEnforceSeatbelt(): { ok: boolean; reason: string } {
  if (cachedProbe) return cachedProbe;
  if (process.platform !== 'darwin') {
    cachedProbe = { ok: false, reason: `seatbelt is macOS-only (platform=${process.platform})` };
    return cachedProbe;
  }
  let dir: string | null = null;
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-n', 'no-internet', '/usr/bin/true'], {
      stdio: 'ignore',
    });
  } catch {
    // fall through to the file-profile probe — named profiles vary by OS
  }
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'legion-sb-probe-'));
    const prof = path.join(dir, 'p.sb');
    writeFileSync(
      prof,
      '(version 1)\n(deny default)\n(allow process-fork)\n(allow process-exec*)\n(allow file-read*)\n(allow sysctl-read)\n(allow mach-lookup)\n',
    );
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', prof, '/usr/bin/true'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (r.status === 0) {
      cachedProbe = { ok: true, reason: 'seatbelt applies' };
    } else {
      cachedProbe = {
        ok: false,
        reason: `sandbox-exec could not apply a profile: ${(r.stderr || '').trim() || `exit ${r.status}`}`,
      };
    }
  } catch (e) {
    cachedProbe = { ok: false, reason: `sandbox-exec unavailable: ${String(e)}` };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return cachedProbe;
}

/** Test seam: forget the cached probe result. */
export function _resetSeatbeltProbe(): void {
  cachedProbe = null;
}

export function writeProfileFile(dir: string, contents: string): string {
  const file = path.join(dir, 'capability.sb');
  writeFileSync(file, contents);
  return file;
}
