import { expectTypeOf } from "vitest";
import type { KavoSettings } from "@kavo/core";

/**
 * Pins `ArrayMutationSettings.strategy`'s required-\>optional widening
 * (issue #221 amends ADR-0029): `arrayMutation.strategy` has no built-in
 * default, so the object shape itself must type-check with `strategy`
 * absent, not just at `false`.
 */

type ArrayMutation = KavoSettings["arrayMutation"];

// `{}` (no strategy) is a legal `arrayMutation` value — this used to be a
// compile error when `strategy` was required. The assignment itself is the
// assertion: this line would fail to compile if `strategy` were still
// mandatory.
const unset: ArrayMutation = {};
void unset;

// The three implemented strategies remain assignable.
const replace: ArrayMutation = { strategy: "replace" };
const resource: ArrayMutation = { strategy: "resource" };
const jsonPatch: ArrayMutation = { strategy: "jsonPatch" };
void replace;
void resource;
void jsonPatch;

// `false` (feature disabled wholesale) stays distinct from `{}` (unset) —
// both remain legal `ArrayMutation` values.
const disabled: ArrayMutation = false;
void disabled;

// An unknown strategy string is still rejected.
// @ts-expect-error - "bogus" is not one of the three implemented strategies
const invalid: ArrayMutation = { strategy: "bogus" };
void invalid;

// Reading `.strategy` off a non-`false` value yields the optional union, not
// a value that's silently narrowed back to `"replace"`.
declare const resolved: Exclude<ArrayMutation, false>;
expectTypeOf(resolved.strategy).toEqualTypeOf<"replace" | "resource" | "jsonPatch" | undefined>();

/**
 * `RelationEdgeSettings.write`'s per-relation override (ADR-0029's
 * per-relation amendment, issue #223): `boolean | { strategy }`, not just
 * `boolean` — a relation can pin its own strategy instead of only ever
 * inheriting the entity's.
 */

type RelationWrite = KavoSettings["relations"]["edges"][string]["write"];

// The original boolean form is unchanged.
const writeOn: RelationWrite = true;
const writeOff: RelationWrite = false;
void writeOn;
void writeOff;

// The new object form pins a strategy of its own.
const writeReplace: RelationWrite = { strategy: "replace" };
const writeResource: RelationWrite = { strategy: "resource" };
const writeJsonPatch: RelationWrite = { strategy: "jsonPatch" };
void writeReplace;
void writeResource;
void writeJsonPatch;

// An unknown strategy inside the object form is still rejected.
// @ts-expect-error - "bogus" is not one of the three implemented strategies
const writeInvalid: RelationWrite = { strategy: "bogus" };
void writeInvalid;
