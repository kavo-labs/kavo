import type { KavoContext } from "../context/kavo-context.js";
import type { ListMetaDto } from "../dto/list-result.js";
import type { OperationHandler } from "../operations/operation-handler.js";
import type { FindManyResult } from "./built-in-handlers.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Computes extra keys for one list response's `ListResultDto.meta` — the
 * response envelope's open bag. Not to be confused with
 * `OperationConfig.meta` (`OperationMetadata`, ADR-0007), which is
 * route/framework metadata on a registry entry.
 *
 * It receives the wrapped handler's whole result, so a contributor can
 * read the rows it is describing (`result.entities`), the count
 * (`result.total`), and whatever `meta` the inner handler already
 * produced, before deciding what to add.
 */
export type ListMetaContributor<Entity = unknown> = (
  result: FindManyResult<Entity>,
  context: KavoContext<Entity>,
) => ListMetaDto | Promise<ListMetaDto>;

/**
 * Wrap a `findMany` handler so `compute`'s keys land on the list
 * envelope's `meta` — the "just add one stat" case, without hand-writing
 * the same wrap-and-spread every time:
 *
 * ```ts
 * // No adapter argument: the built-ins read the request's own
 * // `context.repository` (ADR-0025), which is what lets this wrap be
 * // written inside a `@Kavo` config, before one exists.
 * const handlers = builtInHandlers<Book>();
 * kavo.createCrud(Book, {
 *   operations: {
 *     findMany: {
 *       handler: withListMeta(handlers("findMany"), (result) => ({
 *         inStock: result.entities.filter((book) => book.stock > 0).length,
 *       })),
 *     },
 *   },
 * });
 * ```
 *
 * **Merge precedence: the contributor's keys win.** The inner handler's
 * `meta` is the base and `compute`'s return value merges over it. That is
 * the same direction as every other precedence chain in Kavo (global →
 * entity → operation → per-call: the more specific statement of intent
 * wins), and it makes nested wraps layer predictably — the outermost
 * `withListMeta` owns any key it names. Keys the contributor does not name
 * are carried through untouched, so wrapping never drops what the inner
 * handler set. A contributor that wants the opposite direction has the
 * inner bag in hand and can spread it last: `{ ...mine, ...result.meta }`.
 *
 * The parameter is typed as `OperationHandler<Entity>` — exactly what both
 * `builtInHandlers()("findMany")` and `OperationConfig.handler`
 * are — so the wrap composes with either without a cast. That erases the
 * inner output type, so the shape is checked at run time instead:
 * wrapping a handler that returns anything but a `FindManyResult` — both
 * an `entities` array and a `total` that is a number or `null` — raises
 * `ConfigurationException` (`KAVO_CONFIG_INVALID`) naming the operation,
 * rather than assembling a broken envelope.
 */
export function withListMeta<Entity = unknown>(
  handler: OperationHandler<Entity>,
  compute: ListMetaContributor<Entity>,
): OperationHandler<Entity, unknown, FindManyResult<Entity>> {
  return {
    async execute(input: unknown, context: KavoContext<Entity>): Promise<FindManyResult<Entity>> {
      const result = await handler.execute(input, context);
      if (!isFindManyResult<Entity>(result)) {
        throw new ConfigurationException(
          context.entityName,
          `operations.${context.operation}.handler`,
          `withListMeta wraps a findMany handler returning { entities, total }, ` +
            `but the wrapped handler returned ${describeValue(result)}`,
        );
      }
      const contributed = await compute(result, context);
      return { ...result, meta: { ...result.meta, ...contributed } };
    },
  };
}

/**
 * Both envelope-bearing fields are checked, not just `entities`.
 * `ListResultDto.total` is `number | null` and required, so a handler that
 * returns `{ entities }` alone would leave `total` `undefined` — a key
 * `JSON.stringify` then drops entirely, shipping a REST body with no
 * `total` at all. The engine normalizes `total ?? null` as a second line of
 * defense; this is the first, and it fails loudly where the mistake is.
 */
function isFindManyResult<Entity>(value: unknown): value is FindManyResult<Entity> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { entities?: unknown; total?: unknown };
  return Array.isArray(candidate.entities) && (typeof candidate.total === "number" || candidate.total === null);
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value !== "object") {
    return typeof value;
  }
  return Array.isArray((value as { entities?: unknown }).entities)
    ? "an object whose 'total' is neither a number nor null"
    : "an object with no 'entities' array";
}
