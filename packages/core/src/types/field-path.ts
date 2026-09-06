import type { IsAny, IsUnknown, Primitive } from "./utility.js";

/**
 * Allowed recursion depths for {@link FieldPath}. The default cap and the
 * hard maximum are both 5 — see ADR-0008, revised by ADR-0051 (the default
 * was originally 3). The ceiling exists because template-literal path types
 * grow combinatorially with depth: on entities with many relations an
 * uncapped (or deeply capped) expansion produces union types large enough
 * to slow or crash the compiler.
 */
export type FieldPathDepth = 1 | 2 | 3 | 4 | 5;

/**
 * Depth decrement table: `Prev[3]` is `2`.
 *
 * Exported for {@link IncludePath}, which reuses this counter rather than
 * declaring a second one — ADR-0008's cap is meant to be one policy, not a
 * pattern each path type re-implements. Internal: not on the barrel.
 */
export type Prev = [never, 0, 1, 2, 3, 4, 5];

type PathInto<T, Depth extends 0 | FieldPathDepth> =
  // `any` / `unknown` (untyped entities, index-signature bags): degrade to
  // `string` — every path is *syntactically* accepted and the runtime
  // allowlist remains the actual gate.
  IsAny<T> extends true
    ? string
    : IsUnknown<T> extends true
      ? string
      : Depth extends 0
        ? never
        : T extends Primitive
          ? never
          : T extends readonly (infer Element)[]
            ? // A to-many relation: paths address the element type; the array
              // itself contributes no segment.
              PathInto<Element, Depth>
            : string extends keyof T
              ? // Index signature: keys are unknowable, degrade to `string`.
                string
              : {
                  [K in keyof T & string]: NonNullable<T[K]> extends Function
                    ? never
                    : NonNullable<T[K]> extends Primitive
                      ? K
                      : NonNullable<T[K]> extends readonly (infer Element)[]
                        ? K | `${K}.${PathInto<NonNullable<Element>, Prev[Depth]>}`
                        : NonNullable<T[K]> extends object
                          ? K | `${K}.${PathInto<NonNullable<T[K]>, Prev[Depth]>}`
                          : K;
                }[keyof T & string];

/**
 * Compile-time spell-checked dot-path into an entity: `'name'`,
 * `'profile.city'`, `'posts.comments.author'`.
 *
 * Used by filter, sort, and field-selection typings so relation paths are
 * verified against the entity shape at compile time. Methods are excluded;
 * arrays are traversed through their element type (a path into a to-many
 * relation reads the same as a to-one).
 *
 * This is a *typing* aid, not a security boundary — the runtime allowlist
 * decides what a request may actually filter, sort, or select on.
 *
 * `MaxDepth` defaults to 5, the hard maximum (ADR-0051). Pass a lower value
 * to tighten spell-checking to shallower paths for a specific use
 * (`FieldPath<Entity, 1>` for root-only selectors).
 */
export type FieldPath<Entity, MaxDepth extends FieldPathDepth = 5> = PathInto<Entity, MaxDepth>;
