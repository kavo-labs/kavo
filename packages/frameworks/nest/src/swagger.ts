import { createRequire } from "node:module";
import type {
  ClassRef,
  DtoResolver,
  EntityConfig,
  OperationDescriptor,
  OperationDtoMap,
  QueryFieldSelector,
  RelationFieldSelector,
} from "@kavo/core";
import { DefaultDtoResolver } from "@kavo/core";
import type { KavoHttpMethod } from "./operation-metadata.js";
import { isSchemaHint, readSchemaHint, type SchemaHint } from "./schema-hints.js";

interface RouteShape {
  readonly method: KavoHttpMethod;
  readonly path: string;
  readonly status: number;
  readonly hasIdParam: boolean;
}

type SwaggerModule = {
  ApiOperation(options: object): MethodDecorator;
  ApiParam(options: object): MethodDecorator;
  ApiQuery(options: object): MethodDecorator;
  ApiHeader(options: object): MethodDecorator;
  ApiBody(options: object): MethodDecorator;
  ApiResponse(options: object): MethodDecorator;
};

let cached: SwaggerModule | null | undefined;

/**
 * `@nestjs/swagger` is an *optional* peer: when it is installed, generated
 * routes are documented (operation ids, the `:id` param, the query
 * params on list routes, registered DTO classes as body schemas, and the
 * problem-details error responses from the error catalog); when it is
 * not, this whole module is a no-op — Kavo never forces the dependency.
 */
function loadSwagger(): SwaggerModule | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("@nestjs/swagger") as SwaggerModule;
  } catch {
    cached = null;
  }
  return cached;
}

const PROBLEM_DETAILS_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", example: "https://kavo.dev/errors/kavo-not-found" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string", example: "KAVO_NOT_FOUND" },
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          code: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

const ETAG_RESPONSE_HEADER = {
  description: "Strong entity-tag of this exact representation; usable as an If-None-Match or If-Match token.",
  schema: { type: "string" },
} as const;

/**
 * The generic syntax of every query param and conditional-request header a
 * generated route can carry — identical on every route of every entity in
 * every app, so it is documented **once** here rather than repeated as
 * boilerplate across a Swagger document's routes (issue #171 follow-up).
 * An app splices this into its own top-level document description, e.g.
 * `new DocumentBuilder().setDescription(\`...\${KAVO_API_GUIDE}\`)`.
 * Per-route `ApiQuery`/`ApiHeader` descriptions then carry only what this
 * general guide *can't* say: which fields/relations this entity's config
 * actually allows (see `listQueryParams` and the `include` block below).
 * Conditional-request headers have nothing entity-specific to add at all —
 * `If-None-Match`/`If-Match`'s semantics never vary by entity — so they
 * carry no per-route description whatsoever, deferring entirely to this
 * guide (ADR-0020).
 */
export const KAVO_API_GUIDE = `### List query parameters

- \`filter\`: filter[field][operator]=value (operators: eq, ne, gt, gte, lt, lte, in, notIn, like, ilike, between, isNull, isNotNull; or/and/not groups; JSON escape hatch via filter={...}).
- \`sort\`: comma-separated fields; '-' prefix = descending.
- \`limit\`: page size (clamped to the configured maximum).
- \`offset\`: zero-based index of the first returned row.
- \`fields\`: sparse fieldset — comma-separated field names.

Each list route's own \`filter\`/\`sort\`/\`fields\` parameter description names which fields are actually allowed, where the entity's config makes that known.

### Relation includes (every read route)

- \`include\`: comma-separated relation paths to embed, dot-separated for nesting (e.g. \`include=owner,pets.tags\`).
- \`fields[relation]\`: sparse fieldset for an included relation node (e.g. \`fields[owner]=id,name\`).

Each read route's own \`include\` parameter description names which relations are actually includable on that entity.

### Conditional requests (single-row routes only)

- \`If-None-Match\`: revalidate a cached copy — a matching entity-tag answers 304 with no body.
- \`If-Match\`: apply this write only if the row's current ETag is one of these entity-tags. Take the tag from an unnarrowed read — a \`fields=\`/\`include=\`-narrowed one identifies a different representation and will not match.`;

