import type { MissionRecord } from '@legion/db';

export interface RejectionFeedback {
  priorSummary: string;
  reason: string;
}

/** The exact task prompt sent to a planner worker. Recorded as WORKER_TASK. */
export function buildPlannerPrompt(
  mission: MissionRecord,
  feedback: RejectionFeedback | null,
): string {
  const lines = [
    "You are Legion's planning agent. The repository to analyze is in your",
    'current working directory (a disposable clone). Read files freely, but',
    'DO NOT modify, create, or delete any repository files.',
    '',
    `Mission title: ${mission.title}`,
    `Mission objective: ${mission.objective}`,
    '',
  ];

  if (feedback) {
    lines.push(
      'A previous plan for this mission was rejected.',
      `Previous plan summary: ${feedback.priorSummary}`,
      `It was rejected because: ${feedback.reason}`,
      'Your new plan MUST address this feedback.',
      '',
    );
  }

  lines.push(
    'Do this:',
    '1. Inspect the repository: list its files and read the README and key sources.',
    '2. Produce an implementation plan for the mission objective.',
    '3. Write the plan as a file named plan.json in your current working directory.',
    '',
    'plan.json MUST be raw valid JSON (no markdown fences, no commentary) with',
    'EXACTLY this shape and no extra fields:',
    '{',
    '  "summary": "<one paragraph>",',
    '  "steps": [',
    '    {"n": 1, "title": "<short>", "detail": "<how>", "filesLikelyTouched": ["<repo-relative path>"]}',
    '  ],',
    '  "risks": [{"description": "<risk>", "severity": "low" | "medium" | "high"}],',
    '  "openQuestions": ["<question>"],',
    '  "estimatedComplexity": "trivial" | "small" | "medium" | "large"',
    '}',
    '',
    'Rules: steps must contain at least one entry with n starting at 1;',
    'filesLikelyTouched must use repo-relative paths exactly as they exist in',
    'the repository (e.g. "src/math.ts"). After writing plan.json, verify it',
    'parses: python3 -c "import json; json.load(open(\'plan.json\'))" — then finish.',
  );

  return lines.join('\n');
}
