import { describe, expect, it } from "vitest";
import mongoose, { Schema } from "mongoose";
import type { ClassRef, FieldMetadata } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import { asModel, buildEntityMetadata } from "@kavo/mongoose";

/**
 * Metadata derivation reads `schema.paths` only — it never talks to a
 * server — so these run against a standalone Mongoose instance with no
 * connection at all. `new mongoose.Mongoose()` also gives each test its own
 * model registry, which is what `connection.models` resolves refs through.
 */
function newRegistry() {
  return new mongoose.Mongoose();
}

function fieldsByName(fields: readonly FieldMetadata[]): Record<string, FieldMetadata> {
  return Object.fromEntries(fields.map((field) => [field.name, field]));
}

describe("buildEntityMetadata — fields", () => {
  const registry = newRegistry();
  const Author = registry.model(
    "Author",
    new Schema(
      {
        email: { type: String, required: true },
        name: String,
        age: Number,
        active: { type: Boolean, default: true },
        role: { type: String, enum: ["ADMIN", "MEMBER"], default: "MEMBER" },
        bio: { type: String, default: null },
        joined: { type: Date, default: Date.now },
        meta: Schema.Types.Mixed,
        address: new Schema({ city: String }),
        tags: [String],
        scores: [Number],
        externalId: Schema.Types.ObjectId,
      },
      { timestamps: true },
    ),
  );
  const metadata = buildEntityMetadata(Author as unknown as ClassRef, registry);
  const byName = fieldsByName(metadata.fields);

  it("names the entity from modelName, not the model's useless function name", () => {
    // A Mongoose model's `.name` is the string "model"; only `modelName` is
    // the entity's real name (ADR-0018).
    expect((Author as unknown as { name: string }).name).toBe("model");
    expect(metadata.name).toBe("Author");
  });

  it("uses _id as the single primary identifier and reports it as a string", () => {
    expect(metadata.idField).toBe("_id");
    // ObjectId leaves this adapter as a hex string, so core's
    // `EntityId = string | number` never had to grow a third member.
    expect(byName["_id"]).toMatchObject({ kind: "string", generated: true });
  });

  it("maps Mongoose schema types onto core's coarse FieldKind", () => {
    expect(byName["email"]).toMatchObject({ kind: "string", nullable: false });
    expect(byName["age"]).toMatchObject({ kind: "number" });
    expect(byName["active"]).toMatchObject({ kind: "boolean" });
    expect(byName["joined"]).toMatchObject({ kind: "date" });
    expect(byName["meta"]).toMatchObject({ kind: "json" });
    expect(byName["address"]).toMatchObject({ kind: "json" });
    expect(byName["externalId"]).toMatchObject({ kind: "string" });
  });

  it("reads an array path's kind from its element type and never calls it nullable", () => {
    expect(byName["tags"]).toMatchObject({ kind: "string", nullable: false });
    expect(byName["scores"]).toMatchObject({ kind: "number", nullable: false });
  });

  it("treats an enum path as an enum and carries its allowlist", () => {
    expect(byName["role"]).toMatchObject({ kind: "enum", enumValues: ["ADMIN", "MEMBER"] });
  });

  it("marks a path required only when the schema does", () => {
    expect(byName["email"]!.nullable).toBe(false);
    expect(byName["name"]!.nullable).toBe(true);
  });

  it("counts a function default as generated but a literal default as writable", () => {
    // `default: Date.now` is computed per write; `default: true` and
    // `default: null` are ordinary fallbacks the caller may override.
    expect(byName["joined"]!.generated).toBe(true);
    expect(byName["active"]!.generated).toBe(false);
    expect(byName["bio"]).toMatchObject({ generated: false, nullable: true });
  });

  it("marks the timestamps pair generated", () => {
    expect(byName["createdAt"]).toMatchObject({ kind: "date", generated: true });
    expect(byName["updatedAt"]).toMatchObject({ kind: "date", generated: true });
  });

  it("keeps Mongoose's __v bookkeeping out of the entity description entirely", () => {
    // The default serializer projects onto these fields, so excluding __v
    // here is what keeps it out of every derived DTO and every response.
    expect(byName["__v"]).toBeUndefined();
    expect(metadata.fields.some((field) => field.name === "__v")).toBe(false);
  });

  it("keeps a `select: false` path out of the entity description entirely", () => {
    // `select: false` is Mongoose's "never return this" — a password hash or
    // an API key. Merely hiding it from responses is not enough: the field
    // would still land on the filterable allowlist, and because the
    // predicate runs in the database while the value is projected out of the
    // body, `filter[apiKey][like]=sk_live_9%` would be a blind
    // character-at-a-time extraction oracle.
    const registry = newRegistry();
    const Secretive = registry.model(
      "Secretive",
      new Schema({
        email: String,
        passwordHash: { type: String, select: false },
        apiKey: { type: String, select: false, default: () => "generated" },
      }),
    );
    const names = buildEntityMetadata(Secretive as unknown as ClassRef<object>, registry).fields.map((f) => f.name);

    expect(names).toContain("email");
    expect(names).not.toContain("passwordHash");
    expect(names).not.toContain("apiKey");
  });

  it("reports no auto-detected soft-delete field", () => {
    // Mongoose declares no @DeleteDateColumn equivalent, so soft delete is
    // always explicit `softDelete.field` configuration for this adapter.
    expect(metadata.softDeleteField).toBeNull();
  });
});