/**
 * The `filter`/`sort`/`limit`/`offset`/`fields` params on a list route.
 * `limit`/`offset` carry no per-route description at all — their syntax is
 * always generic, so it lives only in `KAVO_API_GUIDE`.
 * `filter`/`sort`/`fields` carry a description exactly when decoration
 * time can name the entity's actual allowlisted fields (issue #171):
 *
 * `allowlists` sits outside `resolveEntityConfig`'s `SETTINGS_KEYS`
 * (`packages/core/src/config/resolve-entity-config.ts`): it merges from
 * nowhere but the entity's own `EntityConfig` — no global default, no
 * per-operation override — so, unlike `caching.etag` (see
 * `applyConditionalRequestDocs`), there is no later-arriving scope this can
 * miss. Only its **shape** limits what can be
 * read here: an explicit array selector is used verbatim by
 * `resolveFieldSelector`, with no ORM metadata involved, so it is exactly
 * the value `ResolvedEntityConfig.allowlists` will carry — reading it off
 * the raw config is not a guess. The unconfigured default and `{ exclude }`
 * both resolve against the entity's own columns, which come from ORM
 * metadata that does not exist yet at `@Kavo` decoration time (ADR-0012) —
 * the same limitation `QueryFieldSelector`'s own doc comment names for
 * `exclude` — so those carry no description, deferring entirely to the
 * general guide, rather than imply a narrower list than actually exists.
 */
function listQueryParams(config: EntityConfig<object> | undefined): readonly { name: string; description?: string }[] {
  const allowlists = config?.allowlists;
  return [
    { name: "filter", description: allowedFieldsDescription(allowlists?.filterable) },
    { name: "sort", description: allowedFieldsDescription(allowlists?.sortable) },
    { name: "limit" },
    { name: "offset" },
    { name: "fields", description: allowedFieldsDescription(allowlists?.selectable) },
  ];
}

function allowedFieldsDescription(selector: QueryFieldSelector<object> | undefined): string | undefined {
  const fields = explicitAllowlist(selector);
  if (fields === null) return undefined;
  // An explicit empty array is a real, allowed configuration ("nothing is
  // filterable"), and must read as a closed door rather than as nothing to
  // say at all — the same distinction `includableRelations` draws below.
  return fields.length === 0 ? "No field is allowed." : `Allowed fields: ${fields.join(", ")}.`;
}

function explicitAllowlist(selector: QueryFieldSelector<object> | undefined): readonly string[] | null {
  if (selector === undefined || "exclude" in selector) return null;
  return selector;
}

export function applySwaggerMetadata(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: RouteShape,
  entity: ClassRef,
  config: EntityConfig<object> | undefined,
): void {
  const swagger = loadSwagger();
  if (swagger === null) return;

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const apply = (decorator: MethodDecorator): void => {
    decorator(prototype, methodName, propertyDescriptor);
  };

  apply(
    swagger.ApiOperation({
      operationId: `${entity.name}_${descriptor.id}`,
      summary: `${descriptor.id} (${entity.name})`,
    }),
  );

  if (route.hasIdParam) {
    apply(swagger.ApiParam({ name: "id", required: true }));
  }

  // Read from the descriptor, not from the id: `findMany` is simply the
  // standard entry with cardinality `"many"`, and a custom read declaring
  // the same shape (issue #145) takes the same query params through the
  // same normalizer.
  const isList = descriptor.kind === "read" && descriptor.cardinality === "many";
  if (isList) {
    for (const param of listQueryParams(config)) {
      apply(
        swagger.ApiQuery({
          name: param.name,
          required: false,
          type: String,
          ...(param.description !== undefined ? { description: param.description } : {}),
        }),
      );
    }
  }

  // Includes are documented from the entity config's relation allowlist —
  // the only relation knowledge decoration time has (ADR-0012). Every read
  // supports `include` with identical semantics, single-item ones included.
  // The generic `include`/`fields[relation]` syntax lives only in
  // `KAVO_API_GUIDE`; per-route, `include` carries just which
  // relations this entity actually allows (mirroring `listQueryParams`
  // above), and `fields[relation]` carries no description at all — its
  // relation name is already the param name, so there is nothing
  // entity-specific left to add. When no relation is includable, the
  // parameter could never do anything, so it is omitted entirely rather
  // than advertised with a "nothing is includable" description.
  if (descriptor.kind === "read") {
    const includable = includableRelations(config);
    // `null` means decoration time cannot know the set (an `{ exclude }`
    // selector) — the parameter may still do something, so it is emitted
    // undescribed, the same treatment `filterable`/`sortable`/`selectable`
    // get for their own `{ exclude }` form. An empty array is a known,
    // closed set — the parameter could never do anything, so it is omitted
    // entirely rather than advertised with a "nothing is includable"
    // description.
    if (includable === null) {
      apply(
        swagger.ApiQuery({
          name: "include",
          required: false,
          type: String,
        }),
      );
    } else if (includable.length > 0) {
      apply(
        swagger.ApiQuery({
          name: "include",
          required: false,
          type: String,
          description: `Includable: ${includable.join(", ")}.`,
        }),
      );
      for (const relation of includable) {
        apply(
          swagger.ApiQuery({
            name: `fields[${relation}]`,
            required: false,
            type: String,
          }),
        );
      }
    }
  }

  // The slot fallbacks (`patch`→`update`, `list`→`item`) belong to the core
  // resolver, not to this file: documenting a shape the engine would not
  // actually use is a lie that no test would catch. The resolver needs only
  // the DTO map, so it is legal at decoration time (ADR-0012).
  const dtoResolver = new DefaultDtoResolver(config?.dto as OperationDtoMap<object> | undefined);

  const bodyDto = bodyDtoFor(descriptor, dtoResolver);
  if (bodyDto !== null) {
    apply(swagger.ApiBody(bodyOptionsFor(bodyDto)));
  }

  // The success response's ETag header and the conditional-request
  // headers/304/412 responses (ADR-0020) are applied later, by
  // `applyConditionalRequestDocs` — see its doc comment for why: whether
  // they belong on this route depends on `caching.etag` resolved through
  // the *full* precedence chain, which decoration time cannot see
  // (ADR-0012).
  apply(
    swagger.ApiResponse({
      status: route.status,
      description: "Success",
      ...successBodyFor(descriptor, route, entity, dtoResolver),
    }),
  );
  apply(
    swagger.ApiResponse({
      status: 400,
      description: "Query validation failed (RFC 9457 problem details).",
      schema: PROBLEM_DETAILS_SCHEMA,
    }),
  );
  if (route.hasIdParam) {
    apply(
      swagger.ApiResponse({
        status: 404,
        description: "Not found (RFC 9457 problem details).",
        schema: PROBLEM_DETAILS_SCHEMA,
      }),
    );
  }
  if (descriptor.id === "restoreOne" || descriptor.id === "purgeOne") {
    apply(
      swagger.ApiResponse({
        status: 409,
        description: "The row is not deleted (RFC 9457 problem details).",
        schema: PROBLEM_DETAILS_SCHEMA,
      }),
    );
  }
}

