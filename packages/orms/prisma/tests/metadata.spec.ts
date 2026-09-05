import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { ConfigurationException } from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, type PrismaDatamodel, type PrismaField } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";

class Author {
  id!: number;
  email!: string;
}

class Book {
  id!: number;
  title!: string;
  authorId!: number | null;
}

/** No `model NotAModel` exists in prisma/schema.prisma. */
class NotAModel {}

/**
 * `model Ghost` exists in this synthetic datamodel but not on the real
 * generated Prisma Client — exercises `PrismaRepositoryAdapter`'s own
 * "no delegate" guard, distinct from `buildEntityMetadata`'s "no model"
 * guard: metadata resolution succeeds here, the adapter constructor is
 * what fails.
 */
class Ghost {
  id!: number;
}
const ghostDatamodel: PrismaDatamodel = {
  models: [
    {
      name: "Ghost",
      fields: [
        {
          name: "id",
          kind: "scalar",
          type: "Int",
          isId: true,
          isList: false,
          isRequired: true,
          hasDefaultValue: false,
        },
      ],
    },
  ],
  enums: [],
};

/**
 * A synthetic DMMF scalar field. `Prisma.dmmf.datamodel` can only describe
 * what `prisma/schema.prisma` declares, and the fixture schema is on SQLite
 * — which has no scalar lists at all — so the shapes below are written by
 * hand rather than generated.
 */
function scalar(name: string, type: string, overrides: Partial<PrismaField> = {}): PrismaField {
  return {
    name,
    kind: "scalar",
    type,
    isId: false,
    isList: false,
    isRequired: true,
    hasDefaultValue: false,
    ...overrides,
  };
}

/** Matches `model Shapes` in {@link shapesDatamodel} by name, as every marker class must. */
class Shapes {
  id!: number;
}
const shapesDatamodel: PrismaDatamodel = {
  models: [
    {
      name: "Shapes",
      fields: [
        scalar("id", "Int", { isId: true }),
        scalar("published", "Boolean"),
        scalar("payload", "Json"),
        scalar("updatedAt", "DateTime", { isUpdatedAt: true }),
        scalar("tags", "String", { isList: true, isRequired: false }),
      ],
    },
  ],
  enums: [],
};

describe("buildEntityMetadata — scalar field shapes", () => {
  const fieldsByName = () =>
    Object.fromEntries(
      buildEntityMetadata(shapesDatamodel, Shapes, new Map()).fields.map((field) => [field.name, field]),
    );

  it("maps a Boolean column to kind 'boolean'", () => {
    expect(fieldsByName()["published"]).toMatchObject({ kind: "boolean" });
  });

  it("maps a Json column to kind 'json'", () => {
    expect(fieldsByName()["payload"]).toMatchObject({ kind: "json" });
  });

  it("marks an @updatedAt column generated, keeping it out of the create/update DTOs", () => {
    // `@updatedAt` carries no `@default`, so the function-default branch never
    // sees it — without its own check the DTO would ask a caller for a
    // timestamp Prisma overwrites on every write anyway.
    expect(fieldsByName()["updatedAt"]).toMatchObject({ kind: "date", generated: true });
  });

  it("reports a scalar list as non-nullable even when the column is optional", () => {
    // A list column holds a possibly-empty array, never null, so `isRequired:
    // false` on it says nothing about nullability — honoring it would put a
    // `| null` into the DTO for a value that can never arrive as null.
    expect(fieldsByName()["tags"]).toMatchObject({ nullable: false });
  });

  it("never surfaces a client-extension result field as a FieldMetadata entry (issue #373)", () => {
    // `$extends({ result: { shapes: { displayName: { compute } } } })` is
    // pure JavaScript, evaluated by the client after a query returns —
    // Prisma's own DMMF (what `shapesDatamodel` stands in for here) knows
    // nothing about it, so it produces no field here at all. `displayName`
    // is not even a real field on the `Shapes` model, which is exactly the
    // point: an extension field is indistinguishable, from this function's
    // point of view, from a name the model never declared.
    expect(fieldsByName()["displayName"]).toBeUndefined();
  });
});

describe("buildEntityMetadata — bootstrap error paths", () => {
  /** Matches the one-model datamodel each primary-key test builds for it. */
  class Keyed {
    left!: number;
  }
  const keyedDatamodel = (fields: readonly PrismaField[]): PrismaDatamodel => ({
    models: [{ name: "Keyed", fields }],
    enums: [],
  });

  it("throws ConfigurationException when the marker class name matches no Prisma model", () => {
    expect(() => buildEntityMetadata(Prisma.dmmf.datamodel, NotAModel, new Map())).toThrow(ConfigurationException);
    try {
      buildEntityMetadata(Prisma.dmmf.datamodel, NotAModel, new Map());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    }
  });

  it("refuses a model with no @id field", () => {
    // Every operation past `findMany` addresses a row by its id, so a model
    // without one cannot be served at all — bootstrap is where that has to
    // be said, not the first request that tries to read one.
    let thrown: unknown;
    try {
      buildEntityMetadata(keyedDatamodel([scalar("left", "Int")]), Keyed, new Map());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).messageParams).toMatchObject({ entity: "Keyed", path: "id" });
    expect((thrown as Error).message).toMatch(/composite primary keys/);
  });

  it("refuses a model whose primary key spans two @id fields", () => {
    // A composite key has no single value to put in a route path or a
    // cursor; picking one of the two silently would address the wrong rows.
    let thrown: unknown;
    try {
      buildEntityMetadata(
        keyedDatamodel([scalar("left", "Int", { isId: true }), scalar("right", "Int", { isId: true })]),
        Keyed,
        new Map(),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).messageParams).toMatchObject({ entity: "Keyed", path: "id" });
    expect((thrown as Error).message).toMatch(/composite primary keys/);
  });

  it("throws ConfigurationException when a relation's target model wasn't registered in 'entities'", () => {
    // Book.author targets Author, but Author is deliberately left out of the registry.
    const metadata = buildEntityMetadata(Prisma.dmmf.datamodel, Book, new Map([["Book", Book]]));
    const authorRelation = metadata.relations.find((relation) => relation.name === "author")!;
    expect(() => authorRelation.target()).toThrow(ConfigurationException);
    try {
      authorRelation.target();
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    }
  });

  it("resolves a relation's target once its marker class is registered", () => {
    const entities = new Map<string, typeof Author | typeof Book>([
      ["Author", Author],
      ["Book", Book],
    ]);
    const metadata = buildEntityMetadata(Prisma.dmmf.datamodel, Book, entities);
    const authorRelation = metadata.relations.find((relation) => relation.name === "author")!;
    expect(authorRelation.target()).toBe(Author);
  });
});

describe("createInfrastructure — adapter bootstrap error path", () => {
  it("throws ConfigurationException when Prisma Client has no delegate for the resolved model name", async () => {
    const client = newTestPrismaClient();
    try {
      const infrastructure = createInfrastructure(client as never, {
        datamodel: ghostDatamodel,
        entities: [Ghost],
      });
      // Metadata resolution succeeds (Ghost matches ghostDatamodel); the real
      // Prisma Client just has no `ghost` delegate, since no such model exists
      // in the actual schema — this is the adapter constructor's own guard.
      expect(() => infrastructure.adapterFor(Ghost)).toThrow(ConfigurationException);
    } finally {
      // Each client owns a database file now, and the run's scratch root is
      // removed at teardown — an undisconnected client leaves that file open.
      await client.$disconnect();
    }
  });
});