describe("buildEntityMetadata — nested object literals", () => {
  it("collapses Mongoose's flattened dotted paths into one json field at the root", () => {
    // `{ address: { city } }` is stored under `schema.paths` as
    // `address.city` — a name that is not a key of the document core
    // receives, so registering it verbatim made the whole nested object
    // vanish from responses and writes.
    const registry = newRegistry();
    const Nested = registry.model("Nested", new Schema({ name: String, address: { city: String, zip: String } }));
    const metadata = buildEntityMetadata(Nested as unknown as ClassRef, registry);
    const names = metadata.fields.map((field) => field.name);

    expect(Object.keys(Nested.schema.paths)).toContain("address.city"); // Mongoose really does this
    expect(names).not.toContain("address.city");
    expect(names).not.toContain("address.zip");
    expect(fieldsByName(metadata.fields)["address"]).toMatchObject({ kind: "json", generated: false });
    expect(names.filter((name) => name === "address")).toHaveLength(1); // emitted once, not per subpath
  });

  it("describes a sub-schema and a nested literal identically", () => {
    const registry = newRegistry();
    const Sub = registry.model("Sub", new Schema({ address: new Schema({ city: String }) }));
    const byName = fieldsByName(buildEntityMetadata(Sub as unknown as ClassRef, registry).fields);
    expect(byName["address"]).toMatchObject({ kind: "json" });
  });
});

describe("buildEntityMetadata — renamed and disabled schema options", () => {
  it("honours renamed timestamp fields", () => {
    const registry = newRegistry();
    const Doc = registry.model(
      "Doc",
      new Schema({ title: String }, { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }),
    );
    const byName = fieldsByName(buildEntityMetadata(Doc as unknown as ClassRef, registry).fields);
    expect(byName["created_at"]).toMatchObject({ generated: true });
    expect(byName["updated_at"]).toMatchObject({ generated: true });
  });

  it("honours a timestamps pair where only one side is renamed", () => {
    // `{ updatedAt: "modified_at" }` renames one side and leaves the other at
    // its default name. Missing the default-named side would make
    // `createdAt` an ordinary writable field, so it would land in every
    // derived write DTO and a caller could set the document's creation time.
    const registry = newRegistry();
    const Doc = registry.model(
      "PartiallyRenamed",
      new Schema({ title: String }, { timestamps: { updatedAt: "modified_at" } }),
    );
    const byName = fieldsByName(buildEntityMetadata(Doc as unknown as ClassRef, registry).fields);
    expect(byName["createdAt"]).toMatchObject({ kind: "date", generated: true });
    expect(byName["modified_at"]).toMatchObject({ kind: "date", generated: true });
  });

  it("stamps only the enabled side when one timestamp is switched off", () => {
    const registry = newRegistry();
    const Doc = registry.model(
      "OneSidedTimestamps",
      new Schema({ title: String }, { timestamps: { createdAt: false } }),
    );
    const byName = fieldsByName(buildEntityMetadata(Doc as unknown as ClassRef, registry).fields);
    expect(byName["createdAt"]).toBeUndefined(); // Mongoose never adds the path
    expect(byName["updatedAt"]).toMatchObject({ kind: "date", generated: true });
  });

  it("excludes a renamed version key, and includes nothing extra when it is disabled", () => {
    const registry = newRegistry();
    const Renamed = registry.model("Renamed", new Schema({ title: String }, { versionKey: "_version" }));
    const renamedFields = buildEntityMetadata(Renamed as unknown as ClassRef, registry).fields;
    expect(renamedFields.map((field) => field.name)).not.toContain("_version");

    const registry2 = newRegistry();
    const NoVersion = registry2.model("NoVersion", new Schema({ title: String }, { versionKey: false }));
    const names = buildEntityMetadata(NoVersion as unknown as ClassRef, registry2).fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["_id", "title"]));
    expect(names).not.toContain("__v");
  });
});