/**
 * The conditional-request surface of one route (ADR-0020): the `ETag`
 * response header, and — on single-row routes — the `If-None-Match`/
 * `If-Match` request header plus its `304`/`412` response. Applied
 * separately from `applySwaggerMetadata`, and later, because whether any of
 * this belongs on the route depends on `caching.etag` resolved through the
 * *full* precedence chain (built-in default → global → entity →
 * operation), and the global scope only arrives with
 * `KavoModule.forRoot`/`forRootAsync` — long after `@Kavo` decoration runs
 * (ADR-0012).
 *
 * `KavoModule`'s discovery binder (`KavoBinder`, `kavo.module.ts`) is what
 * calls this: by `onModuleInit` it already resolved the entity's full
 * config to bind the service, so it re-derives the true `cached` value from
 * that resolution — `resolveEntityConfig`'s own precedence merge, not a
 * second guess at it here — and calls this once per route the entity
 * decorated, standard and `@Override`d alike. A caller with no
 * `KavoModule.forRoot`/`forRootAsync` in its module graph never reaches
 * this, so its routes carry no conditional-request docs at all, rather
 * than the entity/operation-scope answer decoration time could have
 * given — the same graph shape leaves them with no working `@Kavo`
 * service either, so nothing about that app actually works yet.
 *
 * `If-None-Match`/`If-Match`'s own semantics never vary by entity, so
 * their `ApiHeader` carries no description at all — the full explanation
 * lives only in `KAVO_API_GUIDE`.
 *
 * Idempotent per method function: `KavoBinder`'s `onModuleInit` runs once
 * per app *bootstrap*, but a decorated method's function object is shared
 * process-wide (the controller class outlives any one app instance — the
 * same reason `registeredKavoControllers` is process-scoped), and
 * `@nestjs/swagger`'s own `ApiHeader`/`ApiResponse` decorators only ever
 * append or merge, never replace. A second app bootstrapping the same
 * class — deliberately common in `@kavo/nest`'s own tests — would
 * otherwise double up every conditional-request header on every rebind.
 * `alreadyDocumented` guards against exactly that; it freezes the first
 * *positive* answer for a given method. Once a `cached: true` bootstrap has
 * applied these docs and recorded the method, a later bootstrap of the same
 * class that resolves `cached: false` returns at the `!cached` check above
 * without ever consulting the set, so it cannot retract what the earlier
 * bootstrap applied. A real app never notices, since it bootstraps exactly
 * once.
 */
