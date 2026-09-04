import { describe, expect, it } from "vitest";
import type { FindManyResult, KavoContext, ListMetaDto, OperationHandler } from "@kavo/core";
import { ConfigurationException, builtInHandlers, createKavo, withListMeta } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";

/**
 * `ListResultDto.meta` — the list envelope's open metadata bag (issue
 * #122). Not `OperationConfig.meta`/`OperationMetadata` (ADR-0007), which
 * is route metadata on a registry entry and never reaches a response.
 *
 * The seam is deliberately plain: the `findMany` handler returns `meta`
 * alongside `entities`/`total`, and the engine merges it into the envelope
 * instead of discarding it. No new config key — `operations.findMany.handler`
 * already exists (ADR-0006), so this suite drives the real registry
 * override path rather than reaching into the engine.
 */

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new InMemoryUserAdapter();
  const crud = createKavo().createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

/** A `findMany` handler that ignores the adapter and answers verbatim. */
function fixedHandler(result: FindManyResult<User>): OperationHandler<User, unknown, FindManyResult<User>> {
  return {
    async execute() {
      return result;
    },
  };
}

/** Config that swaps in `handler` for `findMany`, plus createOne for fixture setup. */
function findManyHandler(handler: OperationHandler<User, unknown, unknown>) {
  return { operations: { createOne: true, findMany: { enabled: true, handler } } } as never;
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36 };

describe("ListResultDto.meta — the handler's contribution reaches the envelope", () => {
  it("is absent altogether when the built-in handler contributes nothing", async () => {
    const { crud } = makeCrud();
    await crud.createOne(ADA as never);

    const list = await crud.findMany();
    expect(list.meta).toBeUndefined();
    // Absent, not `undefined`-valued: a key carrying `undefined` still shows
    // up in `Object.keys`/`in` for a programmatic caller even though
    // `JSON.stringify` drops it, so the two views would disagree.
    expect("meta" in list).toBe(false);
    expect(Object.keys(list)).not.toContain("meta");
  });

  it("carries a handler's meta onto the envelope", async () => {
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: { generatedIn: "3ms" } })));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ generatedIn: "3ms" });
  });

  it("reaches the envelope verbatim for arbitrary JSON-serializable shapes", async () => {
    // `meta` is the caller's own data, not entity data: it never passes
    // through the serializer, so nothing narrows, reorders, or coerces it.
    const bag: ListMetaDto = {
      facets: { status: { active: 2, banned: 1 } },
      appliedFilters: ["status", "age"],
      cursor: null,
      exhausted: false,
      queriedAt: 1700000000000,
    };
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: bag })));

    const list = await crud.findMany();
    expect(list.meta).toEqual(bag);
  });

  it("leaves meta whole when field selection narrows the items", async () => {
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: { keep: { me: true } } })));

    const list = await crud.findMany({ select: { root: ["id"] } } as never);
    expect(list.meta).toEqual({ keep: { me: true } });
  });

  it("stays absent when a custom handler omits meta entirely", async () => {
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 7 })));

    const list = await crud.findMany();
    expect("meta" in list).toBe(false);
    expect(list.total).toBe(7);
  });

  it("drops an empty bag a handler returns explicitly", async () => {
    // Emptiness is judged on the merged result, not on whether the handler
    // named the key: `meta: {}` says exactly as little as no `meta` at all,
    // so both leave the same envelope.
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: {} })));

    const list = await crud.findMany();
    expect("meta" in list).toBe(false);
  });

  it("drops keys whose value is undefined, and the bag with them", async () => {
    // `JSON.stringify` erases an `undefined` value, so counting such a key
    // as a contribution would ship `"meta": {}` to a REST client while a
    // programmatic caller saw `{ nextCursor: undefined }` — the two-views
    // divergence omitting the key exists to prevent. A cursor contributor
    // on a last page is exactly this shape.
    const { crud } = makeCrud(
      findManyHandler(fixedHandler({ entities: [], total: 0, meta: { nextCursor: undefined } })),
    );

    const list = await crud.findMany();
    expect("meta" in list).toBe(false);
  });

  it("keeps the bag but not the undefined key when something else contributed", async () => {
    const { crud } = makeCrud(
      findManyHandler(fixedHandler({ entities: [], total: 0, meta: { exhausted: true, nextCursor: undefined } })),
    );

    const list = await crud.findMany();
    expect(list.meta).toEqual({ exhausted: true });
    expect("nextCursor" in (list.meta as object)).toBe(false);
  });

  it("drops the bag when every contributor in a wrap chain adds nothing", async () => {
    const { crud } = makeCrud(
      findManyHandler(withListMeta<User>(fixedHandler({ entities: [], total: 0, meta: {} }), () => ({}))),
    );

    const list = await crud.findMany();
    expect("meta" in list).toBe(false);
  });

  it("coexists with a null total when counting is disabled", async () => {
    // Every other meta case runs with counting on; `total: null` and a
    // populated bag are independent envelope fields and have to co-occur.
    const adapter = new InMemoryUserAdapter();
    const crud = createKavo().createCrud(
      User,
      {
        pagination: { count: false },
        operations: {
          createOne: true,
          findMany: {
            enabled: true,
            handler: withListMeta<User>(builtInHandlers<User>(adapter)("findMany"), (result) => ({
              approximate: true,
              rows: result.entities.length,
            })),
          },
        },
      } as never,
      { adapter, metadata: userMetadata },
    );
    await crud.createOne(ADA as never);

    const list = await crud.findMany();
    expect(list.total).toBeNull();
    expect(list.meta).toEqual({ approximate: true, rows: 1 });
    expect(list.items).toHaveLength(1);
  });
});

