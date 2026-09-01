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
 * | `<Entity>Item`          | single-row success response (root `item` slot)    |
 * | `<Entity>List`          | list-envelope success response (root `list` slot) |
 * | `<Entity>ListItem`      | the envelope's `items[]` element                  |
 * | `<Entity>ListMeta`      | the envelope's `meta` bag                         |
 * | `<Entity>Pagination`    | the page controls for the resolved `pagination.strategy` (issue #313, #319) |
 * | `<Entity>Include`       | the includable relation paths (issue #313)        |
 * | `<Entity>Sort`          | the sortable keys, `-` = descending (issue #313)  |
 * | `<Entity>Filter`        | the structured filter predicate (issue #314, ADR-0042) |
 * | `<Entity>Query`         | the documented-only `filter`+`sort`+`pagination`+`select`+`include`+`search` aggregate (issue #314, ADR-0042) |
 * | `<Entity><Operation>`   | a per-operation `dto.output` (issue #131) or a custom op's own output shape — single-row |
 * | `<Entity><Operation>List` | the same, `many` — plus `…ListItem` / `…ListMeta` |
 * | `KavoProblemDetails`    | shared RFC 9457 error body (400/404/409/412)      |
 * | `KavoProblemDetailError`| one entry of that body's `errors[]` array         |
 * | `<Entity>ValidationError`| the entity-scoped `400` — an `allOf` over `KavoProblemDetails` with no field enumeration (see `applyValidationErrorDoc`) |
 *
 * Only inline schemas Kavo actually constructed are moved: the filter is
 * "carries `x-kavo-entity` or `x-kavo-error`". A schema that is already a
 * `$ref` is left untouched — which is exactly the `{ type: DtoClass }`
 * introspection-fallback path (`@nestjs/swagger` registers that class as its
 * own component), so a decorated/declarative DTO keeps the name Swagger gave
 * it and this helper does not double it up.
 *
 * **Response naming is operation-aware.** A single-row / `many` success
 * response whose shape is the entity's *root* `item` / `list` slot takes the
 * shared `<Entity>Item` / `<Entity>List` name, so the standard operations
 * that serve the same shape collapse onto one component. A response flagged
 * `x-kavo-operation-scoped` (by `successBodyFor`, when `descriptor.output`
 * is set — a per-operation override or a custom operation's own
 * `dto.output`) is named `<Entity><Operation>` instead, so a genuinely
 * different shape gets a meaningful stable name rather than racing the root
 * one for `<Entity>Item` and losing to a positional `_2`.
 *
 * **Name collisions.** After that, a still-genuine clash — two structurally
 * different schemas under one name (e.g. entity `Ad`'s list element and an
 * entity literally named `AdListItem`) — resolves first-wins, then `_2`,
 * `_3`, … in `document.paths` order. That order is stable within one build
 * but shifts if entities are added or `controllers: [...]` is reordered, so
 * a `_2` in the output is a prompt to disambiguate with an explicit DTO
 * class, not a name to depend on. Structurally identical schemas requested
 * under the same name (five routes serving `<Entity>Item`) collapse onto one
 * component; the same shape under two names (`<Entity>Update` /
 * `<Entity>Patch` when no `dto.patch` is set) is emitted under both.
 *
 * **Includable-relation `$ref`s (issue #356).** `applyResponseSchemaDocs`
 * leaves an `x-kavo-includable-ref: "<Target>"` marker on every includable
 * relation whose target metadata resolves — bind time
 * cannot name the target component, since naming happens here. After every
 * response has hoisted, a final pass (`resolveIncludableRefs`) walks every
 * registered component and rewrites each marker to a `$ref` to that entity's
 * real `<Target>Item` (first-wins name, `_2` and all), or — when the target
 * published no synthesized item schema (an explicit `item` DTO, or no read
 * route) — to a plain `{ type: "object" }`, so the document never carries a
 * dangling `$ref`. `$ref` cycles from mutual/self relations are valid
 * OpenAPI 3.x and left as-is.
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
  /**
   * Bind-time marker (`applyResponseSchemaDocs`) on an includable relation:
   * the target entity's resolved name.
   * `resolveIncludableRefs` swaps the whole object for a `$ref` to that
   * entity's `<Target>Item` component once every component name is known.
   */
  "x-kavo-includable-ref"?: string;
  [key: string]: unknown;
}

const REF_PREFIX = "#/components/schemas/";

interface MediaType {
  schema?: SchemaObject;
}

interface OperationObject {
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<string, { content?: Record<string, MediaType> }>;
  "x-kavo-entity"?: unknown;
  "x-kavo-operation"?: unknown;
  "x-kavo-cardinality"?: unknown;
  "x-kavo-query-schemas"?: unknown;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OperationObject> | undefined>;
  components?: { schemas?: Record<string, SchemaObject> };
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
const JSON_MEDIA = "application/json";

/**
 * `T` is deliberately just `object`, not `OpenApiDocument`: `@nestjs/swagger`'s
 * own `OpenAPIObject` type does not structurally satisfy the interface below
 * (its `PathItemObject` has no string index signature), which would break
 * inference on the one call that matters —
 * `registerKavoSchemas(SwaggerModule.createDocument(...))` — and force the
 * caller to cast. The document is mutated in place and handed straight back,
 * so the exact input type is preserved; the structural view is applied
 * internally.
 */
export function registerKavoSchemas<T extends object>(document: T): T {
  const doc = document as OpenApiDocument;
  const components = (doc.components ??= {});
  const schemas = (components.schemas ??= {});
  const registry = new SchemaRegistry(schemas);
  // Entity name -> the actual component name its synthesized single-row
  // `<Entity>Item` landed on (`<Entity>Item`, or `<Entity>Item_2` on a
  // cross-entity collision). Filled as responses hoist; read afterwards to
  // resolve `x-kavo-includable-ref` markers to real `$ref`s.
  const itemComponentByEntity = new Map<string, string>();

  for (const pathItem of Object.values(doc.paths ?? {})) {
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
      hoistResponses(registry, operation, entity, itemComponentByEntity);
      hoistQuerySchemas(registry, operation, entity);
    }
  }

  // Every `<Entity>Item` name is now known, so an includable-relation marker
  // (`applyResponseSchemaDocs`) can be resolved to a
  // `$ref` to its target's item component — or degraded to a plain object
  // when that target has no synthesized item schema. Runs over every
  // registered component so a marker on `<Entity>Item` and its structural
  // twin on `<Entity>ListItem` are both rewritten.
  resolveIncludableRefs(schemas, itemComponentByEntity);

  return document;
}

/**
 * Rewrite the `x-kavo-includable-ref` markers `applyResponseSchemaDocs`
 * leaves on includable relations.
 * Bind time cannot name the target component (this pass owns naming, and a
 * cross-entity clash can bump it to `<Target>Item_2`), so it records only
 * the target entity name; here each marker becomes either a `$ref` to that
 * entity's real item component or — when the entity published no synthesized
 * item schema (an explicit `item` DTO, or no read route) — a plain
 * `{ type: "object" }` with a prose description, so the document never
 * carries a dangling `$ref`. `$ref` cycles (mutual or self relations) are
 * valid OpenAPI 3.x and are left as-is.
 */
function resolveIncludableRefs(
  schemas: Record<string, SchemaObject>,
  itemComponentByEntity: Map<string, string>,
): void {
  for (const schema of Object.values(schemas)) {
    walkIncludableRefs(schema, itemComponentByEntity);
  }
}

function walkIncludableRefs(node: unknown, itemComponentByEntity: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walkIncludableRefs(child, itemComponentByEntity);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      const replacement = resolvedIncludableRef(value, itemComponentByEntity);
      if (replacement === undefined) {
        walkIncludableRefs(value, itemComponentByEntity);
      } else {
        (properties as Record<string, unknown>)[key] = replacement;
      }
    }
  }
  // A `-to-many` relation is `{ type: "array", items: <marker> }`, so the
  // marker can sit directly on `items` as well as on a `properties` entry.
  if (record.items !== undefined) {
    const replacement = resolvedIncludableRef(record.items, itemComponentByEntity);
    if (replacement === undefined) {
      walkIncludableRefs(record.items, itemComponentByEntity);
    } else {
      record.items = replacement;
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(record[key])) {
      walkIncludableRefs(record[key], itemComponentByEntity);
    }
  }
}

function resolvedIncludableRef(value: unknown, itemComponentByEntity: Map<string, string>): SchemaObject | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const target = (value as Record<string, unknown>)["x-kavo-includable-ref"];
  if (typeof target !== "string") {
    return undefined;
  }
  const component = itemComponentByEntity.get(target);
  if (component !== undefined) {
    return { $ref: `${REF_PREFIX}${component}` };
  }
  return {
    type: "object",
    description:
      `Embedded when \`include=\` names this relation; its shape mirrors the ${target}Item component. ` +
      `That component is not published — the ${target} entity has no synthesized item schema ` +
      `(an explicit item DTO, or no read route).`,
  };
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

function hoistResponses(
  registry: SchemaRegistry,
  operation: OperationObject,
  entity: string,
  itemComponentByEntity: Map<string, string>,
): void {
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

    // A per-operation output shape — an `item`/`list` override (issue #131)
    // or a custom operation's own `dto.output`, flagged
    // `x-kavo-operation-scoped` by `successBodyFor` — is named for its
    // operation (`<Entity><Operation>`) so it never competes with the
    // entity's root `item`/`list` component and lose to a positional `_2`.
    const opName = pascalCase(String(operation["x-kavo-operation"] ?? ""));
    const scoped = schema["x-kavo-operation-scoped"] === true && opName !== "";

    if (isMany) {
      const items = schema.properties?.items;
      if (items?.items !== undefined && isHoistable(items.items)) {
        items.items = registry.register(items.items, scoped ? `${entity}${opName}ListItem` : `${entity}ListItem`);
      }
      const meta = schema.properties?.meta;
      if (meta !== undefined && isHoistable(meta)) {
        schema.properties!.meta = registry.register(meta, scoped ? `${entity}${opName}ListMeta` : `${entity}ListMeta`);
      }
      media.schema = registry.register(schema, scoped ? `${entity}${opName}List` : `${entity}List`);
    } else {
      const ref = registry.register(schema, scoped ? `${entity}${opName}` : `${entity}Item`);
      media.schema = ref;
      // The shared root `<Entity>Item` is what an includable-relation marker
      // on another entity resolves a `$ref` to — record the name it actually
      // landed on. A per-operation `<Entity><Operation>` shape is a different
      // component and never a relation target. First-wins, to agree with
      // `SchemaRegistry`'s own collision policy: two `@Kavo` classes over one
      // entity with different configs (a pattern @kavo/nest's own tests use)
      // register `<Entity>Item` then `<Entity>Item_2`, and a marker should
      // point at the first.
      if (!scoped && typeof ref.$ref === "string" && !itemComponentByEntity.has(entity)) {
        itemComponentByEntity.set(entity, ref.$ref.slice(REF_PREFIX.length));
      }
    }
  }
}

/**
 * The `<Entity>Pagination` / `<Entity>Include` / `<Entity>Sort` (issue #313)
 * and `<Entity>Filter` / `<Entity>Query` (issue #314, ADR-0042) query-shape
 * components. `applyQuerySchemaDocs` (`swagger.ts`) stamped them, keyed by
 * slot, as an `x-kavo-query-schemas` extension on every enabled read route at
 * bind time; this lifts each into `components.schemas` under
 * `<Entity><Slot-in-PascalCase>` through the same registry the DTO schemas
 * use, so identical repeats across an entity's read routes collapse onto one
 * component and a genuine cross-entity name clash still resolves to `_2`
 * (which `Filter`'s own recursive `and`/`or`/`not` `$ref`s, and `Query`'s
 * `$ref`s to its sibling slots, do not chase — ADR-0042 accepts that as the
 * same edge case `<Entity>Pagination_2` already lives with). The extension is
 * dropped afterwards — it is plumbing, not published surface, and a document
 * that skipped `registerKavoSchemas` keeps the raw blob instead.
 */
function hoistQuerySchemas(registry: SchemaRegistry, operation: OperationObject, entity: string): void {
  const slots = operation["x-kavo-query-schemas"];
  if (slots === null || typeof slots !== "object") {
    return;
  }
  const bySlot: Record<string, string> = {
    pagination: "Pagination",
    include: "Include",
    sort: "Sort",
    filter: "Filter",
    query: "Query",
  };
  for (const [slot, suffix] of Object.entries(bySlot)) {
    const schema = (slots as Record<string, unknown>)[slot];
    if (schema !== undefined && typeof schema === "object" && schema !== null) {
      registry.register(schema as SchemaObject, `${entity}${suffix}`);
    }
  }
  delete operation["x-kavo-query-schemas"];
}

/** Capitalise the first character of a camelCase operation id. */
function pascalCase(id: string): string {
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
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
   * it would leave the un-`$ref`'d name visible twice — and the internal
   * `x-kavo-operation-scoped` plumbing marker, which has done its job once
   * the name is chosen (the `x-kavo-entity` / `x-kavo-error` links back to
   * Kavo are kept, per #294).
   */
  register(schema: SchemaObject, preferredName: string): SchemaObject {
    const stored = stripInternal(clone(schema));
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

function stripInternal(schema: SchemaObject): SchemaObject {
  delete schema.title;
  delete schema["x-kavo-operation-scoped"];
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
