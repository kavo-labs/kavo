import { describe, expect, it } from "vitest";
import { registerKavoSchemas } from "@kavo/nest";

/**
 * Unit coverage for the document transform itself — the `@Kavo` →
 * `SwaggerModule.createDocument` → `registerKavoSchemas` integration path is
 * exercised in `binding.e2e.spec.ts`. These build the OpenAPI document by
 * hand so the collision, idempotency and skip rules can be pinned exactly.
 */

type Schema = {
  $ref?: string;
  title?: string;
  type?: string;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  items?: Schema;
  "x-kavo-entity"?: string;
  "x-kavo-error"?: boolean;
  "x-kavo-operation-scoped"?: boolean;
};
type Media = { schema?: Schema };
type Operation = {
  "x-kavo-entity"?: string;
  "x-kavo-operation"?: string;
  "x-kavo-cardinality"?: string;
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, { content?: Record<string, Media> }>;
};
type Doc = {
  components?: { schemas?: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};

const json = "application/json";
const postDoc = (post: Operation): Doc => ({ paths: { "/ads": { post } } });
const schemasOf = (doc: Doc): Record<string, Schema> => doc.components?.schemas ?? {};
const reqSchema = (doc: Doc, path: string, verb: string): Schema | undefined =>
  doc.paths[path]?.[verb]?.requestBody?.content?.[json]?.schema;
const resSchema = (doc: Doc, path: string, verb: string, status: string): Schema | undefined =>
  doc.paths[path]?.[verb]?.responses?.[status]?.content?.[json]?.schema;

describe("registerKavoSchemas", () => {
  it("hoists an inline request body carrying x-kavo-entity to <Entity>Create and leaves a $ref", () => {
    const doc = postDoc({
      "x-kavo-entity": "Ad",
      "x-kavo-operation": "createOne",
      "x-kavo-cardinality": "one",
      requestBody: {
        content: {
          [json]: {
            schema: {
              title: "CreateAdDto",
              type: "object",
              properties: { id: { type: "string" } },
              "x-kavo-entity": "Ad",
            },
          },
        },
      },
    });

    registerKavoSchemas(doc);

    expect(reqSchema(doc, "/ads", "post")).toEqual({
      $ref: "#/components/schemas/AdCreate",
    });
    expect(schemasOf(doc).AdCreate).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      "x-kavo-entity": "Ad",
    });
    expect(schemasOf(doc).AdCreate?.title).toBeUndefined();
  });

  it("names the success response from x-kavo-cardinality: List / ListItem / ListMeta for many", () => {
    const element: Schema = {
      title: "AdListDto",
      type: "object",
      properties: { id: { type: "string" } },
      "x-kavo-entity": "Ad",
    };
    const meta: Schema = {
      type: "object",
      additionalProperties: true,
      description: "findMany bag",
      "x-kavo-entity": "Ad",
    };
    const doc: Doc = {
      paths: {
        "/ads": {
          get: {
            "x-kavo-entity": "Ad",
            "x-kavo-operation": "findMany",
            "x-kavo-cardinality": "many",
            responses: {
              "200": {
                content: {
                  [json]: {
                    schema: {
                      title: "AdListList",
                      type: "object",
                      required: ["items", "limit", "offset", "total"],
                      properties: { items: { type: "array", items: element }, meta },
                      "x-kavo-entity": "Ad",
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/ads", "get", "200")).toEqual({
      $ref: "#/components/schemas/AdList",
    });
    const list = schemasOf(doc).AdList;
    expect(list).toBeDefined();
    expect(list?.properties?.items?.items).toEqual({ $ref: "#/components/schemas/AdListItem" });
    expect(list?.properties?.meta).toEqual({ $ref: "#/components/schemas/AdListMeta" });
    expect(list?.required).toEqual(["items", "limit", "offset", "total"]);
    expect(schemasOf(doc).AdListItem).toBeDefined();
    expect(schemasOf(doc).AdListMeta).toMatchObject({ type: "object", additionalProperties: true });
  });

  it("hoists a bare error body to KavoProblemDetails and its errors[] entry to KavoProblemDetailError", () => {
    const problem: Schema = {
      "x-kavo-error": true,
      type: "object",
      properties: {
        code: { type: "string" },
        errors: {
          type: "array",
          items: { "x-kavo-error": true, type: "object", properties: { field: { type: "string" } } },
        },
      },
    };
    const doc: Doc = {
      paths: {
        "/ads": {
          get: {
            "x-kavo-entity": "Ad",
            "x-kavo-cardinality": "one",
            responses: { "404": { content: { [json]: { schema: problem } } } },
          },
        },
      },
    };

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/ads", "get", "404")).toEqual({
      $ref: "#/components/schemas/KavoProblemDetails",
    });
    expect(schemasOf(doc).KavoProblemDetails?.properties?.errors?.items).toEqual({
      $ref: "#/components/schemas/KavoProblemDetailError",
    });
    expect(schemasOf(doc).KavoProblemDetailError).toBeDefined();
  });

  it("hoists the entity-scoped 400 to <Entity>ValidationError with an allOf over KavoProblemDetails", () => {
    const bareProblem: Schema = { "x-kavo-error": true, type: "object", properties: { code: { type: "string" } } };
    const doc = postDoc({
      "x-kavo-entity": "Ad",
      "x-kavo-operation": "createOne",
      "x-kavo-cardinality": "one",
      responses: {
        "400": {
          content: {
            [json]: {
              schema: {
                "x-kavo-error": true,
                "x-kavo-entity": "Ad",
                allOf: [bareProblem],
                description: "Request validation failed for the Ad entity (RFC 9457 problem details).",
              },
            },
          },
        },
      },
    });

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/ads", "post", "400")).toEqual({
      $ref: "#/components/schemas/AdValidationError",
    });
    const validation = schemasOf(doc).AdValidationError;
    expect(validation).toBeDefined();
    expect(validation?.allOf).toEqual([{ $ref: "#/components/schemas/KavoProblemDetails" }]);
    expect(validation?.["x-kavo-entity"]).toBe("Ad");
    expect(validation?.description).toContain("Ad");
    expect(schemasOf(doc).KavoProblemDetails).toBeDefined();
  });

  it("names a per-operation-scoped response for its operation, keeping the root Item/List names free", () => {
    const rootItem: Schema = {
      title: "AdItemDto",
      type: "object",
      properties: { id: { type: "string" } },
      "x-kavo-entity": "Ad",
    };
    const opItem: Schema = {
      title: "AdSummaryDto",
      "x-kavo-operation-scoped": true,
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      "x-kavo-entity": "Ad",
    };
    const doc: Doc = {
      paths: {
        "/ads/{id}": {
          get: {
            "x-kavo-entity": "Ad",
            "x-kavo-operation": "findOne",
            "x-kavo-cardinality": "one",
            responses: { "200": { content: { [json]: { schema: rootItem } } } },
          },
          put: {
            "x-kavo-entity": "Ad",
            "x-kavo-operation": "updateOne",
            "x-kavo-cardinality": "one",
            responses: { "200": { content: { [json]: { schema: opItem } } } },
          },
        },
      },
    };

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/ads/{id}", "get", "200")).toEqual({ $ref: "#/components/schemas/AdItem" });
    expect(resSchema(doc, "/ads/{id}", "put", "200")).toEqual({ $ref: "#/components/schemas/AdUpdateOne" });
    // No positional _2, and the internal marker does not survive into the component.
    expect(schemasOf(doc).AdItem_2).toBeUndefined();
    expect(schemasOf(doc).AdUpdateOne?.["x-kavo-operation-scoped"]).toBeUndefined();
    expect(Object.keys(schemasOf(doc).AdUpdateOne?.properties ?? {})).toEqual(["id", "label"]);
  });

  it("namespaces components by entity across a multi-entity document, suffixing a genuine cross-entity clash", () => {
    const itemFor = (entity: string, props: Record<string, Schema>): { get: Operation } => ({
      get: {
        "x-kavo-entity": entity,
        "x-kavo-operation": "findOne",
        "x-kavo-cardinality": "one",
        responses: {
          "200": {
            content: {
              [json]: {
                schema: { title: `${entity}ItemDto`, type: "object", properties: props, "x-kavo-entity": entity },
              },
            },
          },
        },
      },
    });
    const doc: Doc = {
      paths: {
        "/todos/{id}": itemFor("Todo", { id: { type: "string" }, title: { type: "string" } }),
        "/books/{id}": itemFor("Book", { id: { type: "string" }, isbn: { type: "string" } }),
        // An entity whose name collides with Todo's list-element component.
        "/todo-list-items/{id}": itemFor("TodoListItem", { id: { type: "string" }, done: { type: "boolean" } }),
      },
    };

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/todos/{id}", "get", "200")).toEqual({ $ref: "#/components/schemas/TodoItem" });
    expect(resSchema(doc, "/books/{id}", "get", "200")).toEqual({ $ref: "#/components/schemas/BookItem" });
    expect(Object.keys(schemasOf(doc).TodoItem?.properties ?? {})).toEqual(["id", "title"]);
    expect(Object.keys(schemasOf(doc).BookItem?.properties ?? {})).toEqual(["id", "isbn"]);
    // `TodoListItem` (the entity) wants `TodoListItemItem` — distinct from
    // `Todo`'s hypothetical `TodoListItem`, so no clash here; assert the
    // per-entity prefix actually keeps them apart.
    expect(schemasOf(doc).TodoListItemItem).toBeDefined();
    expect(Object.keys(schemasOf(doc).TodoListItemItem?.properties ?? {})).toEqual(["id", "done"]);
  });

  it("suffixes a real same-name/different-shape clash through _2 and _3", () => {
    const route = (path: string, op: string, props: Record<string, Schema>): Record<string, Operation> => ({
      get: {
        "x-kavo-entity": "Ad",
        "x-kavo-operation": op,
        "x-kavo-cardinality": "one",
        responses: {
          "200": {
            content: {
              [json]: {
                schema: {
                  title: op,
                  "x-kavo-operation-scoped": true,
                  type: "object",
                  properties: props,
                  "x-kavo-entity": "Ad",
                },
              },
            },
          },
        },
      },
    });
    // Three operations all PascalCase to `Sync` is impossible, so force the
    // clash by pre-seeding the bare + `_2` names with unrelated shapes.
    const doc: Doc = {
      components: {
        schemas: {
          AdSync: { type: "object", properties: { a: { type: "number" } } },
          AdSync_2: { type: "object", properties: { b: { type: "number" } } },
        },
      },
      paths: { "/ads/sync": route("/ads/sync", "sync", { c: { type: "string" } }) },
    };

    registerKavoSchemas(doc);

    expect(resSchema(doc, "/ads/sync", "get", "200")).toEqual({ $ref: "#/components/schemas/AdSync_3" });
    expect(Object.keys(schemasOf(doc).AdSync_3?.properties ?? {})).toEqual(["c"]);
  });

  it("collapses identical schemas onto one component and suffixes genuine collisions deterministically", () => {
    const twoRoutes = (props: Record<string, Schema>): Doc => ({
      paths: {
        "/ads": {
          get: {
            "x-kavo-entity": "Ad",
            "x-kavo-cardinality": "one",
            responses: {
              "200": {
                content: {
                  [json]: { schema: { title: "x", type: "object", properties: props, "x-kavo-entity": "Ad" } },
                },
              },
            },
          },
        },
        "/ads/{id}": {
          get: {
            "x-kavo-entity": "Ad",
            "x-kavo-cardinality": "one",
            responses: {
              "200": {
                content: {
                  [json]: { schema: { title: "y", type: "object", properties: props, "x-kavo-entity": "Ad" } },
                },
              },
            },
          },
        },
      },
    });

    const same = twoRoutes({ id: { type: "string" } });
    registerKavoSchemas(same);
    expect(Object.keys(schemasOf(same))).toEqual(["AdItem"]);
    expect(resSchema(same, "/ads", "get", "200")).toEqual({
      $ref: "#/components/schemas/AdItem",
    });
    expect(resSchema(same, "/ads/{id}", "get", "200")).toEqual({
      $ref: "#/components/schemas/AdItem",
    });

    const collide = twoRoutes({ id: { type: "string" } });
    collide.components = { schemas: { AdItem: { type: "object", properties: { unrelated: { type: "number" } } } } };
    registerKavoSchemas(collide);
    expect(Object.keys(schemasOf(collide)).sort()).toEqual(["AdItem", "AdItem_2"]);
    expect(resSchema(collide, "/ads", "get", "200")).toEqual({
      $ref: "#/components/schemas/AdItem_2",
    });
  });

  it("leaves a $ref schema untouched — the introspection-fallback path is unchanged", () => {
    const doc = postDoc({
      "x-kavo-entity": "Ad",
      "x-kavo-operation": "createOne",
      "x-kavo-cardinality": "one",
      requestBody: { content: { [json]: { schema: { $ref: "#/components/schemas/CreateAdDto" } } } },
    });

    registerKavoSchemas(doc);

    expect(reqSchema(doc, "/ads", "post")).toEqual({
      $ref: "#/components/schemas/CreateAdDto",
    });
    expect(schemasOf(doc).AdCreate).toBeUndefined();
  });

  it("gates on the operation's x-kavo-entity, not the schema's — a foreign route is left alone", () => {
    const doc: Doc = {
      paths: {
        "/other": {
          post: {
            requestBody: {
              content: { [json]: { schema: { title: "Foreign", type: "object", "x-kavo-entity": "Ad" } } },
            },
          },
        },
      },
    };
    const before = JSON.stringify(doc.paths);

    registerKavoSchemas(doc);

    expect(JSON.stringify(doc.paths)).toBe(before);
    expect(schemasOf(doc)).toEqual({});
  });

  it("is idempotent — a second pass changes nothing", () => {
    const doc = postDoc({
      "x-kavo-entity": "Ad",
      "x-kavo-operation": "createOne",
      "x-kavo-cardinality": "one",
      requestBody: {
        content: {
          [json]: {
            schema: {
              title: "CreateAdDto",
              type: "object",
              properties: { id: { type: "string" } },
              "x-kavo-entity": "Ad",
            },
          },
        },
      },
    });

    registerKavoSchemas(doc);
    const once = JSON.stringify(doc);
    registerKavoSchemas(doc);
    expect(JSON.stringify(doc)).toBe(once);
  });
});
