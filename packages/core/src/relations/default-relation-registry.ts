import type { RelationDescriptor } from "./relation-descriptor.js";
import type { RelationRegistry } from "./relation-registry.js";
import type { ArrayMutationSettings, RelationEdgeSettings } from "../config/settings.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Resolves one relation's raw `write` config down to a concrete strategy —
 * `true` inherits `entityDefault.strategy`, `{ strategy }` pins its own,
 * regardless of the entity default (ADR-0029's per-relation amendment,
 * issue #223) — or `undefined` when nothing resolves: `entityDefault` is
 * `false` (the feature is off wholesale, which wins over any per-relation
 * override), or `write: true` with no entity-level `strategy` declared
 * (issue #221 — no built-in default).
 */
function resolveArrayMutationStrategy(
  write: RelationEdgeSettings["write"],
  entityDefault: ArrayMutationSettings | false,
): RelationDescriptor["write"] {
  if (entityDefault === false) {
    return undefined;
  }
  if (typeof write === "object" && write !== null) {
    return write.strategy;
  }
  if (write !== true) {
    return undefined;
  }
  return entityDefault.strategy;
}

/**
 * Map-backed relation registry, built once at bootstrap from four
 * sources: the adapter's ORM metadata supplies *shape* — name, target,
 * cardinality; `allowed.includable` (`EntityConfig`, entity-config.ts)
 * supplies *permission*; `defaults.include` (`KavoSettings`, settings.ts)
 * supplies which includable relations load by default (issue #375,
 * ADR-0028); `relations.edges` supplies loading *tuning*
 * (`maxDepth`/`strategy`) for a relation once it is includable, and
 * array-mutation write policy (`write`) for one opted into it. Inclusion is
 * opt-in, so a relation absent from `includable` stays `includable: false`
 * no matter what `edges` or `defaults.include` says about it.
 */
export class DefaultRelationRegistry<Entity = unknown> implements RelationRegistry<Entity> {
  private readonly relations: ReadonlyMap<string, RelationDescriptor>;

  constructor(
    descriptors: readonly RelationDescriptor[],
    includable: readonly string[] = [],
    edges: Readonly<Record<string, RelationEdgeSettings>> = {},
    entityName = "entity",
    // Defaults to the empty object — `BUILT_IN_DEFAULTS.arrayMutation`'s own
    // shape, meaning "on, no strategy declared" — never to `false`: a caller
    // that omits this parameter should see the "declares no
    // arrayMutation.strategy" error below on a write-opted relation, not the
    // misleading "arrayMutation is false" one.
    arrayMutationDefault: ArrayMutationSettings | false = {},
    // `defaults.include` — validated against `includable` at bootstrap
    // (`resolve-entity-config.ts`'s `validateDefaults`) before this
    // constructor ever runs, so every name here is already known-includable.
    defaultIncludes: readonly string[] = [],
  ) {
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    for (const name of includable) {
      const descriptor = byName.get(name);
      if (descriptor === undefined) {
        // Fail fast: a typo in an allowlist that permits nothing looks
        // exactly like working config until the first client asks.
        throw new ConfigurationException(
          entityName,
          "include.fields",
          `'${name}' is not a relation of ${entityName} (relations: ${[...byName.keys()].join(", ") || "none"})`,
        );
      }
      byName.set(name, { ...descriptor, includable: true });
    }
    for (const name of defaultIncludes) {
      const descriptor = byName.get(name);
      if (descriptor !== undefined) {
        byName.set(name, { ...descriptor, defaultInclude: true });
      }
    }
    for (const [name, edge] of Object.entries(edges)) {
      const descriptor = byName.get(name);
      if (descriptor === undefined) {
        throw new ConfigurationException(
          entityName,
          `relations.edges.${name}`,
          `'${name}' is not a relation of ${entityName} (relations: ${[...byName.keys()].join(", ") || "none"})`,
        );
      }
      // `strategy: "key"` reads the parent row's own foreign-key column,
      // which only an owning-side to-one edge has — reject it here, at
      // bootstrap, the same way a mistuned `edges` entry is rejected
      // elsewhere.
      if (edge.strategy === "key") {
        if (descriptor.cardinality !== "one") {
          throw new ConfigurationException(
            entityName,
            `relations.edges.${name}.strategy`,
            `'${name}' is a to-many relation — strategy 'key' reads a local foreign-key column, ` +
              `which only a to-one relation has`,
          );
        }
        if (descriptor.ownsForeignKey === false) {
          throw new ConfigurationException(
            entityName,
            `relations.edges.${name}.strategy`,
            `'${name}' is the inverse side of a one-to-one relation — strategy 'key' reads a local ` +
              `foreign-key column, which only the owning side has; use 'join' here`,
          );
        }
      }
      const writeRequested = edge.write === true || typeof edge.write === "object";
      // `write: true`/`write: { strategy }` on a to-one relation has
      // nothing to mutate — association by id already covers to-one writes
      // (ADR-0014) — so it is rejected here, at bootstrap, the same way a
      // mistuned `edges` entry is rejected elsewhere in this constructor.
      if (writeRequested && descriptor.cardinality !== "many") {
        throw new ConfigurationException(
          entityName,
          `relations.edges.${name}.write`,
          `'${name}' is a to-one relation — 'arrayMutation' write policy only applies to to-many relations, ` +
            `which is what has an array to mutate`,
        );
      }
      let resolvedWrite: RelationDescriptor["write"];
      if (writeRequested) {
        resolvedWrite = resolveArrayMutationStrategy(edge.write, arrayMutationDefault);
        if (resolvedWrite === undefined) {
          throw new ConfigurationException(
            entityName,
            `relations.edges.${name}.write`,
            arrayMutationDefault === false
              ? `'${name}' opts into array-mutation writes, but 'arrayMutation' is false for ${entityName} — ` +
                  `set 'arrayMutation.strategy', give this relation its own 'write: { strategy }', or drop 'write'`
              : `'${name}' opts into array-mutation writes, but neither this relation's 'write' nor ${entityName}'s ` +
                  `'arrayMutation.strategy' names a strategy — set one to "replace", "resource", or "jsonPatch" ` +
                  `(or drop 'write')`,
          );
        }
      }
      // `edges` tunes loading only — it no longer touches `includable`
      // (ADR-0028) or `defaultInclude` (issue #375): a relation can be
      // tuned here without being includable or defaulted in.
      byName.set(name, {
        ...descriptor,
        ...(edge.maxDepth !== undefined && { maxDepth: edge.maxDepth }),
        strategy: edge.strategy ?? descriptor.strategy,
        ...(writeRequested && { write: resolvedWrite }),
      });
    }
    this.relations = byName;
  }

  get(name: string): RelationDescriptor | undefined {
    return this.relations.get(name);
  }

  has(name: string): boolean {
    return this.relations.has(name);
  }

  all(): readonly RelationDescriptor[] {
    return [...this.relations.values()];
  }
}
