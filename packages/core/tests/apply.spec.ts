import { describe, expect, it } from "vitest";
import type {
  ApplyArgs,
  EntityId,
  FilterExpression,
  KavoContext,
  KavoOptions,
  NormalizedQueryContext,
} from "@kavo/core";
import { NotFoundException, QueryNormalizer, createKavo, hasKeyset, resolveEntityConfig } from "@kavo/core";
import {
  Author,
  Comment,
  Post,
  SeededAdapter,
  authorMetadata,
  commentMetadata,
  postMetadata,
} from "./support/blog-fixture.js";

/**
 * A minimal `EQ`/`NE`/`IN`/`AND`/`OR`/`NOT` evaluator, just enough to prove
 * `apply`'s composed filter actually scopes the row set — `SeededAdapter`
 * itself ignores `query.filter` entirely (every other spec in this package
 * asserts on `adapter.lastQuery` instead, which is enough when the point
 * under test is "what filter did the engine build", not "does a real ORM
 * enforce it"). Here the point under test is specifically that a row
 * outside `apply`'s constraint is unreachable, so this adapter enforces it.
 */
function matches(row: unknown, expression: FilterExpression<unknown> | null): boolean {
  if (expression === null) {
    return true;
  }
  const record = row as Record<string, unknown>;
  if (expression.kind === "group") {
    if (expression.operator === "AND") {
      return expression.children.every((child) => matches(row, child));
    }
    if (expression.operator === "OR") {
      return expression.children.some((child) => matches(row, child));
    }
    return !matches(row, expression.children[0] ?? null);
  }
  const value = record[expression.field as string];
  switch (expression.operator) {
    case "EQ":
      return value === expression.value;
    case "NE":
      return value !== expression.value;
    case "IN":
      return (expression.value as readonly unknown[]).includes(value);
    case "NOT_IN":
      return !(expression.value as readonly unknown[]).includes(value);
    default:
      throw new Error(`fixture: unsupported operator '${expression.operator}' in apply.spec.ts`);
  }
}

class ScopedAdapter<Entity extends { id: number }> extends SeededAdapter<Entity> {
  override async findOneById(id: EntityId, query: NormalizedQueryContext<Entity> | null): Promise<Entity | null> {
    this.lastQuery = query;
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null) {
      return null;
    }
    return query !== null && !matches(row, query.filter.root) ? null : row;
  }

  override async findMany(query: NormalizedQueryContext<Entity>): Promise<readonly Entity[]> {
    this.lastQuery = query;
    const scoped = this.rows.filter((row) => matches(row, query.filter.root));
    const offset = hasKeyset(query.pagination) ? 0 : query.pagination.offset;
    return scoped.slice(offset, offset + query.pagination.limit);
  }

  override async count(query: NormalizedQueryContext<Entity>): Promise<number> {
    this.lastQuery = query;
    return this.rows.filter((row) => matches(row, query.filter.root)).length;
  }
}

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1], options?: KavoOptions) {
  const adapter = new ScopedAdapter<Post>([]);
  const kavo = createKavo(options);
  // `author`/`comments` are relations to other registered entities — the
  // include tests below need both known to the same Kavo instance's
  // catalog, the same setup `policy.spec.ts`'s `makeAuthorCrud` uses.
  kavo.createCrud(Author, undefined, { adapter: new SeededAdapter<Author>(), metadata: authorMetadata });
  kavo.createCrud(Comment, undefined, { adapter: new SeededAdapter<Comment>(), metadata: commentMetadata });
  const crud = kavo.createCrud(Post, config as never, { adapter, metadata: postMetadata });
  return { crud, adapter, kavo };
}

interface AppCtx {
  readonly userId?: string;
}

function appOf<Entity>(context: KavoContext<Entity>): AppCtx {
  return context.app as AppCtx;
}

function ownFilter(field: string) {
  return ({ context }: { context: KavoContext<Post> }): FilterExpression<Post> | undefined => {
    const { userId } = appOf(context);
    if (userId === undefined) {
      return undefined;
    }
    return { kind: "condition", field: field as never, operator: "EQ", value: userId };
  };
}

const posts = (rows: readonly Post[]) => rows as Post[];

