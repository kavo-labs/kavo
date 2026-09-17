import { z } from "zod";
import type { KavoSchema, QueryContext, SchemaParseResult } from "@kavo/core";
import type { Review } from "../../generated/kavo-metadata";

export const CreateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(1),
  bookId: z.number().int(),
});

export const UpdateReviewSchema = CreateReviewSchema;

export const PatchReviewSchema = CreateReviewSchema.partial();

const QueryLimitsSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

/**
 * `schema.input.query` doesn't need to re-model all of `QueryContext` in
 * zod — a `KavoSchema` is any adapter satisfying the structural contract
 * (ADR-0055). Here it only clamps `limit`/`offset` to a page size Review
 * wants capped tighter than the entity-wide default, and passes the rest
 * of the query through untouched.
 */
export const ReviewQuerySchema: KavoSchema<QueryContext<Review>> = {
  safeParse(input: unknown): SchemaParseResult<QueryContext<Review>> {
    const result = QueryLimitsSchema.safeParse(input);
    if (!result.success) {
      return {
        success: false,
        error: { issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      };
    }
    return { success: true, data: { ...(input as QueryContext<Review>), ...result.data } };
  },
};

/**
 * `schema.output.item`/`.list` are typed against the full `Review` entity
 * (including the `book` relation), so `book` is passed through untyped
 * here rather than re-modeled in zod — the relation only actually
 * materializes when `include: ["book"]` is requested.
 */
export const ReviewItemSchema = z.object({
  id: z.number().int(),
  rating: z.number().int(),
  comment: z.string(),
  bookId: z.number().int(),
  book: z.any(),
});

export const ReviewListSchema = ReviewItemSchema;
