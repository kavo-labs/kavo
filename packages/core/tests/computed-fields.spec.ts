import { describe, expect, it, vi } from "vitest";
import type {
  ComputedFieldMap,
  DefaultKavoService,
  EntityConfig,
  EntityMetadata,
  KavoAppContext,
  KavoContext,
  ListResultDto,
} from "@kavo/core";
import {
  ConfigurationException,
  DefaultDeserializer,
  QueryValidationException,
  WireQuery,
  createKavo,
} from "@kavo/core";
import { InMemoryUserAdapter, User, contextStub, userMetadata } from "./support/user-fixture.js";
import {
  Author,
  Comment,
  Post,
  SeededAdapter,
  authorMetadata,
  commentMetadata,
  postMetadata,
} from "./support/blog-fixture.js";

/** `fullName`-style descriptor: derived from two real columns, nothing else. */
const shout = {
  resolve: (user: User): string => user.name.toUpperCase(),
};

function makeCrud(config: EntityConfig<User> = {}) {
  const adapter = new InMemoryUserAdapter();
  const kavo = createKavo();
  const crud = kavo.createCrud(User, config as never, { adapter, metadata: userMetadata }) as DefaultKavoService<User>;
  return { crud, adapter, kavo };
}

async function seeded(config: EntityConfig<User> = {}) {
  const fixture = makeCrud(config);
  await fixture.crud.createOne({ name: "Ada", email: "ada@example.com", age: 36 } as never);
  return fixture;
}

/**
 * Every config error names the entity, the key path and the offending
 * value (the bar `config-validation.spec.ts` sets) — `messageParams` is
 * where the first two live, so asserting the rendered message alone
 * would leave the key path free to drift.
 */
function expectConfigError(build: () => unknown, path: string, fragment: string, entity = "User"): void {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationException);
    expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((error as ConfigurationException).messageParams).toMatchObject({ entity, path });
    expect((error as ConfigurationException).message).toContain(fragment);
    return;
  }
  throw new Error("expected a ConfigurationException");
}

describe("computed fields — default projection (ADR-0019)", () => {
  it("appears in a findOne response with no DTO registered", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    expect(await crud.findOne(1)).toMatchObject({ id: 1, name: "Ada", shout: "ADA" });
  });

  it("appears on every element of a findMany response", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    await crud.createOne({ name: "Grace", email: "g@example.com", age: 45 } as never);
    const list = (await crud.findMany()) as unknown as ListResultDto<User & { shout: string }>;
    expect(list.items.map((item) => item.shout)).toEqual(["ADA", "GRACE"]);
  });

  it("is evaluated, not read off the row — a plain object works like a class instance", async () => {
    // The whole point over the "register a DTO naming a class getter"
    // workaround: `@kavo/prisma` and `@kavo/mongoose` hand the engine plain
    // objects that carry no getter at all.
    const adapter = new SeededAdapter<User>([{ id: 1, name: "Ada", email: "a@x.io", age: 36 } as User]);
    const crud = createKavo().createCrud(User, { computed: { shout } } as never, {
      adapter: adapter as never,
      metadata: userMetadata,
    }) as DefaultKavoService<User>;
    expect(await crud.findOne(1)).toEqual({ id: 1, name: "Ada", email: "a@x.io", age: 36, shout: "ADA" });
  });

  it("beats a row that already carries the key — resolving wins over reading", async () => {
    // The branch order in `DefaultSerializer.project` is normative, and a
    // row really can carry a computed key: a Prisma/Mongoose row with a
    // column the metadata seam does not describe, or an ORM that hydrates
    // extra properties. Reading the row instead would put the response back
    // where ADR-0019's Context section found it.
    const { crud, adapter } = makeCrud({ computed: { shout } } as never);
    adapter.rows.push(Object.assign(new User(), { id: 1, name: "Ada", shout: "FROM ROW" }));
    expect(await crud.findOne(1)).toMatchObject({ id: 1, name: "Ada", shout: "ADA" });
  });

  it("beats a class getter of the same name — ADR-0019's motivating case", async () => {
    // The superseded workaround was exactly this: a DTO naming a property
    // the entity class exposes as a getter, which the serializer copied
    // because `key in source` was true. A declared computed field is the
    // replacement, so it has to win over the thing it replaces.
    class Legacy extends User {
      get shout(): string {
        return "FROM GETTER";
      }
    }
    const { crud, adapter } = makeCrud({ computed: { shout } } as never);
    adapter.rows.push(Object.assign(new Legacy(), { id: 1, name: "Ada" }));
    expect(await crud.findOne(1)).toMatchObject({ id: 1, name: "Ada", shout: "ADA" });
  });

  it("does not mistake an inherited name for a declared computed field", async () => {
    // `project` consults the computed table with `hasOwnProperty`, not
    // `in`: with `in`, `toString` would hit `Object.prototype`, `.resolve`
    // would be `undefined`, and the row's own value would silently vanish
    // from the response instead of being emitted.
    class UserItemDto {
      id = 0;
      toString = "";
    }
    const { crud, adapter } = makeCrud({ dto: { item: UserItemDto } } as never);
    adapter.rows.push(Object.assign(new User(), { id: 1, toString: "shadowed" }) as User);
    expect(await crud.findOne(1)).toEqual({ id: 1, toString: "shadowed" });
  });

  it("receives the same KavoContext a custom handler gets, so it can vary by caller", async () => {
    let seen: KavoContext<User> | null = null;
    const { crud } = await seeded({
      computed: {
        viewer: {
          resolve: (_user: User, context: KavoContext<User>) => {
            seen = context;
            return (context.app as { id?: string }).id ?? "anonymous";
          },
        },
      },
    } as never);
    const item = (await crud.findOne(1, undefined, { app: { id: "u-7" } as KavoAppContext })) as User & {
      viewer: string;
    };
    expect(item.viewer).toBe("u-7");
    expect(seen).toMatchObject({ entityName: "User", operation: "findOne" });
    expect((seen as unknown as KavoContext<User>).correlationId).toEqual(expect.any(String));
  });
});

