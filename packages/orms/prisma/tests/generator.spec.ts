import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrismaMetadata } from "@kavo/prisma";
import { generatedModule } from "../src/generator.js";

/**
 * `generatorHandler` (from `@prisma/generator-helper`) can only be driven by
 * an actual `prisma generate` run, so these tests exercise the pure
 * `generatedModule` function it delegates to — same split as
 * `buildEntityMetadata`/`createInfrastructure` in metadata.spec.ts.
 */
const metadata: PrismaMetadata = {
  enums: [{ name: "Role", values: [{ name: "ADMIN" }, { name: "MEMBER" }] }],
  models: [
    {
      name: "Author",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isId: true, isList: false, isRequired: true, hasDefaultValue: true },
        {
          name: "email",
          kind: "scalar",
          type: "String",
          isId: false,
          isList: false,
          isRequired: true,
          hasDefaultValue: false,
        },
        {
          name: "role",
          kind: "enum",
          type: "Role",
          isId: false,
          isList: false,
          isRequired: true,
          hasDefaultValue: false,
        },
        {
          name: "books",
          kind: "object",
          type: "Book",
          isId: false,
          isList: true,
          isRequired: true,
          hasDefaultValue: false,
          relationFromFields: [],
        },
      ],
    },
    {
      name: "Book",
      fields: [
        { name: "id", kind: "scalar", type: "Int", isId: true, isList: false, isRequired: true, hasDefaultValue: true },
        {
          name: "authorId",
          kind: "scalar",
          type: "Int",
          isId: false,
          isList: false,
          isRequired: false,
          hasDefaultValue: false,
        },
        {
          name: "author",
          kind: "object",
          type: "Author",
          isId: false,
          isList: false,
          isRequired: false,
          hasDefaultValue: false,
          relationFromFields: ["authorId"],
        },
      ],
    },
  ],
};

describe("generatedModule", () => {
  it("emits prismaMetadata unchanged from before this feature", () => {
    const source = generatedModule(metadata);
    expect(source).toContain("export const prismaMetadata =");
    expect(source).toContain("export default prismaMetadata;");
  });

  it("emits one typed marker class per model, matching field name/kind/nullability", () => {
    const source = generatedModule(metadata);
    expect(source).toContain("export class Author {");
    expect(source).toContain("id!: number;");
    expect(source).toContain("email!: string;");
    // enum field types by the enum's own generated name
    expect(source).toContain("role!: Role;");
    // to-many relation: array of the target class, never nullable
    expect(source).toContain("books!: Book[];");
    expect(source).toContain("export class Book {");
    // optional scalar and optional to-one relation both get `| null`
    expect(source).toContain("authorId!: number | null;");
    expect(source).toContain("author!: Author | null;");
  });

  it("emits a union type for each enum", () => {
    const source = generatedModule(metadata);
    expect(source).toContain('export type Role = "ADMIN" | "MEMBER";');
  });

  it("pins each class's runtime name so bundler minification can't break entity-name matching", () => {
    const source = generatedModule(metadata);
    expect(source).toContain('Object.defineProperty(Author, "name", { value: "Author" });');
    expect(source).toContain('Object.defineProperty(Book, "name", { value: "Book" });');
  });

  it("emits an entities array naming every model, in declaration order", () => {
    const source = generatedModule(metadata);
    expect(source).toContain("export const entities = [Author, Book] as const;");
  });

  it("produces a module that actually loads and behaves as ClassRefs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kavo-prisma-generator-"));
    const file = join(dir, "generated-metadata.mjs");
    try {
      // Strip the TS-only `as const` so plain Node ESM can load it directly.
      await writeFile(file, generatedModule(metadata).replaceAll(" as const", ""), "utf8");
      const generated = (await import(file)) as {
        default: PrismaMetadata;
        Author: new () => object;
        Book: new () => object;
        entities: readonly (new () => object)[];
      };
      expect(generated.Author.name).toBe("Author");
      expect(generated.Book.name).toBe("Book");
      expect(generated.entities).toEqual([generated.Author, generated.Book]);
      expect(generated.default.models.map((model) => model.name)).toEqual(["Author", "Book"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
