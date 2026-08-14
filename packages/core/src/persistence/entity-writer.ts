import type { EntityId } from "../types/entity-id.js";
import type { KavoContext } from "../context/kavo-context.js";

/**
 * The write half of a repository adapter. Writer methods are single-entity
 * primitives. Were the spec's optional batch surface ever built, it would
 * be an engine-level loop over these — never new adapter methods.
 *
 * Writes participate in the ambient transaction on `context.transaction`
 * when one is active; until an adapter supplies one they are
 * non-transactional.
 */
export interface EntityWriter<Entity = unknown, Id extends EntityId = EntityId> {
  create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  /** Full replace (`PUT` semantics — the engine supplies a complete shape). */
  update(id: Id, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  /** Partial update (`PATCH` semantics — only present keys are written). */
  patch(id: Id, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity>;
  /**
   * Delete by the strategy on `context.config.softDelete`:
   * hard by default, soft when the entity carries a delete-marker field.
   * Soft-deleting an already-deleted row raises `AlreadyDeletedException`.
   */
  delete(id: Id, context: KavoContext<Entity>): Promise<void>;
  /**
   * Un-delete a soft-deleted row and return it. A row that is not deleted
   * raises `NotDeletedException`; a missing one, `NotFoundException`.
   */
  restore(id: Id, context: KavoContext<Entity>): Promise<Entity>;
  /**
   * Permanently delete an already-soft-deleted row. Under a hard delete
   * strategy this is just a delete — the row is gone either way.
   */
  purge(id: Id, context: KavoContext<Entity>): Promise<void>;
  /**
   * `arrayMutation`'s `replace` strategy (ADR-0014's named extension
   * point): whole-array replace of a to-many relation, still id-only —
   * `memberIds` names the complete desired membership, `null`/`[]`
   * disassociates every member. Returns the parent row with `relation`
   * loaded, so a handler can serve it without a second read.
   *
   * Optional: an adapter that doesn't implement this simply doesn't support
   * array-mutation writes, which `createCrud` checks for at bootstrap
   * (`ConfigurationException`) the moment a relation opts in via
   * `relations.edges.<name>.write` — the ORM caveat ADR-0014's Consequences
   * section already names for association by id applies here too: Kavo
   * maps the payload, it does not synthesize a write an adapter declined
   * to make.
   */
  replaceRelation?(
    id: Id,
    relation: string,
    memberIds: readonly Id[] | null,
    context: KavoContext<Entity>,
  ): Promise<Entity>;
  /**
   * `arrayMutation`'s `jsonPatch` strategy: incremental add/remove of one
   * relation's membership, computed against the row's *currently
   * persisted* membership — unlike `replaceRelation` (a whole desired-state
   * array, diffed but not itself transactional), this read (to judge
   * whether a `remove` target is currently a member) and the write it gates
   * must commit atomically, so a concurrent writer can never make that
   * judgment stale by the time the removal executes. `remove`ing an id that
   * is not currently a member raises `JsonPatchTargetNotFoundException`
   * rather than a silent no-op; `add`ing an id already a member is an
   * idempotent no-op; `add`ing an id with no matching row raises the same
   * `NotFoundException` `replaceRelation`'s own existence check raises.
   * Returns the parent row with `relation` loaded, the same contract
   * `replaceRelation` has.
   *
   * Optional, for the same reason `replaceRelation` is: an adapter that
   * doesn't implement this doesn't support `jsonPatch` array-mutation
   * writes, which `createCrud` checks for at bootstrap
   * (`ConfigurationException`) the moment a relation opts into `write`
   * under `arrayMutation.strategy: "jsonPatch"`.
   */
  patchRelation?(
    id: Id,
    relation: string,
    changes: { readonly add: readonly Id[]; readonly remove: readonly Id[] },
    context: KavoContext<Entity>,
  ): Promise<Entity>;
}
