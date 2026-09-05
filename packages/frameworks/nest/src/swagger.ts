import { createRequire } from "node:module";
import type {
  ClassRef,
  DtoResolver,
  EntityConfig,
  EntityMetadata,
  FieldMetadata,
  OperationDescriptor,
  OperationDtoMap,
  RelationCardinality,
  RelationFieldSelector,
} from "@kavo/core";
import { DefaultDtoResolver, shorthandFieldsOf } from "@kavo/core";
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
  ApiExtension(extensionKey: string, extensionProperties: unknown): MethodDecorator;
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
  if (cached !== undefined) {
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    cached = require("@nestjs/swagger") as SwaggerModule;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The RFC 9457 problem-details body every 400/404/409/412 answers with. The
 * `x-kavo-error` markers here are the counterpart of `x-kavo-entity` on the
 * DTO schemas (#294): `registerKavoSchemas` (`register-schemas.ts`) uses
 * them to hoist this shape — and its nested `errors[]` entry — into
 * `components.schemas` as `KavoProblemDetails` / `KavoProblemDetailError`.
 */
const PROBLEM_DETAILS_SCHEMA = {
  "x-kavo-error": true,
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
        "x-kavo-error": true,
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
- \`limit\`: page size (clamped to the configured maximum). Rejected outright on an entity configured with \`pagination.strategy: "none"\`, which always returns the whole match set instead.
- \`offset\`: zero-based index of the first returned row. Same rejection as \`limit\` under \`pagination.strategy: "none"\`.
- \`select\`: sparse fieldset — comma-separated field names.
- \`search[query]\`: free-text search across the entity's searchable fields, composed (AND) with any \`filter\`. \`search[mode]\` (\`substring\`, the default, or \`words\`) and \`search[fields]\` (narrows to a subset of the entity's searchable fields) are optional modifiers, and require \`search[query]\` to be present. Only present on entities that have search enabled — see this route's own \`search[fields]\` description.

Each list route's own \`filter\`/\`sort\`/\`select\`/\`search[fields]\` parameter description names which fields are actually allowed, where the entity's config makes that known.

### Relation includes (every read route)

- \`include\`: comma-separated relation paths to embed, dot-separated for nesting (e.g. \`include=owner,pets.tags\`).
- \`select[relation]\`: sparse fieldset for an included relation node (e.g. \`select[owner]=id,name\`).

Each read route's own \`include\` parameter description names which relations are actually includable on that entity.

### Conditional requests (single-row routes only)

- \`If-None-Match\`: revalidate a cached copy — a matching entity-tag answers 304 with no body.
- \`If-Match\`: apply this write only if the row's current ETag is one of these entity-tags. Take the tag from an unnarrowed read — a \`select=\`/\`include=\`-narrowed one identifies a different representation and will not match.`;

/**
 * The `filter`/`sort`/`select` params on a list route — `limit`/`offset`
 * are deliberately not here, see {@link applyPaginationDocs}. A description
 * exactly when decoration time can name the entity's actual allowlisted
 * fields (issue #171):
 *
 * `allowed` sits outside `resolveEntityConfig`'s `SETTINGS_KEYS`
 * (`packages/core/src/config/resolve-entity-config.ts`): it merges from
 * nowhere but the entity's own `EntityConfig` — no global default, no
 * per-operation override — so, unlike `cache.etag` (see
 * `applyConditionalRequestDocs`), there is no later-arriving scope this can
 * miss. Only its **shape** limits what can be
 * read here: an explicit array selector is used verbatim by
 * `resolveFieldSelector`, with no ORM metadata involved, so it is exactly
 * the value `ResolvedEntityConfig.allowed` will carry — reading it off
 * the raw config is not a guess. The unconfigured default and `{ exclude }`
 * both resolve against the entity's own columns, which come from ORM
 * metadata that does not exist yet at `@Kavo` decoration time (ADR-0012) —
 * the same limitation `QueryFieldSelector`'s own doc comment names for
 * `exclude` — so those carry no description, deferring entirely to the
 * general guide, rather than imply a narrower list than actually exists.
 */
function listQueryParams(config: EntityConfig<object> | undefined): readonly { name: string; description?: string }[] {
  return [
    { name: "filter", description: allowedFieldsDescription(config?.filter?.fields) },
    { name: "sort", description: allowedFieldsDescription(config?.sort?.fields) },
    { name: "select", description: allowedFieldsDescription(config?.select?.fields) },
  ];
}

function allowedFieldsDescription(selector: unknown): string | undefined {
  const fields = explicitAllowlist(selector);
  if (fields === null) {
    return undefined;
  }
  // An explicit empty array is a real, allowed configuration ("nothing is
  // filterable"), and must read as a closed door rather than as nothing to
  // say at all — the same distinction `includableRelations` draws below.
  return fields.length === 0 ? "No field is allowed." : `Allowed fields: ${fields.join(", ")}.`;
}

/**
 * The plain-array spelling only — `{ exclude }` resolves against ORM
 * metadata that doesn't exist at `@Kavo` decoration time (ADR-0012), and
 * `filter.fields`'s map form (issue #386) names a *restriction* per field,
 * not a flat field list, so neither can be read here.
 */
function explicitAllowlist(selector: unknown): readonly string[] | null {
  return Array.isArray(selector) ? (selector as readonly string[]) : null;
}

/**
 * Stamps `x-kavo-entity` on one inline schema this module built, linking a
 * generated DTO schema back to the Kavo entity/operation it came from
 * (issue #294) — additive to whatever OpenAPI keywords the schema already
 * carries. Only ever applied to a schema this module actually constructed
 * (`schemaFromDto` and the hand-built fallback/envelope schemas below); the
 * `{ type: DtoClass }` fallback path, where `@nestjs/swagger`'s own
 * introspection builds the schema, is a documented gap this can't reach.
 */
function withKavoEntity<T extends object>(schema: T, entityName: string): T & { "x-kavo-entity": string } {
  return { ...schema, "x-kavo-entity": entityName };
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
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const apply = (decorator: MethodDecorator): void => {
    decorator(prototype, methodName, propertyDescriptor);
  };

  apply(
    swagger.ApiOperation({
      operationId: `${entity.name}_${descriptor.id}`,
      summary: `${descriptor.id} (${entity.name})`,
      tags: [entity.name],
    }),
  );
  // Machine-readable link from this operation back to the Kavo
  // entity/operation it was generated from (issue #294) — additive to the
  // unchanged `operationId` above, for downstream tooling that would
  // otherwise have to reverse-engineer it from that string.
  apply(swagger.ApiExtension("x-kavo-entity", entity.name));
  apply(swagger.ApiExtension("x-kavo-operation", descriptor.id));
  apply(swagger.ApiExtension("x-kavo-cardinality", descriptor.cardinality));

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
  // The generic `include`/`select[relation]` syntax lives only in
  // `KAVO_API_GUIDE`; per-route, `include` carries just which
  // relations this entity actually allows (mirroring `listQueryParams`
  // above), and `select[relation]` carries no description at all — its
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
            name: `select[${relation}]`,
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
    apply(swagger.ApiBody(bodyOptionsFor(bodyDto, entity.name)));
  }

  // The success response's ETag header and the conditional-request
  // headers/304/412 responses (ADR-0020) are applied later, by
  // `applyConditionalRequestDocs` — see its doc comment for why: whether
  // they belong on this route depends on `cache.etag` resolved through
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
 * this belongs on the route depends on `cache.etag` resolved through the
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
  if (!cached) {
    return;
  }
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyDocumented.has(method)) {
    return;
  }
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
 * The `search[query]`/`search[mode]`/`search[fields]` params on a list
 * route (issue #156) — deferred the same way `applyConditionalRequestDocs`
 * is, and for the same reason: whether they belong on the route depends on
 * whether `search` resolved to an object, through the *full* precedence chain
 * (built-in default → global → entity → operation), which only exists once
 * `KavoModule`'s discovery binder resolves the entity's config —
 * `KavoBinder.onModuleInit`, long after `@Kavo` decoration ran (ADR-0012).
 *
 * Unlike `filter`/`sort`/`select` at decoration time, this late binding is
 * strictly *better* documentation for `search[fields]`, not a fallback:
 * `service.engine.config.allowed.searchable` is the fully **resolved**
 * allowlist (ORM metadata already exists by `onModuleInit`), so the
 * `{ exclude }`/unconfigured-default cases that leave `filter`/`sort`/
 * `select` undescribed at decoration time (`listQueryParams`'s doc comment)
 * are no obstacle here — `searchable` is always a concrete array by the
 * time this runs.
 *
 * Omitted entirely when search isn't enabled, the same treatment
 * `applyConditionalRequestDocs` gives the conditional-request surface when
 * `cache.etag` resolves `false` — advertising a parameter that would
 * always 400 is worse than not documenting it at all.
 */
const alreadySearchDocumented = new WeakSet<object>();

export function applySearchQueryDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  enabled: boolean,
  searchable: readonly string[],
): void {
  const isList = descriptor.kind === "read" && descriptor.cardinality === "many";
  if (!enabled || !isList) {
    return;
  }
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadySearchDocumented.has(method)) {
    return;
  }
  alreadySearchDocumented.add(method);
  const apply = (decorator: MethodDecorator): void => {
    decorator(prototype, methodName, propertyDescriptor);
  };

  apply(
    swagger.ApiQuery({
      name: "search[query]",
      required: false,
      type: String,
    }),
  );
  apply(
    swagger.ApiQuery({
      name: "search[mode]",
      required: false,
      type: String,
    }),
  );
  apply(
    swagger.ApiQuery({
      name: "search[fields]",
      required: false,
      type: String,
      description: searchable.length === 0 ? "No field is searchable." : `Allowed fields: ${searchable.join(", ")}.`,
    }),
  );
}

const UNPAGINATED_DESCRIPTION =
  "Not supported: this entity does not paginate ('pagination.strategy' is 'none') — every request serves the whole match set.";

/**
 * The `limit`/`offset` params on a list route (`pagination.strategy: "none"`,
 * ADR-0030) — deferred to bind time, the same reason `applySearchQueryDocs`
 * is: whether either is actually
 * supported depends on `pagination.strategy` resolved through the *full*
 * precedence chain (built-in default → global → entity → operation), which
 * only exists once `KavoBinder.onModuleInit` runs, long after `@Kavo`
 * decoration (ADR-0012). Unlike `search[...]`, this can't be "declared at
 * decoration time, refined here" (`applySwaggerMetadata`'s doc comment for
 * `cache.etag` describes that shape) — `@nestjs/swagger`'s own parameter
 * de-duplication (`unionWith` over `{ name, in }`, `api-parameters.
 * explorer.js`) keeps the *first* match for a given `{ name, in }` pair, so
 * a second, later `ApiQuery({ name: "limit" })` here would be silently
 * discarded rather than override one `listQueryParams` already applied.
 * `limit`/`offset` are therefore declared *only* here, never at decoration
 * time — the one param pair on a list route this file applies just once.
 *
 * Consequence, same as `applyConditionalRequestDocs`'s own: an app with no
 * `KavoModule.forRoot`/`forRootAsync` in its module graph never reaches
 * `KavoBinder.onModuleInit`, so its list routes now document neither
 * `limit` nor `offset` at all — a regression from decoration time's
 * always-present, undescribed pair. Deliberate, not missed: the same graph
 * shape leaves that app with no working `@Kavo` service either, so nothing
 * about it actually works yet.
 */
const alreadyPaginationDocumented = new WeakSet<object>();

export function applyPaginationDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  strategy: string,
): void {
  const isList = descriptor.kind === "read" && descriptor.cardinality === "many";
  if (!isList) {
    return;
  }
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyPaginationDocumented.has(method)) {
    return;
  }
  alreadyPaginationDocumented.add(method);
  const apply = (decorator: MethodDecorator): void => {
    decorator(prototype, methodName, propertyDescriptor);
  };

  const description = strategy === "none" ? UNPAGINATED_DESCRIPTION : undefined;
  apply(
    swagger.ApiQuery({
      name: "limit",
      required: false,
      type: String,
      ...(description !== undefined && { description }),
    }),
  );
  apply(
    swagger.ApiQuery({
      name: "offset",
      required: false,
      type: String,
      ...(description !== undefined && { description }),
    }),
  );
}

