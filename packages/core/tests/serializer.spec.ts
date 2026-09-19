import { describe, expect, it } from "vitest";
import type {
  ClassRef,
  EntityMetadata,
  KavoContext,
  IncludeNode,
  NormalizedQueryContext,
  ResolvedEntityConfig,
} from "@kavo/core";
import {
  AssociationInvalidShapeException,
  DefaultDeserializer,
  DefaultEntityCatalog,
  DefaultSerializer,
  createKavoContext,
  resolveEntityConfig,
} from "@kavo/core";
import { User, contextStub, unusedRepository, userMetadata } from "./support/user-fixture.js";
import { Author, Post, authorMetadata, postMetadata } from "./support/blog-fixture.js";

const userConfig = resolveEntityConfig(userMetadata, undefined, undefined);
const postConfig = resolveEntityConfig(postMetadata, undefined, undefined);

const EMPTY_QUERY = {
  filter: { root: null },
  sort: [],
  pagination: { limit: 20, offset: 0 },
  select: { root: null, relations: {} },
  include: {},
  withDeleted: false,
  onlyDeleted: false,
  count: true,
};

/** A read context carrying a normalized query — selection and includes are read from it. */
function readContext<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  query: Partial<NormalizedQueryContext<Entity>> = {},
): KavoContext<Entity> {
  return createKavoContext<Entity>({
    operation: "findMany",
    config,
    repository: unusedRepository<Entity>(),
    query: { ...(EMPTY_QUERY as NormalizedQueryContext<Entity>), ...query },
  });
}

function ada(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 1,
    name: "Ada",
    email: "ada@example.com",
    age: 36,
    status: "active",
    createdAt: new Date(0),
    ...overrides,
  });
}

const COLUMNS = ["id", "name", "email", "age", "status", "createdAt"];