describe("filter.apply — is called, receives context, composes with the client's own filter", () => {
  it("is called for findMany, with no client filter", async () => {
    let seen: KavoContext<Post> | undefined;
    const { crud } = makeCrud({
      filter: {
        apply: (args: ApplyArgs<Post>) => {
          seen = args.context;
          return undefined;
        },
      },
    } as never);
    await crud.findMany(undefined, { app: { userId: "u-1" } as never });
    expect(seen).toBeDefined();
    expect(seen?.entityName).toBe("Post");
    expect(seen?.operation).toBe("findMany");
    expect(appOf(seen as KavoContext<Post>).userId).toBe("u-1");
  });

  it("AND-composes with the client's filter when both are present", async () => {
    const { crud, adapter } = makeCrud({
      filter: { apply: ownFilter("authorId") },
    } as never);
    await crud.findMany({ filter: { kind: "condition", field: "title", operator: "EQ", value: "hello" } } as never, {
      app: { userId: "u-1" } as never,
    });
    expect(adapter.lastQuery?.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "title", operator: "EQ", value: "hello" },
        { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" },
      ],
    });
  });

  it("is the whole filter when the client sends none", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    await crud.findMany(undefined, { app: { userId: "u-1" } as never });
    expect(adapter.lastQuery?.filter.root).toEqual({
      kind: "condition",
      field: "authorId",
      operator: "EQ",
      value: "u-1",
    });
  });

  it("apply: () => undefined means no additional constraint", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: () => undefined } } as never);
    await crud.findMany({ filter: { kind: "condition", field: "title", operator: "EQ", value: "a" } } as never);
    expect(adapter.lastQuery?.filter.root).toEqual({ kind: "condition", field: "title", operator: "EQ", value: "a" });

    const { crud: crud2, adapter: adapter2 } = makeCrud({ filter: { apply: () => undefined } } as never);
    await crud2.findMany(undefined);
    expect(adapter2.lastQuery?.filter.root).toBeNull();
  });

  it("different context values produce different filters", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    await crud.findMany(undefined, { app: { userId: "u-1" } as never });
    expect(adapter.lastQuery?.filter.root).toMatchObject({ value: "u-1" });
    await crud.findMany(undefined, { app: { userId: "u-2" } as never });
    expect(adapter.lastQuery?.filter.root).toMatchObject({ value: "u-2" });
  });

  it("throwing inside apply surfaces through the ordinary error pipeline rather than being swallowed", async () => {
    const { crud } = makeCrud({
      filter: {
        apply: () => {
          throw new Error("boom");
        },
      },
    } as never);
    // The engine's error handler wraps any unrecognized thrown error the
    // same generic way regardless of which stage threw it (`KAVO_PERSISTENCE_FAILED`,
    // `default-error-handler.ts`) — the point under test is that `apply`
    // throwing is not caught and discarded anywhere in between, which the
    // original error surviving as `cause` proves.
    await expect(crud.findMany(undefined)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "boom" }),
    });
  });
});

describe("filter.apply — a client filter cannot bypass it", () => {
  it("narrows further inside the AND rather than overriding the server value", async () => {
    const { crud, adapter } = makeCrud({
      filter: {
        fields: ["authorId", "title"],
        apply: ownFilter("authorId"),
      },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "mine", authorId: "u-1" as never, author: null, comments: [], deletedAt: null }]),
    );
    adapter.rows.push(
      ...posts([{ id: 2, title: "theirs", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );

    // Client tries to see u-2's rows while authenticated as u-1.
    const result = await crud.findMany(
      { filter: { kind: "condition", field: "authorId", operator: "EQ", value: "u-2" } } as never,
      { app: { userId: "u-1" } as never },
    );
    expect(result.items).toHaveLength(0);

    // The client's own rows are still reachable.
    const own = await crud.findMany(undefined, { app: { userId: "u-1" } as never });
    expect(own.items).toHaveLength(1);
    expect((own.items[0] as Post).id).toBe(1);
  });
});

describe("filter.apply — findOne is scoped the same way", () => {
  it("returns 404 for a row outside the constraint, not the row itself", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "theirs", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );
    await expect(crud.findOne(1, undefined, { app: { userId: "u-1" } as never })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("finds the row when it is in scope", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "mine", authorId: "u-1" as never, author: null, comments: [], deletedAt: null }]),
    );
    const item = (await crud.findOne(1, undefined, { app: { userId: "u-1" } as never })) as unknown as Post;
    expect(item.id).toBe(1);
  });
});