const alreadyDocumented = new WeakSet<object>();

export function applyConditionalRequestDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: RouteShape,
  cached: boolean,
): void {
  if (!cached) return;
  const swagger = loadSwagger();
  if (swagger === null) return;

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyDocumented.has(method)) return;
  alreadyDocumented.add(method);
  const apply = (decorator: MethodDecorator): void => {
    decorator(prototype, methodName, propertyDescriptor);
  };

  // Collection responses carry no ETag (ADR-0020) — which is a statement
  // about cardinality, not about one operation id.
  const tagged = route.status !== 204 && descriptor.cardinality !== "many";
  if (tagged) {
    // No `description` here: `mergeResponseEntry` (`@nestjs/swagger`)
    // concatenates a non-empty incoming description onto the existing one
    // rather than replacing it, and the "Success" description was already
    // applied at decoration time — repeating it here would render as
    // "Success\n\nSuccess".
    apply(swagger.ApiResponse({ status: route.status, headers: { ETag: ETAG_RESPONSE_HEADER } }));
  }
  if (route.hasIdParam) {
    if (descriptor.kind === "read") {
      apply(swagger.ApiHeader({ name: "If-None-Match", required: false }));
      apply(swagger.ApiResponse({ status: 304, description: "The client's cached representation is still current." }));
    } else {
      apply(swagger.ApiHeader({ name: "If-Match", required: false }));
      apply(
        swagger.ApiResponse({
          status: 412,
          description: "The If-Match precondition failed or cannot be evaluated (RFC 9457 problem details).",
          schema: PROBLEM_DETAILS_SCHEMA,
        }),
      );
    }
  }
}

/**
 * Choose how `@ApiBody` documents a DTO. Kavo DTOs carry their shape in
 * runtime field initializers (no `@ApiProperty` decorators, by design), and
 * `@nestjs/swagger` cannot read those — passing `{ type }` alone yields an
 * empty schema, so the request body renders with no fields. When a fresh
 * instance exposes own enumerable properties we build an explicit JSON
 * schema from them; when it does not (a `@ApiProperty`-decorated or purely
 * declarative class) we defer to Swagger's own `{ type }` introspection.
 */
function bodyOptionsFor(bodyDto: ClassRef): object {
  const schema = schemaFromDto(bodyDto);
  if (schema === null) return { type: bodyDto };
  return { schema: { title: bodyDto.name, ...schema } };
}

/**
 * The success-response schema for a generated route, derived from the
 * resolved response DTO the same way request bodies are (runtime shape →
 * explicit JSON schema; decorated/declarative classes fall back to
 * Swagger's own `{ type }` introspection).
 *
 * The branch is the descriptor's own cardinality rather than a list of
 * operation ids, because that is exactly what `KavoEngine.mapResponse`
 * branches on: a `"many"` operation is wrapped in Kavo's list envelope
 * around the `list` element, everything else documents the `item` DTO (or
 * the entity when no `item` slot is registered). A `204` has no body at
 * all and returns before either. Written this way, a custom operation
 * (issue #145) is documented with the shape it actually serves instead of
 * falling off the end of a switch into a blank response.
 */
function successBodyFor(
  descriptor: OperationDescriptor<object>,
  route: RouteShape,
  entity: ClassRef,
  dtoResolver: DtoResolver<object>,
): object {
  if (route.status === 204) return {};
  // Descriptor override first, same fallback order as `mapResponse`
  // (issue #131): the engine serializes through `descriptor.output` ahead
  // of the entity's root `item`/`list` slot, so documenting the slot alone
  // would advertise a shape no response actually has.
  const resolve = (slot: "item" | "list"): ClassRef =>
    (descriptor.output as ClassRef | null) ?? (dtoResolver.resolve(slot, descriptor.id) as ClassRef | null) ?? entity;
  if (descriptor.cardinality === "many") {
    // `list` falls back to `item` inside the resolver.
    const listDto = resolve("list");
    return { schema: listEnvelopeSchema(schemaFromDto(listDto), listDto.name) };
  }
  // Restore reuses the `item` slot — no dedicated restore shape — and so
  // does every custom single-row operation that registers no `dto.output`.
  const itemDto = resolve("item");
  const schema = schemaFromDto(itemDto);
  return schema === null ? { type: itemDto } : { schema: { title: itemDto.name, ...schema } };
}