describe("the envelope's meta is the caller's to mutate — never the handler's own object", () => {
  it("copies the handler's bag instead of handing it out by reference", async () => {
    // Unlike `items` (a fresh array of freshly serialized DTOs per
    // request), `meta` can be the very same object on every response — a
    // hand-written handler returning a module-scope constant is the
    // documented alternative to `withListMeta`.
    const shared: ListMetaDto = { generatedIn: "3ms" };
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: shared })));

    const list = await crud.findMany();
    expect(list.meta).toEqual(shared);
    expect(list.meta).not.toBe(shared);
  });

  it("keeps a later response's bag pristine after an earlier one is mutated", async () => {
    const shared: ListMetaDto = { generatedIn: "3ms" };
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: shared })));

    const first = await crud.findMany();
    (first.meta as Record<string, unknown>).generatedIn = "tampered";

    const second = await crud.findMany();
    expect(second.meta).toEqual({ generatedIn: "3ms" });
    expect(shared).toEqual({ generatedIn: "3ms" });
  });
});

describe("the envelope's total is always present, even when the handler omits it", () => {
  it("normalizes a missing total to null rather than dropping the key", async () => {
    // `ListResultDto.total` is `number | null` and required. Left
    // `undefined`, `JSON.stringify` would drop the key outright and ship a
    // list body with no `total` at all. This is the unwrapped custom
    // handler path — `withListMeta` rejects the same shape up front.
    const noTotal = {
      async execute() {
        return { entities: [] };
      },
    };
    const { crud } = makeCrud(findManyHandler(noTotal));

    const list = await crud.findMany();
    expect(list.total).toBeNull();
    expect("total" in list).toBe(true);
    expect(JSON.parse(JSON.stringify(list))).toMatchObject({ total: null });
  });
});

describe("the JSON body carries meta only when there is something to carry", () => {
  // The two envelope fields pull in opposite directions on purpose, and the
  // difference is only visible after `JSON.stringify` — which is what a REST
  // or MCP client actually sees.
  it("omits the key from the serialized envelope when nothing contributed", async () => {
    const { crud } = makeCrud();
    await crud.createOne(ADA as never);

    const body = JSON.parse(JSON.stringify(await crud.findMany())) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["items", "limit", "offset", "total"]);
    expect(body["total"]).toBe(1);
  });

  it("carries the key through the round trip when a handler contributed", async () => {
    const { crud } = makeCrud(findManyHandler(fixedHandler({ entities: [], total: 0, meta: { generatedIn: "3ms" } })));

    const body = JSON.parse(JSON.stringify(await crud.findMany())) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["items", "limit", "offset", "total", "meta"]);
    expect(body["meta"]).toEqual({ generatedIn: "3ms" });
  });
});