describe("buildEntityMetadata — relations", () => {
  const registry = newRegistry();
  const Book = registry.model(
    "Book",
    new Schema({
      title: String,
      author: { type: Schema.Types.ObjectId, ref: "Author" },
      reviewers: [{ type: Schema.Types.ObjectId, ref: "Author" }],
      ownerId: Schema.Types.ObjectId,
      dynamic: { type: Schema.Types.ObjectId, refPath: "dynamicModel" },
      dynamicModel: String,
    }),
  );
  const Author = registry.model("Author", new Schema({ name: String }));
  const metadata = buildEntityMetadata(Book as unknown as ClassRef, registry);

  it("derives cardinality from whether the ref path is an array", () => {
    expect(metadata.relations.map((relation) => relation.name).sort()).toEqual(["author", "reviewers"]);
    const byName = Object.fromEntries(metadata.relations.map((relation) => [relation.name, relation]));
    expect(byName["author"]).toMatchObject({ cardinality: "one", includable: false, strategy: "auto" });
    expect(byName["reviewers"]).toMatchObject({ cardinality: "many", includable: false });
  });

  it("also registers a ref path as a field, so the reference id is filterable", () => {
    // Unlike SQL, a Mongoose ref path *is* the foreign key — there is no
    // separate `authorId` column. Core derives the filter/sort/select
    // allowlists from `fields` alone, so without this the reference id
    // could be written but never queried.
    const byName = fieldsByName(metadata.fields);
    expect(byName["author"]).toMatchObject({ kind: "string", generated: false });
    expect(byName["reviewers"]).toMatchObject({ kind: "string", nullable: false });
    // …and it is still a relation, so `include=author` keeps working.
    expect(metadata.relations.map((relation) => relation.name)).toContain("author");
  });

  it("resolves a relation target through the connection's model registry", () => {
    const author = metadata.relations.find((relation) => relation.name === "author")!;
    expect(author.target()).toBe(Author);
  });

  it("treats an ObjectId path with no ref as an ordinary scalar field", () => {
    expect(metadata.fields.map((field) => field.name)).toContain("ownerId");
  });

  it("treats a refPath (dynamic target) as a scalar field, not an unresolvable relation", () => {
    // There is no single target entity for core's relation registry to
    // point at, so the path stays a plain ObjectId column.
    expect(metadata.relations.map((relation) => relation.name)).not.toContain("dynamic");
    expect(metadata.fields.map((field) => field.name)).toContain("dynamic");
  });

  it("fails with a ConfigurationException when a ref target is not registered", () => {
    const orphanRegistry = newRegistry();
    const Orphan = orphanRegistry.model(
      "Orphan",
      new Schema({ missing: { type: Schema.Types.ObjectId, ref: "Nowhere" } }),
    );
    const relation = buildEntityMetadata(Orphan as unknown as ClassRef, orphanRegistry).relations[0]!;
    // Lazy, like every other adapter: registering a model later still works,
    // and a genuinely missing one fails only when something asks for it.
    let thrown: unknown;
    try {
      relation.target();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toContain("Nowhere");
  });
});

describe("buildEntityMetadata — rejected inputs", () => {
  it("rejects an entity that is not a Mongoose model", () => {
    class NotAModel {}
    let thrown: unknown;
    try {
      buildEntityMetadata(NotAModel as ClassRef, newRegistry());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toContain("Mongoose model");
  });

  it("rejects a primitive and null without reading a property off either", () => {
    // A class — the case above — is `typeof "function"` and sails past both
    // of `asModel`'s narrowing guards on its way to the missing `modelName`.
    // `null` and a bare string reach different arms, and reading
    // `null.modelName` would be a TypeError from deep inside bootstrap
    // instead of the exception that names what was actually passed.
    for (const notAModel of [null, "Author"]) {
      let thrown: unknown;
      try {
        asModel(notAModel as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigurationException);
      expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((thrown as Error).message).toContain("Mongoose model");
    }
  });

  it("refuses a schema that disables the _id path", () => {
    // `{ _id: false }` is legal Mongoose — it is how a subdocument opts out
    // of its own key — but a collection without `_id` has nothing for Kavo
    // to address a document by, so it is refused at bootstrap rather than
    // 404ing every single-document route at runtime.
    const registry = newRegistry();
    const NoId = registry.model("NoId", new Schema({ title: String }, { _id: false }));
    expect(Object.keys(NoId.schema.paths)).not.toContain("_id"); // Mongoose really does this

    let thrown: unknown;
    try {
      buildEntityMetadata(NoId as unknown as ClassRef, registry);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toContain("_id");
  });
});

describe("buildEntityMetadata — Mongoose virtuals are invisible (issue #373)", () => {
  it("never surfaces a schema virtual as a FieldMetadata entry", () => {
    // A Mongoose virtual (`schema.virtual("fullName").get(...)`) is a plain
    // JavaScript getter, not backed by a stored path — Mongoose keeps it in
    // `schema.virtuals`, never `schema.paths`, and metadata derivation reads
    // `schema.paths` only. So it carries no `derivedExpression` and no
    // `FieldMetadata` entry at all: it is response-only at best (through a
    // registered DTO or a custom operation reading `schema.virtuals`
    // directly), and naming it in a filter or sort is an ordinary
    // unknown-field 400, the same as any other name the entity does not
    // declare — the documented behavior for an ORM whose virtual is
    // JS-only.
    const registry = newRegistry();
    const UserSchema = new Schema({ firstName: String, lastName: String });
    UserSchema.virtual("fullName").get(function (this: { firstName: string; lastName: string }) {
      return `${this.firstName} ${this.lastName}`;
    });
    const User = registry.model("User", UserSchema);

    const metadata = buildEntityMetadata(User as unknown as ClassRef, registry);
    expect(metadata.fields.map((field) => field.name)).not.toContain("fullName");
  });
});
