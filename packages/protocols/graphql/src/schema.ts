import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLInputObjectType,
  type GraphQLOutputType,
} from "graphql";
import type { DefaultKavoService, EntityId, OperationId, OperationRegistry, StandardOperationId } from "@kavo/core";
import { ConfigurationException, STANDARD_OPERATION_IDS } from "@kavo/core";
import { GraphQLJSON } from "./json-scalar.js";

/**
 * Refuse to bind an entity this protocol cannot page (ADR-0021 §7,
 * extended to `since` by ADR-0022).
 *
 * The list field takes `limit`/`offset` only, and `QueryNormalizer` ignores
 * `offset` under both keyset strategies — so `todos(limit: 20, offset: 40)`
 * against a cursor- or since-configured entity returns rows 1–20 (or
 * everything from the beginning) with no error and no way for the client to
 * tell. `nextCursor`/`nextSince` live in `meta`, which this binding's
 * `<Name>List` type does not carry, so page 2 (or the next poll) is
 * unreachable either way. `pagination.strategy` is entity-scope, so a single
 * `defaults: { pagination: { strategy: "cursor" } }` (or `"since"`) would
 * silently degrade every bound entity to page-one-with-wrong-answers.
 *
 * This check is name-gated on `"cursor"`/`"since"` rather than structural —
 * unlike `QueryNormalizer`, which can probe a strategy's *output* shape,
 * this runs at schema-build time with no request to normalize, so it cannot
 * ask a strategy what it would produce. A third-party keyset strategy under
 * another name is not caught here, the same limitation ADR-0021 §7 already
 * records for cursor.
 *
 * Adding `cursor`/`since`/`meta` to the schema is the eventual fix; failing
 * at bootstrap is the correct behavior until then, and stays correct after.
 * `@kavo/mcp` carries the same guard for the same reason — the two packages
 * may not import each other, so the check is duplicated rather than shared.
 */
/**
 * The bound entity's configured `pagination.strategy`, read structurally.
 *
 * `BoundKavoService` is a `Pick` of the *methods* a schema wires up, and
 * adding `engine` to it would drag `ResolvedEntityConfig<Entity>` — whose
 * allowlists are `FieldPath<Entity>[]` — into an invariant position, so
 * `discovery.ts`'s erased `BoundKavoService<object, …>` would stop accepting
 * any real service. A real `DefaultKavoService` always has the engine;
 * `undefined` here means a hand-rolled stand-in with nothing to check.
 */
function paginationStrategyOf(service: object): string | undefined {
  const engine = (service as { engine?: { config?: { settings?: { pagination?: { strategy?: string } } } } }).engine;
  return engine?.config?.settings?.pagination?.strategy;
}

/**
 * The bound entity's operation registry, read the same structurally-typed
 * way {@link paginationStrategyOf} reads `engine.config` — `engine` is not
 * itself in `BoundKavoService`'s `Pick` for the same reason, so custom
 * operation discovery (the #153 amendment) reaches for it the same way.
 */
function registryOf(service: object): OperationRegistry | undefined {
  return (service as { engine?: { registry?: OperationRegistry } }).engine?.registry;
}

function requireOffsetPageable(entityName: string, strategy: string | undefined, protocolName: string): void {
  if (strategy !== "cursor" && strategy !== "since") {
    return;
  }
  throw new ConfigurationException(
    entityName,
    "pagination.strategy",
    `'${strategy}' is not supported by the ${protocolName} binding: its list field exposes 'limit'/'offset' only, ` +
      `and a keyset page ignores 'offset' — a paged query would silently return the first page (or everything ` +
      `from the beginning) every time. Either page this entity over REST, or give it an entity-scope ` +
      `'pagination.strategy' of 'offset'/'page'`,
  );
}

/**
 * `sort: ["-createdAt", "name"]` → `[{ field: "createdAt", direction: "desc" }, { field: "name", direction: "asc" }]`
 * — the same leading-`-` convention REST's `?sort=` wire param uses, translated here instead of through core's
 * wire-string parser (this binding calls the programmatic `QueryContext` surface, which takes `Sort[]` objects
 * directly, never wire strings).
 */
function parseSortArg(tokens: readonly string[] | undefined): { field: string; direction: "asc" | "desc" }[] {
  if (tokens === undefined) {
    return [];
  }
  return tokens.map((token) =>
    token.startsWith("-")
      ? { field: token.slice(1), direction: "desc" as const }
      : { field: token, direction: "asc" as const },
  );
}

