import type { ClassRef } from "@kavo/core";
import type { GraphQLInputObjectType, GraphQLObjectType } from "graphql";
import type { KavoGraphQLCustomOperation } from "./schema.js";

/**
 * GraphQL object/input types (and which mutations to expose) for one
 * entity — the hand-written part `registerKavoGraphQLTypes` attaches to a
 * class. Each mutation flag/input mirrors `KavoGraphQLOptions` in
 * `schema.ts` one for one — omit any of them to leave that mutation off
 * the schema for this entity, same opt-in shape `@Kavo`'s own `operations`
 * config uses on the REST side.
 */
export interface KavoGraphQLTypes {
  readonly itemType: GraphQLObjectType;
  /** Omit to leave the `create<Name>` mutation off the schema for this entity. */
  readonly createInputType?: GraphQLInputObjectType;
  /** Omit to leave the `update<Name>` mutation off the schema for this entity. */
  readonly updateInputType?: GraphQLInputObjectType;
  /** Omit to leave the `patch<Name>` mutation off the schema for this entity. */
  readonly patchInputType?: GraphQLInputObjectType;
  /** Adds `delete<Name>(id): Boolean`. */
  readonly deleteOne?: boolean;
  /** Adds `restore<Name>(id): <Name>` — meaningful only for a soft-deletable entity. */
  readonly restoreOne?: boolean;
  /** Adds `purge<Name>(id): Boolean` — meaningful only for a soft-deletable entity. */
  readonly purgeOne?: boolean;
  /** Custom operations (issue #145) to expose on this entity's schema — see `KavoGraphQLOptions.operations`. */
  readonly operations?: Readonly<Record<string, KavoGraphQLCustomOperation>>;
}

const typeRegistry = new Map<ClassRef, KavoGraphQLTypes>();

/**
 * Attaches GraphQL types to an entity once, next to its DTOs — the
 * counterpart of `@kavo/nest`'s `getKavoEntities()`: a consumer can walk
 * every `@Kavo` entity and look up its GraphQL types here, wiring a merged
 * schema with no per-entity list of its own (see `resolveKavoGraphQLSchema`
 * in `discovery.ts`, which does exactly that). An entity with no
 * registration here simply has no GraphQL surface — opt-in, not implied by
 * `@Kavo` alone. Process-wide, same scope as `@kavo/nest`'s own registry.
 */
export function registerKavoGraphQLTypes(entity: ClassRef, types: KavoGraphQLTypes): void {
  typeRegistry.set(entity, types);
}

/** The types `registerKavoGraphQLTypes` attached to `entity`, or `undefined` if it never registered any. */
export function getKavoGraphQLTypes(entity: ClassRef): KavoGraphQLTypes | undefined {
  return typeRegistry.get(entity);
}