/**
 * The three query shapes a client generator can type straight off an
 * entity's *resolved* config — `<Entity>Pagination`, `<Entity>Include`,
 * `<Entity>Sort` (issue #313). Emitted as an `x-kavo-query-schemas`
 * extension on the route, keyed by slot (`pagination`/`include`/`sort`);
 * `registerKavoSchemas` reads that blob, names each entry
 * `<Entity><Slot-in-PascalCase>` from the operation's own `x-kavo-entity`,
 * hoists it into `components.schemas` through the same `_N`/clone rules the
 * DTO schemas use (#310), and deletes the extension. A caller that never
 * runs `registerKavoSchemas` sees the raw blob on the route instead.
 *
 * Deferred to bind time for the same reason as `applyPaginationDocs`: the
 * resolved `allowed.sortable` / `allowed.includable` and the
 * precedence-merged `pagination.strategy` only exist once
 * `KavoBinder.onModuleInit` runs, never at `@Kavo` decoration (ADR-0012,
 * ADR-0028, ADR-0030). An app with no `KavoModule.forRoot`/`forRootAsync`
 * gets none of these components — the same graceful-degradation the sibling
 * deferred doc passes accept.
 *
 * These are purely additive: the flat bracket params (`limit`/`offset`,
 * `include`, `sort`) and the `KAVO_API_GUIDE` grammar are untouched.
 *
 * Slot rules, each matching its flat-param counterpart:
 *
 * - **`pagination`** — the wire keys the resolved `pagination.strategy`'s
 *   `normalize` actually reads, via {@link paginationSlotSchema} (issue #319):
 *   `{ limit, offset }` for `offset`, `{ page[number], page[size] }` for
 *   `page`, `{ limit, cursor }` for `cursor` (opaque string, ADR-0021),
 *   `{ limit, since }` for `since` (plain string, ADR-0022). Under
 *   `pagination.strategy: "none"` it is still emitted as `{ limit, offset }`
 *   carrying `UNPAGINATED_DESCRIPTION`, exactly as `applyPaginationDocs`
 *   annotates rather than drops `limit`/`offset` (ADR-0030).
 * - **`include`** — an array whose items enum the resolved
 *   `allowed.includable` **top-level** relation names (`IncludePath<_, 1>`
 *   — `blog`, not `blog.name`; `entity-config.ts` §"the unit `includable`
 *   grants"). A nested path is formed by dotting into one at request time,
 *   governed by the target entity's own config and `limits.includeDepth`,
 *   so nested paths are deliberately *not* enumerated — the description says
 *   as much rather than let a client reject `include=a.b` that Kavo accepts.
 *   Omitted entirely when nothing is includable, matching
 *   `applySwaggerMetadata`'s "omit the `include` param" path (ADR-0028). The
 *   wire value is a comma-separated *string*, so a bare
 *   `{ type: "string", enum }` would be a lie (`include=a,b` matches no
 *   member) — modelling the parsed value as `array<enum>` is honest.
 * - **`sort`** — the same `array<enum>` form over `allowed.sortable`,
 *   with each token present both bare (ascending) and `-`-prefixed
 *   (descending) so the enum stays machine-checkable rather than pushing the
 *   sign into a `pattern` a generator would ignore. An explicit empty
 *   `sortable` still emits the component, with an empty enum and a
 *   "no field is sortable" description — the closed-door reading
 *   `allowedFieldsDescription` gives an explicit empty selector.
 *
 * `pagination` and `sort` are emitted even when unusable (an unpaginated
 * entity, an empty `sortable`) because their flat params are always present
 * on a list route; `include` is *omitted* when nothing is includable
 * because its flat param is too (ADR-0028). The asymmetry mirrors the flat
 * surface rather than being an oversight.
 *
 * `pagination`/`sort` ride list routes only (`cardinality: "many"`);
 * `include` rides every read route. Every enabled read route is stamped;
 * `registerKavoSchemas` collapses structurally-identical repeats onto one
 * component. The `include`/`sort` shapes are entity-scoped, so they always
 * match across an entity's routes; `pagination.strategy` is the one
 * per-operation input (`settingsFor(id)`) that can differ — an entity with
 * a custom list op configured `strategy: "none"` alongside a paginating
 * `findMany` gets `<Entity>Pagination` *and* `<Entity>Pagination_2`, the
 * same positional `_N` any genuine `registerKavoSchemas` clash produces.
 * Idempotent per method function via `alreadyQuerySchemaDocumented`, the
 * same guard the other bind-time passes use against a second bootstrap of
 * one controller class (routine in this package's tests).
 *
 * **`filter` and `query` (ADR-0042), list routes only, same as
 * `pagination`/`sort`** — REST's own `filter=` param is itself list-only
 * (`listQueryParams`'s `isList` guard in `applySwaggerMetadata`), so a
 * shape documenting that grammar has no single-row route to ride either.
 *
 * - **`filter`** — `<Entity>Filter`, one property per field on the
 *   resolved `filterable` allowlist that is also one of the entity's own
 *   scalar columns (`filterOperatorsSchema`); a filterable relation path
 *   (`profile.city`) is valid on the wire but not enumerable here, the
 *   same known gap `include`'s nested-path doc above already accepts —
 *   so the schema carries no `additionalProperties: false`. `and`/`or`
 *   are arrays of `Filter`, `not` is one `Filter` (the wire parser's
 *   unary shape, doc 05 §1) — both `$ref`ing back to this entity's own
 *   expected `<Entity>Filter` name, an assumption `hoistQuerySchemas`
 *   makes true absent a genuine cross-entity name collision (ADR-0042).
 * - **`query`** — `<Entity>Query`, the aggregate `filter`+`sort`+
 *   `pagination`+`select`+`include`+`search` shape for a GraphQL/MCP
 *   resolver or a programmatic `QueryContext` caller — documented-only,
 *   published as a component no REST parameter ever `$ref`s (ADR-0042).
 *   `sort`/`pagination`/`include`/`filter` `$ref` the entity's own other
 *   expected component names; `select`/`search` are inlined rather than
 *   hoisted, since this issue only asks for `Filter`/`Query` as named
 *   components. `search` is omitted when `search` doesn't resolve
 *   to an object, the same gate `applySearchQueryDocs` uses.
 */