/**
 * What a query/mutation resolver in this binding actually calls — the
 * transport-agnostic programmatic surface `createCrud` returns. Kept as a
 * structural type (not `DefaultKavoService` itself) so a caller only has to
 * satisfy the handful of methods a schema actually wires up, the same way
 * `@kavo/nest`'s standard-operation routes bind to it. Exported (not just
 * internal) so `discovery.ts`'s host-agnostic resolver callback can name it.
 *
 * Every standard operation is picked unconditionally — whether a given
 * field actually reaches the schema is decided per entity by which
 * `*InputType`/`include*` options `crudFields` receives, mirroring how
 * `@Kavo`'s own `operations` config opts entities in or out on the REST
 * side. Calling `restoreOne`/`purgeOne` against an entity that never
 * declared soft delete still raises `OperationDisabledException` from the
 * engine itself — this binding does not re-check that, same as REST.
 *
 * `run` is the same generic custom-operation dispatcher `KavoService.run`
 * always had (ADR-0006's #145 amendment) — picked here so `crudFields` can
 * call a custom operation the same way it calls the standard eight, rather
 * than by reaching past this structural type into `DefaultKavoService`.
 */
export type BoundKavoService<
  Entity extends object,
  Id extends EntityId,
  CreateDto,
  UpdateDto,
  PatchDto,
  ItemDto,
  ListDto,
> = Pick<
  DefaultKavoService<Entity, Id, CreateDto, UpdateDto, PatchDto, unknown, ItemDto, ListDto>,
  "findOne" | "findMany" | "createOne" | "updateOne" | "patchOne" | "deleteOne" | "restoreOne" | "purgeOne" | "run"
>;

/**
 * One custom operation (ADR-0006's #145 amendment) to expose on an entity's
 * GraphQL schema — opt-in per id (the #153 amendment): naming an id here is
 * what reaches the schema, there is no automatic derivation from the
 * registry the way the standard eight get one. `crudFields` still refuses
 * an id named here whose registry entry has no declared `dto.output` (or,
 * when `inputType` is given, no declared `dto.input`) — GraphQL needs an
 * actual output/input type to build a field with, and unlike the standard
 * eight a custom operation has no entity-derived fallback shape to reach
 * for (ADR-0006).
 */
export interface KavoGraphQLCustomOperation {
  /** The field's result type. */
  readonly type: GraphQLOutputType;
  /** The input type for a write operation's body. Omit for an id-only or bodyless operation. */
  readonly inputType?: GraphQLInputObjectType;
}

/**
 * One entity's GraphQL binding: a query root (`<name>`/`<name>s`) plus
 * whichever mutations its options ask for — every resolver a direct call
 * into the same engine REST routes use, no parallel request pipeline.
 * Each mutation is opt-in per entity: omit the corresponding option and
 * that field never reaches the schema, the same "declare what you want"
 * shape `createInputType` already had.
 */
export interface KavoGraphQLOptions<
  Entity extends object,
  Id extends EntityId,
  CreateDto,
  UpdateDto,
  PatchDto,
  ItemDto,
  ListDto,
