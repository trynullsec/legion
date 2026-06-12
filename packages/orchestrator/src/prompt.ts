import type { Plan, ReviewComment } from '@legion/core';
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
    'the repository (e.g. "src/math.ts"). Write the file with a shell heredoc',
    "(cat > plan.json <<'EOF' ... EOF). After writing it, verify it parses:",
    'python3 -c "import json; json.load(open(\'plan.json\'))" — then finish.',
    '',
    'IMPORTANT: producing the file is the entire point of your run. Do not',
    'stop after analyzing the repository — your run is a FAILURE unless',
    'plan.json exists in the current working directory when you finish.',
  );

  return lines.join('\n');
}

/**
 * M6a (pin 2): task-mission planner — objective only, no repository clone.
 * Plan schema is reused; filesLikelyTouched carries expected deliverable
 * filenames. Same rejection-feedback rule as the code planner.
 */
export function buildTaskPlannerPrompt(
  mission: MissionRecord,
  feedback: RejectionFeedback | null,
): string {
  const lines = [
    "You are Legion's planning agent for a TASK mission — the deliverable is",
    'one or more files (markdown, text, CSV, or JSON), not code in a',
    'repository. There is no repository to inspect; plan from the objective.',
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
    'Produce a plan for creating the deliverable, then write it as a file',
    'named plan.json in your current working directory.',
    '',
    'plan.json MUST be raw valid JSON (no markdown fences, no commentary) with',
    'EXACTLY this shape and no extra fields:',
    '{',
    '  "summary": "<one paragraph>",',
    '  "steps": [',
    '    {"n": 1, "title": "<short>", "detail": "<how>", "filesLikelyTouched": ["<deliverable filename>"]}',
    '  ],',
    '  "risks": [{"description": "<risk>", "severity": "low" | "medium" | "high"}],',
    '  "openQuestions": ["<question>"],',
    '  "estimatedComplexity": "trivial" | "small" | "medium" | "large"',
    '}',
    '',
    'Rules: steps must contain at least one entry with n starting at 1;',
    'filesLikelyTouched lists the deliverable filenames the worker is expected',
    'to produce (e.g. "summary.md"). Write the file with a shell heredoc',
    "(cat > plan.json <<'EOF' ... EOF). After writing it, verify it parses:",
    'python3 -c "import json; json.load(open(\'plan.json\'))" — then finish.',
    '',
    'IMPORTANT: producing the file is the entire point of your run. Your run',
    'is a FAILURE unless plan.json exists in the current working directory',
    'when you finish.',
  );

  return lines.join('\n');
}

function renderPlan(plan: Plan): string[] {
  const lines = [
    `Plan summary: ${plan.summary}`,
    `Estimated complexity: ${plan.estimatedComplexity}`,
    'Steps:',
  ];
  for (const s of plan.steps) {
    lines.push(
      `  ${s.n}. ${s.title} — ${s.detail} (files: ${s.filesLikelyTouched.join(', ') || 'n/a'})`,
    );
  }
  if (plan.risks.length > 0) {
    lines.push('Risks:');
    for (const r of plan.risks) lines.push(`  - [${r.severity}] ${r.description}`);
  }
  return lines;
}

/** Coder cycle 1: implement the approved plan on the current branch. */
export function buildCoderPrompt(
  mission: MissionRecord,
  plan: Plan,
  priorFailureSummary: string | null,
): string {
  const lines = [
    "You are Legion's coder agent. Your current working directory is a git",
    'repository checked out on a feature branch created for you. Implement the',
    'approved plan below with REAL code changes and REAL git commits.',
    '',
    `Mission: ${mission.title}`,
    '',
    ...renderPlan(plan),
    '',
  ];
  if (priorFailureSummary) {
    lines.push(
      'NOTE: a previous build attempt for this mission failed review.',
      `That attempt's review summary was: ${priorFailureSummary}`,
      'Make sure your implementation addresses it.',
      '',
    );
  }
  lines.push(
    'Rules:',
    '- Work ONLY on the current branch in the current directory. Never switch',
    '  branches, never add remotes, never push, never run git config beyond',
    '  what already works (author identity is provided via environment).',
    '- Edit files with simple shell commands (cat > file <<EOF heredocs are',
    '  reliable). Make one commit per plan step where sensible; commit messages',
    '  must reference the step number (e.g. "step 1: ...").',
    '- Use git add <files> + git commit --no-verify for each commit.',
    '- When every step is implemented and committed, verify with `git status`',
    '  (must be clean) and `git log --oneline`, then finish.',
    '',
    'IMPORTANT: you are the implementer, not an analyst. Do not stop after',
    'reading the code — your run is a FAILURE unless `git log` shows at least',
    'one new commit implementing the plan before you finish.',
  );
  return lines.join('\n');
}

