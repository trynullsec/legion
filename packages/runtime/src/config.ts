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
};