const LIMIT_DESCRIPTION = "Page size, clamped to the configured maximum.";

/**
 * The `<Entity>Pagination` shape for one resolved `pagination.strategy`
 * (issue #319). Its properties are the literal wire keys the matching
 * `PaginationStrategy.normalize` reads (`packages/core/src/query/
 * pagination-strategies.ts`), so a generated client types the page controls
 * it will actually send:
 *
 * - **`offset`** (the default) — `{ limit, offset }` integers.
 * - **`page`** — `{ page[number], page[size] }` integers, 1-indexed.
 * - **`cursor`** — `{ limit, cursor }`; `cursor` is an opaque string echoed
 *   back from the previous page's `meta.nextCursor` (ADR-0021).
 * - **`since`** — `{ limit, since }`; `since` is a plain string echoed back
 *   from the previous poll's `meta.nextSince` (ADR-0022).
 * - **`none`** — `{ limit, offset }` integers with no per-property blurb,
 *   carrying `UNPAGINATED_DESCRIPTION` at the object level (ADR-0030), exactly
 *   as `applyPaginationDocs` annotates rather than drops the flat params.
 * - an unrecognized custom strategy name falls back to the `offset` shape.
 */
function paginationSlotSchema(strategy: string): Record<string, unknown> {
  const integer = (description: string): Record<string, unknown> => ({ type: "integer", description });

  switch (strategy) {
    case "none":
      return {
        type: "object",
        properties: { limit: { type: "integer" }, offset: { type: "integer" } },
        description: UNPAGINATED_DESCRIPTION,
      };
    case "page":
      return {
        type: "object",
        properties: {
          "page[number]": integer("1-based page number."),
          "page[size]": integer(LIMIT_DESCRIPTION),
        },
      };
    case "cursor":
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          cursor: {
            type: "string",
            description: "Opaque page token — pass back `meta.nextCursor` from the previous page verbatim.",
          },
        },
      };
    case "since":
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          since: {
            type: "string",
            description: "Seek boundary — pass back `meta.nextSince` from the previous poll verbatim.",
          },
        },
      };
    default:
      return {
        type: "object",
        properties: {
          limit: integer(LIMIT_DESCRIPTION),
          offset: integer("Zero-based index of the first returned row."),
        },
      };
  }
}

