import { z } from "zod";

export const createBookSchema = z.object({
  title: z.string().min(1).max(200),
  published: z.boolean().optional(),
  authorId: z.number().int().positive().nullable().optional(),
});

export const updateBookSchema = createBookSchema;
export const patchBookSchema = createBookSchema.partial();
