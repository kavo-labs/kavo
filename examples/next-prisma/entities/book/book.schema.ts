import { z } from "zod";

export const CreateBookSchema = z.object({
  title: z.string().min(1),
  published: z.boolean().optional(),
  authorId: z.number().int().optional().nullable(),
});

export const UpdateBookSchema = CreateBookSchema;