const alreadyQuerySchemaDocumented = new WeakSet<object>();

export function applyQuerySchemaDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  entityName: string,
  metadata: EntityMetadata<object>,
  resolved: {
    readonly strategy: string;
    readonly includable: readonly string[];
    readonly sortable: readonly string[];
    readonly filterable: readonly string[];
    readonly selectable: readonly string[];
    readonly searchable: readonly string[];
    readonly searchEnabled: boolean;
  },
): void {
  if (descriptor.kind !== "read") {
    return;
  }
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyQuerySchemaDocumented.has(method)) {
    return;
  }
  alreadyQuerySchemaDocumented.add(method);

  const isList = descriptor.cardinality === "many";
  const slots: Record<string, object> = {};
  const filterRef = { $ref: `#/components/schemas/${entityName}Filter` };

  if (resolved.includable.length > 0) {
    slots.include = withKavoEntity(
      {
        type: "array",
        items: { type: "string", enum: [...resolved.includable] },
        description:
          "Top-level relation names embeddable via `include=` (comma-separated). " +
          "A nested path is formed by dotting into one (e.g. `owner.pets`); nested paths are not enumerated here.",
      },
      entityName,
    );
  }

  if (isList) {
    slots.pagination = withKavoEntity(paginationSlotSchema(resolved.strategy), entityName);
    slots.sort = withKavoEntity(
      {
        type: "array",
        items: {
          type: "string",
          enum: [...resolved.sortable, ...resolved.sortable.map((token) => `-${token}`)],
        },
        description:
          resolved.sortable.length === 0
            ? "No field is sortable."
            : "Sort keys, as passed to `sort=` (comma-separated). Prefix a key with `-` for descending order.",
      },
      entityName,
    );

    const filterProperties: Record<string, object> = {};
    for (const field of metadata.fields) {
      if (resolved.filterable.includes(field.name)) {
        filterProperties[field.name] = filterOperatorsSchema(field);
      }
    }
    slots.filter = withKavoEntity(
      {
        type: "object",
        description:
          Object.keys(filterProperties).length === 0
            ? "No field is filterable."
            : "Structured filter predicate mirroring `filter[field][operator]=value` and the " +
              "`filter={...}` JSON escape hatch (docs/internals/architecture/05-query-grammar.md). " +
              "Field keys are per-field operator maps; `and`/`or` take an array of nested Filter, " +
              "`not` takes one. Relation-path filters (e.g. `profile.city`) are permitted on the wire " +
              "but not enumerated as properties here.",
        properties: {
          ...filterProperties,
          and: { type: "array", items: filterRef },
          or: { type: "array", items: filterRef },
          not: filterRef,
        },
      },
      entityName,
    );

    const queryProperties: Record<string, object> = { filter: filterRef };
    queryProperties.sort = { $ref: `#/components/schemas/${entityName}Sort` };
    queryProperties.pagination = { $ref: `#/components/schemas/${entityName}Pagination` };
    queryProperties.select = {
      type: "array",
      items: { type: "string", enum: [...resolved.selectable] },
      description: "Sparse fieldset for the root resource, as passed to `select=` (comma-separated).",
    };
    if (resolved.includable.length > 0) {
      queryProperties.include = { $ref: `#/components/schemas/${entityName}Include` };
    }
    if (resolved.searchEnabled) {
      queryProperties.search = {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["substring", "words"] },
          fields: { type: "array", items: { type: "string", enum: [...resolved.searchable] } },
        },
      };
    }
    slots.query = withKavoEntity(
      {
        type: "object",
        description:
          "The full query surface — filter, sort, pagination, select, include, search — as one " +
          "typed aggregate, for a GraphQL/MCP resolver or a programmatic QueryContext caller. " +
          "No REST parameter references this shape; REST keeps its flat query params unchanged (ADR-0042).",
        properties: queryProperties,
      },
      entityName,
    );
  }

  if (Object.keys(slots).length === 0) {
    return;
  }
  swagger.ApiExtension("x-kavo-query-schemas", slots)(prototype, methodName, propertyDescriptor);
}