describe("computed fields — DTO narrowing (doc 04 §5)", () => {
  it("is narrowed out by an explicit item DTO that omits it", async () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    const { crud } = await seeded({ computed: { shout }, dto: { item: UserItemDto } } as never);
    expect(await crud.findOne(1)).toEqual({ id: 1, name: "Ada" });
  });

  it("is still evaluated when an explicit item DTO names it", async () => {
    class UserItemDto {
      id = 0;
      shout = "";
    }
    const { crud } = await seeded({ computed: { shout }, dto: { item: UserItemDto } } as never);
    expect(await crud.findOne(1)).toEqual({ id: 1, shout: "ADA" });
  });
});

describe("computed fields — selection", () => {
  it("is selectable by default, so select= can name it", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    expect(await crud.findOne(1, { select: ["name", "shout"] } as never)).toEqual({ name: "Ada", shout: "ADA" });
  });

  it("is selectable over the wire grammar too", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    const list = (await crud.findMany(new WireQuery({ select: "shout" }) as never)) as unknown as ListResultDto<{
      shout: string;
    }>;
    expect(list.items).toEqual([{ shout: "ADA" }]);
  });

  it("is dropped by a fieldset that does not name it — selection narrows uniformly", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    expect(await crud.findOne(1, { select: ["name"] } as never)).toEqual({ name: "Ada" });
  });

  it("never runs a deselected field's resolver", async () => {
    // Load-bearing ordering, not an implementation detail: `resolve` is
    // caller code with an unbounded cost, so the selection check has to
    // come *before* the computed branch. Seeded through the adapter,
    // because `createOne` serializes its own result with no fieldset and
    // would call the resolver before the read under test.
    const resolve = vi.fn((user: User) => user.name.toUpperCase());
    const { crud, adapter } = makeCrud({ computed: { shout: { resolve } } } as never);
    adapter.rows.push(Object.assign(new User(), { id: 1, name: "Ada" }));
    expect(await crud.findOne(1, { select: ["name"] } as never)).toEqual({ name: "Ada" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("opts out of the selectable allowlist with `selectable: false` and is then a 400", async () => {
    const { crud } = await seeded({
      computed: { shout: { ...shout, selectable: false } },
    } as never);
    // Still present in the default projection …
    expect(await crud.findOne(1)).toMatchObject({ shout: "ADA" });
    // … but outside the allowlist, so naming it is rejected, never dropped.
    await expect(crud.findOne(1, { select: ["shout"] } as never)).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      issues: [{ field: "shout", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
    // And the limit of what the flag buys: `selectable: false` narrows the
    // allowlist, not the projection, so any fieldset that omits the field
    // still drops it — with no way for the client to ask for it back.
    expect(await crud.findOne(1, { select: ["name"] } as never)).toEqual({ name: "Ada" });
  });

  it("survives an `{ exclude }` selectable list, which resolves against columns *and* computed", async () => {
    // The exclude form resolves against the same base set the plain default
    // uses; a regression to own-columns-only here is invisible to the
    // default-selector cases above, because that is a different branch.
    const { crud } = await seeded({
      computed: { shout },
      select: { fields: { exclude: ["email"] } },
    } as never);
    expect(await crud.findOne(1, { select: ["shout"] } as never)).toEqual({ shout: "ADA" });
    await expect(crud.findOne(1, { select: ["email"] } as never)).rejects.toBeInstanceOf(QueryValidationException);
  });

  it("leaves the default projection when excluded by name, not just the allowlist", async () => {
    // Changed by ADR-0026, deliberately. This used to assert the opposite:
    // that `{ exclude: ["shout"] }` narrowed the allowlist and left the
    // field in every response anyway. That is #149 — a config that states
    // an intent to hide and does not hide.
    //
    // The descriptor flag and the explicit list now say different things,
    // which is the point of having both: `selectable: false` still keeps
    // the field in the projection (the test above), because it is a default
    // about *nameability*; an explicit list is a statement about the
    // response.
    const { crud } = await seeded({
      computed: { shout },
      select: { fields: { exclude: ["shout"] } },
    } as never);
    expect(await crud.findOne(1)).not.toHaveProperty("shout");
    await expect(crud.findOne(1, { select: ["shout"] } as never)).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      issues: [{ field: "shout", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("keeps a `selectable: false` field when an { exclude } list names something else", async () => {
    // The interaction ADR-0026 §2 promises and the first cut of it broke.
    // `{ exclude }` resolves against the *readable* projection — every
    // column plus every declared computed field — not against the selectable
    // base, which drops `selectable: false` fields. Resolving against the
    // narrower base deleted an audit field the author never named, from
    // every response, because they excluded an unrelated column.
    const { crud } = await seeded({
      computed: { shout: { ...shout, selectable: false } },
      select: { fields: { exclude: ["email"] } },
    } as never);

    const item = (await crud.findOne(1)) as unknown as Record<string, unknown>;
    expect(item["shout"]).toBe("ADA");
    expect(item).not.toHaveProperty("email");
  });

  it("lets an explicit selectable list override the descriptor's `selectable: false`", async () => {
    // The descriptor's flag governs the *derived* default; naming the field
    // in an explicit list is the same deliberate opt-in that an explicit
    // list always is, so it wins — the flag is a default, not a veto.
    const { crud } = await seeded({
      computed: { shout: { ...shout, selectable: false } },
      select: { fields: ["id", "shout"] },
    } as never);
    expect(await crud.findOne(1, { select: ["shout"] } as never)).toEqual({ shout: "ADA" });
  });

  it("never joins the filterable or sortable defaults", async () => {
    const { crud } = await seeded({ computed: { shout } } as never);
    await expect(crud.findMany({ sort: [{ field: "shout" as never, direction: "asc" }] })).rejects.toBeInstanceOf(
      QueryValidationException,
    );
    await expect(crud.findMany(new WireQuery({ "filter[shout][eq]": "ADA" }) as never)).rejects.toBeInstanceOf(
      QueryValidationException,
    );
  });
});

describe("computed fields — bootstrap validation", () => {
  it("rejects a computed field listed as filterable", () => {
    expectConfigError(
      () => makeCrud({ computed: { shout }, filter: { fields: ["shout"] } } as never),
      "filter.fields",
      "'shout' is a computed field on 'User', which can never be filtered on",
    );
  });

  it("rejects a computed field listed as sortable", () => {
    expectConfigError(
      () => makeCrud({ computed: { shout }, sort: { fields: ["shout"] } } as never),
      "sort.fields",
      "'shout' is a computed field on 'User', which can never be sorted on",
    );
  });

  it("rejects a name that collides with a real column", () => {
    expectConfigError(
      () => makeCrud({ computed: { email: shout } } as never),
      "computed.email",
      "computed field 'email' collides with an existing column on 'User'",
    );
  });

  it("rejects a name that collides with a relation", () => {
    const kavo = createKavo();
    expectConfigError(
      () =>
        kavo.createCrud(Post, { computed: { author: { resolve: () => 1 } } } as never, {
          adapter: new SeededAdapter<Post>() as never,
          metadata: postMetadata as EntityMetadata<Post>,
        }),
      "computed.author",
      "computed field 'author' collides with an existing relation on 'Post'",
      "Post",
    );
  });

  it("rejects a descriptor with no resolve function", () => {
    expectConfigError(
      () => makeCrud({ computed: { shout: {} } } as never),
      "computed.shout",
      "computed field 'shout' has no 'resolve' function",
    );
  });

  it("rejects an async resolve rather than emitting an unawaited promise", () => {
    expectConfigError(
      () => makeCrud({ computed: { shout: { resolve: async () => "ADA" } } } as never),
      "computed.shout",
      "computed field 'shout' has an async 'resolve'",
    );
  });

  it("rejects the computed-key `__proto__` spelling rather than losing the declaration", () => {
    // Assigning it into the accumulator would set that object's prototype
    // instead of adding a key, so the field would vanish with no error —
    // the same class of hazard as the filter parser's bracket segments.
    expectConfigError(
      () => makeCrud({ computed: { ["__proto__"]: shout } } as never),
      "computed.__proto__",
      "'__proto__' cannot name a computed field",
    );
  });

  it("rejects the object-literal `__proto__` spelling too — the one people actually write", () => {
    // `{ __proto__: … }` invokes the prototype *setter* rather than
    // creating an own key, so the name never reaches `Object.keys` and the
    // per-key loop above cannot see it. Without the prototype check the
    // declaration registers nothing and throws nothing — precisely the
    // outcome the message promises to prevent.
    expectConfigError(
      () => makeCrud({ computed: { __proto__: shout } } as never),
      "computed.__proto__",
      "'__proto__' cannot name a computed field",
    );
  });

  it("still accepts an explicit selectable list naming the computed field", async () => {
    const { crud } = await seeded({
      computed: { shout },
      select: { fields: ["id", "shout"] },
    } as never);
    expect(await crud.findOne(1, { select: ["shout"] } as never)).toEqual({ shout: "ADA" });
    await expect(crud.findOne(1, { select: ["email"] } as never)).rejects.toBeInstanceOf(QueryValidationException);
  });

  it("lists the declared names in the debug dump", () => {
    const { kavo } = makeCrud({ computed: { shout } } as never);
    expect(kavo.describe("User")).toMatchObject({ computed: ["shout"] });
  });
});

describe("computed fields — a throwing or empty resolver", () => {
  it("surfaces a throwing resolver as a persistence failure, with the cause kept", async () => {
    // `resolve` is caller code running inside response mapping, after the
    // handler has already succeeded. Nothing in core catches it, so it
    // takes the engine's ordinary untranslated-error path.
    const boom = new Error("resolver exploded");
    const { crud, adapter } = makeCrud({
      computed: {
        shout: {
          resolve: () => {
            throw boom;
          },
        },
      },
    } as never);
    // Seeded through the adapter, not `createOne` — writes serialize their
    // result too, so a throwing resolver takes down the write as well.
    adapter.rows.push(Object.assign(new User(), { id: 1, name: "Ada" }));
    await expect(crud.findOne(1)).rejects.toMatchObject({
      code: "KAVO_PERSISTENCE_FAILED",
      status: 500,
      cause: boom,
    });
  });

  it("omits the key when a resolver returns undefined, and keeps an explicit null", async () => {
    // Same distinction the column branch draws: `undefined` is absence,
    // `null` is data — so the programmatic shape and the JSON body agree.
    const { crud } = await seeded({
      computed: {
        absent: { resolve: () => undefined },
        empty: { resolve: () => null },
      },
    } as never);
    const item = (await crud.findOne(1)) as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty("absent");
    expect(item).toHaveProperty("empty", null);
  });
});

describe("computed fields — never writable (ADR-0019)", () => {
  it("is stripped from a create body", async () => {
    const { crud, adapter } = makeCrud({ computed: { shout } } as never);
    const create = vi.spyOn(adapter, "create");
    await crud.createOne({ name: "Ada", email: "a@x.io", shout: "NOPE" } as never);
    expect(create.mock.calls[0]?.[0]).toEqual({ name: "Ada", email: "a@x.io" });
  });

  it("is stripped from update and patch bodies", async () => {
    const { crud, adapter } = await seeded({ computed: { shout } } as never);
    const update = vi.spyOn(adapter, "update");
    const patch = vi.spyOn(adapter, "patch");
    await crud.updateOne(1, { name: "Ada L", shout: "NOPE" } as never);
    await crud.patchOne(1, { shout: "NOPE" } as never);
    expect(update.mock.calls[0]?.[1]).toEqual({ name: "Ada L" });
    expect(patch.mock.calls[0]?.[1]).toEqual({});
  });

  /**
   * The outer of the two layers. A write DTO naming a computed field is
   * the one computed misuse that used to be handled silently — a per-
   * request drop — while every other one is a bootstrap error naming the
   * key path. It is judgeable once, at `createCrud`, and it has a wire
   * consequence the strip cannot reach: `@kavo/nest` builds `@ApiBody`
   * from the DTO's runtime shape, so OpenAPI advertised a property the
   * engine unconditionally discarded.
   */
  for (const slot of ["create", "update", "patch"] as const) {
    it(`rejects a registered ${slot} DTO that declares it, at bootstrap`, () => {
      class WriteUserDto {
        name = "";
        shout = "";
      }
      expectConfigError(
        () => makeCrud({ computed: { shout }, dto: { [slot]: WriteUserDto } } as never),
        `dto.${slot}`,
        `the '${slot}' DTO declares 'shout', which is a computed field on 'User'`,
      );
    });
  }

  it("accepts a write DTO that omits it, so the check is not just 'any DTO'", async () => {
    class CreateUserDto {
      name = "";
      email = "";
    }
    const { crud, adapter } = makeCrud({ computed: { shout }, dto: { create: CreateUserDto } } as never);
    const create = vi.spyOn(adapter, "create");
    await crud.createOne({ name: "Ada", email: "a@x.io", shout: "NOPE" } as never);
    expect(create.mock.calls[0]?.[0]).toEqual({ name: "Ada", email: "a@x.io" });
  });

  /**
   * The inner layer, and the only place it is reachable now that the outer
   * one rejects the config that produced it. `DefaultDeserializer` is
   * exported, so its contract is "a computed name never reaches the
   * adapter" on its own terms — not "the config resolver checked first".
   * Deleting the strip in `deserialize` fails exactly this test.
   */
  it("is stripped by DefaultDeserializer directly, whichever projection is in force", () => {
    class UpdateUserDto {
      name = "";
      shout = "";
    }
    const computed: ComputedFieldMap<User> = { shout };
    const deserializer = new DefaultDeserializer<User>(userMetadata, undefined, computed);
    expect(deserializer.deserialize({ name: "Ada", shout: "NOPE" }, null, contextStub())).toEqual({ name: "Ada" });
    expect(deserializer.deserialize({ name: "Ada", shout: "NOPE" }, UpdateUserDto, contextStub())).toEqual({
      name: "Ada",
    });
  });
});

describe("computed fields — on an included relation target", () => {
  interface BlogConfigs {
    readonly author?: object;
    readonly post?: object;
    readonly comment?: object;
  }

  /**
   * `Author 1—* Post 1—* Comment`, so both include cardinalities are
   * reachable. Every entity gets a computed field named `label` with a
   * *different* resolver, which is what makes "each side uses its own
   * table" an assertion rather than an absence.
   */
  function blog(configs: BlogConfigs = {}) {
    const metadata = new Map<unknown, EntityMetadata<object>>([
      [Author, authorMetadata as EntityMetadata<object>],
      [Post, postMetadata as EntityMetadata<object>],
      [Comment, commentMetadata as EntityMetadata<object>],
    ]);
    const authorAdapter = new SeededAdapter<Author>([]);
    const postAdapter = new SeededAdapter<Post>([]);
    const adapters = new Map<unknown, unknown>([
      [Author, authorAdapter],
      [Post, postAdapter],
      [Comment, new SeededAdapter<Comment>([])],
    ]);
    const kavo = createKavo({
      infrastructure: {
        metadataFor: (entity) => metadata.get(entity) as never,
        adapterFor: (entity) => adapters.get(entity) as never,
      },
    });
    const authors = kavo.createCrud(
      Author,
      (configs.author ?? {
        computed: {
          initials: { resolve: (author: Author) => author.name.slice(0, 2) },
          label: { resolve: (author: Author) => `author:${author.name}` },
        },
        include: { fields: ["posts"] },
      }) as never,
    ) as DefaultKavoService<Author>;
    kavo.createCrud(
      Comment,
      (configs.comment ?? {
        computed: { label: { resolve: (comment: Comment) => `comment:${comment.body}` } },
      }) as never,
    );
    const posts = kavo.createCrud(
      Post,
      (configs.post ?? {
        computed: { label: { resolve: (post: Post) => `post:${post.title}` } },
        include: { fields: ["author", "comments"] },
      }) as never,
    ) as DefaultKavoService<Post>;
    postAdapter.rows.push(
      Object.assign(new Post(), {
        id: 10,
        title: "First",
        authorId: 1,
        author: Object.assign(new Author(), { id: 1, name: "Ada" }),
        comments: [Object.assign(new Comment(), { id: 100, body: "nice", postId: 10 })],
      }),
    );
    return { posts, authors, authorAdapter, postAdapter };
  }

  it("resolves the target's own computed field through the catalog", async () => {
    const { posts } = blog();
    const item = (await posts.findOne(10, { include: ["author"] })) as Post & {
      author: Author & { initials: string };
    };
    expect(item.author).toMatchObject({ id: 1, name: "Ada", initials: "Ad" });
  });

  it("honors the target's selectable allowlist for select[author]", async () => {
    const { posts } = blog();
    const item = (await posts.findOne(10, {
      include: ["author"],
      select: { author: ["initials"] },
    } as never)) as Post & { author: { initials: string } };
    expect(item.author).toEqual({ initials: "Ad" });
  });

  it("gives each side its own table when root and target share a field name", async () => {
    // `label` is declared on Post *and* on Author with different resolvers.
    // A serializer that reused the root projection's computed table for a
    // relation node would emit `author.label === "post:First"` here, which
    // is precisely the failure an absence assertion cannot see.
    const { posts } = blog();
    const item = (await posts.findOne(10, { include: ["author"] })) as Post & {
      label: string;
      author: { label: string };
    };
    expect(item.label).toBe("post:First");
    expect(item.author.label).toBe("author:Ada");
  });

  it("resolves a computed field on every element of a to-many include", async () => {
    // A to-many node reads the target's `list` DTO slot rather than `item`
    // — a distinct lookup in `projectionFor` that the to-one cases never
    // reach.
    const { posts } = blog();
    const item = (await posts.findOne(10, { include: ["comments"] })) as Post & {
      comments: Record<string, unknown>[];
    };
    expect(item.comments).toEqual([{ id: 100, body: "nice", postId: 10, label: "comment:nice" }]);
  });

  it("keeps evaluating a target computed field that the target's item DTO names", async () => {
    class AuthorItemDto {
      id = 0;
      initials = "";
    }
    const { posts } = blog({
      author: {
        computed: { initials: { resolve: (author: Author) => author.name.slice(0, 2) } },
        dto: { item: AuthorItemDto },
      },
    });
    const item = (await posts.findOne(10, { include: ["author"] })) as Post & { author: object };
    expect(item.author).toEqual({ id: 1, initials: "Ad" });
  });

  it("narrows a target computed field away when the target's item DTO omits it", async () => {
    class AuthorItemDto {
      id = 0;
      name = "";
    }
    const { posts } = blog({
      author: {
        computed: { initials: { resolve: (author: Author) => author.name.slice(0, 2) } },
        dto: { item: AuthorItemDto },
      },
    });
    const item = (await posts.findOne(10, { include: ["author"] })) as Post & { author: object };
    expect(item.author).toEqual({ id: 1, name: "Ada" });
  });

  it("hands a target's resolver the root request's context, not one of its own", async () => {
    // One response is one request, so there is only one context to give.
    // Documented on `ComputedFieldDescriptor.resolve` and in ADR-0019, and
    // pinned here so it cannot drift into a silent half-truth.
    let seen: KavoContext<Author> | null = null;
    const { posts, authorAdapter, postAdapter } = blog({
      author: {
        computed: {
          initials: {
            resolve: (author: Author, context: KavoContext<Author>) => {
              seen = context;
              return author.name.slice(0, 2);
            },
          },
        },
      },
    });
    await posts.findOne(10, { include: ["author"] }, { app: { id: "u-7" } as KavoAppContext });
    // Request-scoped members are the caller's, and true from anywhere …
    expect(seen).toMatchObject({ app: { id: "u-7" } });
    // … while the entity-scoped ones describe the *root* operation.
    expect(seen).toMatchObject({ entityName: "Post", operation: "findOne" });
    // `repository` is entity-scoped too, and it is the one that can act:
    // typed `RepositoryAdapter<Author>` here, holding Post's adapter
    // (ADR-0025). Pinned because the type says otherwise, so only a test
    // can keep the documented caveat honest.
    expect(seen!.repository).toBe(postAdapter);
    expect(seen!.repository).not.toBe(authorAdapter);
  });
});
