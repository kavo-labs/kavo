import { expectTypeOf } from "vitest";
import type { IncludePath } from "@kavo/core";
import { Author, Comment, Post } from "../support/blog-fixture.js";

/**
 * Type-level acceptance tests for spell-checked include paths (ADR-0008's
 * cap, applied to relations). See entity-input.test-d.ts for why these files
 * are `.test-d.ts` and how the `@ts-expect-error` directives are enforced.
 *
 * The blog fixture is `Author 1—* Post 1—* Comment` with a `Post.author`
 * back-edge, so a path can revisit a type and exercise the depth guard.
 */

// The whole depth-3 expansion, pinned. Scalars (`name`, `title`, `body`) are
// absent: `include` addresses relations, never fields.
expectTypeOf<IncludePath<Author>>().toEqualTypeOf<"posts" | "posts.author" | "posts.comments" | "posts.author.posts">();

// A leaf entity with no relations can include nothing at all.
expectTypeOf<IncludePath<Comment>>().toEqualTypeOf<never>();

const ok: readonly IncludePath<Author>[] = ["posts", "posts.comments", "posts.author.posts"];
void ok;

// To-many and to-one read the same: the array contributes no segment.
const toOne: IncludePath<Post> = "author";
const toMany: IncludePath<Post> = "comments";
void toOne;
void toMany;

// @ts-expect-error — a misspelled relation is a compile error. This is the
// behavior the old `readonly string[]` typing could not give.
const typo: IncludePath<Author> = "posts.commentz";
void typo;

// @ts-expect-error — scalar fields are not includable.
const scalar: IncludePath<Author> = "name";
void scalar;

// @ts-expect-error — depth 4 exceeds the default cap of 3.
const tooDeep: IncludePath<Author> = "posts.author.posts.comments";
void tooDeep;

// Raising the cap admits it — same knob as FieldPath, same hard maximum.
const deepened: IncludePath<Author, 5> = "posts.author.posts.comments";
void deepened;

// Untyped entities degrade to `string` rather than erroring: the runtime
// relation registry stays the real gate.
expectTypeOf<IncludePath<any>>().toEqualTypeOf<string>();
expectTypeOf<IncludePath<unknown>>().toEqualTypeOf<string>();

// An index-signature bag has unknowable keys — same degradation.
interface Bag {
  [key: string]: unknown;
}
expectTypeOf<IncludePath<Bag>>().toEqualTypeOf<string>();

// `QueryContext`'s default entity is `unknown`, so untyped callers keep the
// old `readonly string[]` contract exactly.
expectTypeOf<readonly IncludePath<unknown>[]>().toEqualTypeOf<readonly string[]>();

/**
 * A primitive-element array (`tags`, a TypeORM `simple-array` column) is a
 * scalar column, not a relation — mirrors `ScalarKeys`'s treatment of the
 * same shape in `EntityInput`. It must not appear as an include path: there
 * is nothing under it to include, and offering it would let a caller "include"
 * a field the runtime relation registry has never heard of.
 */
class Tagged {
  id = 0;
  tags: string[] = [];
  reviews: { rating: number }[] = [];
}

expectTypeOf<IncludePath<Tagged>>().toEqualTypeOf<"reviews">();

// @ts-expect-error — a primitive-array column is excluded, exactly as a bare
// scalar field is.
const primitiveArray: IncludePath<Tagged> = "tags";
void primitiveArray;

/**
 * `IncludePath<Entity, 1>` is what `RelationFieldSelector` (entity-config.ts,
 * ADR-0028) types `allowlists.includable` against: exactly the entity's own
 * top-level relation names, with no dotted nesting — `include=` grants
 * permission one relation segment at a time from the root, the same unit
 * `relations.edges` keyed on before this change.
 */
expectTypeOf<IncludePath<Author, 1>>().toEqualTypeOf<"posts">();
expectTypeOf<IncludePath<Post, 1>>().toEqualTypeOf<"author" | "comments">();
expectTypeOf<IncludePath<Comment, 1>>().toEqualTypeOf<never>();

// @ts-expect-error — a dotted nested path is not a top-level relation name.
const nestedAtDepthOne: IncludePath<Author, 1> = "posts.comments";
void nestedAtDepthOne;

// @ts-expect-error — a scalar field is still not a relation, at any depth.
const scalarAtDepthOne: IncludePath<Author, 1> = "name";
void scalarAtDepthOne;

// @ts-expect-error — a typo'd relation name still fails at depth 1.
const typoAtDepthOne: IncludePath<Author, 1> = "postz";
void typoAtDepthOne;