/**
 * Retags the always-present `400` response (applied by `applySwaggerMetadata`
 * at decoration time with the bare `PROBLEM_DETAILS_SCHEMA`) as an
 * entity-scoped variant, so `registerKavoSchemas` can hoist it to
 * `<Entity>ValidationError` — an `allOf` over `KavoProblemDetails` — instead
 * of collapsing every entity's `400` onto the one shared component. The only
 * thing entity-specific it can add is the `x-kavo-entity` marker and a
 * name-scoping `description`; it deliberately does **not** enumerate the
 * fields a validation error may reference:
 *
 * - an `enum` on `errors[].field` would be a lie — a validation error can
 *   name a nested relation path (`owner.name`) or a non-column key, the same
 *   reason `applyBodySchemaDocs` refuses `additionalProperties: false`; and
 * - a `description` listing the resolved write/query allowlist would disagree
 *   with the request-body schema on the very same route, which is projected
 *   through the resolved `create`/`update` DTO when one is registered
 *   (`DefaultDeserializer`: an explicit DTO *replaces* the allowlist,
 *   ADR-0026's precedent) — publishing the wider allowlist would disclose
 *   internal column names the DTO boundary exists to hide.
 *
 * Deferred to bind time only so it rides the same `KavoBinder.onModuleInit`
 * pass as the other retag functions here; an app with no
 * `KavoModule.forRoot`/`forRootAsync` never reaches it, so its `400`s keep
 * the bare shape and hoist to `KavoProblemDetails` — the same
 * graceful-degradation the sibling deferred functions accept.
 */
const alreadyValidationErrorDocumented = new WeakSet<object>();

export function applyValidationErrorDoc(
  prototype: Record<string, unknown>,
  methodName: string,
  entityName: string,
): void {
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyValidationErrorDocumented.has(method)) {
    return;
  }
  alreadyValidationErrorDocumented.add(method);

  // `type: undefined` clears the key `mergeResponseEntry`'s `Object.assign`
  // would otherwise leave behind — see `applyResponseSchemaDocs`'s doc
  // comment. The decoration-time `description` ("Query validation failed…")
  // is preserved by the same merge and still accurate.
  swagger.ApiResponse({
    status: 400,
    type: undefined,
    schema: {
      "x-kavo-error": true,
      "x-kavo-entity": entityName,
      allOf: [PROBLEM_DETAILS_SCHEMA],
      description:
        `Request validation failed for the ${entityName} entity (RFC 9457 problem details). ` +
        "Each `errors[]` entry identifies the offending field.",
    },
  })(prototype, methodName, propertyDescriptor);
}

const alreadyBodySchemaDocumented = new WeakSet<object>();

/**
 * Fallback request-body schema for `createOne`/`updateOne`/`patchOne` when
 * the entity has no `dto.create`/`dto.update`/`dto.patch` (or
 * `descriptor.input` override) configured — `applySwaggerMetadata`'s own
 * `bodyDtoFor` then resolves to `null` and applies no `@ApiBody` at all,
 * leaving a route that genuinely validates and accepts a specific field set
 * undocumented (issue #264). Deferred to bind time for the same reason as
 * `applyConditionalRequestDocs`/`applySearchQueryDocs`/`applyPaginationDocs`:
 * the entity's own columns (`EntityMetadata.fields`) don't exist yet at
 * `@Kavo` decoration time (ADR-0012), and `allowed.creatable`/`updatable`
 * need the full precedence chain to be final.
 *
 * `KavoBinder.onModuleInit` calls this only when it re-derives that
 * `bodyDtoFor` resolved `null` at decoration time — so a route documented
 * from a real DTO is never touched here, and an app with no
 * `KavoModule.forRoot`/`forRootAsync` in its graph keeps today's
 * no-body-schema behavior, the same limitation the other three deferred doc
 * functions already carry.
 *
 * The synthesized schema names exactly the columns `creatable`/`updatable`
 * actually allow — generated columns excluded the same way the default
 * deserializer already strips them from write payloads — but deliberately
 * carries no `additionalProperties: false`: `creatable`/`updatable` narrow
 * *silently* (`docs/features/allowed.md`'s opening line), the same way an
 * unknown body key already does, so declaring the schema closed would tell a
 * validating client/gateway that a body Kavo actually accepts is invalid.
 * A schema that ends up with no properties at all still has to read as "no
 * field is allowed" rather than fall through to no documentation — an empty
 * `properties: {}` with no `description` reads to a client generator as
 * "this route takes no body", which is a lie (issue #339). That case gets a
 * `description` saying so instead of a schema constraint — the same
 * distinction `allowedFieldsDescription` draws for an explicit empty
 * selector.
 *
 * Relation names on `creatable`/`updatable` (associable by id, ADR-0014)
 * have no `metadata.fields` entry — `metadata.fields` is scalar columns
 * only — so they are picked up from `metadata.relations` instead and
 * documented as the reference-object shape the deserializer accepts:
 * `{ "id": ... }` for a to-one, an array of them for a to-many, either
 * nullable so `null` can disassociate. The related row's id *type* is taken
 * from the target entity's own metadata via `relationTargetMetadata` (the
 * binder resolves it through `infrastructure.metadataFor(relation.target())`);
 * `id` stays untyped (`{}`) when the target is unresolvable — no
 * infrastructure, or a root that cannot derive its metadata — and also when
 * the target is a **composite-key** entity, where a single scalar `id` would
 * be an outright wrong assertion rather than an honest blank. A relation
 * never joins the outer `required` list (`RelationDescriptor` carries no
 * nullability).
 */
export function applyBodySchemaDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  metadata: EntityMetadata<object>,
  writableAllowed: { readonly creatable: readonly string[]; readonly updatable: readonly string[] },
  relationTargetMetadata: Readonly<Record<string, EntityMetadata<object>>>,
): void {
  const allowed = allowedFieldsFor(descriptor.id, writableAllowed);
  if (allowed === null) {
    return;
  }
  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }

  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyBodySchemaDocumented.has(method)) {
    return;
  }
  alreadyBodySchemaDocumented.add(method);

  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const field of metadata.fields) {
    if (field.generated || !allowed.includes(field.name)) {
      continue;
    }
    properties[field.name] = fieldSchema(field);
    if (!field.nullable) {
      required.push(field.name);
    }
  }
  // A relation on the allowlist is associable by id (ADR-0014): it is
  // written as a `{ "id": ... }` reference object — an array of them for a
  // to-many — or `null` to disassociate. It has no `metadata.fields` entry,
  // so it is emitted from `metadata.relations` here; without this, an entity
  // whose entire writable projection is relations synthesizes an empty
  // `properties: {}` that reads as "no body" (issue #339).
  for (const relation of metadata.relations) {
    if (!allowed.includes(relation.name)) {
      continue;
    }
    const target = relationTargetMetadata[relation.name];
    // A composite-key target has no single `id` column — `metadata.idField`
    // is just its first key part — so a typed scalar `id` would be a wrong
    // assertion; leave it `{}` for that case (finding #261).
    const idField =
      target !== undefined && target.compositeIdFields === undefined
        ? target.fields.find((field) => field.name === target.idField)
        : undefined;
    properties[relation.name] = associationBodySchema(
      relation.cardinality,
      idField !== undefined ? fieldSchema(idField) : undefined,
    );
  }
  // `patchOne` is a partial update — every field is optional regardless of
  // column nullability — so it never carries `required`. `createOne` and
  // `updateOne` replace the row, so a non-nullable column the caller is
  // allowed to write is genuinely required. A database `default:` cannot be
  // told apart from a true requirement here (`FieldMetadata` has no
  // `hasDefault`), so such a column is reported required — a known, narrow
  // over-statement, not a lie about what the route accepts.
  const emitRequired = descriptor.id !== "patchOne" && required.length > 0;
  swagger.ApiBody({
    schema: withKavoEntity(
      {
        title: `${metadata.name}${titleForBodyOperation(descriptor.id)}`,
        type: "object",
        properties,
        ...(emitRequired ? { required } : {}),
        ...(Object.keys(properties).length === 0 ? { description: "No field is writable." } : {}),
      },
      metadata.name,
    ),
  })(prototype, methodName, propertyDescriptor);
}