> {
  /** Singular, capitalized entity name — becomes `Query.<lowerName>` / `<Name>List` / `createName` / etc. */
  readonly name: string;
  readonly service: BoundKavoService<Entity, Id, CreateDto, UpdateDto, PatchDto, ItemDto, ListDto>;
  readonly itemType: GraphQLObjectType;
  /** Omit to leave the `create<Name>` mutation off the schema. */
  readonly createInputType?: GraphQLInputObjectType;
  /** Omit to leave the `update<Name>` mutation off the schema. */
  readonly updateInputType?: GraphQLInputObjectType;
  /** Omit to leave the `patch<Name>` mutation off the schema. */
  readonly patchInputType?: GraphQLInputObjectType;
  /** Adds `delete<Name>(id): Boolean`. */
  readonly deleteOne?: boolean;
  /** Adds `restore<Name>(id): <Name>` — meaningful only for a soft-deletable entity. */
  readonly restoreOne?: boolean;
  /** Adds `purge<Name>(id): Boolean` — meaningful only for a soft-deletable entity. */
  readonly purgeOne?: boolean;
  /**
   * Custom operations (issue #145) to expose on this entity's schema, keyed
   * by operation id — opt-in per id, see {@link KavoGraphQLCustomOperation}.
   * An id named here that the entity's `operations` config never declared,
   * that is disabled, or whose registry entry has no matching declared DTO
   * shape is a `ConfigurationException` at schema-build time.
   */
  readonly operations?: Readonly<Record<string, KavoGraphQLCustomOperation>>;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Field maps for one entity's binding — the unit `createKavoGraphQLSchema`
 * wraps and `mergeKavoGraphQLSchemas`/`resolveKavoGraphQLSchema` combine.
 * Not exported from the barrel: an internal building block, same status as
 * `lowerFirst`.
 */
export function crudFields<
  Entity extends object,
  Id extends EntityId,
  CreateDto,
  UpdateDto,
  PatchDto,
  ItemDto,
  ListDto,
>(
  options: KavoGraphQLOptions<Entity, Id, CreateDto, UpdateDto, PatchDto, ItemDto, ListDto>,
): {
  query: Record<string, GraphQLFieldConfig<unknown, unknown>>;
  mutation: Record<string, GraphQLFieldConfig<unknown, unknown>>;
} {
  const {
    name,
    service,
    itemType,
    createInputType,
    updateInputType,
    patchInputType,
    deleteOne,
    restoreOne,
    purgeOne,
    operations: customOperations,
  } = options;
  requireOffsetPageable(name, paginationStrategyOf(service), "GraphQL");
  const fieldName = lowerFirst(name);
  const idArgs = { id: { type: new GraphQLNonNull(GraphQLInt) } };

  const listType = new GraphQLObjectType({
    name: `${name}List`,
    fields: {
      items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(itemType))) },
      total: { type: GraphQLInt },
      limit: { type: new GraphQLNonNull(GraphQLInt) },
      offset: { type: new GraphQLNonNull(GraphQLInt) },
    },
  });

  const query: Record<string, GraphQLFieldConfig<unknown, unknown>> = {
    [fieldName]: {
      type: itemType,
      args: idArgs,
      resolve: (_root: unknown, args: { id: number }) => service.findOne(args.id as Id),
    },
    [`${fieldName}s`]: {
      type: new GraphQLNonNull(listType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        sort: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
        filter: { type: GraphQLJSON },
      },
      resolve: (
        _root: unknown,
        args: { limit?: number; offset?: number; sort?: readonly string[]; filter?: unknown },
      ) =>
        service.findMany({
          limit: args.limit,
          offset: args.offset,
          sort: parseSortArg(args.sort),
          filter: args.filter ?? null,
        } as never),
    },
  };

  const mutation: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};

  if (createInputType !== undefined) {
    mutation[`create${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: { input: { type: new GraphQLNonNull(createInputType) } },
      resolve: (_root: unknown, args: { input: CreateDto }) => service.createOne(args.input),
    };
  }

  if (updateInputType !== undefined) {
    mutation[`update${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: { ...idArgs, input: { type: new GraphQLNonNull(updateInputType) } },
      resolve: (_root: unknown, args: { id: number; input: UpdateDto }) => service.updateOne(args.id as Id, args.input),
    };
  }

  if (patchInputType !== undefined) {
    mutation[`patch${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: { ...idArgs, input: { type: new GraphQLNonNull(patchInputType) } },
      resolve: (_root: unknown, args: { id: number; input: PatchDto }) => service.patchOne(args.id as Id, args.input),
    };
  }

  if (deleteOne === true) {
    mutation[`delete${name}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: idArgs,
      resolve: async (_root: unknown, args: { id: number }) => {
        await service.deleteOne(args.id as Id);
        return true;
      },
    };
  }

  if (restoreOne === true) {
    mutation[`restore${name}`] = {
      type: new GraphQLNonNull(itemType),
      args: idArgs,
      resolve: (_root: unknown, args: { id: number }) => service.restoreOne(args.id as Id),
    };
  }

  if (purgeOne === true) {
    mutation[`purge${name}`] = {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: idArgs,
      resolve: async (_root: unknown, args: { id: number }) => {
        await service.purgeOne(args.id as Id);
        return true;
      },
    };
  }

  const standardIds: ReadonlySet<StandardOperationId> = new Set(STANDARD_OPERATION_IDS);
  const registry = registryOf(service);
  for (const [id, custom] of Object.entries(customOperations ?? {})) {
    if (standardIds.has(id as StandardOperationId)) {
      throw new ConfigurationException(
        name,
        `operations.${id}`,
        `'${id}' is one of the standard eight operations — GraphQL already exposes it unconditionally, ` +
          `so it has no place in 'operations'`,
      );
    }
    const descriptor = registry?.get(id as OperationId);
    if (descriptor === undefined) {
      throw new ConfigurationException(
        name,
        `operations.${id}`,
        `'${id}' names a GraphQL custom operation, but the entity never declared 'operations.${id}' — ` +
          `add it there first, or remove it from this schema's 'operations' option`,
      );
    }
    if (!descriptor.enabled) {
      throw new ConfigurationException(
        name,
        `operations.${id}`,
        `'${id}' is disabled on this entity — a disabled operation cannot be exposed on the GraphQL schema`,
      );
    }
    if (descriptor.output === null) {
      throw new ConfigurationException(
        name,
        `operations.${id}`,
        `'${id}' has no declared 'dto.output' — a custom operation needs a declared output shape to reach ` +
          `GraphQL, unlike the standard eight it has no entity-derived fallback; declare 'dto.output' on ` +
          `the operation, or remove it from this schema's 'operations' option`,
      );
    }
    if (custom.inputType !== undefined && descriptor.input === null) {
      throw new ConfigurationException(
        name,
        `operations.${id}`,
        `'${id}' names an 'inputType' here, but the operation has no declared 'dto.input' — declare ` +
          `'dto.input' on the operation, or drop 'inputType' from this schema's 'operations' option`,
      );
    }

    const takesId = descriptor.cardinality === "one";
    const takesInput = custom.inputType !== undefined;
    const args: GraphQLFieldConfigArgumentMap = {};
    if (takesId) {
      Object.assign(args, idArgs);
    }
    if (takesInput) {
      args["input"] = { type: new GraphQLNonNull(custom.inputType as GraphQLInputObjectType) };
    }

    const field: GraphQLFieldConfig<unknown, unknown> = {
      type: custom.type,
      args,
      resolve: (_root: unknown, resolverArgs: { id?: number; input?: unknown }) =>
        service.run(id, {
          id: takesId ? (resolverArgs.id as Id) : undefined,
          body: takesInput ? (resolverArgs.input as never) : undefined,
        } as never),
    };

    const customFieldName = `${fieldName}${upperFirst(id)}`;
    if (descriptor.kind === "read") {
      query[customFieldName] = field;
    } else {
      mutation[customFieldName] = field;
    }
  }

  return { query, mutation };
}