/** Coder cycle 2: revise on the SAME branch per the review comments. */
export function buildRevisionPrompt(
  mission: MissionRecord,
  plan: Plan,
  comments: ReviewComment[],
  reviewSummary: string,
): string {
  const lines = [
    "You are Legion's coder agent. Your current working directory is a git",
    'repository on a feature branch where you already implemented the plan',
    'below — but the reviewer requested changes. Address every comment with',
    'additional REAL commits on the SAME branch.',
    '',
    `Mission: ${mission.title}`,
    '',
    ...renderPlan(plan),
    '',
    `Review summary: ${reviewSummary}`,
    'Review comments to address:',
  ];
  for (const c of comments) {
    lines.push(`  - [${c.severity}] ${c.file ?? '(general)'}: ${c.body}`);
  }
  lines.push(
    '',
    'Rules: same as before — current branch only, no remotes, no pushes,',
    'git add + git commit --no-verify, reference the comment you are fixing in',
    'each commit message, leave the worktree clean, then finish.',
  );
  return lines.join('\n');
}

/** M6a (pin 3): task worker cycle 1 — produce the deliverable files. */
export function buildTaskWorkerPrompt(
  mission: MissionRecord,
  plan: Plan,
  priorFailureSummary: string | null,
): string {
  const lines = [
    "You are Legion's task worker. Your job is to produce the mission's",
    'deliverable as one or more files written into the deliverables/',
    'subdirectory of your current working directory.',
    '',
    `Mission: ${mission.title}`,
    `Objective: ${mission.objective}`,
    '',
    ...renderPlan(plan),
    '',
  ];
  if (priorFailureSummary) {
    lines.push(
      'NOTE: a previous attempt for this mission failed.',
      `What went wrong: ${priorFailureSummary}`,
      'Make sure your deliverable addresses it.',
      '',
    );
  }
  lines.push(
    'Rules:',
    '- Write every output file into the deliverables/ directory (create it',
    '  with mkdir -p deliverables if needed). Allowed formats: .md, .txt,',
    '  .csv, .json.',
    '- Use the filenames the plan names in filesLikelyTouched.',
    '- Never include credentials, API keys, tokens, or other secrets in a',
    '  deliverable — deliverables are security-scanned before any human',
    '  review.',
    '- Write files with shell heredocs (cat > deliverables/<name> <<\'EOF\'',
    '  ... EOF), verify each with cat, then finish.',
    '',
    'IMPORTANT: the files are the entire point of your run. Your run is a',
    'FAILURE if deliverables/ is empty when you finish.',
  );
  return lines.join('\n');
}

/** M6a: task worker cycle 2 — revise the deliverable per review comments. */
export function buildTaskRevisionPrompt(
  mission: MissionRecord,
  plan: Plan,
  comments: ReviewComment[],
  reviewSummary: string,
): string {
  const lines = [
    "You are Legion's task worker. You already produced deliverable files in",
    'the deliverables/ subdirectory of your current working directory — but',
    'the reviewer requested changes. Revise the files in place to address',
    'every comment.',
    '',
    `Mission: ${mission.title}`,
    '',
    ...renderPlan(plan),
    '',
    `Review summary: ${reviewSummary}`,
    'Review comments to address:',
  ];
  for (const c of comments) {
    lines.push(`  - [${c.severity}] ${c.file ?? '(general)'}: ${c.body}`);
  }
  lines.push(
    '',
    'Rules: same as before — every output file lives in deliverables/, no',
    'secrets, verify each file with cat, then finish. deliverables/ must not',
    'be empty when you finish.',
  );
  return lines.join('\n');
}

