import { describe, expect, it } from "vitest";
import { builtInHandlers, ConfigurationException, createKavo, withListMeta } from "@kavo/core";
import { crudTools } from "@kavo/mcp";
import {
  InMemoryNoteAdapter,
  InMemoryTodoAdapter,
  Note,
  noteMetadata,
  Todo,
  todoMetadata,
} from "./support/todo-fixture.js";

/**
 * Proves the binding end to end: a toolset built by `crudTools` calls
 * straight into the same `createCrud` service REST would bind to — no
 * parallel pipeline, no database, just the in-memory adapter core's own
 * tests use. There is no per-entity config: every entity gets the full
 * standard toolset unconditionally.
 */
describe("crudTools", () => {
  function setup() {
    const adapter = new InMemoryTodoAdapter();
    const service = createKavo().createCrud(Todo, undefined, { adapter, metadata: todoMetadata });
    const bindings = crudTools({ name: "Todo", service });
    return { adapter, bindings };
  }

  function find(bindings: ReturnType<typeof setup>["bindings"], name: string) {
    const binding = bindings.find((candidate) => candidate.tool.name === name);
    if (binding === undefined) {
      throw new Error(`no tool named ${name}`);
    }
    return binding;
  }

  it("produces the full standard toolset unconditionally, no per-entity config", () => {
    const { bindings } = setup();
    expect(bindings.map((binding) => binding.tool.name).sort()).toEqual(
      [
        "todo.createOne",
        "todo.deleteOne",
        "todo.findMany",
        "todo.findOne",
        "todo.patchOne",
        "todo.purgeOne",
        "todo.restoreOne",
        "todo.updateOne",
      ].sort(),
    );
  });

  it("runs createOne then findOne through the same engine, returning JSON text content", async () => {
    const { bindings } = setup();

    const created = await find(bindings, "todo.createOne").handler({ title: "write tests", done: false });
    expect(created.isError).toBeUndefined();
    expect(JSON.parse((created.content[0] as { text: string }).text)).toEqual({
      id: 1,
      title: "write tests",
      done: false,
    });

    const fetched = await find(bindings, "todo.findOne").handler({ id: 1 });
    expect(JSON.parse((fetched.content[0] as { text: string }).text)).toMatchObject({ id: 1, title: "write tests" });
  });

  it("runs findMany with pagination, sort, and filter forwarded to the normalized query", async () => {
    const { adapter, bindings } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true });

    const result = await find(bindings, "todo.findMany").handler({
      limit: 1,
      offset: 1,
      sort: ["-title"],
      filter: { kind: "condition", field: "done", operator: "EQ", value: true },
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.items).toEqual([{ id: 2, title: "b", done: true }]);
    expect(adapter.lastQuery?.sort).toEqual([{ field: "title", direction: "desc" }]);
    expect(adapter.lastQuery?.filter.root).toEqual({ kind: "condition", field: "done", operator: "EQ", value: true });
  });

  it("reads an unprefixed sort token as ascending, alongside a '-' descending one", async () => {
    // The `-` prefix is the only descending spelling, so the absence of one
    // is what carries "ascending". Testing only `-title` leaves the default
    // direction free to flip unnoticed.
    const { adapter, bindings } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false });

    await find(bindings, "todo.findMany").handler({ sort: ["-title", "done"] });

    expect(adapter.lastQuery?.sort).toEqual([
      { field: "title", direction: "desc" },
      { field: "done", direction: "asc" },
    ]);
  });

  it("lets a non-Kavo throw escape as a protocol error rather than a routine tool result", async () => {
    // A `KavoException` is a domain answer and becomes `isError` content a
    // model can reason about. A bug is not an answer: reframing it the same
    // way would hide a 500 behind a tidy tool response. The engine wraps
    // adapter throws into `PersistenceFailedException`, so reaching this
    // path takes a stub service rather than a real one.
    const bindings = crudTools({
      name: "Todo",
      service: {
        async findOne() {
          throw new Error("bug");
        },
      } as never,
    });

    await expect(find(bindings, "todo.findOne").handler({ id: 1 })).rejects.toThrow("bug");
  });

  it("carries the list envelope's contributed meta into the tool result unchanged", async () => {
    // Doc 16 §"A successful call returns" claims the whole envelope is
    // stringified, so whatever a `findMany` handler contributes to `meta`
    // (doc 07 §3.1) reaches an MCP client with no per-key schema work
    // here. Nothing else in this package pins that claim.
    const CONTRIBUTED = { facets: { done: { true: 1, false: 1 } }, exhausted: false, cursor: null };
    const adapter = new InMemoryTodoAdapter();
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          findMany: { handler: withListMeta<Todo>(builtInHandlers<Todo>(adapter)("findMany"), () => CONTRIBUTED) },
        },
      } as never,
      { adapter, metadata: todoMetadata },
    );
    adapter.rows.push({ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true });

    const result = await find(crudTools({ name: "Todo", service }), "todo.findMany").handler({});

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.meta).toEqual(CONTRIBUTED);
    expect(payload.items).toHaveLength(2);
    expect(payload.total).toBe(2);
  });

  it("runs update, patch, and delete through the same engine", async () => {
    const { adapter, bindings } = setup();
    adapter.rows.push({ id: 1, title: "before", done: false });

    const updated = await find(bindings, "todo.updateOne").handler({ id: 1, title: "after", done: true });
    expect(JSON.parse((updated.content[0] as { text: string }).text)).toMatchObject({ title: "after", done: true });

    const patched = await find(bindings, "todo.patchOne").handler({ id: 1, done: false });
    expect(JSON.parse((patched.content[0] as { text: string }).text)).toMatchObject({ done: false });

    const deleted = await find(bindings, "todo.deleteOne").handler({ id: 1 });
    expect(JSON.parse((deleted.content[0] as { text: string }).text)).toEqual({ deleted: true });
    expect(adapter.rows).toHaveLength(0);
  });

  it("maps a KavoException (not found) to an isError tool result instead of throwing", async () => {
    const { bindings } = setup();

    const result = await find(bindings, "todo.findOne").handler({ id: 999 });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("KAVO_NOT_FOUND");
  });

  it("maps restore/purge on a non-soft-deletable entity to an isError result (still produced unconditionally)", async () => {
    const { adapter, bindings } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false });

    const restored = await find(bindings, "todo.restoreOne").handler({ id: 1 });
    expect(restored.isError).toBe(true);
  });

  it("resolves restore/purge tools against a soft-deletable entity", async () => {
    const adapter = new InMemoryNoteAdapter();
    const service = createKavo().createCrud(
      Note,
      {
        softDelete: { strategy: "soft" },
        operations: { createOne: true, deleteOne: true, restoreOne: true, purgeOne: true },
      },
      { adapter, metadata: noteMetadata },
    );
    const created = await service.createOne({ text: "keep me" } as never);
    await service.deleteOne(created.id as never);

    const bindings = crudTools({ name: "Note", service });

    const restored = await find(bindings, "note.restoreOne").handler({ id: created.id });
    expect(JSON.parse((restored.content[0] as { text: string }).text)).toMatchObject({
      id: created.id,
      text: "keep me",
    });

    const purged = await find(bindings, "note.purgeOne").handler({ id: created.id });
    expect(JSON.parse((purged.content[0] as { text: string }).text)).toEqual({ purged: true });
    expect(adapter.rows).toHaveLength(0);
  });
});

