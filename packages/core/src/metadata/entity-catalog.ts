import type { ClassRef, DeepPartial } from "../types/utility.js";
import type { KavoSettings } from "../config/settings.js";
import type { EntityMetadata } from "./entity-metadata.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import { resolveEntityConfig } from "../config/resolve-entity-config.js";

/** One entity's bootstrap products, as other entities need to see them. */
export interface EntityRuntimeInfo<Entity extends object = object> {
  readonly metadata: EntityMetadata<Entity>;
  readonly config: ResolvedEntityConfig<Entity>;
}

/**
 * Cross-entity lookup. Nested includes are the first feature
 * that needs to see *another* entity's resolved config: an included node's
 * selectable allowlist, DTOs, delete strategy, and further relations all
 * come from the target entity, never from the entity being queried — a
 * relation must not widen what its target exposes.
 *
 * Lookup is deliberately by-request rather than a bootstrap snapshot:
 * `createCrud(Owner)` may run before `createCrud(Pet)`, and neither order
 * should change what `include=pets` does.
 */
export interface EntityCatalog {
  /**
   * The target's runtime info: its registered entry when it went through
   * `createCrud`, else one derived from metadata alone, else `undefined`
   * when no metadata source knows the class.
   */
  get(entity: ClassRef): EntityRuntimeInfo | undefined;
}

/** Supplies metadata for entities that never went through `createCrud`. */
export type MetadataSource = (entity: ClassRef) => EntityMetadata<object> | undefined;

/**
 * The catalog a Kavo root instance keeps. Entities registered through
 * `createCrud` are served with their real configuration; anything else a
 * relation points at is *derived* from ORM metadata plus global defaults —
 * so an unregistered target is readable (its own scalar columns) but opens
 * no further relations, because inclusion is opt-in and nothing opted in.
 */
export class DefaultEntityCatalog implements EntityCatalog {
  private readonly registered = new Map<ClassRef, EntityRuntimeInfo>();
  private readonly derived = new Map<ClassRef, EntityRuntimeInfo | undefined>();

  constructor(
    private readonly metadataSource: MetadataSource = () => undefined,
    private readonly globalDefaults?: DeepPartial<KavoSettings>,
  ) {}

  register(entity: ClassRef, info: EntityRuntimeInfo): void {
    this.registered.set(entity, info);
    // A later real registration must win over anything already derived.
    this.derived.delete(entity);
  }

  get(entity: ClassRef): EntityRuntimeInfo | undefined {
    const known = this.registered.get(entity);
    if (known !== undefined) {
      return known;
    }
    if (this.derived.has(entity)) {
      return this.derived.get(entity);
    }

    let info: EntityRuntimeInfo | undefined;
    const metadata = this.metadataSource(entity);
    if (metadata !== undefined) {
      info = { metadata, config: resolveEntityConfig(metadata, undefined, this.globalDefaults) };
    }
    this.derived.set(entity, info);
    return info;
  }
}