const MAX_DELIVERABLE_CHARS = 40_000;

/** M6a (pin 3): reviewer for task missions — judge the deliverable against the plan. */
export function buildDeliverableReviewerPrompt(
  plan: Plan,
  files: { name: string; content: string }[],
): string {
  const lines = [
    "You are Legion's reviewer for a TASK mission. Below is the approved plan",
    'and the full content of every deliverable file the worker produced.',
    'Review the deliverable strictly against the plan.',
    '',
    ...renderPlan(plan),
    '',
    'Deliverable files:',
  ];
  let budget = MAX_DELIVERABLE_CHARS;
  for (const f of files) {
    const body = f.content.length > budget ? `${f.content.slice(0, budget)}\n…(truncated)` : f.content;
    budget = Math.max(0, budget - body.length);
    lines.push(`--- BEGIN FILE ${f.name} ---`, body, `--- END FILE ${f.name} ---`, '');
  }
  lines.push(
    'Verdict guidance: approve when the deliverable fulfils the plan steps and',
    'the mission objective, is coherent, and contains nothing dangerous (no',
    'credentials or secrets). Request changes only for concrete, actionable',
    'problems (each as a must_fix comment, file = the deliverable filename).',
    '',
    'Write your review as a file named review.json in your current working',
    "directory using the terminal tool (a heredoc is reliable: cat > review.json <<'EOF' ... EOF).",
    'It MUST be raw valid JSON (no markdown fences) shaped EXACTLY:',
    '{',
    '  "verdict": "approve" | "request_changes",',
    '  "comments": [{"file": "<filename or null>", "severity": "note" | "should_fix" | "must_fix", "body": "<text>"}],',
    '  "summary": "<one paragraph>"',
    '}',
    'Verify it parses: python3 -c "import json; json.load(open(\'review.json\'))" — then finish.',
    '',
    'IMPORTANT: do NOT answer with your review as a chat message — the file is',
    'the only output that counts. Your run is a FAILURE unless review.json',
    'exists in your current working directory when you finish.',
  );
  return lines.join('\n');
}

const MAX_DIFF_CHARS = 60_000;

/** Reviewer: judge the diff against the plan, write review.json. */
export function buildReviewerPrompt(
  plan: Plan,
  diff: string,
  commits: string,
): string {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffBody = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  return [
    "You are Legion's code reviewer. Below is an approved implementation plan,",
    'the list of commits, and the full unified diff produced by the coder.',
    'Review the diff strictly against the plan.',
    '',
    ...renderPlan(plan),
    '',
    'Commits:',
    commits.trim() || '(none)',
    '',
    `Unified diff${truncated ? ' (truncated)' : ''}:`,
    '--- BEGIN DIFF ---',
    diffBody,
    '--- END DIFF ---',
    '',
    'Verdict guidance: approve when the diff faithfully implements the plan',
    'steps and contains no dangerous or clearly broken code. Request changes',
    'only for concrete, actionable problems (each as a must_fix comment).',
    '',
    'Write your review as a file named review.json in your current working',
    "directory using the terminal tool (a heredoc is reliable: cat > review.json <<'EOF' ... EOF).",
    'It MUST be raw valid JSON (no markdown fences) shaped EXACTLY:',
    '{',
    '  "verdict": "approve" | "request_changes",',
    '  "comments": [{"file": "<path or null>", "severity": "note" | "should_fix" | "must_fix", "body": "<text>"}],',
    '  "summary": "<one paragraph>"',
    '}',
    'Verify it parses: python3 -c "import json; json.load(open(\'review.json\'))" — then finish.',
    '',
    'IMPORTANT: do NOT answer with your review as a chat message — the file is',
    'the only output that counts. Your run is a FAILURE unless review.json',
    'exists in your current working directory when you finish.',
  ].join('\n');
}
