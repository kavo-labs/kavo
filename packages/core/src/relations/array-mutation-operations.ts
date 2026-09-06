import type { OperationDescriptor, OperationRegistry } from "../operations/operation-registry.js";
import type { OperationHandler } from "../operations/operation-handler.js";
import type { RelationConfig } from "../config/entity-config.js";
import { ConfigurationException } from "../errors/exceptions.js";

/** The four sub-collection actions `arrayMutation`'s `resource` strategy synthesizes (ADR-0029's resource amendment). */
export type ArrayMutationAction = "replace" | "list" | "add" | "remove";

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * `tags` → `replaceTags` — the one operation id shape the `replace`
 * strategy needs (ADR-0014's named extension point). Exported so
 * `@kavo/nest`'s route generation and core's `createCrud` derive the exact
 * same id from the exact same relation name (ADR-0013).
 */
export function replaceRelationOperationId(relationName: string): string {
  return `replace${capitalize(relationName)}`;
}

/** `tags` → `listTags` — the `resource` strategy's `GET :id/tags` operation id. */
export function listRelationOperationId(relationName: string): string {
  return `list${capitalize(relationName)}`;
}

/** `tags` → `addTags` — the `resource` strategy's `POST :id/tags` operation id. */
export function addRelationOperationId(relationName: string): string {
  return `add${capitalize(relationName)}`;
}

/** `tags` → `removeTags` — the `resource` strategy's `DELETE :id/tags` operation id. */
export function removeRelationOperationId(relationName: string): string {
  return `remove${capitalize(relationName)}`;
}

const OPERATION_ID_BY_ACTION: Readonly<Record<ArrayMutationAction, (relationName: string) => string>> = {
  replace: replaceRelationOperationId,
  list: listRelationOperationId,
  add: addRelationOperationId,
  remove: removeRelationOperationId,
};

/**
 * Relation names opted into array-mutation writes, read straight off
 * entity-level `EntityConfig.relations` config — the only view route
 * generation has at decoration time (ADR-0012), the same config-only
 * precedent `declaresSoftDelete` (`default-operation-registry.ts`) sets for
 * `restoreOne`. A relation's cardinality is not checked here — that needs
 * ORM metadata, unavailable at decoration time — so a to-one relation
 * wrongly marked `write` still gets a route generated blindly; it is
 * rejected at bootstrap once metadata exists (`DefaultRelationRegistry`),
 * the same two-stage validation `restoreOne`/`purgeOne` get.
 *
 * Since issue #404 a `write` entry always names its own `strategy`
 * (`write: { strategy }`) — there is no entity-level default to inherit —
 * so decoration time and `createCrud` resolve the same strategy for the
 * same relation from the same input, with no gap between them.
 */
export function writeOptedInRelationNames(
  relations: Readonly<Record<string, RelationConfig | undefined>> | undefined,
): readonly string[] {
  if (relations === undefined) {
    return [];
  }
  return Object.entries(relations)
    .filter(([, entry]) => entry?.write !== undefined)
    .map(([name]) => name);
}

const unboundArrayMutationHandler = (
  operationId: string,
  relationName: string,
  entityName: string,
): OperationHandler<unknown> => ({
  execute(): Promise<never> {
    throw new ConfigurationException(
      entityName,
      `relations.${relationName}.write`,
      `'${operationId}' has no bound handler — this registry was built for inspection (route generation) only`,
    );
  },
});

/** One handler factory per action `registerArrayMutationOperations` may register — all optional (inspection-only build otherwise). */
export interface ArrayMutationHandlerFactories<Entity extends object> {
  readonly replace?: (relationName: string) => OperationHandler<Entity>;
  readonly list?: (relationName: string) => OperationHandler<Entity>;
  readonly add?: (relationName: string) => OperationHandler<Entity>;
  readonly remove?: (relationName: string) => OperationHandler<Entity>;
}

/**
 * A route-synthesizing strategy paired with the relation it applies to —
 * `"jsonPatch"` is deliberately excluded from this type: it reuses
 * `patchOne`'s existing route rather than synthesizing one, so it never
 * reaches this function (ADR-0029's jsonPatch amendment) — a caller filters
 * `jsonPatch`-strategy relations out before building this list.
 */
export interface ArrayMutationRelationEntry {
  readonly name: string;
  readonly strategy: "replace" | "resource";
}

/**
 * Registers the `arrayMutation` operations for one write-opted-in relation
 * per entry into an already-built registry — a post-hoc step (not part of
 * `createOperationRegistry`) because these entries aren't declared through
 * `EntityConfig.operations`, they're synthesized from `EntityConfig.relations`.
 *
 * Each entry's own `strategy` decides its action set, so one call can mix
 * `replace`- and `resource`-strategy relations on the same entity (ADR-0029's
 * per-relation amendment, issue #223): `"replace"` registers exactly one
 * operation — `replace<Relation>`, the whole-array `PUT` (ADR-0014).
 * `"resource"` registers four — `replace<Relation>` plus `list<Relation>`
 * (`GET`), `add<Relation>` (`POST`) and `remove<Relation>` (`DELETE`)
 * (ADR-0029's resource amendment) — since a resource entity's `PUT` has the
 * exact same whole-array-replace semantics `replace`'s own strategy uses.
 *
 * `@kavo/nest`'s decorator calls this with no `handlers` (route
 * generation only, same as every other registry it builds — see
 * `unboundHandler` in `default-operation-registry.ts`); `createCrud` calls
 * it with the handlers that reach `context.repository` — the same handler
 * factories serve every relation regardless of its own strategy, since a
 * factory is keyed by *action*, not strategy.
 */
export function registerArrayMutationOperations<Entity extends object>(
  registry: OperationRegistry<Entity>,
  relations: readonly ArrayMutationRelationEntry[],
  entityName: string,
  handlers?: ArrayMutationHandlerFactories<Entity>,
): void {
  for (const { name, strategy } of relations) {
    const actions: readonly ArrayMutationAction[] =
      strategy === "resource" ? ["replace", "list", "add", "remove"] : ["replace"];
    for (const action of actions) {
      const operationId = OPERATION_ID_BY_ACTION[action](name);
      const handlerFactory = handlers?.[action];
      const descriptor: OperationDescriptor<Entity> = {
        id: operationId,
        kind: action === "list" ? "read" : "write",
        cardinality: "one",
        enabled: true,
        handler:
          handlerFactory?.(name) ??
          (unboundArrayMutationHandler(operationId, name, entityName) as OperationHandler<Entity>),
        input: null,
        output: null,
        meta: { arrayMutation: { relation: name, strategy, action } },
      };
      registry.register(descriptor);
    }
  }
}
