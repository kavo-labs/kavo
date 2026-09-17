import { kavo } from "../../lib/kavo";
import { Author } from "../../generated/kavo-metadata";
import { CreateAuthorSchema } from "./author.schema";

export const authors = kavo.createCrud<Author>(Author, {
  filter: { fields: ["id", "name", "email"] },
  sort: { fields: ["id", "name"] },
  include: { fields: ["books"] },
  // `schema.input` as a single schema applies it to create/update/patch alike.
  schema: {
    input: CreateAuthorSchema,
  },
});
