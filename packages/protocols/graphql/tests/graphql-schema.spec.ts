import { describe, expect, it } from "vitest";
import type { KavoContext } from "@kavo/core";
import { ConfigurationException, createKavo } from "@kavo/core";
import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  graphql,
} from "graphql";
import {
  createKavoGraphQLSchema,
  getKavoGraphQLTypes,
  mergeKavoGraphQLSchemas,
  registerKavoGraphQLTypes,
} from "@kavo/graphql";
import {
  InMemoryNoteAdapter,
  InMemoryTagAdapter,
  InMemoryTodoAdapter,
  Note,
  noteMetadata,
  Tag,
  tagMetadata,
  Todo,
  todoMetadata,
} from "./support/todo-fixture.js";

/**
 * Proves the binding end to end: a schema built by `createKavoGraphQLSchema`
 * resolves queries and mutations by calling straight into the same
 * `createCrud` service REST would bind to — no parallel pipeline, no
 * database, just the in-memory adapter core's own tests use.
 */
describe("createKavoGraphQLSchema", () => {
  const TodoType = new GraphQLObjectType({
    name: "Todo",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      done: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });

  const CreateTodoInput = new GraphQLInputObjectType({
    name: "CreateTodoInput",
    fields: {
      title: { type: new GraphQLNonNull(GraphQLString) },
      done: { type: GraphQLBoolean },
    },
  });

  function setup() {
    const adapter = new InMemoryTodoAdapter();
    const service = createKavo().createCrud(Todo, undefined, { adapter, metadata: todoMetadata });
    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service,
      itemType: TodoType,
      createInputType: CreateTodoInput,
    });
    return { adapter, schema };
  }

  it("resolves a mutation and a follow-up query through the same engine", async () => {
    const { schema } = setup();

    const created = await graphql({
      schema,
      source: `mutation { createTodo(input: { title: "write tests", done: false }) { id title done } }`,
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createTodo).toEqual({ id: 1, title: "write tests", done: false });

    const fetched = await graphql({ schema, source: `query { todo(id: 1) { id title } }` });
    expect(fetched.errors).toBeUndefined();
    expect(fetched.data?.todo).toEqual({ id: 1, title: "write tests" });
  });

  it("resolves the list query with pagination envelope fields", async () => {
    const { adapter, schema } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true });

    const result = await graphql({
      schema,
      source: `query { todos(limit: 1, offset: 1) { items { id title } total limit offset } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.todos).toEqual({
      items: [{ id: 2, title: "b" }],
      total: 2,
      limit: 1,
      offset: 1,
    });
  });

  it("merges multiple entities onto one Query/Mutation root without collisions", async () => {
    const todoAdapter = new InMemoryTodoAdapter();
    const todoService = createKavo().createCrud(Todo, undefined, { adapter: todoAdapter, metadata: todoMetadata });
    const tagAdapter = new InMemoryTagAdapter();
    const tagService = createKavo().createCrud(Tag, undefined, { adapter: tagAdapter, metadata: tagMetadata });

    const TagType = new GraphQLObjectType({
      name: "Tag",
      fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        label: { type: new GraphQLNonNull(GraphQLString) },
      },
    });
    const CreateTagInput = new GraphQLInputObjectType({
      name: "CreateTagInput",
      fields: { label: { type: new GraphQLNonNull(GraphQLString) } },
    });

    const schema = mergeKavoGraphQLSchemas([
      { name: "Todo", service: todoService, itemType: TodoType, createInputType: CreateTodoInput },
      { name: "Tag", service: tagService, itemType: TagType, createInputType: CreateTagInput },
    ]);

    const created = await graphql({
      schema,
      source: `mutation {
        createTodo(input: { title: "one endpoint", done: false }) { id title }
        createTag(input: { label: "urgent" }) { id label }
      }`,
    });
    expect(created.errors).toBeUndefined();
    expect(created.data).toEqual({
      createTodo: { id: 1, title: "one endpoint" },
      createTag: { id: 1, label: "urgent" },
    });

    const fetched = await graphql({ schema, source: `query { todo(id: 1) { title } tag(id: 1) { label } }` });
    expect(fetched.errors).toBeUndefined();
    expect(fetched.data).toEqual({ todo: { title: "one endpoint" }, tag: { label: "urgent" } });
  });

  it("omits the mutation type when no createInputType is supplied", () => {
    const service = createKavo().createCrud(Todo, undefined, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });
    const schema = createKavoGraphQLSchema({ name: "Todo", service, itemType: TodoType });
    expect(schema.getMutationType()).toBeUndefined();
  });

  it("registers and retrieves GraphQL types per entity, letting a consumer discover them by class", () => {
    expect(getKavoGraphQLTypes(Tag)).toBeUndefined();

    registerKavoGraphQLTypes(Tag, { itemType: TodoType });
    expect(getKavoGraphQLTypes(Tag)).toEqual({ itemType: TodoType });
  });

  it("resolves update/patch/delete mutations through the same engine", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push({ id: 1, title: "before", done: false });
    const service = createKavo().createCrud(Todo, undefined, { adapter, metadata: todoMetadata });

    const UpdateTodoInput = new GraphQLInputObjectType({
      name: "UpdateTodoInput",
      fields: {
        title: { type: new GraphQLNonNull(GraphQLString) },
        done: { type: new GraphQLNonNull(GraphQLBoolean) },
      },
    });
    const PatchTodoInput = new GraphQLInputObjectType({
      name: "PatchTodoInput",
      fields: { done: { type: GraphQLBoolean } },
    });

    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service,
      itemType: TodoType,
      updateInputType: UpdateTodoInput,
      patchInputType: PatchTodoInput,
      deleteOne: true,
    });

    const updated = await graphql({
      schema,
      source: `mutation { updateTodo(id: 1, input: { title: "after", done: true }) { title done } }`,
    });
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updateTodo).toEqual({ title: "after", done: true });

    const patched = await graphql({ schema, source: `mutation { patchTodo(id: 1, input: { done: false }) { done } }` });
    expect(patched.errors).toBeUndefined();
    expect(patched.data?.patchTodo).toEqual({ done: false });

    const deleted = await graphql({ schema, source: `mutation { deleteTodo(id: 1) }` });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data?.deleteTodo).toBe(true);

    const afterDelete = await graphql({ schema, source: `query { todo(id: 1) { id } }` });
    expect(afterDelete.errors?.[0]?.message).toMatch(/not found/i);
  });

  it("forwards sort and filter args through to the normalized query", async () => {
    const { adapter, schema } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true });

    const result = await graphql({
      schema,
      source: `query {
        todos(sort: ["-title"], filter: { kind: "condition", field: "done", operator: "EQ", value: true }) {
          items { id }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(adapter.lastQuery?.sort).toEqual([{ field: "title", direction: "desc" }]);
    expect(adapter.lastQuery?.filter.root).toEqual({ kind: "condition", field: "done", operator: "EQ", value: true });
  });

  it("reads an unprefixed sort token as ascending, alongside a '-' descending one", async () => {
    // The `-` prefix is the only descending spelling, so its absence is
    // what carries "ascending". The MCP binding duplicates this parser
    // deliberately (the two may not import each other), so both need it.
    const { adapter, schema } = setup();
    adapter.rows.push({ id: 1, title: "a", done: false });

    const result = await graphql({
      schema,
      source: `query { todos(sort: ["-title", "done"]) { items { id } } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(adapter.lastQuery?.sort).toEqual([
      { field: "title", direction: "desc" },
      { field: "done", direction: "asc" },
    ]);
  });

  it("resolves restore/purge mutations against a soft-deletable entity", async () => {
    const adapter = new InMemoryNoteAdapter();
    const service = createKavo().createCrud(
      Note,
      {
        delete: { strategy: "soft" },
        operations: { createOne: true, deleteOne: true, restoreOne: true, purgeOne: true },
      },
      { adapter, metadata: noteMetadata },
    );
    const created = await service.createOne({ text: "keep me" } as never);
    await service.deleteOne(created.id as never);

    const NoteType = new GraphQLObjectType({
      name: "Note",
      fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        text: { type: new GraphQLNonNull(GraphQLString) },
      },
    });

    const schema = createKavoGraphQLSchema({
      name: "Note",
      service,
      itemType: NoteType,
      restoreOne: true,
      purgeOne: true,
    });

    const restored = await graphql({ schema, source: `mutation { restoreNote(id: ${created.id}) { id text } }` });
    expect(restored.errors).toBeUndefined();
    expect(restored.data?.restoreNote).toEqual({ id: created.id, text: "keep me" });

    const purged = await graphql({ schema, source: `mutation { purgeNote(id: ${created.id}) }` });
    expect(purged.errors).toBeUndefined();
    expect(purged.data?.purgeNote).toBe(true);

    expect(adapter.rows).toHaveLength(0);
  });
});

/**
 * A custom operation (ADR-0006's #145 amendment) reaches GraphQL only when
 * named in `operations` *and* its registry entry declares a `dto.output`
 * (the #153 amendment) — issue #153.
 */
describe("custom operations reach GraphQL (issue #153)", () => {
  const TodoType = new GraphQLObjectType({
    name: "Todo",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      title: { type: new GraphQLNonNull(GraphQLString) },
      done: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });

  it("exposes an opted-in custom write as a mutation field, dispatched through service.run", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push({ id: 1, title: "write tests", done: false });
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          markDoneOne: {
            handler: {
              async execute(input: unknown, context: KavoContext<Todo>) {
                const { id } = input as { id: number };
                return context.repository.update(id, { done: true }, context);
              },
            },
            dto: { output: Todo },
          },
        },
      } as never,
      { adapter, metadata: todoMetadata },
    );

    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service,
      itemType: TodoType,
      operations: { markDoneOne: { type: TodoType } },
    });

    const result = await graphql({ schema, source: `mutation { todoMarkDoneOne(id: 1) { id done } }` });
    expect(result.errors).toBeUndefined();
    expect(result.data?.todoMarkDoneOne).toEqual({ id: 1, done: true });
    expect(adapter.rows[0]?.done).toBe(true);
  });

  it("exposes an opted-in custom read as a query field, decided by the registry's kind", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push({ id: 1, title: "peek", done: false });
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          findOne: true,
          statusOne: {
            kind: "read",
            handler: {
              async execute(input: unknown, context: KavoContext<Todo>) {
                return context.repository.findOneById(input as number, null, context);
              },
            },
            dto: { output: Todo },
          },
        },
      } as never,
      { adapter, metadata: todoMetadata },
    );

    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service,
      itemType: TodoType,
      operations: { statusOne: { type: TodoType } },
    });

    expect(schema.getMutationType()).toBeUndefined();
    const result = await graphql({ schema, source: `query { todoStatusOne(id: 1) { id title } }` });
    expect(result.errors).toBeUndefined();
    expect(result.data?.todoStatusOne).toEqual({ id: 1, title: "peek" });
  });

  it("refuses a named custom operation with no declared dto.output", () => {
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          noShapeOne: { handler: { async execute() {} } },
        },
      } as never,
      { adapter: new InMemoryTodoAdapter(), metadata: todoMetadata },
    );

    try {
      createKavoGraphQLSchema({
        name: "Todo",
        service,
        itemType: TodoType,
        operations: { noShapeOne: { type: TodoType } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/no declared 'dto.output'/);
    }
  });

  it("refuses naming a standard operation id in 'operations'", () => {
    const service = createKavo().createCrud(Todo, undefined, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });

    try {
      createKavoGraphQLSchema({
        name: "Todo",
        service,
        itemType: TodoType,
        operations: { findOne: { type: TodoType } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/standard eight operations/);
    }
  });

  it("refuses naming an id the entity never declared", () => {
    const service = createKavo().createCrud(Todo, undefined, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });

    try {
      createKavoGraphQLSchema({
        name: "Todo",
        service,
        itemType: TodoType,
        operations: { ghostOne: { type: TodoType } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/never declared/);
    }
  });

  it("refuses naming a disabled custom operation", () => {
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          markDoneOne: { handler: { async execute() {} }, dto: { output: Todo }, enabled: false },
        },
      } as never,
      { adapter: new InMemoryTodoAdapter(), metadata: todoMetadata },
    );

    try {
      createKavoGraphQLSchema({
        name: "Todo",
        service,
        itemType: TodoType,
        operations: { markDoneOne: { type: TodoType } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/is disabled/);
    }
  });

  it("refuses an 'inputType' named for an operation with no declared dto.input", () => {
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          markDoneOne: { handler: { async execute() {} }, dto: { output: Todo } },
        },
      } as never,
      { adapter: new InMemoryTodoAdapter(), metadata: todoMetadata },
    );

    const MarkDoneInput = new GraphQLInputObjectType({
      name: "MarkDoneInput",
      fields: { note: { type: GraphQLString } },
    });

    try {
      createKavoGraphQLSchema({
        name: "Todo",
        service,
        itemType: TodoType,
        operations: { markDoneOne: { type: TodoType, inputType: MarkDoneInput } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as Error).message).toMatch(/no declared 'dto.input'/);
    }
  });

  it("exposes a cardinality-'many' custom read as a query field with no id argument", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push(
      { id: 1, title: "a", done: true },
      { id: 2, title: "b", done: false },
      { id: 3, title: "c", done: true },
    );
    const service = createKavo().createCrud(
      Todo,
      {
        operations: {
          findOne: true,
          doneMany: {
            kind: "read",
            cardinality: "many",
            handler: {
              async execute() {
                const rows = adapter.rows.filter((row) => row.done);
                return { entities: rows, total: rows.length };
              },
            },
            dto: { output: Todo },
          },
        },
      } as never,
      { adapter, metadata: todoMetadata },
    );

    const DoneManyResult = new GraphQLObjectType({
      name: "TodoDoneManyResult",
      fields: { items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TodoType))) } },
    });

    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service,
      itemType: TodoType,
      operations: { doneMany: { type: DoneManyResult } },
    });

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.["todoDoneMany"]?.args).toEqual([]);

    const result = await graphql({ schema, source: `query { todoDoneMany { items { id done } } } ` });
    expect(result.errors).toBeUndefined();
    expect(result.data?.todoDoneMany).toEqual({
      items: [
        { id: 1, done: true },
        { id: 3, done: true },
      ],
    });
  });

  it("leaves an un-named custom operation off the schema even when it declares a dto", async () => {
    const adapter = new InMemoryTodoAdapter();
    const service = createKavo().createCrud(
      Todo,
      {
        operations: { markDoneOne: { handler: { async execute() {} }, dto: { output: Todo } } },
      } as never,
      { adapter, metadata: todoMetadata },
    );

    const schema = createKavoGraphQLSchema({ name: "Todo", service, itemType: TodoType });
    expect(schema.getMutationType()).toBeUndefined();
  });
});

describe("cursor-paginated entities are refused at bootstrap", () => {
  function cursorTodoType() {
    return new GraphQLObjectType({
      name: "Todo",
      fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        title: { type: new GraphQLNonNull(GraphQLString) },
      },
    });
  }

  /** The `<Name>List` type has no `meta`, and `offset` is ignored under a keyset (ADR-0021 §7). */
  function cursorTodoService() {
    return createKavo({
      defaults: {
        pagination: { strategy: "cursor" },
      },
    } as never).createCrud(Todo, { sort: { default: ["id"] } } as never, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });
  }

  it("throws rather than silently answering `todos(limit, offset)` with page one", () => {
    expect(() =>
      createKavoGraphQLSchema({
        name: "Todo",
        service: cursorTodoService(),
        itemType: cursorTodoType(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("names the entity, the config key, and the way out", () => {
    expect(() =>
      createKavoGraphQLSchema({ name: "Todo", service: cursorTodoService(), itemType: cursorTodoType() }),
    ).toThrow(/pagination\.strategy/);
    expect(() =>
      createKavoGraphQLSchema({ name: "Todo", service: cursorTodoService(), itemType: cursorTodoType() }),
    ).toThrow(/'offset'\/'page'/);
  });

  it("still binds an offset-paginated entity", () => {
    const service = createKavo().createCrud(Todo, undefined, {
      adapter: new InMemoryTodoAdapter(),
      metadata: todoMetadata,
    });
    expect(() => createKavoGraphQLSchema({ name: "Todo", service, itemType: cursorTodoType() })).not.toThrow();
  });
});

/**
 * `pagination.strategy: "none"` (ADR-0030) is not `"cursor"`/`"since"`, so
 * `requireOffsetPageable` lets it through at bootstrap — the ADR's
 * Consequences section claims this composes correctly by construction
 * rather than needing a bootstrap refusal of its own. That claim rests on
 * `NONE_PAGINATION_LIMIT` (`2^31 - 1`) surviving `GraphQLInt.serialize`,
 * which throws on anything outside `[-2^31, 2^31 - 1]` — one off from the
 * boundary this envelope field actually carries. Proven here rather than
 * inferred, and the regression guard if the sentinel ever changes.
 */
describe("pagination.strategy: 'none' entities (ADR-0030, issue #225)", () => {
  function unpaginatedTodoType() {
    return new GraphQLObjectType({
      name: "Todo",
      fields: {
        id: { type: new GraphQLNonNull(GraphQLInt) },
        title: { type: new GraphQLNonNull(GraphQLString) },
      },
    });
  }

  function unpaginatedTodoService(adapter: InMemoryTodoAdapter) {
    return createKavo({ defaults: { pagination: { strategy: "none" } } } as never).createCrud(Todo, undefined, {
      adapter,
      metadata: todoMetadata,
    });
  }

  it("binds without a bootstrap refusal, unlike cursor/since", () => {
    expect(() =>
      createKavoGraphQLSchema({
        name: "Todo",
        service: unpaginatedTodoService(new InMemoryTodoAdapter()),
        itemType: unpaginatedTodoType(),
      }),
    ).not.toThrow();
  });

  it("serves the whole match set when the query sends no limit/offset, and limit serializes as GraphQLInt", async () => {
    const adapter = new InMemoryTodoAdapter();
    adapter.rows.push(
      { id: 1, title: "a", done: false },
      { id: 2, title: "b", done: false },
      { id: 3, title: "c", done: false },
      { id: 4, title: "d", done: false },
      { id: 5, title: "e", done: false },
    );
    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service: unpaginatedTodoService(adapter),
      itemType: unpaginatedTodoType(),
    });

    const result = await graphql({ schema, source: `query { todos { items { id } total limit offset } }` });

    expect(result.errors).toBeUndefined();
    expect(result.data?.todos).toEqual({
      items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      total: 5,
      limit: 2147483647,
      offset: 0,
    });
  });

  it("rejects an explicit limit/offset the same way REST does, rather than truncating silently", async () => {
    const schema = createKavoGraphQLSchema({
      name: "Todo",
      service: unpaginatedTodoService(new InMemoryTodoAdapter()),
      itemType: unpaginatedTodoType(),
    });

    const result = await graphql({ schema, source: `query { todos(limit: 5) { total } }` });

    // The binding surfaces `QueryValidationException` as-is; its `.message`
    // is the catalog's generic `KAVO_QUERY_INVALID` summary (the field-level
    // "pagination.strategy is 'none'" detail lives on `.issues`, which this
    // binding does not expose through `GraphQLError`) — so what's provable
    // here is that the field errors at all, rather than silently truncating
    // to a page.
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe("The request query is invalid.");
  });
});
