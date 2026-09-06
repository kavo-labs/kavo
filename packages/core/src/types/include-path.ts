import type { FieldPathDepth, Prev } from "./field-path.js";
import type { IsAny, IsUnknown, Primitive } from "./utility.js";

type IncludeInto<T, Depth extends 0 | FieldPathDepth> =
  // `any` / `unknown` (untyped entities, index-signature bags): degrade to
  // `string`, exactly as `FieldPath` does. The runtime include resolver
  // remains the actual gate.
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
              IncludeInto<Element, Depth>
            : string extends keyof T
              ? // Index signature: keys are unknowable, degrade to `string`.
                string
              : {
                  [K in keyof T & string]: NonNullable<T[K]> extends Function
                    ? never
                    : NonNullable<T[K]> extends Primitive
                      ? // The one difference from `FieldPath`: a scalar is a
                        // *field*, never something you can include.
                        never
                      : NonNullable<T[K]> extends readonly (infer Element)[]
                        ? // Mirrors `ScalarKeys`: an array of primitives
                          // (`tags: string[]`) is a column, not a relation —
                          // there is nothing under it to include, so it is
                          // excluded exactly as a bare scalar is, rather than
                          // being offered as a path with nothing reachable
                          // past it.
                          NonNullable<Element> extends Primitive
                          ? never
                          : K | `${K}.${IncludeInto<NonNullable<Element>, Prev[Depth]>}`
                        : NonNullable<T[K]> extends object
                          ? K | `${K}.${IncludeInto<NonNullable<T[K]>, Prev[Depth]>}`
                          : never;
                }[keyof T & string];

/**
 * Compile-time spell-checked relation include path: `'profile'`,
 * `'posts.comments'`, `'posts.author.posts'`.
 *
 * The relation-only sibling of {@link FieldPath} — same recursion counter,
 * same default depth and hard maximum, both 5 (ADR-0008, revised by
 * ADR-0051), same degradation to `string` for `any`/`unknown`/
 * index-signature entities. Scalar properties
 * are excluded: `include` addresses relations, and `'name'` being rejected
 * at compile time is the point.
 *
 * Like `FieldPath` this is a *typing* aid, not a security boundary: whether
 * a relation may actually be included is decided at runtime by the relation
 * registry's `includable` flag and the include-depth budget.
 */
export type IncludePath<Entity, MaxDepth extends FieldPathDepth = 5> = IncludeInto<Entity, MaxDepth>;