/**
 * The list envelope, wrapping the resolved list-element schema.
 *
 * `required` names the four fields every list response carries, which
 * leaves `meta` as the one a client must not assume: it is omitted from
 * the body unless a `findMany` handler contributed to it.
 *
 * `meta` is also the one field with no static shape to document. Unlike
 * `items` — projected through the `list` DTO, so `schemaFromDto` can read
 * real fields off it — `ListMetaDto` is an open `[key: string]: unknown`
 * bag filled at request time by handler code Kavo never sees, so there is
 * nothing to enumerate at decoration time. `additionalProperties: true`
 * says exactly that; without it, a bare `{ type: "object" }` with no
 * `properties` reads to most OpenAPI generators as an object with *no*
 * permitted keys, which is the opposite of what this field is.
 */
function listEnvelopeSchema(
  element: { type: "object"; properties: Record<string, object> } | null,
  title: string,
): object {
  return {
    title: `${title}List`,
    type: "object",
    required: ["items", "limit", "offset", "total"],
    properties: {
      items: {
        type: "array",
        items: element ?? { type: "object" },
      },
      limit: { type: "integer" },
      offset: { type: "integer" },
      total: { type: "integer", nullable: true },
      meta: {
        type: "object",
        additionalProperties: true,
        description:
          "Open metadata bag about the list itself, filled by the findMany " +
          "handler (see FindManyResult.meta / withListMeta). Absent when " +
          "nothing contributed; its keys are application-defined and are " +
          "not projected through a DTO.",
      },
    },
  };
}

function schemaFromDto(bodyDto: ClassRef): { type: "object"; properties: Record<string, object> } | null {
  let instance: Record<string, unknown>;
  try {
    instance = new (bodyDto as new () => Record<string, unknown>)();
  } catch {
    return null;
  }
  const keys = Object.keys(instance);
  if (keys.length === 0) return null;
  const properties: Record<string, object> = {};
  for (const key of keys) {
    properties[key] = jsonSchemaForValue(instance[key]);
  }
  return { type: "object", properties };
}

/** Infer a JSON-schema fragment from a DTO field's initializer value. */
function jsonSchemaForValue(value: unknown): object {
  if (isSchemaHint(value)) return schemaForHint(readSchemaHint(value));
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "bigint":
      return { type: "integer" };
    case "object":
      if (value instanceof Date) return { type: "string", format: "date-time" };
      if (Array.isArray(value)) return { type: "array", items: {} };
      if (value !== null) return { type: "object" };
      return {};
    default:
      return {};
  }
}

/** Expand a schema hint (enum / oneOf array) into its OpenAPI fragment. */
function schemaForHint(hint: SchemaHint): object {
  switch (hint.kind) {
    case "enum":
      return {
        type: hint.numeric ? "number" : "string",
        enum: [...hint.values],
        ...(hint.example !== undefined ? { example: hint.example } : {}),
      };
    case "oneOfArray":
      return {
        type: "array",
        items: {
          oneOf: hint.variants.map((variant) => {
            const schema = schemaFromDto(variant);
            return schema === null ? { type: "object" } : { title: variant.name, ...schema };
          }),
        },
      };
  }
}

/**
 * Relation names this entity's config opens to `include=`
 * (`allowlists.includable`, ADR-0028) — or `null` when decoration time
 * cannot know the set at all.
 *
 * Unlike `filterable`/`sortable`/`selectable`, `includable` is opt-in: an
 * unconfigured key resolves to `[]`, not "every relation" (`resolveAllowlists`
 * in core), and that default needs no ORM metadata to compute — so `undefined`
 * here is a real, known empty set, not an unknown one. Only an `{ exclude }`
 * selector is unresolvable without ORM metadata (same limitation
 * `listQueryParams` documents for the other three keys); `null` signals that
 * case so the caller advertises `include` rather than omitting a parameter
 * that may well do something.
 */
function includableRelations(config: EntityConfig<object> | undefined): readonly string[] | null {
  const selector = (config?.allowlists as { includable?: RelationFieldSelector<object> } | undefined)?.includable;
  if (selector === undefined) return [];
  if ("exclude" in selector) return null;
  return selector;
}

function bodyDtoFor(descriptor: OperationDescriptor<object>, dtoResolver: DtoResolver<object>): ClassRef | null {
  if (descriptor.input !== null) return descriptor.input as ClassRef;
  const resolve = (slot: "create" | "update" | "patch"): ClassRef | null =>
    dtoResolver.resolve(slot, descriptor.id) as ClassRef | null;
  switch (descriptor.id) {
    case "createOne":
      return resolve("create");
    case "updateOne":
      return resolve("update");
    case "patchOne":
      // `patch` falls back to `update` inside the resolver.
      return resolve("patch");
    default:
      return null;
  }
}
