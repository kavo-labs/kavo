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
   * Present only on the `replace`/`list`/`add`/`remove`<Relation> operations
   * Kavo itself synthesizes from `relations.edges.<name>.write` (ADR-0014's
   * named extension point) — never set through application config. Names
   * the relation the operation targets and which of the two synthesizing
   * strategies produced it, so `KavoEngine.resolveInput` can route the
   * request through the right array-mutation path instead of the ordinary
   * DTO deserializer, and `@kavo/nest` can derive the sub-collection route
   * (`:id/<relation>`, method keyed off `action`) without a static per-id
   * route table.
   *
   * `strategy: "replace"` only ever produces `action: "replace"` — the
   * whole-array `PUT` ADR-0014 defines. `strategy: "resource"` (ADR-0029's
   * resource amendment) produces all four actions: `"replace"` (the same
   * whole-array `PUT`), `"list"` (`GET`, current membership), `"add"`
   * (`POST`, one member by id) and `"remove"` (`DELETE`, one member by id).
   */
  readonly arrayMutation?: {
    readonly relation: string;
    readonly strategy: "replace" | "resource";
    readonly action: "replace" | "list" | "add" | "remove";
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