describe("withListMeta — wrapping a findMany handler to add envelope metadata", () => {
  /** Wraps the built-in `findMany`, the documented main path. */
  function wrapBuiltIn(
    compute: (result: FindManyResult<User>, context: KavoContext<User>) => ListMetaDto | Promise<ListMetaDto>,
  ) {
    const adapter = new InMemoryUserAdapter();
    const crud = createKavo().createCrud(
      User,
      findManyHandler(withListMeta<User>(builtInHandlers<User>(adapter)("findMany"), compute)),
      { adapter, metadata: userMetadata },
    );
    return { crud, adapter };
  }

  it("adds the contributor's keys without disturbing entities or total", async () => {
    const { crud } = wrapBuiltIn((result) => ({ oldest: Math.max(...result.entities.map((user) => user.age)) }));
    await crud.createOne(ADA as never);
    await crud.createOne({ name: "Grace", email: "grace@example.com", age: 45 } as never);

    const list = await crud.findMany();
    expect(list.items).toHaveLength(2);
    expect(list.total).toBe(2);
    expect(list.meta).toEqual({ oldest: 45 });
  });

  it("hands the contributor the real result and request context", async () => {
    let seen: { entityName: string; operation: string; total: number | null; rows: number } | null = null;
    const { crud } = wrapBuiltIn((result, context) => {
      seen = {
        entityName: context.entityName,
        operation: context.operation,
        total: result.total,
        rows: result.entities.length,
      };
      return {};
    });
    await crud.createOne(ADA as never);

    await crud.findMany();
    expect(seen).toEqual({ entityName: "User", operation: "findMany", total: 1, rows: 1 });
  });

  it("awaits an async contributor", async () => {
    const { crud } = wrapBuiltIn(async () => Promise.resolve({ computed: "async" }));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ computed: "async" });
  });

  it("keeps the inner handler's meta keys the contributor does not name", async () => {
    const inner = fixedHandler({ entities: [], total: 0, meta: { fromInner: 1, shared: "inner" } });
    const { crud } = makeCrud(findManyHandler(withListMeta<User>(inner, () => ({ fromOuter: 2 }))));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ fromInner: 1, shared: "inner", fromOuter: 2 });
  });

  it("gives the contributor precedence on a key both set", async () => {
    // Documented precedence: the outer, more specific decoration wins —
    // the same direction as global → entity → operation → per-call.
    const inner = fixedHandler({ entities: [], total: 0, meta: { shared: "inner" } });
    const { crud } = makeCrud(findManyHandler(withListMeta<User>(inner, () => ({ shared: "outer" }))));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ shared: "outer" });
  });

  it("lets a contributor opt out of that precedence by spreading the inner bag last", async () => {
    const inner = fixedHandler({ entities: [], total: 0, meta: { shared: "inner" } });
    const { crud } = makeCrud(
      findManyHandler(withListMeta<User>(inner, (result) => ({ shared: "outer", ...result.meta }))),
    );

    const list = await crud.findMany();
    expect(list.meta).toEqual({ shared: "inner" });
  });

  it("layers nested wraps so the outermost owns a contested key", async () => {
    const inner = fixedHandler({ entities: [], total: 0, meta: { layer: "handler" } });
    const wrapped = withListMeta<User>(
      withListMeta<User>(inner, () => ({ layer: "middle", middleOnly: true })),
      () => ({ layer: "outer" }),
    );
    const { crud } = makeCrud(findManyHandler(wrapped));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ layer: "outer", middleOnly: true });
  });

  it("leaves the inner bag untouched when the contributor returns nothing to add", async () => {
    const inner = fixedHandler({ entities: [], total: 0, meta: { fromInner: true } });
    const { crud } = makeCrud(findManyHandler(withListMeta<User>(inner, () => ({}))));

    const list = await crud.findMany();
    expect(list.meta).toEqual({ fromInner: true });
  });

  it("rejects a wrapped handler that is not findMany-shaped", async () => {
    // The parameter is typed as `OperationHandler<Entity>` so the wrap
    // composes with `builtInHandlers(...)` and `OperationConfig.handler`
    // without a cast — which erases the output type, so a wrong-shaped
    // inner handler has to be caught here rather than assembling a broken
    // envelope.
    const notAList = {
      async execute() {
        return Object.assign(new User(), { id: 1 });
      },
    };
    const { crud } = makeCrud(findManyHandler(withListMeta<User>(notAList, () => ({ never: "reached" }))));

    await expect(crud.findMany()).rejects.toBeInstanceOf(ConfigurationException);
    await expect(crud.findMany()).rejects.toMatchObject({
      code: "KAVO_CONFIG_INVALID",
      context: { entityName: "User" },
    });
    await expect(crud.findMany()).rejects.toThrow("operations.findMany.handler");
  });

  // The message has to name *what* came back, or the adopter is left
  // guessing which of their handlers is wrong. One case per branch of the
  // shape description, so none of them can quietly stop being reached.
  it.each([
    { label: "null", returned: null, fragment: "returned null" },
    { label: "an array", returned: [] as unknown, fragment: "returned an array" },
    { label: "a primitive", returned: "nope" as unknown, fragment: "returned string" },
    { label: "a bare object", returned: {} as unknown, fragment: "returned an object with no 'entities' array" },
    {
      label: "an entities array with no total",
      returned: { entities: [] } as unknown,
      fragment: "returned an object whose 'total' is neither a number nor null",
    },
    {
      label: "an entities array with a non-numeric total",
      returned: { entities: [], total: "7" } as unknown,
      fragment: "returned an object whose 'total' is neither a number nor null",
    },
  ])("names what the wrapped handler returned instead — $label", async ({ returned, fragment }) => {
    const wrong = {
      async execute() {
        return returned;
      },
    };
    const { crud } = makeCrud(findManyHandler(withListMeta<User>(wrong, () => ({ never: "reached" }))));

    await expect(crud.findMany()).rejects.toMatchObject({ code: "KAVO_CONFIG_INVALID" });
    await expect(crud.findMany()).rejects.toThrow(fragment);
  });

  it("never runs the contributor when the wrapped handler is wrong-shaped", async () => {
    let ran = false;
    const notAList = {
      async execute() {
        return null;
      },
    };
    const { crud } = makeCrud(
      findManyHandler(
        withListMeta<User>(notAList, () => {
          ran = true;
          return {};
        }),
      ),
    );

    await expect(crud.findMany()).rejects.toBeInstanceOf(ConfigurationException);
    expect(ran).toBe(false);
  });
});

