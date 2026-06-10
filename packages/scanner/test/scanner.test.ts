import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countFindings,
  DEFAULT_GITLEAKS_BIN,
  DEFAULT_SEMGREP_BIN,
  LEGION_RULES_DIR,
  mergeSarif,
  runGitleaks,
  runSemgrep,
  ScannerCrashError,
  verdict,
} from '../src/index.js';

const exec = promisify(execFile);

let scratch: string;

async function gitRepo(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(dir, rel), content);
  }
  await exec('git', ['init', '-q', dir]);
  const git = (...a: string[]) =>
    exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  await git('add', '-A');
  await git('commit', '-q', '-m', 'fixture');
}

beforeAll(async () => {
  for (const [bin, name] of [
    [DEFAULT_GITLEAKS_BIN, 'gitleaks'],
    [DEFAULT_SEMGREP_BIN, 'semgrep'],
  ] as const) {
    if (!existsSync(bin)) {
      throw new Error(
        `${name} is not installed at ${bin} — run scripts/setup-scanners.sh first. ` +
          'The M4 scan tests run the real scanners and never skip.',
      );
    }
  }
  scratch = await mkdtemp(path.join(os.tmpdir(), 'legion-scanner-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('T32: real SARIF outputs merge into one valid document', () => {
  it('runs both scanners on tiny fixtures, merges, preserves tools, counts correctly', async () => {
    // fixture A: a planted high-entropy AWS-style key for gitleaks
    const dirty = path.join(scratch, 'dirty');
    await exec('mkdir', ['-p', dirty]);
    await gitRepo(dirty, {
      'config.ts': 'const AWS_ACCESS_KEY_ID = "AKIAQ3EGV7DKVPNZX2MJ";\n',
    });

    // fixture B: a legion-rules warning (md5) for semgrep
    const warny = path.join(scratch, 'warny');
    await exec('mkdir', ['-p', warny]);
    await gitRepo(warny, {
      'notes.py': 'import hashlib\nh = hashlib.md5(b"x")\n',
    });

    const gl = await runGitleaks(dirty, null);
    const sg = await runSemgrep(warny, [LEGION_RULES_DIR]);

    // each is itself a single-run SARIF doc from the real tool
    expect(gl.runs).toHaveLength(1);
    expect(sg.runs).toHaveLength(1);
    expect(gl.runs[0]!.results.length).toBeGreaterThanOrEqual(1);
    expect(sg.runs[0]!.results.length).toBeGreaterThanOrEqual(1);

    // gitleaks findings are always level 'error' (a secret is never a warning)
    for (const r of gl.runs[0]!.results) expect(r.level).toBe('error');

    const merged = mergeSarif([gl, sg]);
    expect(merged.version).toBe('2.1.0');
    expect(merged.$schema).toContain('sarif');
    expect(merged.runs).toHaveLength(2);
    const tools = merged.runs.map((r) => r.tool.driver.name.toLowerCase());
    expect(tools.some((t) => t.includes('gitleaks'))).toBe(true);
    expect(tools.some((t) => t.includes('semgrep'))).toBe(true);

    // counts across tools
    const counts = countFindings(merged);
    expect(counts.errors).toBeGreaterThanOrEqual(1); // the secret
    expect(counts.warnings).toBeGreaterThanOrEqual(1); // the md5 rule
    const single = countFindings(gl);
    expect(single.errors).toBe(gl.runs[0]!.results.length);
    expect(single.warnings).toBe(0);
  });

  it('clean fixtures produce zero findings and an empty-but-valid merge', async () => {
    const clean = path.join(scratch, 'clean');
    await exec('mkdir', ['-p', clean]);
    await gitRepo(clean, { 'index.ts': 'export const ok = 1;\n' });

    const gl = await runGitleaks(clean, null);
    const sg = await runSemgrep(clean, [LEGION_RULES_DIR]);
    const merged = mergeSarif([gl, sg]);
    expect(merged.runs).toHaveLength(2);
    expect(countFindings(merged)).toEqual({ errors: 0, warnings: 0, notes: 0 });
  });

  it('a missing level counts as warning (SARIF default), and verdict honors the threshold', () => {
    const synthetic = mergeSarif([
      {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'x' } },
            results: [
              { ruleId: 'a', message: { text: 'no level' } },
              { ruleId: 'b', level: 'note', message: { text: 'note' } },
            ],
          },
        ],
      },
    ]);
    expect(countFindings(synthetic)).toEqual({ errors: 0, warnings: 1, notes: 1 });
    expect(verdict({ errors: 0, warnings: 1, notes: 1 }, 'error')).toBe('pass');
    expect(verdict({ errors: 0, warnings: 1, notes: 1 }, 'warning')).toBe('fail');
    expect(verdict({ errors: 1, warnings: 0, notes: 0 }, 'error')).toBe('fail');
    expect(verdict({ errors: 0, warnings: 0, notes: 5 }, 'warning')).toBe('pass');
  });

  it('a crashing scanner surfaces as ScannerCrashError with stderr, never as a result', async () => {
    const fake = path.join(scratch, 'fake-gitleaks.sh');
    await writeFile(fake, '#!/bin/sh\necho "catastrophic failure" >&2\nexit 2\n');
    await exec('chmod', ['+x', fake]);
    const clean = path.join(scratch, 'clean');
    await expect(
      runGitleaks(clean, null, { gitleaksBin: fake }),
    ).rejects.toThrow(ScannerCrashError);
    try {
      await runGitleaks(clean, null, { gitleaksBin: fake });
    } catch (e) {
      const err = e as ScannerCrashError;
      expect(err.tool).toBe('gitleaks');
      expect(err.stderrTail).toContain('catastrophic failure');
    }
  });
});