function allowedFieldsFor(
  id: string,
  allowed: { readonly creatable: readonly string[]; readonly updatable: readonly string[] },
): readonly string[] | null {
  switch (id) {
    case "createOne":
      return allowed.creatable;
    case "updateOne":
    case "patchOne":
      return allowed.updatable;
    default:
      return null;
  }
}

function titleForBodyOperation(id: string): string {
  switch (id) {
    case "createOne":
      return "Create";
    case "updateOne":
      return "Update";
    default:
      return "Patch";
  }
}

/** The base OpenAPI fragment for one column's own value type, ignoring nullability. */
function fieldKindSchema(field: FieldMetadata): object {
  switch (field.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "enum":
      return { type: "string", ...(field.enumValues !== undefined ? { enum: [...field.enumValues] } : {}) };
    case "json":
      return { type: "object" };
  }
}

/** Map one ORM-independent column description to its OpenAPI fragment. */
function fieldSchema(field: FieldMetadata): object {
  const base = fieldKindSchema(field);
  return field.nullable ? { ...base, nullable: true } : base;
}

/**
 * The request-body fragment for a write-side relation property (ADR-0014):
 * a `{ id }` reference object for a to-one, an array of them for a to-many,
 * either one nullable so `null` disassociates. `idSchema` is the target
 * entity's primary-key fragment when the caller could resolve it; `{}` (an
 * untyped id) otherwise.
 */
function associationBodySchema(cardinality: RelationCardinality, idSchema?: object): object {
  const reference = {
    type: "object",
    properties: { id: idSchema ?? {} },
    required: ["id"],
    description: "Associate by id (ADR-0014); pass `null` to disassociate.",
  };
  return cardinality === "many"
    ? { type: "array", nullable: true, items: reference }
    : { ...reference, nullable: true };
}

/**
 * The per-field operator map `<Entity>Filter` (ADR-0042) values one
 * filterable field by — `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`notIn`/
 * `between`/`isNull`/`isNotNull` for every kind, matching doc 05's grammar
 * table uniformly; `like`/`ilike` only for a string-kind field, doc 05's
 * one kind-specific restriction ("Both operators apply to string columns
 * only"). The operator value itself ignores the column's own nullability —
 * `isNull`/`isNotNull` are what a filter uses to test it — so this reads
 * `fieldKindSchema` directly rather than `fieldSchema`'s nullable-augmented
 * form.
 */
