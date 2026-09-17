import { z } from "zod";

export const CreateAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
});

export const UpdateAuthorSchema = CreateAuthorSchema;
