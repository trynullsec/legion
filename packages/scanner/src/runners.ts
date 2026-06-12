import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SarifDocument } from './sarif.js';

const exec = promisify(execFile);

export const DEFAULT_GITLEAKS_BIN = path.join(
  os.homedir(), '.legion', 'tools', 'gitleaks',
);
export const DEFAULT_SEMGREP_BIN = path.join(
  os.homedir(), '.legion', 'tools', 'semgrep-venv', 'bin', 'semgrep',
);

/** In-repo deterministic house rules — Legion source, not a scanner fork. */
export const LEGION_RULES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'legion-rules',
);

export const DEFAULT_SEMGREP_CONFIGS = ['p/default', LEGION_RULES_DIR];

export class ScannerCrashError extends Error {
  constructor(
    readonly tool: 'gitleaks' | 'semgrep',
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(`${tool} crashed (exit ${exitCode}): ${stderrTail.slice(-300)}`);
    this.name = 'ScannerCrashError';
  }
}

function tail(s: string, n = 4000): string {
  return s.length > n ? s.slice(-n) : s;
}

interface ExecFailure {
  code?: number;
  stdout?: string;
  stderr?: string;
}

async function readSarif(
  file: string,
  tool: 'gitleaks' | 'semgrep',
  stderr: string,
): Promise<SarifDocument> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new ScannerCrashError(tool, null, `no SARIF report produced; stderr: ${tail(stderr)}`);
  }
  let parsed: SarifDocument;
  try {
    parsed = JSON.parse(raw) as SarifDocument;
  } catch (e) {
    throw new ScannerCrashError(tool, null, `invalid SARIF JSON (${String(e)}); stderr: ${tail(stderr)}`);
  }
  if (parsed.version !== '2.1.0' || !Array.isArray(parsed.runs)) {
    throw new ScannerCrashError(tool, null, `unexpected SARIF shape; stderr: ${tail(stderr)}`);
  }
  return parsed;
}

/**
 * Secrets scan over the repo's git history (full diff — a secret added then
 * deleted still counts). `baseSha` limits the scan to the attempt branch's
 * commits; null scans the whole history.
 * Exit 0 = clean, 1 = leaks found; anything else is a crash.
 */
export async function runGitleaks(
  repoDir: string,
  baseSha: string | null,
  options: { gitleaksBin?: string } = {},
): Promise<SarifDocument> {
  const bin =
    options.gitleaksBin ?? process.env.LEGION_GITLEAKS_BIN ?? DEFAULT_GITLEAKS_BIN;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'legion-gl-'));
  const report = path.join(tmp, `${randomUUID()}.sarif`);
  const args = [
    'git',
    '--report-format', 'sarif',
    '--report-path', report,
    '--no-banner',
    '--exit-code', '1',
    ...(baseSha ? [`--log-opts=${baseSha}..HEAD`] : []),
    repoDir,
  ];
  let stderr = '';
  try {
    const r = await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    stderr = r.stderr;
  } catch (e) {
    const failure = e as ExecFailure;
    stderr = failure.stderr ?? '';
    if (failure.code !== 1) {
      await rm(tmp, { recursive: true, force: true });
      throw new ScannerCrashError(
        'gitleaks',
        failure.code ?? null,
        tail(`${stderr}\n${failure.stdout ?? ''}`),
      );
    }
    // exit 1 = leaks found; the SARIF report carries them
  }
  const sarif = await readSarif(report, 'gitleaks', stderr);
  await rm(tmp, { recursive: true, force: true });
  // a hardcoded secret is never a warning — force level error (pin 4)
  for (const run of sarif.runs) {
    for (const result of run.results ?? []) {
      result.level = 'error';
    }
  }
  return sarif;
}

/**
 * M6a: secrets scan over a plain directory (task-mission deliverables are not
 * a git repository). Same SARIF contract, same exit-code semantics, same
 * unconditional error-level mapping as the git mode.
 */
export async function runGitleaksDir(
  dir: string,
  options: { gitleaksBin?: string } = {},
): Promise<SarifDocument> {
  const bin =
    options.gitleaksBin ?? process.env.LEGION_GITLEAKS_BIN ?? DEFAULT_GITLEAKS_BIN;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'legion-gld-'));
  const report = path.join(tmp, `${randomUUID()}.sarif`);
  const args = [
    'dir',
    '--report-format', 'sarif',
    '--report-path', report,
    '--no-banner',
    '--exit-code', '1',
    dir,
  ];
  let stderr = '';
  try {
    const r = await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    stderr = r.stderr;
  } catch (e) {
    const failure = e as ExecFailure;
    stderr = failure.stderr ?? '';
    if (failure.code !== 1) {
      await rm(tmp, { recursive: true, force: true });
      throw new ScannerCrashError(
        'gitleaks',
        failure.code ?? null,
        tail(`${stderr}\n${failure.stdout ?? ''}`),
      );
    }
    // exit 1 = leaks found; the SARIF report carries them
  }
  const sarif = await readSarif(report, 'gitleaks', stderr);
  await rm(tmp, { recursive: true, force: true });
  // a hardcoded secret is never a warning — force level error (M4 pin 4)
  for (const run of sarif.runs) {
    for (const result of run.results ?? []) {
      result.level = 'error';
    }
  }
  return sarif;
}

/**
 * Code-pattern scan of the workspace checkout. Exit 0 = ran (findings live
 * in the SARIF); anything else is a crash.
 */
export async function runSemgrep(
  repoDir: string,
  configs?: string[],
  options: { semgrepBin?: string } = {},
): Promise<SarifDocument> {
  const bin =
    options.semgrepBin ?? process.env.LEGION_SEMGREP_BIN ?? DEFAULT_SEMGREP_BIN;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'legion-sg-'));
  const report = path.join(tmp, `${randomUUID()}.sarif`);
  const configArgs = (configs ?? DEFAULT_SEMGREP_CONFIGS).flatMap((c) => [
    '--config', c,
  ]);
  const args = [
    'scan',
    '--sarif',
    '--output', report,
    ...configArgs,
    '--metrics=off',
    '--quiet',
    repoDir,
  ];
  let stderr = '';
  try {
    const r = await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    stderr = r.stderr;
  } catch (e) {
    const failure = e as ExecFailure;
    await rm(tmp, { recursive: true, force: true });
    throw new ScannerCrashError(
      'semgrep',
      failure.code ?? null,
      tail(`${failure.stderr ?? ''}\n${failure.stdout ?? ''}`),
    );
  }
  const sarif = await readSarif(report, 'semgrep', stderr);
  await rm(tmp, { recursive: true, force: true });
  return sarif;
}
