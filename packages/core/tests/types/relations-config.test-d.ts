import { expectTypeOf } from "vitest";
import type { EntityConfig, RelationConfig, RelationWriteConfig } from "@kavo/core";

/**
 * Pins the shape of `EntityConfig.relations` after issue #404 folded
 * `KavoSettings.relations.edges` and `KavoSettings.arrayMutation` into one
 * entity-scope block. Two things this file guards:
 *
 * - `write` accepts **only** `{ strategy }` — the boolean form is gone
 *   (there is no entity-level default left to inherit).
 * - `relations` is no longer a `KavoSettings` key, so it never merges
 *   through the global -> operation -> per-call precedence chain.
 */

interface Cat {
  id: number;
  name: string;
  tags: { id: number }[];
  owner: { id: number };
}

type CatRelations = NonNullable<EntityConfig<Cat>["relations"]>;

// A `read` block tunes loading.
const readTuned: CatRelations = { tags: { read: { maxDepth: 1, strategy: "batch" } } };
void readTuned;

// A `write` block names its own strategy — the only accepted form.
const writeReplace: CatRelations = { tags: { write: { strategy: "replace" } } };
const writeResource: CatRelations = { tags: { write: { strategy: "resource" } } };
const writeJsonPatch: CatRelations = { tags: { write: { strategy: "jsonPatch" } } };
void writeReplace;
void writeResource;
void writeJsonPatch;

// Both halves together.
const both: CatRelations = { tags: { read: { strategy: "batch" }, write: { strategy: "replace" } } };
void both;

// The boolean `write` form is rejected — there is no strategy to inherit.
// @ts-expect-error - `write: true` is no longer accepted (issue #404)
const writeBoolean: CatRelations = { tags: { write: true } };
void writeBoolean;

// An unknown strategy is rejected.
// @ts-expect-error - "bogus" is not one of the three implemented strategies
const writeInvalid: CatRelations = { tags: { write: { strategy: "bogus" } } };
void writeInvalid;

// `RelationWriteConfig` is exactly `{ strategy }`.
expectTypeOf<RelationWriteConfig>().toEqualTypeOf<{ readonly strategy: "replace" | "resource" | "jsonPatch" }>();

// `RelationConfig` carries only `read` and `write`.
expectTypeOf<keyof RelationConfig>().toEqualTypeOf<"read" | "write">();

// `relations` is not part of the settings tree any more.
// @ts-expect-error - `relations` was removed from KavoSettings (issue #404)
type _NoRelationsSetting = import("@kavo/core").KavoSettings["relations"];

// `arrayMutation` is not part of the settings tree any more.
// @ts-expect-error - `arrayMutation` was removed from KavoSettings (issue #404)
type _NoArrayMutationSetting = import("@kavo/core").KavoSettings["arrayMutation"];
