import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../src/index.js';

const VALID_PLAN = {
  summary:
    'Add input validation to the math utilities so that negative numbers and non-finite values are rejected consistently.',
  steps: [
    {
      n: 1,
      title: 'Add validation helpers',
      detail: 'Introduce a validateNumber() guard in src/math.ts.',
      filesLikelyTouched: ['src/math.ts'],
    },
    {
      n: 2,
      title: 'Cover with tests',
      detail: 'Extend the test suite with negative and NaN cases.',
      filesLikelyTouched: ['test/math.test.ts'],
    },
  ],
  risks: [
    {
      description: 'Throwing on invalid input may break existing callers.',
      severity: 'medium',
    },
  ],
  openQuestions: ['Should invalid input throw or return NaN?'],
  estimatedComplexity: 'small',
};

describe('T17: Plan schema', () => {
  it('accepts a valid plan fixture', () => {
    const result = PlanSchema.safeParse(VALID_PLAN);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.estimatedComplexity).toBe('small');
    }
  });

  it('rejects a plan with missing steps, with a precise issue path', () => {
    const { steps: _omit, ...withoutSteps } = VALID_PLAN;
    const result = PlanSchema.safeParse(withoutSteps);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'steps');
      expect(issue).toBeTruthy();
      expect(issue?.code).toBe('invalid_type');
    }
  });

  it('rejects an empty steps array (≥1 step required)', () => {
    const result = PlanSchema.safeParse({ ...VALID_PLAN, steps: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === 'steps');
      expect(issue).toBeTruthy();
      expect(issue?.code).toBe('too_small');
    }
  });

  it('rejects a bad risk severity, pointing at the exact element', () => {
    const result = PlanSchema.safeParse({
      ...VALID_PLAN,
      risks: [{ description: 'something', severity: 'catastrophic' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path.join('.') === 'risks.0.severity',
      );
      expect(issue).toBeTruthy();
    }
  });

  it('rejects a non-string summary and bad complexity', () => {
    expect(PlanSchema.safeParse({ ...VALID_PLAN, summary: 42 }).success).toBe(
      false,
    );
    expect(
      PlanSchema.safeParse({ ...VALID_PLAN, estimatedComplexity: 'huge' })
        .success,
    ).toBe(false);
  });
});
