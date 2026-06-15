import { existsSync, realpathSync } from 'node:fs';
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
  /**
   * M8: terminal execution backend for full-capability (open) missions —
   * 'docker' (default, recommended; Hermes-grade hardened container) or
   * 'local' (host execution). docker-unavailable + docker-selected → fail.
   */
  terminalBackend: TerminalBackend;
  /** M8: host root for per-mission Docker sandbox volumes (~/.legion/sandboxes). */
  sandboxesRoot: string;
  /** M8: pinned Docker image for the terminal backend (Hermes default). */
  dockerImage: string;
  /** M8: the vendored Hermes toolset name an open worker enables (full core exec). */
  openMissionToolset: string;
}

export type TerminalBackend = 'docker' | 'local';

/** Resolve the terminal backend from env (default docker, per pin 2). */
export function resolveTerminalBackend(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackend {
  const raw = (env.LEGION_TERMINAL_BACKEND ?? 'docker').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw === 'docker' || raw === '') return 'docker';
  throw new Error(
    `LEGION_TERMINAL_BACKEND="${raw}" is invalid — use 'docker' or 'local'`,
  );
}

/**
 * Locate the Docker daemon unix socket (for the seatbelt scoped grant +
 * availability check). Honors DOCKER_HOST=unix://... then the common Docker
 * Desktop / Linux paths. Returns the realpath when resolvable, else null.
 */
export function detectDockerSocket(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  const host = env.DOCKER_HOST;
  if (host?.startsWith('unix://')) candidates.push(host.slice('unix://'.length));
  candidates.push(
    path.join(os.homedir(), '.docker', 'run', 'docker.sock'),
    '/var/run/docker.sock',
    '/run/docker.sock',
  );
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  return null;
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
  terminalBackend: resolveTerminalBackend(),
  sandboxesRoot: path.join(os.homedir(), '.legion', 'sandboxes'),
  // Hermes' pinned default image (python + node) — full-capability execution.
  dockerImage:
    process.env.LEGION_DOCKER_IMAGE ??
    'nikolaik/python-nodejs:python3.11-nodejs20',
  // hermes-api-server = the vendored full core toolset (terminal, execute_code,
  // read/write/patch, browser, web_search/web_extract, todo, delegate_task).
  openMissionToolset: 'hermes-api-server',
};

/**
 * M8: the host path Hermes' docker backend bind-mounts to the container's
 * /workspace, given our per-mission TERMINAL_SANDBOX_DIR=<sandboxesRoot>/<id>.
 * Hermes lays it out as <sandbox>/docker/<task_id>/workspace (task_id default).
 */
export function dockerWorkspaceDir(sandboxesRoot: string, missionId: string): string {
  return path.join(sandboxesRoot, missionId, 'docker', 'default', 'workspace');
}

/** Host of the LLM control-plane endpoint (always reachable via the proxy). */
export function modelHostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return 'openrouter.ai';
  }
}
