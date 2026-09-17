import type { Book } from "../book/book.entity";

// Marker class: an empty class whose name matches the Prisma model, giving
// `createCrud` a stable identity to key off (ADR-0017). Prisma generates no
// runtime class for a model the way TypeORM's `@Entity()` does. Relation
// properties are declared too (typed, never populated by the class itself)
// so `FieldPath`/`IncludePath` can spell-check `filter`/`sort`/`include`
// config against them at compile time — `@kavo/prisma`'s adapter derives
// the real relation shape from the Prisma schema at runtime regardless.
export class Author {
  id!: number;
  name!: string;
  email!: string;
  books!: Book[];
}

// Next.js's production build minifies server bundles (SWC minify), which
// renames classes — `@kavo/prisma`'s marker-class matching reads the
// runtime `entity.name`, so a mangled class would no longer match its
// Prisma model. Pinning the name to a string literal survives minification
// (only identifiers are mangled, not string values).
Object.defineProperty(Author, "name", { value: "Author" });
