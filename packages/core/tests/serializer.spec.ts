import { describe, expect, it } from "vitest";
import type { KavoContext, IncludeNode, NormalizedQueryContext, ResolvedEntityConfig } from "@kavo/core";
import {
  DefaultDeserializer,
  DefaultDtoResolver,
  DefaultSerializer,
  createKavoContext,
  resolveEntityConfig,
} from "@kavo/core";
import { User, contextStub, unusedRepository, userMetadata } from "./support/user-fixture.js";
import { Author, Post, postMetadata } from "./support/blog-fixture.js";

const userConfig = resolveEntityConfig(userMetadata, undefined, undefined);
const postConfig = resolveEntityConfig(postMetadata, undefined, undefined);

const EMPTY_QUERY = {
  filter: { root: null },
  sort: [],
  pagination: { limit: 20, offset: 0 },
  fields: { root: null, relations: {} },
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
    const context = readContext(userConfig, { fields: { root: ["name", "email"], relations: {} } as never });
    expect(serializer.serializeItem(ada(), UserItemDto, context)).toEqual({ name: "Ada" });
  });

  it("keeps a null column value — null is data, not absence", () => {
    const context = readContext(userConfig, { fields: { root: ["name"], relations: {} } as never });
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

  it("applies the same rules element-wise across a list", () => {
    class UserListDto {
      id = 0;
      name = "";
    }
    const context = readContext(userConfig, { fields: { root: ["id"], relations: {} } as never });
    const items = serializer.serializeList([ada(), ada({ id: 2, name: "Grace" })], UserListDto, context);
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
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

  it("drops the resolved soft-delete marker field from the derived default", () => {
    // The marker is an ordinary, non-generated column whenever the ORM
    // cannot declare a delete-date column (Prisma/Mongoose/MikroORM, and
    // `@kavo/typeorm` too when `softDelete.field` names a plain column) —
    // exactly the shape a `generated`-only check cannot see.
    const withMarker = {
      ...userMetadata,
      fields: [...userMetadata.fields, { name: "deletedAt", kind: "date" as const, nullable: true, generated: false }],
    };
    const deserializer = new DefaultDeserializer(withMarker, undefined, {}, "deletedAt");
    const payload = deserializer.deserialize({ deletedAt: new Date(0), name: "Ada" }, null, contextStub());
    expect(payload).toEqual({ name: "Ada" });
  });

  it("leaves an ordinary column named 'deletedAt' writable when the entity has no soft-delete marker", () => {
    // `softDeleteField` argument is `null` by default — no marker resolved,
    // no exclusion.
    const withMarker = {
      ...userMetadata,
      fields: [...userMetadata.fields, { name: "deletedAt", kind: "date" as const, nullable: true, generated: false }],
    };
    const deserializer = new DefaultDeserializer(withMarker);
    const payload = deserializer.deserialize({ deletedAt: new Date(0), name: "Ada" }, null, contextStub());
    expect(payload).toEqual({ deletedAt: new Date(0), name: "Ada" });
  });
});

describe("DefaultDtoResolver — slot resolution", () => {
  class CreateUserDto {}
  class UpdateUserDto {}
  class PatchUserDto {}
  class UserQueryDto {}
  class UserItemDto {}
  class UserListDto {}

  it("resolves every slot to null when nothing is registered", () => {
    // `null` is not "no DTO": it means "use the entity-derived default",
    // which the serializer/deserializer builds from metadata.
    const resolver = new DefaultDtoResolver<User>();
    for (const slot of ["create", "update", "patch", "query", "item", "list"] as const) {
      expect(resolver.resolve(slot, "findOne")).toBeNull();
    }
  });

  it("returns the registered class for each slot it was given", () => {
    const resolver = new DefaultDtoResolver<User>({
      create: CreateUserDto,
      update: UpdateUserDto,
      patch: PatchUserDto,
      query: UserQueryDto,
      item: UserItemDto,
      list: UserListDto,
    } as never);
    expect(resolver.resolve("create", "createOne")).toBe(CreateUserDto);
    expect(resolver.resolve("update", "updateOne")).toBe(UpdateUserDto);
    expect(resolver.resolve("patch", "patchOne")).toBe(PatchUserDto);
    expect(resolver.resolve("query", "findMany")).toBe(UserQueryDto);
    expect(resolver.resolve("item", "findOne")).toBe(UserItemDto);
    expect(resolver.resolve("list", "findMany")).toBe(UserListDto);
  });

  it("falls patch back to the registered update class", () => {
    const resolver = new DefaultDtoResolver<User>({ update: UpdateUserDto } as never);
    expect(resolver.resolve("patch", "patchOne")).toBe(UpdateUserDto);
  });

  it("prefers an explicit patch class over the update fallback", () => {
    const resolver = new DefaultDtoResolver<User>({ update: UpdateUserDto, patch: PatchUserDto } as never);
    expect(resolver.resolve("patch", "patchOne")).toBe(PatchUserDto);
  });

  it("falls list back to the registered item class", () => {
    const resolver = new DefaultDtoResolver<User>({ item: UserItemDto } as never);
    expect(resolver.resolve("list", "findMany")).toBe(UserItemDto);
  });

  it("prefers an explicit list class over the item fallback", () => {
    const resolver = new DefaultDtoResolver<User>({ item: UserItemDto, list: UserListDto } as never);
    expect(resolver.resolve("list", "findMany")).toBe(UserListDto);
  });

  it("chains no other slot — update keeps its own derived default", () => {
    // The table's "update: same default as create" means the same
    // *derived* default, not the class someone registered for create.
    const resolver = new DefaultDtoResolver<User>({ create: CreateUserDto } as never);
    expect(resolver.resolve("create", "createOne")).toBe(CreateUserDto);
    expect(resolver.resolve("update", "updateOne")).toBeNull();
    expect(resolver.resolve("patch", "patchOne")).toBeNull();
  });

  it("resolves by slot alone — restore and custom operations reuse item and list", () => {
    const resolver = new DefaultDtoResolver<User>({ item: UserItemDto, list: UserListDto } as never);
    for (const operation of ["findOne", "createOne", "restoreOne", "activate"]) {
      expect(resolver.resolve("item", operation)).toBe(UserItemDto);
      expect(resolver.resolve("list", operation)).toBe(UserListDto);
    }
  });
});

/** The `author` edge of Post, resolved as an include-tree node would be. */
function authorNode(): IncludeNode {
  return {
    relation: postMetadata.relations[0]!,
    path: "author",
    fields: null,
    strategy: "join",
    softDelete: { strategy: "hard", field: null },
    children: {},
  };
}
