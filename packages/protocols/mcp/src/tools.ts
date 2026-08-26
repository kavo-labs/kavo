import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DefaultKavoService, EntityId } from "@kavo/core";
import { ConfigurationException, KavoException } from "@kavo/core";

/**
 * `sort: ["-createdAt", "name"]` → `[{ field: "createdAt", direction: "desc" }, { field: "name", direction: "asc" }]`
 * — same convention (and same reasoning) as `@kavo/graphql`'s `parseSortArg`: this binding calls the programmatic
 * `QueryContext` surface directly, never REST's wire-string parser.
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
 * What a tool handler in this binding actually calls — the same
 * transport-agnostic programmatic surface `createCrud` returns that
 * `@kavo/graphql`'s `BoundKavoService` binds to. Kept as its own structural
 * type for the same reason: a caller only has to satisfy the operations a
 * toolset actually wires up.
 */
export type BoundKavoService<Entity extends object, Id extends EntityId, CreateDto, UpdateDto, PatchDto> = Pick<
  DefaultKavoService<Entity, Id, CreateDto, UpdateDto, PatchDto, unknown, unknown, unknown>,
  "findOne" | "findMany" | "createOne" | "updateOne" | "patchOne" | "deleteOne" | "restoreOne" | "purgeOne"
>;

/**
 * Refuse to bind an entity this protocol cannot page (ADR-0021 §7, extended
 * to `since` by ADR-0022).
 *
 * `<name>.findMany` accepts `limit`/`offset` only, and `QueryNormalizer`
 * ignores `offset` under both keyset strategies — so a model calling
 * `todo.findMany({ limit: 20, offset: 40 })` against a cursor- or
 * since-configured entity gets rows 1–20 (or everything from the beginning)
 * back with no error and no way to tell, and the `nextCursor`/`nextSince` it
 * would need is not in the tool's result shape. Name-gated on
 * `"cursor"`/`"since"` rather than structural, the same limitation
 * ADR-0021 §7 already records. Failing at bootstrap beats answering wrongly.
 * `@kavo/graphql` carries the identical guard; the two packages may not
 * import each other, so it is duplicated rather than shared.
 */
/**
 * The bound entity's configured `pagination.strategy`, read structurally —
 * for the same reason `@kavo/graphql` reads it that way: putting `engine` in
 * `BoundKavoService`'s `Pick` would drag the entity-typed
 * `ResolvedEntityConfig` into an invariant position and break every erased
 * `BoundKavoService<object, …>` call site.
 */
function paginationStrategyOf(service: object): string | undefined {
  const engine = (service as { engine?: { config?: { settings?: { pagination?: { strategy?: string } } } } }).engine;
  return engine?.config?.settings?.pagination?.strategy;
}

function requireOffsetPageable(entityName: string, strategy: string | undefined): void {
  if (strategy !== "cursor" && strategy !== "since") {
    return;
  }
  throw new ConfigurationException(
    entityName,
    "pagination.strategy",
    `'${strategy}' is not supported by the MCP binding: '<entity>.findMany' exposes 'limit'/'offset' only, ` +
      `and a keyset page ignores 'offset' — a paged call would silently return the first page (or everything ` +
      `from the beginning) every time. Either page this entity over REST, or give it an entity-scope ` +
      `'pagination.strategy' of 'offset'/'page'`,
  );
}

