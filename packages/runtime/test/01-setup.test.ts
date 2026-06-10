import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

const exec = promisify(execFile);

describe('T9: setup-workers.sh provisions the Hermes venv', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'setup-workers.sh');
  const venvPython = path.join(REPO_ROOT, '.venv-workers', 'bin', 'python');

  it('runs non-interactively and creates the venv', async () => {
    const { stdout } = await exec('bash', [script], {
      timeout: 840_000,
      env: { ...process.env, CI: '1' },
    });
    expect(stdout).toContain('[setup-workers] done');
    expect(existsSync(venvPython)).toBe(true);
  }, 900_000);

  it('smoke check: the hermes entry point is invocable from the venv', async () => {
    const { stdout } = await exec(
      venvPython,
      ['-c', 'from run_agent import AIAgent; print("hermes-entrypoint-ok")'],
      { timeout: 120_000 },
    );
    expect(stdout).toContain('hermes-entrypoint-ok');
  });

  it('venv python is 3.11 as pinned', async () => {
    const { stdout } = await exec(venvPython, ['--version'], {
      timeout: 30_000,
    });
    expect(stdout).toContain('Python 3.11');
  });
});
