/**
 * `registerKavoSchemas` — hoist the inline request/response schemas Kavo
 * generates into `components.schemas` as named, `$ref`-able entries.
 *
 * `@Kavo` route generation and the bind-time doc passes (`swagger.ts`) emit
 * every body/response shape *inline* on the route, because the only identity
 * available at either moment is a `title` string. That is enough to render,
 * but a client generator sees an anonymous object on every route and cannot
 * tell that `POST /ads`, `GET /ads/:id` and `PATCH /ads/:id` all speak about
 * the same entity.
 *
 * This helper post-processes a finished OpenAPI document — the same "the app
 * splices this in" shape as `KAVO_API_GUIDE` — walking every operation Kavo
 * generated (identified by the `x-kavo-entity` / `x-kavo-operation` /
 * `x-kavo-cardinality` extensions from #294) and lifting the inline schemas
 * it built into `components.schemas` under stable, entity-prefixed names,
 * leaving a `$ref` behind:
 *
 * | Component               | Source                                            |
 * | ---------------------- | ------------------------------------------------- |
 * | `<Entity>Create`        | `createOne` request body                          |
 * | `<Entity>Update`        | `updateOne` request body                          |
 * | `<Entity>Patch`         | `patchOne` request body                           |
 * | `<Entity>Item`          | single-row success response                       |
 * | `<Entity>List`          | list-envelope success response                    |
 * | `<Entity>ListItem`      | the envelope's `items[]` element                  |
 * | `<Entity>ListMeta`      | the envelope's `meta` bag                         |
 * | `KavoProblemDetails`    | shared RFC 9457 error body (400/404/409/412)      |
 * | `KavoProblemDetailError`| one entry of that body's `errors[]` array         |
 * | `<Entity>ValidationError`| the entity-scoped `400` (`allOf` over the above) |
 *
 * Only inline schemas Kavo actually constructed are moved: the filter is
 * "carries `x-kavo-entity` or `x-kavo-error`". A schema that is already a
 * `$ref` is left untouched — which is exactly the `{ type: DtoClass }`
 * introspection-fallback path (`@nestjs/swagger` registers that class as its
 * own component), so a decorated/declarative DTO keeps the name Swagger gave
 * it and this helper does not double it up.
 *
 * **Name collisions.** When two structurally different schemas want the same
 * name (e.g. entity `Ad`'s list element and an entity literally named
 * `AdListItem`), the first wins the bare name and later ones get `_2`, `_3`,
 * … Iteration follows `document.paths` insertion order, which Nest builds
 * deterministically, so the assignment is stable across runs. Structurally
 * identical schemas (the common case — five routes serving `<Entity>Item`)
 * collapse onto one component.
 *
 * The helper mutates and returns the document, so it composes inline:
 *
 * ```ts
 * SwaggerModule.setup("docs", app, registerKavoSchemas(
 *   SwaggerModule.createDocument(app, config),
 * ));
 * ```
 *
 * It imports nothing from `@nestjs/swagger` — it is a pure transform over the
 * plain document object — so it is safe to call whether or not the optional
 * peer is installed (with no peer, there is simply nothing to hoist).
 */

interface SchemaObject {
  $ref?: string;
  title?: string;
  type?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  allOf?: SchemaObject[];
  [key: string]: unknown;
}

interface MediaType {
  schema?: SchemaObject;
}

interface OperationObject {
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<string, { content?: Record<string, MediaType> }>;
  "x-kavo-entity"?: unknown;
  "x-kavo-operation"?: unknown;
  "x-kavo-cardinality"?: unknown;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OperationObject> | undefined>;
  components?: { schemas?: Record<string, SchemaObject> };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
const JSON_MEDIA = "application/json";

export function registerKavoSchemas<T extends OpenApiDocument>(document: T): T {
  const components = (document.components ??= {});
  const schemas = (components.schemas ??= {});
  const registry = new SchemaRegistry(schemas);

  for (const pathItem of Object.values(document.paths ?? {})) {
    if (pathItem === undefined) {
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || operation === null || typeof operation !== "object") {
        continue;
      }
      const entity = operation["x-kavo-entity"];
      if (typeof entity !== "string") {
        continue;
      }
      hoistRequestBody(registry, operation, entity);
      hoistResponses(registry, operation, entity);
    }
  }

  return document;
}

function hoistRequestBody(registry: SchemaRegistry, operation: OperationObject, entity: string): void {
  const media = operation.requestBody?.content?.[JSON_MEDIA];
  if (media?.schema === undefined || !isHoistable(media.schema)) {
    return;
  }
  const bySlot: Record<string, string | undefined> = {
    createOne: `${entity}Create`,
    updateOne: `${entity}Update`,
    patchOne: `${entity}Patch`,
  };
  const name = bySlot[String(operation["x-kavo-operation"])];
  if (name === undefined) {
    return;
  }
  media.schema = registry.register(media.schema, name);
}

