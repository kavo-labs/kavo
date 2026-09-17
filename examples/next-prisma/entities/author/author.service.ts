import { kavo } from "../../lib/kavo";
import { Author } from "./author.entity";

export const authors = kavo.createCrud<Author>(Author, {
  filter: { fields: ["id", "name", "email"] },
  sort: { fields: ["id", "name"] },
  include: { fields: ["books"] },
});