describe("filter.apply — enforced on single-row writes by id (ADR-0048)", () => {
  it("updateOne on an out-of-scope row answers 404, not a successful write", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "theirs", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );
    await expect(
      crud.updateOne(1, { title: "hijacked" } as never, { app: { userId: "u-1" } as never }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.rows[0]?.title).toBe("theirs");
  });

  it("updateOne on an in-scope row succeeds", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "mine", authorId: "u-1" as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.updateOne(1, { title: "edited" } as never, { app: { userId: "u-1" } as never });
    expect(adapter.rows[0]?.title).toBe("edited");
  });

  it("deleteOne on an out-of-scope row answers 404, not a successful delete", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "theirs", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );
    await expect(crud.deleteOne(1, { app: { userId: "u-1" } as never })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteOne on an in-scope row succeeds", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "mine", authorId: "u-1" as never, author: null, comments: [], deletedAt: null }]),
    );
    await expect(crud.deleteOne(1, { app: { userId: "u-1" } as never })).resolves.toBeUndefined();
  });

  it("apply returning undefined on a write leaves the id lookup unconstrained", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "anyone's", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );
    // No `context.app.userId` — `ownFilter` returns `undefined`, so `apply` contributes no constraint this time.
    await crud.updateOne(1, { title: "edited" } as never);
    expect(adapter.rows[0]?.title).toBe("edited");
  });
});

describe("filter.apply — scopes count/total the same way it scopes items (findMany's shared filter)", () => {
  it("total reflects only in-scope rows", async () => {
    const { crud, adapter } = makeCrud({ filter: { apply: ownFilter("authorId") } } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "mine", authorId: "u-1" as never, author: null, comments: [], deletedAt: null }]),
    );
    adapter.rows.push(
      ...posts([{ id: 2, title: "theirs", authorId: "u-2" as never, author: null, comments: [], deletedAt: null }]),
    );
    const result = await crud.findMany(undefined, { app: { userId: "u-1" } as never });
    expect(result.total).toBe(1);
  });
});

describe("sort.apply — forced sort keys are prepended, never replaced by the client's own", () => {
  it("prepends ahead of an explicit client sort", async () => {
    const { crud, adapter } = makeCrud({
      sort: { fields: ["title"], apply: () => [{ field: "id", direction: "asc" }] },
    } as never);
    await crud.findMany({ sort: [{ field: "title", direction: "desc" }] } as never);
    expect(adapter.lastQuery?.sort).toEqual([
      { field: "id", direction: "asc" },
      { field: "title", direction: "desc" },
    ]);
  });

  it("prepends ahead of sort.default when the client sends none", async () => {
    const { crud, adapter } = makeCrud({
      sort: { fields: ["title"], default: ["title"], apply: () => [{ field: "id", direction: "asc" }] },
    } as never);
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.sort).toEqual([
      { field: "id", direction: "asc" },
      { field: "title", direction: "asc" },
    ]);
  });
});

describe("select.apply — forced fields are unioned into the projection, never a mask", () => {
  it("adds a field the client didn't ask for", async () => {
    const { crud, adapter } = makeCrud({
      select: { fields: ["id", "title", "authorId"], apply: () => ["authorId"] },
    } as never);
    await crud.findMany({ select: ["title"] } as never);
    expect(adapter.lastQuery?.select.root).toEqual(expect.arrayContaining(["title", "authorId"]));
  });

  it("is a no-op against an unrestricted (null) projection", async () => {
    const { crud, adapter } = makeCrud({ select: { apply: () => ["authorId"] } } as never);
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.select.root).toBeNull();
  });
});

describe("include.apply — forced relation paths are unioned before resolution", () => {
  it("force-includes a relation the client didn't ask for", async () => {
    const { crud, adapter } = makeCrud({
      include: { fields: ["author", "comments"], apply: () => ["comments"] },
    } as never);
    await crud.findMany(undefined);
    expect(Object.keys(adapter.lastQuery?.include ?? {})).toEqual(["comments"]);
  });

  it("unions with a client-requested path rather than replacing it", async () => {
    const { crud, adapter } = makeCrud({
      include: { fields: ["author", "comments"], apply: () => ["comments"] },
    } as never);
    await crud.findMany({ include: ["author"] } as never);
    expect(Object.keys(adapter.lastQuery?.include ?? {}).sort()).toEqual(["author", "comments"]);
  });
});