/**
 * Every path that follows mutates its schema object as it hoists nested
 * members. `applySwaggerMetadata` hands out the module-level
 * `PROBLEM_DETAILS_SCHEMA` *by reference* on every error response (and again
 * inside `applyValidationErrorDoc`'s `allOf`), and two `createDocument`
 * calls in one process could otherwise leave one document `$ref`-ing a
 * component the other one registered. Cloning up front keeps each document
 * self-contained and makes the transform order-independent.
 */
function detach(schema: SchemaObject): SchemaObject {
  return clone(schema);
}

function hoistResponses(registry: SchemaRegistry, operation: OperationObject, entity: string): void {
  const isMany = operation["x-kavo-cardinality"] === "many";
  for (const response of Object.values(operation.responses ?? {})) {
    const media = response?.content?.[JSON_MEDIA];
    if (media === undefined || media.schema === undefined || !isHoistable(media.schema)) {
      continue;
    }
    const schema = detach(media.schema);

    if (schema["x-kavo-error"] !== undefined) {
      media.schema = hoistProblemDetails(registry, schema, entity);
      continue;
    }

    if (isMany) {
      const items = schema.properties?.items;
      if (items?.items !== undefined && isHoistable(items.items)) {
        items.items = registry.register(items.items, `${entity}ListItem`);
      }
      const meta = schema.properties?.meta;
      if (meta !== undefined && isHoistable(meta)) {
        schema.properties!.meta = registry.register(meta, `${entity}ListMeta`);
      }
      media.schema = registry.register(schema, `${entity}List`);
    } else {
      media.schema = registry.register(schema, `${entity}Item`);
    }
  }
}

/**
 * The problem-details family. A bare `400`/`404`/`409`/`412` schema carries
 * only `x-kavo-error` and becomes `KavoProblemDetails`; the entity-scoped
 * `400` from `applyValidationErrorDoc` additionally carries `x-kavo-entity`
 * and an `allOf` whose first member is that same bare shape — hoisted to
 * `KavoProblemDetails` in place, leaving `<Entity>ValidationError` as a thin
 * `allOf` reference.
 */
function hoistProblemDetails(registry: SchemaRegistry, schema: SchemaObject, entity: string): SchemaObject {
  hoistErrorItems(registry, schema);
  if (typeof schema["x-kavo-entity"] === "string") {
    const inner = schema.allOf?.[0];
    if (inner !== undefined && isHoistable(inner)) {
      hoistErrorItems(registry, inner);
      schema.allOf![0] = registry.register(inner, "KavoProblemDetails");
    }
    return registry.register(schema, `${entity}ValidationError`);
  }
  return registry.register(schema, "KavoProblemDetails");
}

function hoistErrorItems(registry: SchemaRegistry, schema: SchemaObject): void {
  const items = schema.properties?.errors?.items;
  if (items !== undefined && isHoistable(items)) {
    schema.properties!.errors!.items = registry.register(items, "KavoProblemDetailError");
  }
}

function isHoistable(schema: SchemaObject | undefined): schema is SchemaObject {
  return (
    schema !== undefined &&
    typeof schema === "object" &&
    typeof schema.$ref !== "string" &&
    (schema["x-kavo-entity"] !== undefined || schema["x-kavo-error"] !== undefined)
  );
}

class SchemaRegistry {
  private readonly canonical = new Map<string, string>();

  constructor(private readonly schemas: Record<string, SchemaObject>) {
    for (const [name, schema] of Object.entries(schemas)) {
      this.canonical.set(name, stableStringify(schema));
    }
  }

  /**
   * Store `schema` under `preferredName` (or a `_N`-suffixed variant on a
   * genuine collision) and return the `$ref` that should replace it. The
   * stored copy drops `title` — the component key supersedes it, and keeping
   * it would leave the un-`$ref`'d name visible twice.
   */
  register(schema: SchemaObject, preferredName: string): SchemaObject {
    const stored = stripTitle(clone(schema));
    const json = stableStringify(stored);

    let name = preferredName;
    for (let attempt = 2; ; attempt += 1) {
      const existing = this.canonical.get(name);
      if (existing === undefined) {
        this.schemas[name] = stored;
        this.canonical.set(name, json);
        break;
      }
      if (existing === json) {
        break;
      }
      name = `${preferredName}_${attempt}`;
    }
    return { $ref: `#/components/schemas/${name}` };
  }
}

function stripTitle(schema: SchemaObject): SchemaObject {
  delete schema.title;
  return schema;
}

function clone(value: SchemaObject): SchemaObject {
  return JSON.parse(JSON.stringify(value)) as SchemaObject;
}

/** Key-sorted JSON, so structural equality is a string comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
