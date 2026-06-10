/** Minimal SARIF 2.1.0 surface Legion relies on. */
export interface SarifResult {
  ruleId?: string;
  level?: 'error' | 'warning' | 'note' | 'none';
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
  [key: string]: unknown;
}

export interface SarifRun {
  tool: { driver: { name: string; [key: string]: unknown } };
  results: SarifResult[];
  [key: string]: unknown;
}

export interface SarifDocument {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface ScanCounts {
  errors: number;
  warnings: number;
  notes: number;
}

export const SARIF_SCHEMA =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/** Merge tool outputs into ONE valid SARIF doc — one runs[] entry per tool. */
export function mergeSarif(documents: SarifDocument[]): SarifDocument {
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: documents.flatMap((d) => d.runs),
  };
}

/**
 * Count findings by level across all runs. Per the SARIF spec, a result
 * without an explicit level defaults to 'warning'.
 */
export function countFindings(doc: SarifDocument): ScanCounts {
  const counts: ScanCounts = { errors: 0, warnings: 0, notes: 0 };
  for (const run of doc.runs) {
    for (const result of run.results ?? []) {
      const level = result.level ?? 'warning';
      if (level === 'error') counts.errors++;
      else if (level === 'warning') counts.warnings++;
      else if (level === 'note') counts.notes++;
    }
  }
  return counts;
}

export type FailLevel = 'error' | 'warning';

export function verdict(counts: ScanCounts, failLevel: FailLevel): 'pass' | 'fail' {
  if (counts.errors > 0) return 'fail';
  if (failLevel === 'warning' && counts.warnings > 0) return 'fail';
  return 'pass';
}

/** Flattened finding for API/board consumption. */
export interface Finding {
  tool: string;
  ruleId: string;
  level: 'error' | 'warning' | 'note' | 'none';
  file: string | null;
  line: number | null;
  message: string;
}

export function listFindings(doc: SarifDocument): Finding[] {
  const findings: Finding[] = [];
  for (const run of doc.runs) {
    const tool = run.tool.driver.name;
    for (const result of run.results ?? []) {
      const loc = result.locations?.[0]?.physicalLocation;
      findings.push({
        tool,
        ruleId: result.ruleId ?? '(unknown rule)',
        level: result.level ?? 'warning',
        file: loc?.artifactLocation?.uri ?? null,
        line: loc?.region?.startLine ?? null,
        message: result.message?.text ?? '',
      });
    }
  }
  return findings;
}
