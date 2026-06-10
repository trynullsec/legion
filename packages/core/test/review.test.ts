import { describe, expect, it } from 'vitest';
import { ReviewSchema } from '../src/index.js';

const VALID_REVIEW = {
  verdict: 'approve',
  comments: [
    {
      file: 'src/math.ts',
      severity: 'note',
      body: 'Consider extracting the guard into a helper.',
    },
    { file: null, severity: 'should_fix', body: 'Add a changelog entry.' },
  ],
  summary: 'Implements the plan correctly; validation is sound.',
};

describe('T23: Review schema', () => {
  it('accepts a valid review', () => {
    const result = ReviewSchema.safeParse(VALID_REVIEW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verdict).toBe('approve');
      expect(result.data.comments).toHaveLength(2);
    }
  });

  it('accepts request_changes with must_fix comments', () => {
    const result = ReviewSchema.safeParse({
      ...VALID_REVIEW,
      verdict: 'request_changes',
      comments: [
        { file: 'src/math.ts', severity: 'must_fix', body: 'divide() still returns Infinity.' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bad verdict with a precise path', () => {
    const result = ReviewSchema.safeParse({ ...VALID_REVIEW, verdict: 'lgtm' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'verdict');
      expect(issue).toBeTruthy();
    }
  });

  it('rejects a bad comment severity, pointing at the exact element', () => {
    const result = ReviewSchema.safeParse({
      ...VALID_REVIEW,
      comments: [{ file: null, severity: 'blocker', body: 'x' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'comments.0.severity',
      );
      expect(issue).toBeTruthy();
    }
  });

  it('rejects a missing summary with a precise path', () => {
    const { summary: _omit, ...withoutSummary } = VALID_REVIEW;
    const result = ReviewSchema.safeParse(withoutSummary);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'summary');
      expect(issue?.code).toBe('invalid_type');
    }
  });
});