/** One entity's MCP tool binding: a `Tool` definition plus the handler that runs it — `crudTools`'s unit of work. */
export interface KavoMcpToolBinding {
  readonly tool: Tool;
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** One entity's MCP binding options. */
export interface KavoMcpToolsOptions<Entity extends object, Id extends EntityId, CreateDto, UpdateDto, PatchDto> {
  /** Singular, capitalized entity name — becomes the `<lowerName>.<operation>` tool name prefix. */
  readonly name: string;
  readonly service: BoundKavoService<Entity, Id, CreateDto, UpdateDto, PatchDto>;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Runs a handler and turns a `KavoException` into a normal (`isError:
 * true`) tool result instead of letting it propagate — the MCP protocol's
 * own convention for an expected domain failure (bad id, disabled
 * operation, conflict): the *call* succeeded, the *operation* didn't. An
 * error the engine did not itself raise (a bug, an unmapped adapter
 * failure) still propagates, so it surfaces as a protocol-level error
 * rather than being silently reframed as routine tool output.
 *
 * This is also how a mutation tool that doesn't apply to a given entity —
 * `restoreOne`/`purgeOne` on one that never declared soft delete —
 * degrades: every entity gets the full standard toolset unconditionally
 * (§ below), and the engine's own `OperationDisabledException` for a
 * disabled operation lands here as a normal `isError` result, exactly the
 * way calling the equivalent disabled REST route would.
 */
async function guarded(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (error) {
    if (error instanceof KavoException) {
      return { isError: true, content: [{ type: "text", text: `${error.code}: ${error.detail}` }] };
    }
    throw error;
  }
}

const idSchema = { type: ["string", "number"] };

function objectSchema(properties: Record<string, object>, required: readonly string[]): Tool["inputSchema"] {
  return { type: "object", properties, required: [...required] };
}

const idOnlySchema = objectSchema({ id: idSchema }, ["id"]);

/**
 * `{ id }` required, with any other property left unconstrained — JSON
 * Schema permits additional properties by default (no `additionalProperties:
 * false` here), so this doubles as `updateOne`/`patchOne`'s input schema: a
 * caller fills in `id` plus whatever DTO fields it wants, with no
 * per-entity schema to author or keep in sync.
 */
const idAndFreeformSchema = objectSchema({ id: idSchema }, ["id"]);

/** No constraints at all — every field an entity's `create` DTO accepts, forwarded straight through. */
const freeformObjectSchema: Tool["inputSchema"] = { type: "object" };

/**
 * Every standard operation, for one entity — unconditional. There is no
 * per-entity opt-in or hand-authored input schema (there used to be; see
 * git history / the issue this simplified) — every `@Kavo` entity handed
 * to `resolveKavoMcpTools` gets the full 8-tool set, the same way `@Kavo`
 * itself enables every standard operation by default. An operation that
 * doesn't actually apply — `restoreOne` on a non-soft-deletable entity, or
 * any operation an entity's own `@Kavo` config disabled — still produces a
 * tool, and calling it surfaces `OperationDisabledException` as a normal
 * `isError` result (`guarded`), exactly like calling the disabled REST
 * route would.
 */
export function crudTools<Entity extends object, Id extends EntityId, CreateDto, UpdateDto, PatchDto>(
  options: KavoMcpToolsOptions<Entity, Id, CreateDto, UpdateDto, PatchDto>,
): readonly KavoMcpToolBinding[] {
  const { name, service } = options;
  requireOffsetPageable(name, paginationStrategyOf(service));
  const prefix = lowerFirst(name);

  return [
    {
      tool: { name: `${prefix}.findOne`, description: `Find one ${name} by id.`, inputSchema: idOnlySchema },
      handler: (args) => guarded(() => service.findOne(args["id"] as Id)),
    },
    {
      tool: {
        name: `${prefix}.findMany`,
        description: `List ${name} records, with optional pagination, sort, and filter.`,
        inputSchema: objectSchema(
          {
            limit: { type: "integer" },
            offset: { type: "integer" },
            sort: { type: "array", items: { type: "string" } },
            filter: { type: "object" },
          },
          [],
        ),
      },
      handler: (args) =>
        guarded(() =>
          service.findMany({
            limit: args["limit"] as number | undefined,
            offset: args["offset"] as number | undefined,
            sort: parseSortArg(args["sort"] as readonly string[] | undefined),
            filter: (args["filter"] as never) ?? null,
          } as never),
        ),
    },
    {
      tool: { name: `${prefix}.createOne`, description: `Create a new ${name}.`, inputSchema: freeformObjectSchema },
      handler: (args) => guarded(() => service.createOne(args as CreateDto)),
    },
    {
      tool: {
        name: `${prefix}.updateOne`,
        description: `Replace an existing ${name} by id.`,
        inputSchema: idAndFreeformSchema,
      },
      handler: (args) => {
        const { id, ...input } = args;
        return guarded(() => service.updateOne(id as Id, input as UpdateDto));
      },
    },
    {
      tool: {
        name: `${prefix}.patchOne`,
        description: `Partially update an existing ${name} by id.`,
        inputSchema: idAndFreeformSchema,
      },
      handler: (args) => {
        const { id, ...input } = args;
        return guarded(() => service.patchOne(id as Id, input as PatchDto));
      },
    },
    {
      tool: { name: `${prefix}.deleteOne`, description: `Delete a ${name} by id.`, inputSchema: idOnlySchema },
      handler: (args) =>
        guarded(async () => {
          await service.deleteOne(args["id"] as Id);
          return { deleted: true };
        }),
    },
    {
      tool: {
        name: `${prefix}.restoreOne`,
        description: `Restore a soft-deleted ${name} by id.`,
        inputSchema: idOnlySchema,
      },
      handler: (args) => guarded(() => service.restoreOne(args["id"] as Id)),
    },
    {
      tool: {
        name: `${prefix}.purgeOne`,
        description: `Permanently delete a soft-deleted ${name} by id.`,
        inputSchema: idOnlySchema,
      },
      handler: (args) =>
        guarded(async () => {
          await service.purgeOne(args["id"] as Id);
          return { purged: true };
        }),
    },
  ];
}