describe("apply — existing default/backward-compatible behavior is unchanged", () => {
  it("sort.default still applies on its own with no apply configured", async () => {
    const { crud, adapter } = makeCrud({ sort: { fields: ["title"], default: ["title"] } } as never);
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.sort).toEqual([{ field: "title", direction: "asc" }]);
  });

  it("an entity configuring none of the four apply hooks behaves exactly as before", async () => {
    const { crud, adapter } = makeCrud();
    adapter.rows.push(
      ...posts([{ id: 1, title: "a", authorId: 1 as never, author: null, comments: [], deletedAt: null }]),
    );
    const result = await crud.findMany(undefined);
    expect(result.items).toHaveLength(1);
    await crud.updateOne(1, { title: "b" } as never);
    expect(adapter.rows[0]?.title).toBe("b");
  });
});

describe("apply — bootstrap validation", () => {
  it("rejects a non-function apply", () => {
    expect(() => makeCrud({ filter: { apply: "nope" } } as never)).toThrow(/filter\.apply/);
  });
});

describe("QueryNormalizer — composing a resolved apply result directly (both entry points)", () => {
  const config = resolveEntityConfig(
    postMetadata,
    {
      filter: { fields: ["title", "authorId"] },
      sort: { fields: ["title"] },
      select: { fields: ["title", "authorId"] },
    },
    undefined,
  );
  const normalizer = new QueryNormalizer<Post>(postMetadata);

  const serverApply = {
    filter: { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" } as FilterExpression<Post>,
    sort: [{ field: "id", direction: "asc" }] as const,
    select: ["authorId"] as const,
  };

  it("normalizeWire (the HTTP/wire entry point) composes filter/sort/select the same way normalizeInput does", () => {
    const query = normalizer.normalizeWire(
      { "filter[title][eq]": "hello", sort: "-title", select: "title" },
      config,
      serverApply,
    );
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "title", operator: "EQ", value: "hello" },
        { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" },
      ],
    });
    expect(query.sort).toEqual([
      { field: "id", direction: "asc" },
      { field: "title", direction: "desc" },
    ]);
    expect(query.select.root).toEqual(expect.arrayContaining(["title", "authorId"]));
  });

  it("normalizeWire with no client query still gets the server constraint alone", () => {
    const query = normalizer.normalizeWire({}, config, serverApply);
    expect(query.filter.root).toEqual({ kind: "condition", field: "authorId", operator: "EQ", value: "u-1" });
  });

  it("normalizeInput (the programmatic entry point) composes the same way", () => {
    const query = normalizer.normalizeInput(
      {
        filter: { kind: "condition", field: "title", operator: "EQ", value: "hello" },
        sort: [{ field: "title", direction: "desc" }],
      },
      config,
      serverApply,
    );
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "title", operator: "EQ", value: "hello" },
        { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" },
      ],
    });
    expect(query.sort).toEqual([
      { field: "id", direction: "asc" },
      { field: "title", direction: "desc" },
    ]);
  });

  it("normalizeInput with no serverApply argument at all behaves exactly as before (backward compatible)", () => {
    const query = normalizer.normalizeInput(undefined, config);
    expect(query.filter.root).toBeNull();
  });
});

