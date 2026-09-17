import { kavo } from "../../lib/kavo";
import { Author } from "../../generated/kavo-metadata";
import { createAuthorSchema, patchAuthorSchema, updateAuthorSchema } from "./author.schema";

export const authors = kavo.createCrud<Author>(Author, {
  filter: { fields: ["id", "name", "email"] },
  sort: { fields: ["id", "name"] },
  include: { fields: ["books"] },
  schema: { create: createAuthorSchema, update: updateAuthorSchema, patch: patchAuthorSchema },
});
