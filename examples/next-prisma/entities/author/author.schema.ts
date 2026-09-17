import { z } from "zod";

export const createAuthorSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
});

export const updateAuthorSchema = createAuthorSchema;
export const patchAuthorSchema = createAuthorSchema.partial();
