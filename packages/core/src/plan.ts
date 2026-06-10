import { z } from 'zod';

export const PlanStepSchema = z.object({
  n: z.number().int().positive(),
  title: z.string().min(1),
  detail: z.string().min(1),
  filesLikelyTouched: z.array(z.string()),
});

export const PlanRiskSchema = z.object({
  description: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']),
});

export const PlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  risks: z.array(PlanRiskSchema),
  openQuestions: z.array(z.string()),
  estimatedComplexity: z.enum(['trivial', 'small', 'medium', 'large']),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanRisk = z.infer<typeof PlanRiskSchema>;
export type Plan = z.infer<typeof PlanSchema>;