describe("DefaultSerializer — response projection", () => {
  const serializer = new DefaultSerializer<User>(userMetadata);

  it("projects every column when no DTO is registered", () => {
    expect(Object.keys(serializer.serializeItem(ada(), null, contextStub()))).toEqual(COLUMNS);
  });

  it("projects a registered DTO's runtime key set and drops the rest", () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    expect(serializer.serializeItem(ada(), UserItemDto, contextStub())).toEqual({ id: 1, name: "Ada" });
  });

  it("falls back to the entity-derived default when the DTO has no runtime shape", () => {
    // A DTO class projects by the own keys of `new Dto()`; a class that
    // declares none narrows nothing and the response stays correct,
    // just unnarrowed (doc 04 §4).
    class OpaqueDto {}
    expect(Object.keys(serializer.serializeItem(ada(), OpaqueDto, contextStub()))).toEqual(COLUMNS);
  });

  it("falls back the same way when the DTO's constructor throws", () => {
    // A DTO with required constructor arguments, or a field initializer
    // that throws, is an ordinary mistake. Probing its shape must not turn
    // that into a 500 on every response: the projection degrades, the
    // request still answers.
    class NeedsArgumentsDto {
      constructor() {
        throw new Error("needs arguments");
      }
    }
    expect(Object.keys(serializer.serializeItem(ada(), NeedsArgumentsDto, contextStub()))).toEqual(COLUMNS);
  });

  it("narrows with the request's fieldset but never widens the DTO", () => {
    // Serialization order is normative: DTO mapping first, then field
    // selection — so `email`, which the DTO hides, cannot be selected back.
    class UserItemDto {
      id = 0;
      name = "";
    }
    const context = readContext(userConfig, { select: { root: ["name", "email"], relations: {} } as never });
    expect(serializer.serializeItem(ada(), UserItemDto, context)).toEqual({ name: "Ada" });
  });

  it("keeps a null column value — null is data, not absence", () => {
    const context = readContext(userConfig, { select: { root: ["name"], relations: {} } as never });
    const row = ada({ name: null as never });
    expect(serializer.serializeItem(row, null, context)).toEqual({ name: null });
  });

  it("omits a column the row does not carry rather than emitting undefined", () => {
    // The spec fixes the projection, not what to do about a row that was
    // never fully hydrated; emitting the key as `undefined` would make a
    // partially loaded row indistinguishable from a null column.
    const partial = { id: 1, name: "Ada" } as User;
    expect(serializer.serializeItem(partial, null, contextStub())).toEqual({ id: 1, name: "Ada" });
  });

  it("an empty schema.output.item { fields: [] } shorthand narrows the response to nothing, not the entity-derived default", () => {
    const config = resolveEntityConfig(userMetadata, { schema: { output: { item: { fields: [] } } } }, undefined);
    const itemSchema = config.schema.resolveOutput("item", "findOne");
    expect(serializer.serializeItem(ada(), itemSchema, contextStub())).toEqual({});
  });

  it("narrows serializeItem's projection using a class-shaped schema", () => {
    class ItemSchema {
      id = 0;
    }
    const result = serializer.serializeItem(ada(), ItemSchema, contextStub());
    expect(result).toEqual({ id: 1 });
  });

  it("does not narrow serializeItem's projection for a validator-shaped schema (narrowing happens at the engine layer)", () => {
    const validator = { safeParse: () => ({ success: true, data: {} }) };
    const result = serializer.serializeItem(ada(), validator as never, contextStub()) as object;
    expect(Object.keys(result)).toEqual(COLUMNS);
  });

  it("applies the same rules element-wise across a list", () => {
    class UserListDto {
      id = 0;
      name = "";
    }
    const context = readContext(userConfig, { select: { root: ["id"], relations: {} } as never });
    const items = serializer.serializeList([ada(), ada({ id: 2, name: "Grace" })], UserListDto, context);
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("DefaultSerializer — ORM-derived fields (issue #373)", () => {
  const derivedMetadata: EntityMetadata<User> = {
    ...userMetadata,
    fields: [
      ...userMetadata.fields,
      { name: "fullName", kind: "string", nullable: false, generated: false, derivedExpression: "concat" },
    ],
  };

  it("excludes an un-opted-in derived field from the unconfigured default projection", () => {
    const serializer = new DefaultSerializer<User>(derivedMetadata);
    const row = { ...ada(), fullName: "Ada Lovelace" } as User;
    expect(Object.keys(serializer.serializeItem(row, null, contextStub()))).toEqual(COLUMNS);
  });

  it("reads an opted-in derived field straight off the row, like any other column", () => {
    // Opt-in happens through `allowlists.selectable`, resolved at bootstrap
    // into `ResolvedEntityConfig.projection` — the serializer never inspects
    // `derivedExpression` itself, only the resolved key list it is handed.
    const serializer = new DefaultSerializer<User>(derivedMetadata, undefined, [...COLUMNS, "fullName"]);
    const row = { ...ada(), fullName: "Ada Lovelace" } as User;
    expect(serializer.serializeItem(row, null, contextStub())).toEqual({ ...ada(), fullName: "Ada Lovelace" });
  });
});

describe("DefaultDeserializer — ORM-derived fields (issue #373)", () => {
  it("never writes a derived field, even if the raw body carries one", () => {
    const derivedMetadata: EntityMetadata<User> = {
      ...userMetadata,
      fields: [
        ...userMetadata.fields,
        { name: "fullName", kind: "string", nullable: false, generated: false, derivedExpression: "concat" },
      ],
    };
    const deserializer = new DefaultDeserializer<User>(derivedMetadata);
    const context = createKavoContext<User>({
      operation: "createOne",
      config: resolveEntityConfig(derivedMetadata, undefined, undefined),
      repository: unusedRepository<User>(),
    });
    const result = deserializer.deserialize({ name: "Ada", fullName: "Ada Lovelace" }, null, context);
    expect(result).toEqual({ name: "Ada" });
  });
});

describe("DefaultSerializer — relation keys (doc 04 §6)", () => {
  const serializer = new DefaultSerializer<Post>(postMetadata);

  const post = (): Post =>
    Object.assign(new Post(), {
      id: 10,
      title: "First",
      authorId: 1,
      author: Object.assign(new Author(), { id: 1, name: "Ada" }),
    });

  it("never emits a loaded relation the request did not include", () => {
    const serialized = serializer.serializeItem(post(), null, readContext(postConfig));
    expect(serialized).not.toHaveProperty("author");
    expect(serialized).not.toHaveProperty("comments");
  });

  it("still omits a relation a registered DTO declares — the include decides the load", () => {
    class PostItemDto {
      id = 0;
      title = "";
      author: unknown = null;
    }
    const serialized = serializer.serializeItem(post(), PostItemDto, readContext(postConfig));
    expect(serialized).toEqual({ id: 10, title: "First" });
  });

  it("emits an included relation the row actually carries", () => {
    const context = readContext(postConfig, { include: { author: authorNode() } });
    expect(serializer.serializeItem(post(), null, context)).toMatchObject({
      author: { id: 1, name: "Ada" },
    });
  });

  it("skips an included relation the row never loaded", () => {
    // Distinct from "loaded and empty" (`author: null`, covered in
    // includes.spec): a programmatic caller can hand the engine an entity
    // the adapter never hydrated, and an absent key is not a null relation.
    const context = readContext(postConfig, { include: { author: authorNode() } });
    const unhydrated = Object.assign(new Post(), { id: 10, title: "First" });
    delete (unhydrated as Partial<Post>).author;
    expect(serializer.serializeItem(unhydrated, null, context)).not.toHaveProperty("author");
  });
});

describe("DefaultDeserializer — write projection", () => {
  const deserializer = new DefaultDeserializer<User>(userMetadata);

  it("keeps the writable columns and drops keys the entity does not have", () => {
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com", role: "admin" },
      null,
      contextStub(),
    );
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("drops generated columns, so a body can never write one", () => {
    // No validation subsystem exists to reject them, so stripping is the
    // safe default: a client cannot set `id` or `createdAt` (doc 04 §3).
    const payload = deserializer.deserialize({ id: 999, createdAt: new Date(1), name: "Ada" }, null, contextStub());
    expect(payload).toEqual({ name: "Ada" });
  });

  it("distinguishes an explicit null from a missing key", () => {
    // PATCH writes only the keys the body carries; `null` is one of them
    // (clear the column), absence is not (leave it alone).
    expect(deserializer.deserialize({ name: null }, null, contextStub())).toEqual({ name: null });
    expect(deserializer.deserialize({ email: "a@x.io" }, null, contextStub())).toEqual({ email: "a@x.io" });
  });

  it("takes the registered DTO's key set when one is given", () => {
    class CreateUserDto {
      name = "";
    }
    expect(deserializer.deserialize({ name: "Ada", email: "a@x.io" }, CreateUserDto, contextStub())).toEqual({
      name: "Ada",
    });
  });

  it("falls back to the derived default for a DTO with no runtime shape", () => {
    class OpaqueDto {}
    expect(deserializer.deserialize({ name: "Ada", id: 9 }, OpaqueDto, contextStub())).toEqual({ name: "Ada" });
  });

  it("treats a bodyless request as an empty payload", () => {
    // `KavoRequest.body` is nullable, and every write deserializes it.
    expect(deserializer.deserialize(null, null, contextStub())).toEqual({});
  });
});

describe("DefaultDeserializer — id and soft-delete marker exclusion", () => {
  // `User.id` is `generated: true`, which already excludes it — these cases
  // need a primary key an ORM does *not* mark generated (an app-assigned
  // natural key), the case a `generated`-only check misses entirely.
  const naturalKeyMetadata = {
    ...userMetadata,
    fields: userMetadata.fields.map((field) => (field.name === "id" ? { ...field, generated: false } : field)),
  };

  it("drops a non-generated primary key from the derived default regardless of `generated`", () => {
    const deserializer = new DefaultDeserializer(naturalKeyMetadata);
    const payload = deserializer.deserialize({ id: "chosen-id", name: "Ada" }, null, contextStub());
    expect(payload).toEqual({ name: "Ada" });
  });

  it("still lets an explicit write DTO name the primary key", () => {
    // Unlike a computed field, the id is a real column with a legitimate
    // opt-in use (assigning a natural key on create), so an explicit DTO
    // still reaches it.
    class CreateUserDto {
      id = "";
      name = "";
    }
    const deserializer = new DefaultDeserializer(naturalKeyMetadata);
    const payload = deserializer.deserialize({ id: "chosen-id", name: "Ada" }, CreateUserDto, contextStub());
    expect(payload).toEqual({ id: "chosen-id", name: "Ada" });
  });

  const withMarker = {
    ...userMetadata,
    fields: [...userMetadata.fields, { name: "deletedAt", kind: "date" as const, nullable: true, generated: false }],
  };

  /**
   * A context carrying only what `deserialize` reads off it: the resolved
   * soft-delete field for *this call*. Deliberately not a full
   * `resolveEntityConfig` output — the field this class must track is
   * `context.config.delete.field` specifically, resolved fresh per
   * request/operation/call (ADR-0013's precedence chain), never a value
   * baked into the deserializer at construction.
   */
  function contextWithMarker(field: string | null): KavoContext<User> {
    return {
      config: { delete: field === null ? { strategy: "hard", field: null } : { strategy: "soft", field } },
    } as KavoContext<User>;
  }

  it("drops the soft-delete marker field the call context resolves, from the derived default", () => {
    // The marker is an ordinary, non-generated column whenever the ORM
    // cannot declare a delete-date column (Prisma/Mongoose/MikroORM, and
    // `@kavo/typeorm` too when `delete.field` names a plain column) —
    // exactly the shape a `generated`-only check cannot see.
    const deserializer = new DefaultDeserializer(withMarker);
    const payload = deserializer.deserialize(
      { deletedAt: new Date(0), name: "Ada" },
      null,
      contextWithMarker("deletedAt"),
    );
    expect(payload).toEqual({ name: "Ada" });
  });

  it("leaves an ordinary column named 'deletedAt' writable when the call resolves no soft-delete marker", () => {
    const deserializer = new DefaultDeserializer(withMarker);
    const payload = deserializer.deserialize({ deletedAt: new Date(0), name: "Ada" }, null, contextWithMarker(null));
    expect(payload).toEqual({ deletedAt: new Date(0), name: "Ada" });
  });

  it("tracks a per-call marker override, not a value fixed at construction — the same deserializer excludes a different field for a different call", () => {
    // The regression this pins: an entity-scope-only exclusion (baked in
    // once, at bootstrap) would miss an operation or per-call
    // `delete.field` override that renames the marker — reopening the
    // exact mass-assignment gap this class exists to close, for that one
    // config shape. One `DefaultDeserializer` instance is shared across
    // every call for an entity, so tracking the override has to happen at
    // `deserialize` time, against that call's own resolved context.
    const renamed = {
      ...userMetadata,
      fields: [...userMetadata.fields, { name: "archivedAt", kind: "date" as const, nullable: true, generated: false }],
    };
    const deserializer = new DefaultDeserializer(renamed);
    const defaultScope = deserializer.deserialize(
      { archivedAt: new Date(0), name: "Ada" },
      null,
      contextWithMarker(null),
    );
    expect(defaultScope).toEqual({ archivedAt: new Date(0), name: "Ada" });
    const overriddenScope = deserializer.deserialize(
      { archivedAt: new Date(0), name: "Ada" },
      null,
      contextWithMarker("archivedAt"),
    );
    expect(overriddenScope).toEqual({ name: "Ada" });
  });

  it("still lets an explicit write DTO name the soft-delete marker, even when the call resolves one", () => {
    class UpdateUserDto {
      deletedAt: Date | null = null;
      name = "";
    }
    const deserializer = new DefaultDeserializer(withMarker);
    const payload = deserializer.deserialize(
      { deletedAt: new Date(0), name: "Ada" },
      UpdateUserDto,
      contextWithMarker("deletedAt"),
    );
    expect(payload).toEqual({ deletedAt: new Date(0), name: "Ada" });
  });
});

describe("DefaultDeserializer — single-key relation association (ADR-0014, issue #291)", () => {
  const catalog = new DefaultEntityCatalog((entity: ClassRef) => {
    if (entity === Author) {
      return authorMetadata as unknown as EntityMetadata<object>;
    }
    return undefined;
  });
  const deserializer = new DefaultDeserializer<Post>(postMetadata, catalog);

  function deserialize(raw: unknown) {
    return deserializer.deserialize(raw, null, { entityName: "Post", operation: "createOne" } as never);
  }

  it("narrows a reference object to just the target's id field", () => {
    expect(deserialize({ author: { id: 7 } })).toEqual({ author: { id: 7 } });
  });

  it("drops extra keys on a reference object rather than honoring a deep write", () => {
    expect(deserialize({ author: { id: 7, name: "Rae" } })).toEqual({ author: { id: 7 } });
  });

  it("disassociates on null", () => {
    expect(deserialize({ author: null })).toEqual({ author: null });
  });

  it("rejects a bare scalar instead of resolving it as shorthand for an {id} reference", () => {
    expect(() => deserialize({ author: 7 })).toThrowError(AssociationInvalidShapeException);
  });

  it("throws AssociationInvalidShapeException with the KAVO_ASSOCIATION_INVALID_SHAPE code", () => {
    try {
      deserialize({ author: 7 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssociationInvalidShapeException);
      expect((error as AssociationInvalidShapeException).code).toBe("KAVO_ASSOCIATION_INVALID_SHAPE");
      expect((error as AssociationInvalidShapeException).status).toBe(400);
    }
  });
});

describe("DefaultDeserializer — creatable/updatable narrowing (issue #259)", () => {
  /** A context carrying a resolved config's allowed, for one operation. */
  function writeContext(
    operation: "createOne" | "updateOne" | "patchOne",
    config: ResolvedEntityConfig<User>,
  ): KavoContext<User> {
    return { operation, config } as KavoContext<User>;
  }

  it("is a no-op intersection when neither list is configured", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      null,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("an empty schema.input.create { fields: [] } shorthand closes writes entirely, rather than falling back to the derived default", () => {
    // A shorthand-synthesized class with zero fields is a *known* empty
    // allowlist, not "shape unknown" — `shorthandFieldsOf` distinguishes it
    // from a hand-written declarative class with no initializers, which
    // still falls back (schema-shape.spec.ts).
    const config = resolveEntityConfig(userMetadata, { schema: { input: { create: { fields: [] } } } }, undefined);
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const dto = config.schema.resolveInput("create", "createOne");
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      dto,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({});
  });

  it("a bare empty array shorthand (schema.input.create: []) closes writes the same way as { fields: [] }", () => {
    const config = resolveEntityConfig(userMetadata, { schema: { input: { create: [] } } }, undefined);
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const dto = config.schema.resolveInput("create", "createOne");
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      dto,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({});
  });

  it("narrows createOne's derived projection via the schema.input.create { fields } shorthand", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { create: { fields: ["name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const dto = config.schema.resolveInput("create", "createOne");
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      dto,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({ name: "Ada" });
  });

  it("leaves updateOne/patchOne unaffected by a create-only shorthand", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { create: { fields: ["name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const updateDto = config.schema.resolveInput("update", "updateOne");
    const updatePayload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      updateDto,
      writeContext("updateOne", config),
    );
    expect(updatePayload).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("narrows both updateOne and patchOne via the same schema.input.update { fields } shorthand", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { update: { fields: ["name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const body = { name: "Ada", email: "ada@example.com" };
    const updateDto = config.schema.resolveInput("update", "updateOne");
    const patchDto = config.schema.resolveInput("patch", "patchOne");
    expect(deserializer.deserialize(body, updateDto, writeContext("updateOne", config))).toEqual({ name: "Ada" });
    expect(deserializer.deserialize(body, patchDto, writeContext("patchOne", config))).toEqual({ name: "Ada" });
  });

  it("leaves createOne unaffected by an update-only shorthand", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { update: { fields: ["name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const createDto = config.schema.resolveInput("create", "createOne");
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      createDto,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("lets an explicit create shorthand reach the primary key — an explicit DTO replaces the derived default rather than narrowing it", () => {
    // `{ fields: ["id", "name"] }` synthesizes a class carrying both keys —
    // same as a hand-written DTO naming `id` (ADR-0026's `dto.item`
    // precedent), unlike the *derived* default, which excludes the primary
    // key unconditionally (commit 8aa8d65).
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { create: { fields: ["id" as never, "name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const dto = config.schema.resolveInput("create", "createOne");
    const payload = deserializer.deserialize({ id: 5, name: "Ada" }, dto, writeContext("createOne", config));
    expect(payload).toEqual({ id: 5, name: "Ada" });
  });

  it("keeps the soft-delete marker excluded only for the derived default, not for an explicit DTO/shorthand", () => {
    const withMarker = {
      ...userMetadata,
      fields: [...userMetadata.fields, { name: "deletedAt", kind: "date" as const, nullable: true, generated: false }],
    };
    const config = resolveEntityConfig(withMarker, { delete: { field: "deletedAt" } }, undefined);
    const deserializer = new DefaultDeserializer<User>(withMarker);
    const payload = deserializer.deserialize(
      { deletedAt: new Date(0), name: "Ada" },
      null,
      writeContext("updateOne", config),
    );
    expect(payload).toEqual({ name: "Ada" });
  });

  it("leaves an explicitly registered write DTO's key set untouched", () => {
    // ADR-0026's `selectable`-vs-`dto.item` precedent: a registered DTO
    // replaces the projection outright, so it wins even where a `{ fields }`
    // shorthand elsewhere would have narrowed it further.
    class CreateUserDto {
      email = "";
    }
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const payload = deserializer.deserialize(
      { name: "Ada", email: "ada@example.com" },
      CreateUserDto,
      writeContext("createOne", config),
    );
    expect(payload).toEqual({ email: "ada@example.com" });
  });

  it("does not narrow a custom write operation, which resolves no DTO", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { schema: { input: { create: { fields: ["name"] } } } },
      undefined,
    );
    const deserializer = new DefaultDeserializer<User>(userMetadata);
    const payload = deserializer.deserialize({ name: "Ada", email: "ada@example.com" }, null, {
      operation: "archiveUser",
      config,
    } as KavoContext<User>);
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com" });
  });
});

/** The `author` edge of Post, resolved as an include-tree node would be. */
function authorNode(): IncludeNode {
  return {
    relation: postMetadata.relations[0]!,
    path: "author",
    fields: null,
    strategy: "join",
    delete: { strategy: "hard", field: null },
    children: {},
  };
}