function filterOperatorsSchema(field: FieldMetadata): object {
  const value = fieldKindSchema(field);
  const properties: Record<string, object> = {
    eq: value,
    ne: value,
    gt: value,
    gte: value,
    lt: value,
    lte: value,
    in: { type: "array", items: value },
    notIn: { type: "array", items: value },
    between: { type: "array", items: value, minItems: 2, maxItems: 2 },
    isNull: { type: "boolean" },
    isNotNull: { type: "boolean" },
  };
  if (field.kind === "string") {
    properties.like = value;
    properties.ilike = value;
  }
  return { type: "object", properties };
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
function bodyOptionsFor(bodyDto: ClassRef, entityName: string): object {
  const schema = schemaFromDto(bodyDto, entityName);
  if (schema === null) {
    return { type: bodyDto };
  }
  return { schema: withKavoEntity({ title: bodyDto.name, ...schema }, entityName) };
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
  if (route.status === 204) {
    return {};
  }
  // Descriptor override first, same fallback order as `mapResponse`
  // (issue #131): the engine serializes through `descriptor.output` ahead
  // of the entity's root `item`/`list` slot, so documenting the slot alone
  // would advertise a shape no response actually has.
  const resolve = (slot: "item" | "list"): ClassRef =>
    (descriptor.output as ClassRef | null) ?? (dtoResolver.resolve(slot, descriptor.id) as ClassRef | null) ?? entity;
  // A per-operation `descriptor.output` override (issue #131) or a custom
  // operation's own `dto.output` produces a shape that is *not* the entity's
  // root `item`/`list` slot, so `registerKavoSchemas` must name its
  // component per operation (`<Entity><Operation>`) rather than fold it onto
  // the shared `<Entity>Item`/`<Entity>List` and hand the loser a
  // positional `_2`. This marker is that signal; it rides the same
  // `withKavoEntity` stamp #294 already applies.
  const operationScoped = descriptor.output !== null;
  if (descriptor.cardinality === "many") {
    // `list` falls back to `item` inside the resolver.
    const listDto = resolve("list");
    return {
      schema: listEnvelopeSchema(schemaFromDto(listDto, entity.name), listDto.name, entity.name, operationScoped),
    };
  }
  // Restore reuses the `item` slot — no dedicated restore shape — and so
  // does every custom single-row operation that registers no `dto.output`.
  const itemDto = resolve("item");
  const schema = schemaFromDto(itemDto, entity.name);
  return schema === null
    ? { type: itemDto }
    : {
        schema: withKavoEntity(
          { title: itemDto.name, ...(operationScoped ? { "x-kavo-operation-scoped": true } : {}), ...schema },
          entity.name,
        ),
      };
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
  element: { type: "object"; properties: Record<string, object>; required?: string[] } | null,
  title: string,
  entityName: string,
  operationScoped = false,
): object {
  return withKavoEntity(
    {
      title: `${title}List`,
      ...(operationScoped ? { "x-kavo-operation-scoped": true } : {}),
      type: "object",
      required: ["items", "limit", "offset", "total"],
      properties: {
        items: {
          type: "array",
          items: element === null ? { type: "object" } : withKavoEntity(element, entityName),
        },
        limit: { type: "integer" },
        offset: { type: "integer" },
        total: { type: "integer", nullable: true },
        meta: withKavoEntity(
          {
            type: "object",
            additionalProperties: true,
            description:
              "Open metadata bag about the list itself, filled by the findMany " +
              "handler (see FindManyResult.meta / withListMeta). Absent when " +
              "nothing contributed; its keys are application-defined and are " +
              "not projected through a DTO.",
          },
          entityName,
        ),
      },
    },
    entityName,
  );
}

const alreadyResponseSchemaDocumented = new WeakSet<object>();

/**
 * Fallback success-response schema, narrowed to `selectable`, for a route
 * whose `item`/`list` DTO `successBodyFor` had nothing but the entity itself
 * to fall back to (issue #264's response-side counterpart to
 * `applyBodySchemaDocs`). Without this, `successBodyFor`'s `schemaFromDto`
 * reads the entity's own runtime shape unfiltered — every own column,
 * regardless of `selectable` — even though the response the engine actually
 * serializes is projected through `selectable` at request time.
 *
 * `descriptor.output !== null` or a real `item`/`list` DTO (`dtoResolver`
 * resolves non-`null`, following the same `list`→`item` internal fallback
 * `successBodyFor` already relies on) means decoration time already
 * documented a shape that has nothing to do with `selectable`, so this
 * leaves it alone. Deferred to bind time for the same reason as
 * `applyBodySchemaDocs`: both `metadata.fields` and the fully resolved
 * `allowed.selectable` only exist once `KavoBinder.onModuleInit` runs.
 *
 * A second `ApiResponse({ status, schema })` call for the same status
 * *replaces* the existing entry's `schema` while preserving its
 * `description` (`mergeResponseEntry`'s own merge rules — see
 * `applyConditionalRequestDocs`'s doc comment for why that merge is safe to
 * rely on here), so this can override what `applySwaggerMetadata` already
 * applied at decoration time rather than needing to intercept it there.
 *
 * That decoration-time entry carries `type: itemDto`, not `schema`, exactly
 * when `schemaFromDto` found no own enumerable properties on a fresh
 * instance (`successBodyFor`'s `{ type }` fallback — the common shape for a
 * real ORM entity, whose columns are declared without initializers).
 * `mergeResponseEntry`'s `Object.assign` only ever *adds* keys, so leaving
 * `type` alone here would merge it alongside our `schema` — and
 * `@nestjs/swagger`'s own `ResponseObjectFactory.create` picks the branch on
 * `type` truthiness, so a lingering `type` wins outright and the narrowed
 * `schema` this function just built would be silently discarded. `type:
 * undefined` clears that key in the merge (an explicit `undefined` is still
 * an own property `Object.assign` copies over), so the narrowed `schema`
 * is what the document actually emits.
 *
 * A relation on `allowed.includable` (ADR-0028) can be embedded in the
 * row (`?include=word`), so it is emitted as an **optional** property —
 * never in `required`, since it is only present when `include=` asks for
 * it, and this shape is shared with the write responses, which never
 * resolve `include=` at all (ADR-0020: "a write resolves no query, so a
 * write response never carries relations"). The property defers wholly to
 * the relation target's own config (ADR-0026 decision 4; the ADR-0044
 * parent-side ceiling was removed in ADR-0045):
 *
 * - When the target's metadata resolves (via `relationTargetMetadata`,
 *   which the binder fills from `infrastructure.metadataFor(relation.target())`),
 *   this emits an unstamped marker (`x-kavo-includable-ref: "<Target>"`)
 *   carrying only the target entity's resolved name. It is *not* a `$ref`
 *   yet: bind time does not know the final component name
 *   (`registerKavoSchemas` owns naming and may land on `<Target>Item_2` on
 *   a collision). `registerKavoSchemas` resolves each marker in a post-pass
 *   to `{ $ref: "#/components/schemas/<Target>Item" }`, or — when the
 *   target has no synthesized item component (its own read route registered
 *   an explicit DTO, or it has no read route) — to a degraded
 *   `{ type: "object" }` with a prose description. A document that never
 *   runs `registerKavoSchemas` keeps the marker inline, which is still a
 *   valid schema (an object with a vendor extension and a description),
 *   just not `$ref`-composed.
 *
 * - When the target's name cannot be resolved at bind time, no marker is
 *   emitted and the property stays a generic `{ type: "object" }` with a
 *   description.
 *
 * A `-to-many` relation wraps whichever shape in `{ type: "array", items }`.
 *
 * The property rides the shared `item` shape, so it appears on the
 * `createOne`/`updateOne`/`patchOne` responses too. That is deliberate:
 * gating it on `descriptor.kind === "read"` would make the read route's
 * schema structurally differ from the write routes', and
 * `registerKavoSchemas` only collapses structurally-identical repeats — so
 * every entity with an includable relation would publish both `<Entity>Item`
 * and `<Entity>Item_2`. The property is optional, so a write response that
 * omits it stays valid against the schema. For the same reason a
 * `defaultInclude: true` relation is **not** promoted to `required`: it is
 * carried only by reads, and a `required` property a write response omits
 * would make the shared schema lie.
 */
export function applyResponseSchemaDocs(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: RouteShape,
  metadata: EntityMetadata<object>,
  selectable: readonly string[],
  computedFieldNames: readonly string[],
  includable: readonly string[],
  relationTargetMetadata: Readonly<Record<string, EntityMetadata<object>>>,
  dtoResolver: DtoResolver<object>,
): void {
  if (route.status === 204) {
    return;
  }
  const isList = descriptor.cardinality === "many";
  const slot: "item" | "list" = isList ? "list" : "item";
  if (descriptor.output !== null || dtoResolver.resolve(slot, descriptor.id) !== null) {
    return;
  }

  const swagger = loadSwagger();
  if (swagger === null) {
    return;
  }
  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  const method = propertyDescriptor.value as object;
  if (alreadyResponseSchemaDocumented.has(method)) {
    return;
  }
  alreadyResponseSchemaDocumented.add(method);

  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const field of metadata.fields) {
    if (!selectable.includes(field.name)) {
      continue;
    }
    properties[field.name] = fieldSchema(field);
    // A non-nullable column is always present in a serialized row, so it is
    // `required` in the response shape. Computed fields (below) carry no type
    // information and are left optional.
    if (!field.nullable) {
      required.push(field.name);
    }
  }
  // Declared computed fields (ADR-0019) aren't in `metadata.fields` — no
  // column backs them — but the engine serializes them into every response
  // and the resolved `selectable` allowlist carries their names by default.
  // Gate them by the same `selectable` check as the columns above, so an
  // explicit `allowed.selectable` that omits or `exclude`s one (ADR-0026),
  // or a `selectable: false` descriptor, drops it here too. Computed
  // descriptors carry no type information, so the fragment is left untyped
  // and nullable rather than coerced to `string` (issue #302).
  for (const name of computedFieldNames) {
    if (!selectable.includes(name)) {
      continue;
    }
    properties[name] = { nullable: true };
  }
  // An includable relation (ADR-0028) is embedded only when `include=` asks
  // for it, so it is an *optional* property — appended after the column and
  // computed loops so those keep their exact order, and never pushed to
  // `required`. Driven off the resolved `allowed.includable` names rather
  // than `RelationDescriptor.includable`, which reflects the ORM-derived
  // metadata, not the config grant.
  for (const relationName of includable) {
    const relation = metadata.relations.find((edge) => edge.name === relationName);
    if (relation === undefined) {
      continue;
    }
    const targetMetadata = relationTargetMetadata[relationName];
    let object: object;
    if (targetMetadata !== undefined) {
      // Defer wholly to the target (ADR-0026 decision 4). Emit a marker
      // carrying the target entity's resolved name; `registerKavoSchemas`
      // turns it into a `$ref` to `<Target>Item` (or a degraded object when
      // that component was never synthesized). Unstamped by `withKavoEntity`
      // so the marker itself is not hoisted as an entity component.
      object = {
        type: "object",
        "x-kavo-includable-ref": targetMetadata.name,
        description:
          `Embedded when \`include=${relationName}\` is requested; its shape is the ` +
          `${targetMetadata.name}Item component. Its projection is governed by the target entity's own ` +
          `config (ADR-0026), not this one.`,
      };
    } else {
      // Target metadata unresolvable from this root — no name to reference,
      // so fall back to a generic object rather than a dangling marker.
      object = {
        type: "object",
        description:
          `Embedded when \`include=${relationName}\` is requested. Its projection is governed by ` +
          `the ${relationName} target's own config (ADR-0026 decision 4).`,
      };
    }
    properties[relationName] = relation.cardinality === "many" ? { type: "array", items: object } : object;
  }
  const element = { type: "object" as const, properties, ...(required.length > 0 ? { required } : {}) };
  const schema = isList
    ? listEnvelopeSchema(element, metadata.name, metadata.name)
    : withKavoEntity({ title: metadata.name, ...element }, metadata.name);
  // `type: undefined` clears whatever `type` decoration time's `{ type:
  // itemDto }` fallback left on this status's response entry — see this
  // function's doc comment for why a lingering `type` would otherwise win
  // outright over the `schema` set here.
  swagger.ApiResponse({ status: route.status, schema, type: undefined })(prototype, methodName, propertyDescriptor);
}

