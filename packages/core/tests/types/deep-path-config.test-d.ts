import { createKavo } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * ADR-0051: `sort.fields` and `filter.fields` accept a relation path up to
 * depth 5 with no cast, because both are typed against `FieldPath` whose
 * default cap is now 5. The map form of `filter.fields` already widened
 * every string via `(string & {})`, so this exercises the **array** form,
 * where the depth change is observable.
 *
 * `include.fields` is deliberately *not* covered here: it is
 * `IncludePath<Entity, 1>` (ADR-0028) — top-level relation names only — and
 * the default-cap change does not reach it. Nested include depth stays a
 * runtime concern (`include.limits.maxDepth`).
 *
 * Blog fixture: `Author 1—* Post *—1 Author` back-edge — `posts.author.…`
 * revisits `Author`, so `posts.author.posts.author.name` is a real depth-5
 * path.
 */

const kavo = createKavo({});

kavo.createCrud(Author, {
  // Depth-4 and depth-5 paths, array form, no cast.
  sort: { fields: ["name", "posts.author.posts.title", "posts.author.posts.author.name"] },
  filter: { fields: ["posts.author.posts.title", "posts.author.posts.author.name"] },
});

kavo.createCrud(Author, {
  // @ts-expect-error — depth 6 exceeds the default cap of 5.
  sort: { fields: ["posts.author.posts.author.posts.title"] },
});

kavo.createCrud(Author, {
  // @ts-expect-error — depth 6 exceeds the default cap of 5.
  filter: { fields: ["posts.author.posts.author.posts.title"] },
});
