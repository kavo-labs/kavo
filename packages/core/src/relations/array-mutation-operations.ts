import type { OperationDescriptor, OperationRegistry } from "../operations/operation-registry.js";
import type { OperationHandler } from "../operations/operation-handler.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * `tags` → `replaceTags` — the one operation id shape the `replace`
 * strategy needs (ADR-0014's named extension point). Exported so
 * `@kavo/nest`'s route generation and core's `createCrud` derive the exact
 * same id from the exact same relation name (ADR-0013).
 */
export function replaceRelationOperationId(relationName: string): string {
  return `replace${relationName.charAt(0).toUpperCase()}${relationName.slice(1)}`;
}

/**
 * Relation names opted into array-mutation writes, read straight off
 * entity-level `relations.edges` config — the only view route generation
 * has at decoration time (ADR-0012), the same config-only precedent
 * `declaresSoftDelete` (`default-operation-registry.ts`) sets for
 * `restoreOne`. A relation's cardinality is not checked here — that needs
 * ORM metadata, unavailable at decoration time — so a to-one relation
 * wrongly marked `write: true` still gets a route generated blindly; it is
 * rejected at bootstrap once metadata exists (`DefaultRelationRegistry`),
 * the same two-stage validation `restoreOne`/`purgeOne` get.
 */
export function writeOptedInRelationNames(
  edges: Readonly<Record<string, { readonly write?: boolean } | undefined>> | undefined,
): readonly string[] {
  if (edges === undefined) return [];
  return Object.entries(edges)
    .filter(([, edge]) => edge?.write === true)
    .map(([name]) => name);
}

const unboundArrayMutationHandler = (relationName: string, entityName: string): OperationHandler<unknown> => ({
  execute(): Promise<never> {
    throw new ConfigurationException(
      entityName,
      `relations.edges.${relationName}.write`,
      `'${replaceRelationOperationId(relationName)}' has no bound handler — this registry was built for ` +
        `inspection (route generation) only`,
    );
  },
});

/**
 * Registers one `replace<Relation>` operation per write-opted-in relation
 * into an already-built registry — a post-hoc step (not part of
 * `createOperationRegistry`) because these entries aren't declared through
 * `EntityConfig.operations`, they're synthesized from `relations.edges`.
 *
 * `@kavo/nest`'s decorator calls this with no `handlerFactory` (route
 * generation only, same as every other registry it builds — see
 * `unboundHandler` in `default-operation-registry.ts`); `createCrud` calls
 * it with one that reaches `context.repository.replaceRelation`.
 */
export function registerArrayMutationOperations<Entity extends object>(
  registry: OperationRegistry<Entity>,
  relationNames: readonly string[],
  entityName: string,
  handlerFactory?: (relationName: string) => OperationHandler<Entity>,
): void {
  for (const name of relationNames) {
    const descriptor: OperationDescriptor<Entity> = {
      id: replaceRelationOperationId(name),
      kind: "write",
      cardinality: "one",
      enabled: true,
      handler: handlerFactory?.(name) ?? (unboundArrayMutationHandler(name, entityName) as OperationHandler<Entity>),
      input: null,
      output: null,
      meta: { arrayMutation: { relation: name, strategy: "replace" } },
    };
    registry.register(descriptor);
  }
}