function schemaFromDto(
  bodyDto: ClassRef,
  entityName: string,
): { type: "object"; properties: Record<string, object> } | null {
  let instance: Record<string, unknown>;
  try {
    instance = new (bodyDto as new () => Record<string, unknown>)();
  } catch {
    return null;
  }
  const keys = Object.keys(instance);
  if (keys.length === 0) {
    return null;
  }
  const properties: Record<string, object> = {};
  for (const key of keys) {
    properties[key] = jsonSchemaForValue(instance[key], entityName);
  }
  return { type: "object", properties };
}

/** Infer a JSON-schema fragment from a DTO field's initializer value. */
function jsonSchemaForValue(value: unknown, entityName: string): object {
  if (isSchemaHint(value)) {
    return schemaForHint(readSchemaHint(value), entityName);
  }
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
      if (value instanceof Date) {
        return { type: "string", format: "date-time" };
      }
      if (Array.isArray(value)) {
        return { type: "array", items: {} };
      }
      if (value !== null) {
        return { type: "object" };
      }
      return {};
    default:
      return {};
  }
}

/** Expand a schema hint (enum / oneOf array) into its OpenAPI fragment. */
function schemaForHint(hint: SchemaHint, entityName: string): object {
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
            const schema = schemaFromDto(variant, entityName);
            return schema === null
              ? { type: "object" }
              : withKavoEntity({ title: variant.name, ...schema }, entityName);
          }),
        },
      };
  }
}

/**
 * Relation names this entity's config opens to `include=`
 * (`allowed.includable`, ADR-0028) — or `null` when decoration time
 * cannot know the set at all.
 *
 * Unlike `filterable`/`sortable`/`selectable`, `includable` is opt-in: an
 * unconfigured key resolves to `[]`, not "every relation" (`resolveAllowed`
 * in core), and that default needs no ORM metadata to compute — so `undefined`
 * here is a real, known empty set, not an unknown one. Only an `{ exclude }`
 * selector is unresolvable without ORM metadata (same limitation
 * `listQueryParams` documents for the other three keys); `null` signals that
 * case so the caller advertises `include` rather than omitting a parameter
 * that may well do something.
 */
function includableRelations(config: EntityConfig<object> | undefined): readonly string[] | null {
  const selector = config?.include?.fields as RelationFieldSelector<object> | undefined;
  if (selector === undefined) {
    return [];
  }
  if ("exclude" in selector) {
    return null;
  }
  return selector;
}

export function bodyDtoFor(descriptor: OperationDescriptor<object>, dtoResolver: DtoResolver<object>): ClassRef | null {
  if (descriptor.input !== null) {
    return descriptor.input as ClassRef;
  }
  // A `dto.<slot>` `{ fields }` shorthand (issue #386) synthesizes a real
  // class so the engine's own DTO machinery treats it uniformly, but it
  // carries no type information of its own — treated as "no real DTO" here
  // so the richer ORM-metadata-driven fallback below still runs instead of
  // NestJS's generic (untyped) class introspection.
  const resolve = (slot: "create" | "update" | "patch"): ClassRef | null => {
    const resolved = dtoResolver.resolve(slot, descriptor.id) as (new () => object) | null;
    return shorthandFieldsOf(resolved) !== null ? null : (resolved as ClassRef | null);
  };
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