describe("cursor-paginated entities are refused at bootstrap", () => {
  /** `<entity>.findMany` exposes `limit`/`offset` only, and a keyset ignores `offset` (ADR-0021 §7). */
  function cursorTodoService() {
    return createKavo({
      defaults: {
        pagination: { strategy: "cursor" },
        query: { defaultSort: [{ field: "id", direction: "asc" }] },
      },
    } as never).createCrud(Todo, undefined, { adapter: new InMemoryTodoAdapter(), metadata: todoMetadata });
  }

  it("throws rather than silently answering a paged findMany with page one", () => {
    expect(() => crudTools({ name: "Todo", service: cursorTodoService() })).toThrow(ConfigurationException);
  });

  it("names the entity, the config key, and the way out", () => {
    expect(() => crudTools({ name: "Todo", service: cursorTodoService() })).toThrow(/pagination\.strategy/);
    expect(() => crudTools({ name: "Todo", service: cursorTodoService() })).toThrow(/'offset'\/'page'/);
  });

  it("still binds an offset-paginated entity", () => {
    const service = createKavo().createCrud(Todo, undefined, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });
    expect(() => crudTools({ name: "Todo", service })).not.toThrow();
  });
});

/**
 * `pagination.strategy: "none"` (ADR-0030) is not `"cursor"`/`"since"`, so
 * `requireOffsetPageable` lets it through at bootstrap here too — same
 * treatment `@kavo/graphql` gets (`graphql-schema.spec.ts`'s equivalent
 * describe block). `<entity>.findMany`'s tool schema declares `limit`/
 * `offset` as plain optional integers (`tools.ts`), so a model that never
 * names either in its arguments gets `args["limit"]`/`args["offset"]` as
 * `undefined` — the same "caller didn't ask" signal `normalizeInput`
 * already treats as absent — proven here rather than inferred.
 */
describe("pagination.strategy: 'none' entities (ADR-0030, issue #225)", () => {
  function unpaginatedTodoService(adapter: InMemoryTodoAdapter) {
    return createKavo({ defaults: { pagination: { strategy: "none" } } } as never).createCrud(Todo, undefined, {
      adapter,
      metadata: todoMetadata,
    });
  }

  it("binds without a bootstrap refusal, unlike cursor/since", () => {
    expect(() => crudTools({ name: "Todo", service: unpaginatedTodoService(new InMemoryTodoAdapter()) })).not.toThrow();
  });

  it("serves the whole match set when the call omits limit/offset entirely", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push(
      { id: 1, title: "a", done: false },
      { id: 2, title: "b", done: false },
      { id: 3, title: "c", done: false },
      { id: 4, title: "d", done: false },
      { id: 5, title: "e", done: false },
    );
    const bindings = crudTools({ name: "Todo", service: unpaginatedTodoService(adapter) });
    const binding = bindings.find((candidate) => candidate.tool.name === "todo.findMany");
    if (binding === undefined) {
      throw new Error("no tool named todo.findMany");
    }

    const result = await binding.handler({});

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.items).toHaveLength(5);
    expect(payload.total).toBe(5);
    expect(payload.limit).toBe(2147483647);
    expect(payload.offset).toBe(0);
  });

  it("rejects an explicit limit/offset the same way REST does, rather than truncating silently", async () => {
    const bindings = crudTools({ name: "Todo", service: unpaginatedTodoService(new InMemoryTodoAdapter()) });
    const binding = bindings.find((candidate) => candidate.tool.name === "todo.findMany");
    if (binding === undefined) {
      throw new Error("no tool named todo.findMany");
    }

    const result = await binding.handler({ limit: 5 });

    // Same limitation the GraphQL binding has: `KavoException.detail` is the
    // catalog's generic `KAVO_QUERY_INVALID` summary, not the field-level
    // "pagination.strategy is 'none'" detail on `.issues` — provable here is
    // that the call errors at all, not that it silently paginates anyway.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe("KAVO_QUERY_INVALID: The request query is invalid.");
  });
});
