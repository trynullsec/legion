import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Monorepo root (packages/runtime/src → three levels up). */
export const REPO_ROOT = path.join(HERE, '..', '..', '..');

export interface RuntimeConfig {
  /** Python interpreter inside the worker venv. */
  venvPython: string;
  /** Vendored hermes-agent checkout (read-only). */
  vendorDir: string;
  /** Our JSONL launcher that drives Hermes programmatically. */
  launcherPath: string;
  /** Root for per-worker isolated working directories. */
  workdirRoot: string;
  /** Default OpenRouter model — see README for the rationale. */
  model: string;
  /** OpenAI-compatible endpoint. */
  baseUrl: string;
  /** Hard per-worker timeout (ms). */
  timeoutMs: number;
  /** Grace window between SIGTERM and SIGKILL on graceful stop (ms). */
  killGraceMs: number;
  /** Max model iterations per task. */
  maxTurns: number;
  /**
   * M7: read-only roots a confined worker needs to exec the runtime — the
   * venv, the vendored agent, and the launcher dir. Deliberately EXCLUDES the
   * repo root (and thus .env) so a confined worker cannot read secrets.
   */
  runtimeReadRoots: string[];
  /** Secret-bearing paths explicitly denied to confined workers (e.g. .env). */
  secretDenyReadPaths: string[];
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  venvPython: path.join(REPO_ROOT, '.venv-workers', 'bin', 'python'),
  vendorDir: path.join(REPO_ROOT, 'vendor', 'hermes-agent'),
  launcherPath: path.join(REPO_ROOT, 'packages', 'runtime', 'python', 'worker_main.py'),
  workdirRoot: path.join(os.homedir(), '.legion', 'workdirs'),
  model: 'openai/gpt-oss-120b',
  baseUrl: 'https://openrouter.ai/api/v1',
  timeoutMs: 10 * 60 * 1000,
  killGraceMs: 10 * 1000,
  maxTurns: 12,
  runtimeReadRoots: [
    path.join(REPO_ROOT, '.venv-workers'),
    path.join(REPO_ROOT, 'vendor', 'hermes-agent'),
    path.join(REPO_ROOT, 'packages', 'runtime', 'python'),
  ],
  secretDenyReadPaths: [path.join(REPO_ROOT, '.env')],
};

/** Host of the LLM control-plane endpoint (always reachable via the proxy). */
export function modelHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'openrouter.ai';
  }
}
