/**
 * T71 (M6d) — the open worker's toolset is an explicit read-only allowlist.
 * Resolved from the REAL vendored hermes toolset registry (the same module
 * the launcher passes to AIAgent via enabled_toolsets): exactly web_search +
 * web_extract (hermes' name for the pin's web_fetch — url → readable text),
 * and no write/shell/send/file tool anywhere in it.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

const exec = promisify(execFile);

const VENV_PYTHON = path.join(REPO_ROOT, '.venv-workers', 'bin', 'python');
const VENDOR = path.join(REPO_ROOT, 'vendor', 'hermes-agent');

/** The single source of truth the launcher uses for open workers. */
export const OPEN_TOOLSET = 'web';

async function resolveToolset(name: string): Promise<string[]> {
  const { stdout } = await exec(
    VENV_PYTHON,
    [
      '-c',
      'import json, sys\n' +
        'from toolsets import resolve_multiple_toolsets\n' +
        'print(json.dumps(sorted(resolve_multiple_toolsets([sys.argv[1]]))))',
      name,
    ],
    { env: { ...process.env, PYTHONPATH: VENDOR } },
  );
  return JSON.parse(stdout.trim()) as string[];
}

describe('T71: open worker toolset allowlist', () => {
  it('venv + vendor exist (setup is a precondition, never skipped)', () => {
    expect(existsSync(VENV_PYTHON)).toBe(true);
    expect(existsSync(VENDOR)).toBe(true);
  });

  it('the open toolset contains exactly web_search and web_extract', async () => {
    const tools = await resolveToolset(OPEN_TOOLSET);
    expect(tools).toEqual(['web_extract', 'web_search']);
  });

  it('no write / shell / send / file / spend tool is reachable', async () => {
    const tools = await resolveToolset(OPEN_TOOLSET);
    const forbidden = /terminal|shell|exec|bash|file|write|edit|create|delete|send|email|message|telegram|discord|slack|sms|browser|payment|spend|wallet/i;
    for (const tool of tools) {
      expect(tool).not.toMatch(forbidden);
    }
  });

  it('contrast: the default worker toolset (terminal) is NOT the open toolset', async () => {
    const terminal = await resolveToolset('terminal');
    expect(terminal.some((t) => /terminal|shell|exec/i.test(t))).toBe(true);
    const open = await resolveToolset(OPEN_TOOLSET);
    for (const t of terminal) {
      expect(open).not.toContain(t);
    }
  });
});