describe("create.apply/update.apply — force write-body values the client cannot override (issue #391)", () => {
  it("createOne: forces a value the client never sent", async () => {
    const { crud, adapter } = makeCrud({
      create: { apply: () => ({ authorId: 7 }) },
    } as never);
    await crud.createOne({ title: "hello" } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "hello", authorId: 7 });
  });

  it("createOne: overwrites a value the client did send", async () => {
    const { crud, adapter } = makeCrud({
      create: { apply: () => ({ authorId: 7 }) },
    } as never);
    await crud.createOne({ title: "hello", authorId: 999 } as never);
    expect(adapter.rows[0]).toMatchObject({ authorId: 7 });
  });

  it("createOne: receives the same ApplyArgs shape filter.apply gets, with a null id", async () => {
    let seen: ApplyArgs<Post> | undefined;
    const { crud } = makeCrud({
      create: {
        apply: (args: ApplyArgs<Post>) => {
          seen = args;
          return undefined;
        },
      },
    } as never);
    await crud.createOne({ title: "hello" } as never, { app: { userId: "u-1" } as never });
    expect(seen?.resource).toBe("Post");
    expect(seen?.operation).toBe("createOne");
    expect(seen?.params.id).toBeNull();
    expect(appOf(seen?.context as KavoContext<Post>).userId).toBe("u-1");
  });

  it("updateOne: forces a value the client never sent, alongside the fields it did", async () => {
    const { crud, adapter } = makeCrud({
      update: { apply: () => ({ authorId: 7 }) },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "old", authorId: 1 as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.updateOne(1, { title: "new" } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "new", authorId: 7 });
  });

  it("updateOne: overwrites a value the client did send", async () => {
    const { crud, adapter } = makeCrud({
      update: { apply: () => ({ authorId: 7 }) },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "old", authorId: 1 as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.updateOne(1, { title: "new", authorId: 999 } as never);
    expect(adapter.rows[0]).toMatchObject({ authorId: 7 });
  });

  it("updateOne: receives the coerced id in params, unlike createOne", async () => {
    let seen: ApplyArgs<Post> | undefined;
    const { crud, adapter } = makeCrud({
      update: {
        apply: (args: ApplyArgs<Post>) => {
          seen = args;
          return undefined;
        },
      },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "old", authorId: 1 as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.updateOne(1, { title: "new" } as never);
    expect(seen?.params.id).toBe(1);
  });

  it("patchOne never consults update.apply, matching update.default's own scope", async () => {
    const { crud, adapter } = makeCrud({
      update: { apply: () => ({ authorId: 7 }) },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "old", authorId: 1 as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.patchOne(1, { title: "new" } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "new", authorId: 1 });
  });

  it("create.apply is never consulted on updateOne, and update.apply never on createOne", async () => {
    const { crud, adapter } = makeCrud({
      create: { apply: () => ({ authorId: 1 }) },
      update: { apply: () => ({ authorId: 2 }) },
    } as never);
    adapter.rows.push(
      ...posts([{ id: 1, title: "old", authorId: 9 as never, author: null, comments: [], deletedAt: null }]),
    );
    await crud.updateOne(1, { title: "new" } as never);
    expect(adapter.rows[0]).toMatchObject({ authorId: 2 });
    await crud.createOne({ title: "another" } as never);
    expect(adapter.rows[1]).toMatchObject({ authorId: 1 });
  });

  it("a key apply returns undefined for is left alone rather than reset", async () => {
    const { crud, adapter } = makeCrud({
      create: { apply: () => undefined },
    } as never);
    await crud.createOne({ title: "hello", authorId: 3 } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "hello", authorId: 3 });
  });

  it("apply wins over default when both configure the same field", async () => {
    const { crud, adapter } = makeCrud({
      create: { default: { authorId: 1 }, apply: () => ({ authorId: 2 }) },
    } as never);
    await crud.createOne({ title: "hello" } as never);
    expect(adapter.rows[0]).toMatchObject({ authorId: 2 });
  });

  it("an unconfigured apply changes nothing (backward compatible)", async () => {
    const { crud, adapter } = makeCrud();
    await crud.createOne({ title: "hello", authorId: 5 } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "hello", authorId: 5 });
  });

  it("still forces a value for a field create.fields's { exclude } removed from the body allowlist (issue #397)", async () => {
    // The "clients can't set it, the server does" idiom: `apply` runs after
    // deserialization (kavo-engine's `applyWriteApply`), so it reaches the
    // adapter even though `authorId` is stripped from the client body.
    const { crud, adapter } = makeCrud({
      create: { fields: { exclude: ["authorId"] }, apply: () => ({ authorId: 7 }) },
    } as never);
    await crud.createOne({ title: "hello", authorId: 999 } as never);
    expect(adapter.rows[0]).toMatchObject({ title: "hello", authorId: 7 });
  });

  it("does NOT fill a field create.fields's { exclude } removed via create.default — apply is the tool for that", async () => {
    // `default` is applied inside the deserializer's loop over the writable
    // allowlist, so a field the allowlist no longer contains is never
    // filled. Pre-existing for the plain array form; `{ exclude }` just
    // makes it easy to reach. Documented in docs/features/allowed.md.
    const { crud, adapter } = makeCrud({
      create: { fields: { exclude: ["authorId"] }, default: { authorId: 7 } },
    } as never);
    await crud.createOne({ title: "hello" } as never);
    expect(adapter.rows[0]).not.toHaveProperty("authorId");
  });
});

describe("create.apply/update.apply — bootstrap validation", () => {
  it("rejects a non-function create.apply", () => {
    expect(() => makeCrud({ create: { apply: "nope" } } as never)).toThrow(/create\.apply/);
  });

  it("rejects a non-function update.apply", () => {
    expect(() => makeCrud({ update: { apply: "nope" } } as never)).toThrow(/update\.apply/);
  });
});