/**
 * Builds a one-entity `GraphQLSchema` over an existing `createCrud`
 * service. Schema derivation from entity metadata, relations, and
 * filtering is still out of scope (ADR-worthy work, tracked separately):
 * the caller supplies the GraphQL object/input types by hand, and every
 * resolver delegates straight to the bound service, which itself is sugar
 * over `engine.execute` — the identical pipeline REST runs.
 *
 * For an app with more than one entity, prefer `mergeKavoGraphQLSchemas` (or
 * `resolveKavoGraphQLSchema` for a framework-driven registry) — they put
 * every entity's fields on one `Query`/`Mutation` root instead of one
 * schema (and one mounted endpoint) per entity.
 */
export function createKavoGraphQLSchema<
  Entity extends object,
  Id extends EntityId,
  CreateDto,
  UpdateDto,
  PatchDto,
  ItemDto,
  ListDto,
>(options: KavoGraphQLOptions<Entity, Id, CreateDto, UpdateDto, PatchDto, ItemDto, ListDto>): GraphQLSchema {
  const { query, mutation } = crudFields(options);
  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: query }),
    mutation:
      Object.keys(mutation).length > 0 ? new GraphQLObjectType({ name: "Mutation", fields: mutation }) : undefined,
  });
}

/**
 * Combines several entities' bindings onto one `Query`/`Mutation` root —
 * the shape an app actually wants: one `/graphql` endpoint for every
 * `@Kavo` entity, not one per entity. Each entry is the same options shape
 * `createKavoGraphQLSchema` takes; field names are namespaced by each
 * entity's own `name`, so entries never collide with each other.
 */
export function mergeKavoGraphQLSchemas(
  bindings: readonly KavoGraphQLOptions<object, EntityId, unknown, unknown, unknown, unknown, unknown>[],
): GraphQLSchema {
  const query: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};
  const mutation: Record<string, GraphQLFieldConfig<unknown, unknown>> = {};

  for (const binding of bindings) {
    const fields = crudFields(binding);
    Object.assign(query, fields.query);
    Object.assign(mutation, fields.mutation);
  }

  if (Object.keys(query).length === 0) {
    // An empty `Query` type is invalid GraphQL (`Type Query must define one
    // or more fields.`) — graphql-js would only report that cryptically, on
    // the first request, deep inside `graphql()`'s own schema validation.
    // Failing fast here, at schema-build time, with a message that names the
    // actual fix, is what `resolveKavoGraphQLSchema` (zero entities
    // discovered) relies on to fail at boot instead of at request time.
    throw new ConfigurationException(
      "GraphQLSchema",
      "bindings",
      "no entity registered any GraphQL types — call registerKavoGraphQLTypes(Entity, {...}) " +
        "for at least one @Kavo entity before enabling a GraphQL endpoint",
    );
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: "Query", fields: query }),
    mutation:
      Object.keys(mutation).length > 0 ? new GraphQLObjectType({ name: "Mutation", fields: mutation }) : undefined,
  });
}
