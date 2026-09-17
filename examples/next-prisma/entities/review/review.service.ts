import { kavo } from "../../lib/kavo";
import { Review } from "../../generated/kavo-metadata";
import {
  CreateReviewSchema,
  PatchReviewSchema,
  ReviewItemSchema,
  ReviewListSchema,
  ReviewQuerySchema,
  UpdateReviewSchema,
} from "./review.schema";

export const reviews = kavo.createCrud<Review>(Review, {
  filter: { fields: ["id", "rating", "bookId"] },
  sort: { fields: ["id", "rating"] },
  include: { fields: ["book"] },
  // The full per-slot form — one schema per input/output slot, unlike
  // author/book's single-schema shorthand.
  schema: {
    input: {
      create: CreateReviewSchema,
      update: UpdateReviewSchema,
      patch: PatchReviewSchema,
      query: ReviewQuerySchema,
    },
    output: {
      item: ReviewItemSchema,
      list: ReviewListSchema,
    },
  },
});
