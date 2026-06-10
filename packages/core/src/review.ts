import { z } from 'zod';

export const ReviewCommentSchema = z.object({
  file: z.string().nullable(),
  severity: z.enum(['note', 'should_fix', 'must_fix']),
  body: z.string().min(1),
});

export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  comments: z.array(ReviewCommentSchema),
  summary: z.string().min(1),
});

export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type Review = z.infer<typeof ReviewSchema>;
