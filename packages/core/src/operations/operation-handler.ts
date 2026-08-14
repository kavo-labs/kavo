import type { KavoContext } from "../context/kavo-context.js";

/**
 * Opaque, module-augmentable metadata bag carried by every operation
 * registry entry. Core's only contract: store it, merge it per the standard
 * precedence (global routes → entity → operation), and hand it to the
 * framework layer.
 *
 * Consumers type their keys via declaration merging — `@kavo/nest`
 * augments it with route options:
 *
 * ```ts
 * // in @kavo/nest
 * declare module "@kavo/core" {
 *   interface OperationMetadata {
 *     routes?: {
 *       method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
 *       path?: string;
 *       /** `false` = service-only: callable in code, no route. *\/
 *       enabled?: boolean;
 *       swagger?: Record<string, unknown>;
 *     };
 *   }
 * }
 * ```
 */
export interface OperationMetadata {
  /**
   * Present only on the `replace<Relation>` operations Kavo itself
   * synthesizes from `relations.edges.<name>.write` (ADR-0014's named
   * extension point) — never set through application config. Names the
   * relation the operation targets, so `KavoEngine.resolveInput` can route
   * its body through the array-mutation path instead of the ordinary DTO
   * deserializer (a `replace` body is a bare array, not an entity-shaped
   * object), and `@kavo/nest` can derive the sub-collection route
   * (`PUT :id/<relation>`) without a static per-id route table.
   */
  readonly arrayMutation?: {
    readonly relation: string;
    readonly strategy: "replace";
  };
}

/**
 * The single execution contract every operation flows through — built-in
 * CRUD, overridden, and custom operations alike (one mechanism,
 * three behaviors). Handlers run inside the pipeline and receive
 * the fully-resolved per-request context.
 */
export interface OperationHandler<Entity = unknown, Input = unknown, Output = unknown> {
  execute(input: Input, context: KavoContext<Entity>): Promise<Output>;
}
