import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Author } from "./author.model.js";

/**
 * The relation side, zero-config: every derived default comes from the
 * Mongoose schema through the metadata seam — allowlist configuration, DTO shapes, and
 * the generated routes. `_id`, `createdAt` and `updatedAt` are reported as
 * generated, so none of them is client-writable.
 */
@Kavo(Author)
@Controller("authors")
export class AuthorController {}
