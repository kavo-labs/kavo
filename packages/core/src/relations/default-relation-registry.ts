import type { RelationDescriptor } from "./relation-descriptor.js";
import type { RelationRegistry } from "./relation-registry.js";
import type { RelationEdgeSettings } from "../config/settings.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Map-backed relation registry, built once at bootstrap from three
 * sources: the adapter's ORM metadata supplies *shape* — name, target,
 * cardinality; `allowlists.includable` (`EntityConfig`, entity-config.ts)
 * supplies *permission*; `relations.edges` (`KavoSettings`, settings.ts)
 * supplies loading *tuning* (`defaultInclude`/`maxDepth`/`strategy`) for a
 * relation once it is includable (ADR-0028). Inclusion is opt-in, so a
 * relation absent from `includable` stays `includable: false` no matter
 * what `edges` says about it.
 */
export class DefaultRelationRegistry<Entity = unknown> implements RelationRegistry<Entity> {
  private readonly relations: ReadonlyMap<string, RelationDescriptor>;

  constructor(
    descriptors: readonly RelationDescriptor[],
    includable: readonly string[] = [],
    edges: Readonly<Record<string, RelationEdgeSettings>> = {},
    entityName = "entity",
  ) {
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    for (const name of includable) {
      const descriptor = byName.get(name);
      if (descriptor === undefined) {
        // Fail fast: a typo in an allowlist that permits nothing looks
        // exactly like working config until the first client asks.
        throw new ConfigurationException(
          entityName,
          "allowlists.includable",
          `'${name}' is not a relation of ${entityName} (relations: ${[...byName.keys()].join(", ") || "none"})`,
        );
      }
      byName.set(name, { ...descriptor, includable: true });
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
      // `write: true` on a to-one relation has nothing to mutate —
      // association by id already covers to-one writes (ADR-0014) — so it
      // is rejected here, at bootstrap, the same way a mistuned `edges`
      // entry is rejected elsewhere in this constructor.
      if (edge.write === true && descriptor.cardinality !== "many") {
        throw new ConfigurationException(
          entityName,
          `relations.edges.${name}.write`,
          `'${name}' is a to-one relation — 'arrayMutation' write policy only applies to to-many relations, ` +
            `which is what has an array to mutate`,
        );
      }
      // `edges` tunes loading only — it no longer touches `includable`
      // (ADR-0028): a relation can be tuned here without being includable,
      // and `defaultInclude: true` on one that isn't is rejected earlier,
      // at bootstrap, by `validateIncludableRelations`.
      byName.set(name, {
        ...descriptor,
        ...(edge.defaultInclude !== undefined && { defaultInclude: edge.defaultInclude }),
        ...(edge.maxDepth !== undefined && { maxDepth: edge.maxDepth }),
        strategy: edge.strategy ?? descriptor.strategy,
        ...(edge.write !== undefined && { write: edge.write }),
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
