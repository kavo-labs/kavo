import { expectTypeOf } from "vitest";
import type { FieldPath } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Type-level acceptance tests for spell-checked dot-paths (ADR-0008's
 * recursion cap; ADR-0051 raised its default from 3 to 5). See
 * entity-input.test-d.ts for why these files are `.test-d.ts` and how the
 * `@ts-expect-error` directives are enforced.
 *
 * The blog fixture is `Author 1—* Post 1—* Comment` with a `Post.author`
 * back-edge, so a path can revisit a type and exercise the depth guard.
 * `FieldPath` (unlike `IncludePath`) admits scalar leaves, so the full
 * depth-5 union is large — these assertions probe its edges rather than
 * pinning the whole expansion.
 */

// Own scalar, and relation paths up to the depth-5 default cap.
const own: FieldPath<Author> = "name";
const d2: FieldPath<Author> = "posts.title";
const d3: FieldPath<Author> = "posts.author.name";
const d4: FieldPath<Author> = "posts.author.posts.title";
const d5: FieldPath<Author> = "posts.author.posts.author.name";
void own;
void d2;
void d3;
void d4;
void d5;

// @ts-expect-error — depth 6 exceeds the default cap of 5 (ADR-0051).
const d6: FieldPath<Author> = "posts.author.posts.author.posts.title";
void d6;

// @ts-expect-error — a misspelled segment is a compile error at any depth.
const typo: FieldPath<Author> = "posts.titel";
void typo;

// The knob still lowers the cap below the default: a tightened
// `FieldPath<Author, 3>` rejects the depth-4 path the default admits.
const stillOk: FieldPath<Author, 3> = "posts.author.name";
void stillOk;
// @ts-expect-error — depth 4 exceeds the explicitly lowered cap of 3.
const lowered: FieldPath<Author, 3> = "posts.author.posts.title";
void lowered;

// Untyped entities degrade to `string` rather than erroring — the runtime
// allowlist stays the real gate.
expectTypeOf<FieldPath<any>>().toEqualTypeOf<string>();
expectTypeOf<FieldPath<unknown>>().toEqualTypeOf<string>();

// An index-signature bag has unknowable keys — same degradation.
interface Bag {
  [key: string]: unknown;
}
expectTypeOf<FieldPath<Bag>>().toEqualTypeOf<string>();
