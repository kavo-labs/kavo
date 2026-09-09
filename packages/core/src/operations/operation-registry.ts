import type { OperationCardinality, OperationId, OperationKind } from "./operation.js";
import type { OperationHandler, OperationMetadata } from "./operation-handler.js";
import type { DtoClass } from "../dto/dto.js";
import type { RealtimeEventId } from "../realtime/realtime-event.js";

/** One registered operation: the unit the engine dispatches through. */
export interface OperationDescriptor<Entity = unknown, Input = unknown, Output = unknown> {
  readonly id: OperationId;
  readonly kind: OperationKind;
  readonly cardinality: OperationCardinality;
  /**
   * Disabled entries stay in the registry (so tooling can report them) but
   * never execute — calling one raises `OperationDisabledException`, and
   * `@kavo/nest` generates no route for it.
   */
  readonly enabled: boolean;
  readonly handler: OperationHandler<Entity, Input, Output>;
  /** Explicit input DTO; `null` = the slot default. */
  readonly input: DtoClass | null;
  /** Explicit output DTO; `null` = the slot default. */
  readonly output: DtoClass | null;
  /** Explicit query DTO; `null`/absent = the slot default. Typing only — see doc 04 §8. */
  readonly query?: DtoClass | null;
  readonly meta: OperationMetadata;
  /**
   * The realtime event a **custom** operation's write publishes as (issue
   * #175) — `CustomOperationConfig.realtimeEvent`, carried through
   * unvalidated at this layer (`createOperationRegistry` already checked it
   * against `kind`/`cardinality` at bootstrap). Absent on every standard id,
   * whose event comes from `REALTIME_EVENT_BY_OPERATION` instead — the two
   * never overlap because a standard id is never routed through
   * `registerCustomOperation`.
   */
  readonly realtimeEvent?: RealtimeEventId;
}

/**
 * The per-entity operation table. The engine dispatches *every*
 * operation through this registry — the built-in CRUD handlers are just
 * default entries, nothing about them is special-cased. The
 * disable/override/custom config is a control surface over this registry,
 * and `@kavo/nest` route generation reads it — which is what makes later
 * operations appear as routes with zero changes to the generator.
 */
export interface OperationRegistry<Entity = unknown> {
  get(id: OperationId): OperationDescriptor<Entity> | undefined;
  has(id: OperationId): boolean;
  /** All entries, enabled and disabled, in registration order. */
  all(): readonly OperationDescriptor<Entity>[];
  register(descriptor: OperationDescriptor<Entity>): void;
  /** Replace an entry's handler, keeping its scaffolding (override). */
  replace(id: OperationId, handler: OperationHandler<Entity>): void;
  /** Deactivate an entry (disable). */
  disable(id: OperationId): void;
}