describe("withListMeta under cursor pagination — the strategy's key is the base", () => {
  /** The same wrap-the-built-in path, on a cursor-paginated entity. */
  function cursorWrapped(compute: (result: FindManyResult<User>, context: KavoContext<User>) => ListMetaDto) {
    const adapter = new InMemoryUserAdapter();
    const crud = createKavo({
      defaults: {
        pagination: { strategy: "cursor" },
        defaults: { sort: ["id"] },
      },
    } as never).createCrud(
      User,
      findManyHandler(withListMeta<User>(builtInHandlers<User>(adapter)("findMany"), compute)),
      { adapter, metadata: userMetadata },
    );
    return { crud, adapter };
  }

  it("keeps nextCursor alongside a contributor's own keys", async () => {
    const { crud } = cursorWrapped(() => ({ generatedIn: "3ms" }));
    for (const age of [1, 2, 3]) {
      await crud.createOne({ ...ADA, age } as never);
    }

    const list = await crud.findMany({ limit: 2 } as never);
    expect(list.meta).toBeDefined();
    expect(list.meta?.["generatedIn"]).toBe("3ms");
    expect(typeof list.meta?.["nextCursor"]).toBe("string");
  });

  it("lets a contributor that names nextCursor explicitly win", async () => {
    // The documented precedence at `KavoEngine.listMeta`: the strategy's key
    // is the base and the handler's merges over it, the same "more specific
    // wins" direction every other precedence chain in Kavo runs (ADR-0021).
    const { crud } = cursorWrapped(() => ({ nextCursor: "mine" }));
    for (const age of [1, 2, 3]) {
      await crud.createOne({ ...ADA, age } as never);
    }

    const list = await crud.findMany({ limit: 2 } as never);
    expect(list.meta?.["nextCursor"]).toBe("mine");
  });
});
