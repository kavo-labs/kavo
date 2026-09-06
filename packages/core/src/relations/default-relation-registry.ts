import type { RelationDescriptor } from "./relation-descriptor.js";
import type { RelationRegistry } from "./relation-registry.js";
import type { RelationConfig } from "../config/entity-config.js";
import { ConfigurationException } from "../errors/exceptions.js";

const LOAD_STRATEGIES = ["join", "batch", "key", "auto"] as const;
const ARRAY_MUTATION_STRATEGIES = ["replace", "resource", "jsonPatch"] as const;

/**
 * Map-backed relation registry, built once at bootstrap from three
 * sources: the adapter's ORM metadata supplies *shape* — name, target,
 * cardinality; `include.fields` (`EntityConfig`, entity-config.ts) supplies
 * *permission* (ADR-0028); `include.default` supplies which includable
 * relations load by default (issue #375). `EntityConfig.relations` (issue
 * #404, replacing `KavoSettings.relations.edges` and
 * `KavoSettings.arrayMutation`) supplies per-relation read-loading *tuning*
 * (`read.maxDepth`/`read.strategy`) for a relation once it is includable,
 * and array-mutation write policy (`write.strategy`) for one opted into it.
 *
 * Inclusion is opt-in, so a relation absent from `includable` stays
 * `includable: false` no matter what `relations` or `include.default` says
 * about it. Likewise `relations` grants no write permission — that stays
 * `create`/`update`/DTO (ADR-0014). This class also *validates* the
 * `relations` block: an unknown relation name, a bare entry that tunes
 * nothing, a bad `read.strategy`/`write.strategy`, `strategy: "key"` on an
 * edge with no local foreign key, or `write` on a to-one relation are each
 * a bootstrap `ConfigurationException` here.
 */
export class DefaultRelationRegistry<Entity = unknown> implements RelationRegistry<Entity> {
  private readonly relations: ReadonlyMap<string, RelationDescriptor>;

  constructor(
    descriptors: readonly RelationDescriptor[],
    includable: readonly string[] = [],
    relations: Readonly<Record<string, RelationConfig | undefined>> = {},
    entityName = "entity",
    // `include.default` — validated against `includable` at bootstrap
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
    for (const [name, entry] of Object.entries(relations)) {
      if (entry === undefined) {
        continue;
      }
      const descriptor = byName.get(name);
      if (descriptor === undefined) {
        throw new ConfigurationException(
          entityName,
          `relations.${name}`,
          `'${name}' is not a relation of ${entityName} (relations: ${[...byName.keys()].join(", ") || "none"})`,
        );
      }

      const read = entry.read;
      const write = entry.write;
      const tunesRead = read !== undefined && (read.maxDepth !== undefined || read.strategy !== undefined);
      // A bare entry (`{}`, or `{ read: {} }`) tunes nothing — reject it at
      // bootstrap rather than let a no-op sit in config looking meaningful.
      if (!tunesRead && write === undefined) {
        throw new ConfigurationException(
          entityName,
          `relations.${name}`,
          `'${name}' configures neither 'read' tuning (maxDepth/strategy) nor a 'write' policy — drop the entry`,
        );
      }

      if (read?.maxDepth !== undefined && (!Number.isInteger(read.maxDepth) || read.maxDepth <= 0)) {
        throw new ConfigurationException(
          entityName,
          `relations.${name}.read.maxDepth`,
          `expected a positive integer, got ${JSON.stringify(read.maxDepth)}`,
        );
      }
      if (read?.strategy !== undefined && !LOAD_STRATEGIES.includes(read.strategy)) {
        throw new ConfigurationException(
          entityName,
          `relations.${name}.read.strategy`,
          `expected "join", "batch", "key", or "auto", got ${JSON.stringify(read.strategy)}`,
        );
      }
      // `strategy: "key"` reads the parent row's own foreign-key column,
      // which only an owning-side to-one edge has — reject it here, at
      // bootstrap, the same way every other mistuned entry is.
      if (read?.strategy === "key") {
        if (descriptor.cardinality !== "one") {
          throw new ConfigurationException(
            entityName,
            `relations.${name}.read.strategy`,
            `'${name}' is a to-many relation — strategy 'key' reads a local foreign-key column, ` +
              `which only a to-one relation has`,
          );
        }
        if (descriptor.ownsForeignKey === false) {
          throw new ConfigurationException(
            entityName,
            `relations.${name}.read.strategy`,
            `'${name}' is the inverse side of a one-to-one relation — strategy 'key' reads a local ` +
              `foreign-key column, which only the owning side has; use 'join' here`,
          );
        }
      }

      let resolvedWrite: RelationDescriptor["write"];
      if (write !== undefined) {
        // `write` on a to-one relation has nothing to mutate — association
        // by id already covers to-one writes (ADR-0014).
        if (descriptor.cardinality !== "many") {
          throw new ConfigurationException(
            entityName,
            `relations.${name}.write`,
            `'${name}' is a to-one relation — array-mutation write policy only applies to to-many relations, ` +
              `which is what has an array to mutate`,
          );
        }
        if (!ARRAY_MUTATION_STRATEGIES.includes(write.strategy)) {
          throw new ConfigurationException(
            entityName,
            `relations.${name}.write.strategy`,
            `expected "replace", "resource", or "jsonPatch", got ${JSON.stringify(write.strategy)}`,
          );
        }
        resolvedWrite = write.strategy;
      }

      // `relations` tunes loading only — it never touches `includable`
      // (ADR-0028) or `defaultInclude` (issue #375): a relation can be
      // tuned here without being includable or defaulted in.
      byName.set(name, {
        ...descriptor,
        ...(read?.maxDepth !== undefined && { maxDepth: read.maxDepth }),
        strategy: read?.strategy ?? descriptor.strategy,
        ...(write !== undefined && { write: resolvedWrite }),
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
