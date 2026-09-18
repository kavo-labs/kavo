# Remove `dto`; `schema` absorbs it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `packages/core/src/dto/` and the `dto` config key entirely; every `schema` slot accepts either a `KavoSchema` validator (unchanged) or a plain/class-validator-decorated class (`SchemaClass`, today's `DtoClass` renamed), unifying `dto`'s class-based mechanism into `schema` as a second accepted shape instead of a separate config key.

**Architecture:** `packages/core/src/dto/` is renamed to `packages/core/src/schema/`. `DefaultSchemaResolver` absorbs `DefaultDtoResolver`'s resolution logic (including the `{ fields: [...] }` shorthand and the top-level `create`/`update`-fields fallback). Every consumer that branched on "is there a `dto` for this slot, else a `schema`" now branches once, inside the schema layer, on "is this slot's resolved value a validator (has `safeParse`) or a class (doesn't)."

**Tech Stack:** TypeScript, Vitest + SWC, pnpm workspaces, NestJS (for `@kavo/nest` tasks).

**Spec:** `docs/superpowers/specs/2026-09-18-remove-dto-design.md`

## Global Constraints

- No migration shim, deprecation warning, or dual-read period — `dto` is deleted outright (spec's "Breaking change, no migration shim" section).
- `@kavo/core` has zero runtime dependencies (ADR-0005) — nothing added here may import a validation library.
- The core barrel (`packages/core/src/index.ts`) stays a deliberate explicit named list — no `export *` (ADR-0010).
- Every file, symbol, and doc-comment reference to `dto`/`Dto` that this plan doesn't explicitly say to keep must be removed or renamed, not left dangling.
- `pnpm check` must pass at the end of every task that touches `src/` (build + typecheck + depcruise + lint + test).

---

## Task 1: `SchemaClass` and the merged structural contract in core

**Files:**
- Create: `packages/core/src/schema/kavo-schema.ts` (moved from `packages/core/src/dto/kavo-schema.ts`, unchanged content)
- Create: `packages/core/src/schema/schema-class.ts`
- Test: `packages/core/tests/schema/schema-class.spec.ts`

**Interfaces:**
- Produces: `SchemaClass<Shape extends object = object>` (`type SchemaClass<Shape extends object = object> = new () => Shape`), `SchemaLike<T>` (`type SchemaLike<T> = KavoSchema<T> | SchemaClass<T>`), `isSchemaClass(value: unknown): value is SchemaClass` (structural check: `typeof value === "function"`).
- Consumes: `KavoSchema<Output>` from `./kavo-schema.js` (moved, not yet deleted from `dto/` in this task — Task 2 deletes the old location).

- [ ] **Step 1: Move `kavo-schema.ts`**

```bash
mkdir -p packages/core/src/schema
git mv packages/core/src/dto/kavo-schema.ts packages/core/src/schema/kavo-schema.ts
```

- [ ] **Step 2: Write the failing test for `SchemaClass`/`isSchemaClass`**

```ts
// packages/core/tests/schema/schema-class.spec.ts
import { describe, expect, it } from "vitest";
import { isSchemaClass } from "@kavo/core/schema/schema-class.js";

describe("isSchemaClass", () => {
  it("is true for a plain class", () => {
    class UserDto {
      id = 0;
    }
    expect(isSchemaClass(UserDto)).toBe(true);
  });

  it("is false for a KavoSchema-shaped validator", () => {
    const validator = { safeParse: () => ({ success: true, data: {} }) };
    expect(isSchemaClass(validator)).toBe(false);
  });

  it("is false for null and primitives", () => {
    expect(isSchemaClass(null)).toBe(false);
    expect(isSchemaClass(42)).toBe(false);
  });
});
```

Note: import from the package's `tests/tsconfig` path alias (`@kavo/core`), matching how other `packages/core/tests/**` specs import sibling `src` modules — check an existing spec in `packages/core/tests/dto/` (soon to be renamed, see Task 2) for the exact import-path convention before writing this import.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/schema/schema-class.spec.ts`
Expected: FAIL — `schema-class.js` does not exist yet.

- [ ] **Step 4: Implement `schema-class.ts`**

```ts
// packages/core/src/schema/schema-class.ts
import type { KavoSchema } from "./kavo-schema.js";

/** A registerable class: plain, no-argument, shape-only — today's `DtoClass`, renamed and folded into `schema`. */
export type SchemaClass<Shape extends object = object> = new () => Shape;

/** Every `schema.<slot>` position accepts either a validator or a plain class. */
export type SchemaLike<T> = KavoSchema<T> | SchemaClass<T>;

/** Structural check: a class constructor has no `safeParse`, a `KavoSchema` does. */
export function isSchemaClass(value: unknown): value is SchemaClass {
  return typeof value === "function";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/schema/schema-class.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema packages/core/tests/schema
git commit -m "feat(core): add SchemaClass/SchemaLike, the merged dto+schema contract"
```

---

## Task 2: Move and widen `entity-schema.ts`; delete `dto.ts`

**Files:**
- Modify: `packages/core/src/dto/entity-schema.ts` → move to `packages/core/src/schema/entity-schema.ts`
- Delete: `packages/core/src/dto/dto.ts`
- Test: `packages/core/tests/schema/entity-schema.spec.ts` (renamed/extended from the existing `packages/core/tests/dto/entity-schema.spec.ts` if one exists — check first)

**Interfaces:**
- Consumes: `KavoSchema`, `SchemaClass`, `SchemaLike`, `isSchemaClass` from Task 1.
- Produces: `SchemaInputSlot`, `SchemaOutputSlot` (unchanged), `EntitySchemaMap<Entity, ...>` and `EntitySchema<Entity, ...>` now typed with `SchemaLike<T>` instead of `KavoSchema<T>` at every slot position, `SchemaResolver<Entity>`, `DefaultSchemaResolver<Entity>`, `OperationSchemaOverride<InputOut, OutputOut, QueryOut>` now with `SchemaLike<...>` fields, `SchemaInputOf<Ops, Id, Fallback>` / `SchemaOutputOf<Ops, Id, Fallback>` / `SchemaQueryOf<Ops, Id, Fallback>` with **no fallback branch to `Dto*Of`** — they resolve `Fallback` directly when no `schema` override exists.

- [ ] **Step 1: Move the file**

```bash
git mv packages/core/src/dto/entity-schema.ts packages/core/src/schema/entity-schema.ts
```

- [ ] **Step 2: Widen the slot types and drop the `Dto*Of` fallback**

Edit `packages/core/src/schema/entity-schema.ts`:

- Change the import from `import type { KavoSchema } from "./kavo-schema.js";` to also import `SchemaClass`, `SchemaLike` from `./schema-class.js`, and delete the import `import type { OperationEntryOf, DtoInputOf, DtoOutputOf, DtoQueryOf } from "./dto.js";` — replace with `import type { OperationEntryOf } from "../operations/operation-entry.js"` (see Step 3 below for where `OperationEntryOf` moves).
- In `SchemaInputMap`/`SchemaOutputMap`/`EntitySchemaMap`/`EntitySchema`/`OperationSchemaOverride`, replace every `KavoSchema<X>` slot type with `SchemaLike<X>`.
- Replace `isKavoSchema` with `isSchemaClass`-based branching where `DefaultSchemaResolver`'s constructor currently does `isKavoSchema(schema) ? ... : ...` — the shorthand-detection logic (a bare validator/class passed instead of the `{ input, output }` map) still needs to distinguish "is this the whole-map shorthand" from "is this the `{ input, output }` object" by checking `"input" in value || "output" in value` is absent, **not** by checking `safeParse` — a bare `SchemaClass` shorthand has no `safeParse` either. Replace the existing `isKavoSchema` structural check with:

```ts
function isSchemaShorthand(value: unknown): value is SchemaLike<unknown> {
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (value === null) {
    return false;
  }
  // The `{ input, output }` / `{ create, update, ... }` per-slot map shapes
  // are plain objects with none of a validator's or class's own signature;
  // a validator has `safeParse`, a class is itself a function.
  return typeof value === "function" || typeof (value as { safeParse?: unknown }).safeParse === "function";
}
```

  Use `isSchemaShorthand` everywhere `isKavoSchema` was used.
- Delete the `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf` fallback to `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`:

```ts
export type SchemaInputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly input: SchemaLike<infer Output> } } ? Output : Fallback;

export type SchemaOutputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly output: SchemaLike<infer Output> } } ? Output : Fallback;

export type SchemaQueryOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly query: SchemaLike<infer Output> } } ? Output : Fallback;
```

- [ ] **Step 3: Move `OperationEntryOf`**

`OperationEntryOf` was defined in `dto/dto.ts` (used by both `dto.ts` itself and `entity-schema.ts`, and by `service/custom-operation.ts`). Create `packages/core/src/operations/operation-entry.ts`:

```ts
// packages/core/src/operations/operation-entry.ts
/**
 * The operation entry shape `Ops[Id]` resolves to, or `undefined` when `Id`
 * was never declared. Read by the `Schema*Of` type-inference helpers
 * (`schema/entity-schema.ts`) and by `service/custom-operation.ts`, which
 * reads the same `Ops` literal for a custom operation's handler signature.
 */
export type OperationEntryOf<Ops, Id extends string> = Id extends keyof Ops ? Ops[Id] : undefined;
```

Update every importer of `OperationEntryOf` (grep for it — `service/custom-operation.ts` is the other known one) to import from `../operations/operation-entry.js` instead of `../dto/dto.js`.

- [ ] **Step 4: Delete `dto.ts`**

```bash
git rm packages/core/src/dto/dto.ts
```

Do not delete `WriteApply`/`WriteFieldsConfig`/`FieldsShorthand` yet if `entity-config.ts` still imports them from `dto/dto.ts` — Task 4 moves those. For this task, if `dto.ts`'s removal breaks other files, leave a stub re-export is **not** allowed (no shims per Global Constraints) — instead, complete Task 4's moves for `WriteApply`/`WriteFieldsConfig`/`FieldsShorthand` as part of this same commit if the build requires it (these three types have nothing to do with DTOs — they're the write-side field-allowlist config — so they move to `packages/core/src/config/write-fields.ts`, a new file, right now):

```bash
mkdir -p packages/core/src/config
```

Create `packages/core/src/config/write-fields.ts` with `WriteApply`, `FieldsShorthand`, `WriteFieldsConfig` moved verbatim (same doc comments) from the old `dto/dto.ts`, importing `EntityInput` from `../types/utility.js`, `FieldPath` from `../types/field-path.js`, `ApplyArgs` from `../policy/kavo-apply.js` (same imports `dto.ts` had for these three types).

- [ ] **Step 5: Fix the existing entity-schema tests**

Locate the current test file (likely `packages/core/tests/dto/entity-schema.spec.ts` — run `find packages/core/tests -iname "*entity-schema*"` to confirm the path), move it to `packages/core/tests/schema/entity-schema.spec.ts`, and update its imports from `@kavo/core`'s `dto` subpath to `schema`. Add these new cases to the existing describe blocks:

```ts
describe("DefaultSchemaResolver with a SchemaClass slot", () => {
  it("resolves a class-shaped schema.input.create unchanged", () => {
    class CreateUserSchema {
      name = "";
    }
    const resolver = new DefaultSchemaResolver<{ name: string }>({ input: { create: CreateUserSchema } });
    expect(resolver.resolveInput("create", "createOne")).toBe(CreateUserSchema);
  });

  it("does not confuse a class-shaped shorthand with the { input, output } map", () => {
    class WholeEntitySchema {
      name = "";
    }
    const resolver = new DefaultSchemaResolver<{ name: string }>(WholeEntitySchema);
    expect(resolver.resolveInput("create", "createOne")).toBe(WholeEntitySchema);
    expect(resolver.resolveOutput("item", "findOne")).toBe(WholeEntitySchema);
  });
});
```

- [ ] **Step 6: Run the full core test suite and typecheck**

Run: `pnpm --filter @kavo/core test && pnpm --filter @kavo/core typecheck`
Expected: PASS (some downstream packages will still fail to build until later tasks — run only `@kavo/core`'s own scripts here, not the workspace-wide `pnpm check`)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schema packages/core/src/config/write-fields.ts packages/core/src/operations/operation-entry.ts packages/core/tests/schema
git rm -r packages/core/src/dto/dto.ts packages/core/tests/dto 2>/dev/null || true
git commit -m "feat(core): widen EntitySchema slots to SchemaLike, delete dto.ts"
```

---

## Task 3: Port `dtoShapeKeys` → `schemaShapeKeys` and the `{ fields }` shorthand

**Files:**
- Create: `packages/core/src/schema/schema-shape.ts` (ported from `packages/core/src/dto/dto-shape.ts`)
- Create: `packages/core/src/schema/schema-fields-shorthand.ts` (ported from `packages/core/src/dto/dto-fields-shorthand.ts`)
- Delete: `packages/core/src/dto/dto-shape.ts`, `packages/core/src/dto/dto-fields-shorthand.ts`
- Test: `packages/core/tests/schema/schema-shape.spec.ts`, `packages/core/tests/schema/schema-fields-shorthand.spec.ts`

**Interfaces:**
- Consumes: `SchemaClass`, `isSchemaClass` from Task 1.
- Produces: `schemaShapeKeys(schema: SchemaClass | null): readonly string[] | null`, `shorthandFieldsOf(schemaClass: SchemaClass | null): readonly string[] | null`, `isFieldsShorthand(value: unknown): value is FieldsShorthand<unknown>`, `schemaClassFromFields(fields: readonly string[]): SchemaClass`, `resolveSchemaClassSlot<Entity>(entry: SchemaClass | FieldsShorthand<Entity> | undefined): SchemaClass | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/tests/schema/schema-shape.spec.ts
import { describe, expect, it } from "vitest";
import { schemaShapeKeys } from "@kavo/core/schema/schema-shape.js";

describe("schemaShapeKeys", () => {
  it("returns null for a null schema", () => {
    expect(schemaShapeKeys(null)).toBeNull();
  });

  it("returns the own enumerable keys of a fresh instance", () => {
    class ItemDto {
      id = 0;
      name = "";
    }
    expect(schemaShapeKeys(ItemDto)).toEqual(["id", "name"]);
  });

  it("returns null for a class with no initialized fields", () => {
    class Empty {}
    expect(schemaShapeKeys(Empty)).toBeNull();
  });

  it("returns null and does not throw for a class whose constructor throws", () => {
    class Throws {
      constructor() {
        throw new Error("boom");
      }
    }
    expect(schemaShapeKeys(Throws)).toBeNull();
  });
});
```

```ts
// packages/core/tests/schema/schema-fields-shorthand.spec.ts
import { describe, expect, it } from "vitest";
import {
  isFieldsShorthand,
  resolveSchemaClassSlot,
  schemaClassFromFields,
  shorthandFieldsOf,
} from "@kavo/core/schema/schema-fields-shorthand.js";
import { schemaShapeKeys } from "@kavo/core/schema/schema-shape.js";

describe("schema fields shorthand", () => {
  it("isFieldsShorthand recognizes { fields: [...] }", () => {
    expect(isFieldsShorthand({ fields: ["id", "name"] })).toBe(true);
    expect(isFieldsShorthand({})).toBe(false);
    expect(isFieldsShorthand(null)).toBe(false);
  });

  it("schemaClassFromFields synthesizes a class whose shape matches the field list", () => {
    const cls = schemaClassFromFields(["id", "name"]);
    expect(schemaShapeKeys(cls)).toEqual(["id", "name"]);
    expect(shorthandFieldsOf(cls)).toEqual(["id", "name"]);
  });

  it("shorthandFieldsOf returns null for a hand-written class", () => {
    class Hand {
      id = 0;
    }
    expect(shorthandFieldsOf(Hand)).toBeNull();
  });

  it("resolveSchemaClassSlot passes a class through unchanged", () => {
    class Hand {
      id = 0;
    }
    expect(resolveSchemaClassSlot(Hand)).toBe(Hand);
  });

  it("resolveSchemaClassSlot synthesizes a class from a { fields } shorthand", () => {
    const resolved = resolveSchemaClassSlot({ fields: ["id"] });
    expect(schemaShapeKeys(resolved)).toEqual(["id"]);
  });

  it("resolveSchemaClassSlot returns null for undefined", () => {
    expect(resolveSchemaClassSlot(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/core/tests/schema/schema-shape.spec.ts packages/core/tests/schema/schema-fields-shorthand.spec.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Implement `schema-shape.ts`**

```ts
// packages/core/src/schema/schema-shape.ts
import type { SchemaClass } from "./schema-class.js";

const shapeCache = new WeakMap<SchemaClass, readonly string[] | null>();

/**
 * The runtime key set of a class-shaped schema, from the own enumerable
 * properties of a fresh instance. A class that initializes its fields
 * (`id = 0`) yields a precise projection; a purely declarative one yields
 * `null` — "shape unknown" — and the caller falls back to the
 * entity-derived default.
 */
export function schemaShapeKeys(schema: SchemaClass | null): readonly string[] | null {
  if (schema === null) {
    return null;
  }
  const cached = shapeCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  let keys: readonly string[] | null;
  try {
    const instance = new schema();
    const ownKeys = Object.keys(instance as object);
    keys = ownKeys.length > 0 ? Object.freeze(ownKeys) : null;
  } catch {
    keys = null;
  }
  shapeCache.set(schema, keys);
  return keys;
}
```

- [ ] **Step 4: Implement `schema-fields-shorthand.ts`**

```ts
// packages/core/src/schema/schema-fields-shorthand.ts
import type { SchemaClass } from "./schema-class.js";
import type { FieldsShorthand } from "../config/write-fields.js";

const SHORTHAND_FIELDS = new WeakMap<SchemaClass, readonly string[]>();

/** The fields behind a shorthand-synthesized class, or `null` for a hand-registered one (or no class at all). */
export function shorthandFieldsOf(schemaClass: SchemaClass | null): readonly string[] | null {
  if (schemaClass === null) {
    return null;
  }
  return SHORTHAND_FIELDS.get(schemaClass) ?? null;
}

export function isFieldsShorthand(value: unknown): value is FieldsShorthand<unknown> {
  return typeof value === "object" && value !== null && Array.isArray((value as { fields?: unknown }).fields);
}

/** Synthesizes a `SchemaClass` from a field list — same key set a hand-written class with those fields would produce. */
export function schemaClassFromFields(fields: readonly string[]): SchemaClass {
  const schemaClass = class FieldsShorthandSchema {
    constructor() {
      for (const field of fields) {
        (this as Record<string, unknown>)[field] = undefined;
      }
    }
  };
  SHORTHAND_FIELDS.set(schemaClass, fields);
  return schemaClass;
}

/** Resolve one class-shaped schema slot entry — a class, a `{ fields }` shorthand, or unset — to a `SchemaClass | null`. */
export function resolveSchemaClassSlot<Entity>(
  entry: SchemaClass | FieldsShorthand<Entity> | undefined,
): SchemaClass | null {
  if (entry === undefined) {
    return null;
  }
  if (typeof entry === "function") {
    return entry;
  }
  return schemaClassFromFields(entry.fields as readonly string[]);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run packages/core/tests/schema/schema-shape.spec.ts packages/core/tests/schema/schema-fields-shorthand.spec.ts`
Expected: PASS

- [ ] **Step 6: Delete the old `dto/` versions and commit**

```bash
git rm packages/core/src/dto/dto-shape.ts packages/core/src/dto/dto-fields-shorthand.ts
git add packages/core/src/schema packages/core/tests/schema
git commit -m "feat(core): port dtoShapeKeys and the fields shorthand into schema"
```

---

## Task 4: `EntitySchemaMap`'s `patch`/`item`/`list` accept the `{ fields }` shorthand

**Files:**
- Modify: `packages/core/src/schema/entity-schema.ts`
- Test: `packages/core/tests/schema/entity-schema.spec.ts`

**Interfaces:**
- Consumes: `FieldsShorthand` from `../config/write-fields.js` (Task 2), `resolveSchemaClassSlot`, `isFieldsShorthand` from Task 3.
- Produces: `SchemaInputMap`'s `patch` field and `SchemaOutputMap`'s `item`/`list` fields now typed `SchemaLike<X> | FieldsShorthand<Entity>` (not `create`/`update`/`query` — those stay `SchemaLike`-only, mirroring `dto.create`/`dto.update`'s historical class-only restriction from issue #388, and `query` never had a shorthand).

- [ ] **Step 1: Write the failing test**

Add to `packages/core/tests/schema/entity-schema.spec.ts`:

```ts
describe("DefaultSchemaResolver with the { fields } shorthand", () => {
  it("resolves schema.output.item's { fields } shorthand to a synthesized class", () => {
    const resolver = new DefaultSchemaResolver<{ id: number; name: string }>({
      output: { item: { fields: ["id"] } },
    });
    const resolved = resolver.resolveOutput("item", "findOne");
    expect(schemaShapeKeys(resolved as SchemaClass)).toEqual(["id"]);
  });

  it("resolves schema.input.patch's { fields } shorthand", () => {
    const resolver = new DefaultSchemaResolver<{ id: number; name: string }>({
      input: { patch: { fields: ["name"] } },
    });
    expect(schemaShapeKeys(resolver.resolveInput("patch", "patchOne") as SchemaClass)).toEqual(["name"]);
  });
});
```

Import `schemaShapeKeys` and `SchemaClass` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/schema/entity-schema.spec.ts`
Expected: FAIL — `{ fields: [...] }` is rejected by the current type/resolution (or, since this is JS at runtime, resolves to a broken shape rather than a proper class).

- [ ] **Step 3: Update `entity-schema.ts`**

- Import `FieldsShorthand` from `../config/write-fields.js` and `resolveSchemaClassSlot`, `isFieldsShorthand` from `./schema-fields-shorthand.js`.
- Change `SchemaInputMap`'s `patch` field type to `KavoSchema<PatchOut> | SchemaClass<PatchOut & object> | FieldsShorthand<unknown>` — actually, to keep the generic parameterization clean, change the whole map's field types to accept `SchemaLike<X> | FieldsShorthand<Entity>` only for `patch` (input side) and `item`/`list` (output side); `create`/`update`/`query` stay `SchemaLike<X>`-only. Thread an `Entity` generic parameter through `SchemaInputMap`/`SchemaOutputMap` (they currently have none) so `FieldsShorthand<Entity>` can be spelled — add `Entity` as their first generic parameter and update `EntitySchemaMap`'s two call sites to pass it through.
- In `DefaultSchemaResolver`'s constructor, after resolving `input.patch`/`output.item`/`output.list` from the map, run each through: if `isFieldsShorthand(value)`, replace it with `resolveSchemaClassSlot(value)` before storing; otherwise store the `SchemaLike` value unchanged. `isSchemaShorthand` (Task 2's whole-map-shorthand detector) must check `isFieldsShorthand` too, so a bare `{ fields: [...] }` passed as the *entire* `schema` argument is rejected the same way today's code rejects nonsense — actually per the spec, the whole-`schema`-argument shorthand is validator/class only, never `{ fields }` (that shorthand is per-slot, not whole-schema), so no change needed there — just don't let `isFieldsShorthand` objects fall into the `isSchemaShorthand` branch by mistake (`isFieldsShorthand` and `isSchemaShorthand` are mutually exclusive shapes already: one has `.fields`, the other has `.safeParse` or is a function).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/schema/entity-schema.spec.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @kavo/core typecheck`

```bash
git add packages/core/src/schema packages/core/tests/schema
git commit -m "feat(core): schema.input.patch/output.item/list accept { fields } shorthand"
```

---

## Task 5: `DefaultSchemaResolver` absorbs `DefaultDtoResolver`'s write-fields fallback

**Files:**
- Modify: `packages/core/src/schema/entity-schema.ts`
- Delete: `packages/core/src/dto/default-dto-resolver.ts`
- Test: `packages/core/tests/schema/entity-schema.spec.ts`

**Interfaces:**
- Consumes: `WriteFieldsConfig` from `../config/write-fields.js`.
- Produces: `DefaultSchemaResolver`'s constructor gains a second parameter, `writable: { readonly create?: WriteFieldsConfig<Entity>; readonly update?: WriteFieldsConfig<Entity> } = {}` — when `schema.input.create`/`schema.input.update` names no class/validator, it falls back to a class synthesized from the top-level `create.fields`/`update.fields` array (today's `DefaultDtoResolver` behavior), exactly mirroring how `resolveEntityConfig` already passes `writable` fields alongside `dto` today.

- [ ] **Step 1: Write the failing test**

```ts
describe("DefaultSchemaResolver's create/update writable-fields fallback", () => {
  it("falls back to a class synthesized from the top-level create.fields when schema.input.create is unset", () => {
    const resolver = new DefaultSchemaResolver<{ id: number; name: string }>(undefined, {
      create: { fields: ["name"] },
    });
    expect(schemaShapeKeys(resolver.resolveInput("create", "createOne") as SchemaClass)).toEqual(["name"]);
  });

  it("a registered schema.input.create wins over the top-level create.fields fallback", () => {
    class CreateSchema {
      id = 0;
    }
    const resolver = new DefaultSchemaResolver<{ id: number; name: string }>(
      { input: { create: CreateSchema } },
      { create: { fields: ["name"] } },
    );
    expect(resolver.resolveInput("create", "createOne")).toBe(CreateSchema);
  });

  it("ignores a { exclude } form (not a plain array) for the fallback", () => {
    const resolver = new DefaultSchemaResolver<{ id: number; name: string }>(undefined, {
      create: { fields: { exclude: ["id"] } },
    });
    expect(resolver.resolveInput("create", "createOne")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/schema/entity-schema.spec.ts`
Expected: FAIL — `DefaultSchemaResolver` currently takes one constructor argument.

- [ ] **Step 3: Implement the second constructor parameter**

In `packages/core/src/schema/entity-schema.ts`, add:

```ts
import type { WriteFieldsConfig } from "../config/write-fields.js";
import { schemaClassFromFields } from "./schema-fields-shorthand.js";

export interface WritableSchemaFieldsConfig<Entity> {
  readonly create?: WriteFieldsConfig<Entity>;
  readonly update?: WriteFieldsConfig<Entity>;
}

function writableFieldsToSchemaClass<Entity>(
  fields: WriteFieldsConfig<Entity>["fields"] | undefined,
): SchemaClass | null {
  if (fields === undefined || !Array.isArray(fields)) {
    return null;
  }
  return schemaClassFromFields(fields as readonly string[]);
}
```

Change `DefaultSchemaResolver`'s constructor signature to:

```ts
constructor(schema?: EntitySchema<Entity>, writable: WritableSchemaFieldsConfig<Entity> = {}) {
  // ...existing map/input/output resolution unchanged up to building `this.input`...
  this.input = Object.freeze({
    create: input.create ?? writableFieldsToSchemaClass(writable.create?.fields),
    update: input.update ?? writableFieldsToSchemaClass(writable.update?.fields),
    patch: (isFieldsShorthand(input.patch) ? resolveSchemaClassSlot(input.patch) : input.patch) ?? input.update ?? null,
    query: input.query ?? null,
  });
  // ...output unchanged from Task 4...
}
```

(Fold this in with Task 4's `patch` shorthand-resolution logic already added in that step — don't duplicate it; this step only adds the `create`/`update` fallback parameter and argument threading.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/tests/schema/entity-schema.spec.ts`
Expected: PASS

- [ ] **Step 5: Delete `default-dto-resolver.ts` and commit**

```bash
git rm packages/core/src/dto/default-dto-resolver.ts
git add packages/core/src/schema
git commit -m "feat(core): DefaultSchemaResolver absorbs the create/update writable-fields fallback"
```

---

## Task 6: `resolve-entity-config.ts` — drop `DefaultDtoResolver`, retarget the derived-field check

**Files:**
- Modify: `packages/core/src/config/resolve-entity-config.ts`
- Modify: `packages/core/src/config/resolved-entity-config.ts`
- Modify: `packages/core/src/config/entity-config.ts`
- Test: `packages/core/tests/config/resolve-entity-config.spec.ts` (locate exact path with `find packages/core/tests -iname "*resolve-entity-config*"`)

**Interfaces:**
- Consumes: `DefaultSchemaResolver`, `WritableSchemaFieldsConfig` from `../schema/entity-schema.js`; `schemaShapeKeys` from `../schema/schema-shape.js`; `schemaClassFromFields`, `resolveSchemaClassSlot` from `../schema/schema-fields-shorthand.js`; `WriteApply`, `WriteFieldsConfig`, `FieldsShorthand` from `./write-fields.js`.
- Produces: `ResolvedEntityConfig.schema: SchemaResolver<Entity>` is the **only** resolver field (`dto: DtoResolver<Entity>` deleted). `EntityConfig.dto` deleted from `entity-config.ts`.

- [ ] **Step 1: Update `entity-config.ts`**

- Delete `readonly dto?: OperationDtoMap<Entity, ...>;` from `EntityConfig` (around line 781 per the earlier read).
- Delete the `OperationDtoMap`, `OperationDtoOverride`, `DtoResolver` import from `../dto/dto.js`; keep the `EntitySchema`, `OperationSchemaOverride` import but retarget it to `../schema/entity-schema.js`.
- Change `WriteFieldsConfig` import to `./write-fields.js` (it moved there in Task 2).
- `OperationConfig.dto?: DtoOverride` and `CustomOperationConfig.dto?: OperationDtoOverride` fields are deleted; their doc comments that describe the `dto` → `schema` → default fallback chain are rewritten to describe just `schema` → default (drop the middle tier).
- `StandardOperationsConfig`'s generic parameters `DtoOverride`/`Pick<OperationDtoOverride, ...>` per operation id are deleted — `OperationConfig`'s second generic parameter (used for the old `dto` `Pick`) is removed entirely; every `OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">, ...>` call site in `StandardOperationsConfig` becomes `OperationConfig<Entity, "errors" | "cache" | "realtime">` (i.e. `OperationConfig`'s settings-subtree parameter shifts from third to second position — update `OperationConfig`'s own declaration to drop its middle `DtoOverride` parameter too).

- [ ] **Step 2: Update `resolved-entity-config.ts`**

Find `dto: DtoResolver<Entity>` in the `ResolvedEntityConfig` interface (or similar) and delete it — `schema: SchemaResolver<Entity>` (already present per the spec) is the only resolver field. Update the import to drop `DtoResolver` from `../dto/dto.js` (that whole import line goes).

- [ ] **Step 3: Update `resolve-entity-config.ts`**

- Delete the imports: `DtoClass`, `WriteApply`, `WriteFieldsConfig` from `../dto/dto.js` (retarget `WriteApply`/`WriteFieldsConfig` to `./write-fields.js`; `DtoClass` is gone, use `SchemaClass` from `../schema/schema-class.js` instead), `dtoShapeKeys` from `../dto/dto-shape.js` (retarget to `schemaShapeKeys` from `../schema/schema-shape.js`), `dtoClassFromFields`/`resolveDtoSlot` from `../dto/dto-fields-shorthand.js` (retarget to `schemaClassFromFields`/`resolveSchemaClassSlot` from `../schema/schema-fields-shorthand.js`), `DefaultDtoResolver` from `../dto/default-dto-resolver.js` (deleted, no replacement import needed).
- Find wherever `dto: new DefaultDtoResolver(entityConfig?.dto, ...)` is constructed (around the reported line 192) and delete that whole property — `schema: new DefaultSchemaResolver(entityConfig?.schema, { create: entityConfig?.create, update: entityConfig?.update })` should already exist there (per the spec's description that `schema` resolution is already wired in); if its second argument isn't already passing `{ create, update }`, add it now so it gets the Task 5 fallback.
- Rewrite `rejectDerivedWriteDtoKeys` (the function from the earlier read, lines ~435-462): rename to `rejectDerivedWriteSchemaKeys`, retarget every `entityConfig?.dto` read to `entityConfig?.schema` (specifically `entityConfig?.schema?.input` for `create`/`update`/`patch`), use `resolveSchemaClassSlot`/`schemaClassFromFields`/`schemaShapeKeys` instead of their `dto`-named equivalents, and **skip the check entirely when the resolved slot value is a validator, not a class** (a `KavoSchema` has no static shape `schemaShapeKeys` can read — reflection only applies to a class; a validator-configured slot can't leak a derived field into an OpenAPI body the same way, since there's no `dtoShapeKeys`-driven OpenAPI generation for it either — that's `@kavo/nest`'s job in Task 9, not this check's). Concretely:

```ts
function rejectDerivedWriteSchemaKeys<Entity extends object>(
  entityName: string,
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  createFields: readonly string[] | undefined,
  updateFields: readonly string[] | undefined,
): void {
  const names = new Set(
    metadata.fields.filter((field) => field.derivedExpression !== undefined).map((field) => field.name),
  );
  if (names.size === 0) {
    return;
  }
  const input = entityConfig?.schema as { input?: Record<string, unknown> } | undefined;
  const map = input?.input ?? {};
  const checks: readonly [slot: string, scope: string, schemaClass: SchemaClass | null][] = [
    [
      "create",
      "schema.input.create",
      isSchemaClass(map.create) ? (map.create as SchemaClass) : createFields ? schemaClassFromFields(createFields) : null,
    ],
    [
      "update",
      "schema.input.update",
      isSchemaClass(map.update) ? (map.update as SchemaClass) : updateFields ? schemaClassFromFields(updateFields) : null,
    ],
    [
      "patch",
      "schema.input.patch",
      resolveSchemaClassSlot(map.patch as Parameters<typeof resolveSchemaClassSlot>[0]),
    ],
  ];
  for (const [slot, scope, schemaClass] of checks) {
    const declared = schemaShapeKeys(schemaClass)?.find((key) => names.has(key));
    if (declared === undefined) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      scope,
      `the '${slot}' schema declares '${declared}', which is an ORM-derived field on '${entityName}' — ` +
        `a derived field has no writable storage behind it, so the value is stripped from every write ` +
        `payload while the generated OpenAPI body may still advertise the property; drop it from the schema`,
    );
  }
}
```

  (`isSchemaClass` needs importing from `../schema/schema-class.js`; note `map.create`/`map.update` here are values already known to be either a `SchemaClass` or a `KavoSchema` — the `isSchemaClass` guard is what skips the validator case per the paragraph above.) Update the call site that invokes this function to use the new name.

- [ ] **Step 4: Update the existing test file for the renamed/retargeted function**

Find and update every `dto:` config object in `resolve-entity-config.spec.ts` (or wherever `rejectDerivedWriteDtoKeys`'s behavior is tested) to `schema: { input: { ... } }`, and update the expected error message substrings from `'X' DTO declares` to `'X' schema declares` and `dto.create`/`dto.update`/`dto.patch` to `schema.input.create`/`schema.input.update`/`schema.input.patch`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @kavo/core test && pnpm --filter @kavo/core typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config packages/core/tests/config
git commit -m "feat(core): drop dto from EntityConfig/ResolvedEntityConfig, retarget derived-field check to schema"
```

---

## Task 7: Operation registry — drop `input`/`output`/`query: DtoClass`, keep only `schemaInput`/`schemaOutput`/`schemaQuery`

**Files:**
- Modify: `packages/core/src/operations/operation-registry.ts`
- Modify: `packages/core/src/operations/default-operation-registry.ts`
- Test: `packages/core/tests/operations/default-operation-registry.spec.ts` (confirm path with `find`)

**Interfaces:**
- Produces: `OperationDescriptor<Entity>` no longer has `input`/`output`/`query: DtoClass | null` fields — only `schemaInput`/`schemaOutput`/`schemaQuery: SchemaLike<unknown> | null` remain. `resolveDtoOverride` deleted; `resolveSchemaOverride` (already existing per the spec) is the only per-operation override resolver, and its validated-fields check (which operation ids may declare `input`/`output`/`query`) is unchanged — it already runs against `schema`.

- [ ] **Step 1: Read the current registry files in full**

Run: `sed -n '1,60p' packages/core/src/operations/operation-registry.ts` and locate every `input`/`output`/`query`/`resolveDtoOverride`/`DTO_OVERRIDE_FIELDS`-named symbol in `default-operation-registry.ts` (the earlier grep found `resolveDtoOverride` around lines 162-192, 392-403, 498). Confirm `resolveSchemaOverride` already exists and mirrors it structurally before editing, since the plan assumes it does per the Task 2 spec excerpt.

- [ ] **Step 2: Write/extend the failing test**

Add a case to `default-operation-registry.spec.ts` asserting that a registry built from an `EntityConfig` with no `dto` key (since it no longer exists as a type) and a `schema.output.item` class produces a descriptor whose `schemaOutput` resolves that class, and that the descriptor object has no `output` property at all:

```ts
it("produces a descriptor with schemaOutput only, no legacy output field", () => {
  class ItemSchema {
    id = 0;
  }
  const registry = createOperationRegistry(metadata, {
    schema: { output: { item: ItemSchema } },
  } as EntityConfig<TestEntity>);
  const descriptor = registry.get("findOne");
  expect(descriptor?.schemaOutput).toBe(ItemSchema);
  expect(descriptor).not.toHaveProperty("output");
});
```

(Adapt `metadata`/`TestEntity`/`createOperationRegistry`'s actual call signature to match the existing test file's setup helpers — read the file first.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/operations/default-operation-registry.spec.ts`

- [ ] **Step 4: Delete `input`/`output`/`query` from `OperationDescriptor` and `resolveDtoOverride`**

In `operation-registry.ts`: remove the `input`/`output`/`query: DtoClass | null` fields from the `OperationDescriptor` interface, and any `DtoClass`/`OperationDtoOverride` imports from `../dto/dto.js`.

In `default-operation-registry.ts`: delete the `resolveDtoOverride` function and every call site that populates `input`/`output`/`query` on a built descriptor; keep `resolveSchemaOverride` and its `schemaInput`/`schemaOutput`/`schemaQuery` population untouched. Remove now-unused `DtoClass`/`OperationDtoOverride`/`DtoResolver` imports.

- [ ] **Step 5: Fix every other place in `default-operation-registry.ts` that reads `descriptor.input`/`.output`/`.query`**

Grep within the file for `.input`/`.output`/`.query` reads that assumed the old `DtoClass` fields and update them to read `.schemaInput`/`.schemaOutput`/`.schemaQuery` instead (these should already largely exist alongside, per the spec — this step is about deleting the now-dead `dto`-branch, not adding a new one).

- [ ] **Step 6: Run test to verify it passes, then the whole core suite**

Run: `pnpm vitest run packages/core/tests/operations/default-operation-registry.spec.ts && pnpm --filter @kavo/core test`

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/operations packages/core/tests/operations
git commit -m "feat(core): operation registry drops DtoClass fields, keeps schema-only descriptor"
```

---

## Task 8: Serializer/Deserializer — rename `dto` param to `schema`, branch on validator vs. class

**Files:**
- Modify: `packages/core/src/serialization/serializer.ts`
- Modify: `packages/core/src/serialization/default-serializer.ts`
- Test: `packages/core/tests/serialization/default-serializer.spec.ts` (confirm path)

**Interfaces:**
- Produces: `Serializer.serializeItem<T>(entity, schema: SchemaLike<T & object> | null, context)`, `serializeList` likewise, `Deserializer.deserialize<T>(raw, schema: SchemaLike<T & object> | null, context)`. Narrowing logic: `isSchemaClass(schema) ? schemaShapeKeys(schema) : null` — a validator-kind schema contributes **no** narrowing at this layer (unchanged: the engine's own `safeParse` step, Task 10, is what narrows/validates it); a class-kind one narrows exactly as `dtoShapeKeys` did.

- [ ] **Step 1: Write the failing test**

Add to `default-serializer.spec.ts`:

```ts
it("narrows serializeItem's projection using a class-shaped schema", () => {
  class ItemSchema {
    id = 0;
  }
  const result = serializer.serializeItem({ id: 1, name: "a" }, ItemSchema, context);
  expect(result).toEqual({ id: 1 });
});

it("does not narrow serializeItem's projection for a validator-shaped schema (narrowing happens at the engine layer)", () => {
  const validator = { safeParse: () => ({ success: true, data: {} }) };
  const result = serializer.serializeItem({ id: 1, name: "a" }, validator, context);
  expect(result).toEqual({ id: 1, name: "a" });
});
```

(Match the existing file's `serializer`/`context` test fixtures — read the file first for exact setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/tests/serialization/default-serializer.spec.ts`

- [ ] **Step 3: Update `serializer.ts`'s interface**

Rename the `dto: DtoClass<...> | null` parameters in `Serializer`/`Deserializer` to `schema: SchemaLike<...> | null`; import `SchemaLike` from `../schema/schema-class.js` instead of `DtoClass` from `../dto/dto.js`.

- [ ] **Step 4: Update `default-serializer.ts`**

- Change the import `import { dtoShapeKeys } from "../dto/dto-shape.js";` and `import type { DtoClass } from "../dto/dto.js";` to `import { schemaShapeKeys } from "../schema/schema-shape.js";` and `import { isSchemaClass, type SchemaClass, type SchemaLike } from "../schema/schema-class.js";`.
- Rename `narrowToDto(projection, dto: DtoClass | null)` to `narrowToSchema(projection, schema: SchemaLike<unknown> | null)`:

```ts
function narrowToSchema(projection: Projection, schema: SchemaLike<unknown> | null): Projection {
  if (schema === null || !isSchemaClass(schema)) {
    return projection;
  }
  const keys = schemaShapeKeys(schema);
  return keys === null ? projection : { ...projection, keys };
}
```

- Rename every `serializeItem`/`serializeList` parameter from `dto` to `schema`, update their call to `narrowToSchema` instead of `narrowToDto`.
- In `projectionFor` (the relation-target projection method), change `const dto = info.config.dto.resolve(...)` to `const schema = info.config.schema.resolveOutput(node.relation.cardinality === "many" ? "list" : "item", "findMany")`, and `dtoShapeKeys(dto)` to `isSchemaClass(schema) ? schemaShapeKeys(schema) : null`.
- In `DefaultDeserializer.deserialize`, rename its `dto` parameter to `schema: SchemaLike<Shape & object> | null`, and change `const explicit = dtoShapeKeys(dto);` to `const explicit = isSchemaClass(schema) ? schemaShapeKeys(schema) : null;`. The doc comments referencing "a registered `create`/`update`/`patch` DTO" get reworded to "a class-shaped `create`/`update`/`patch` schema" — keep the substance (a validator-shaped schema contributes no explicit allowlist here; the derived writable projection is still what's used, and the engine's `safeParse` step separately validates/reshapes afterward).

- [ ] **Step 5: Run test to verify it passes, then the whole file's suite**

Run: `pnpm vitest run packages/core/tests/serialization/default-serializer.spec.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/serialization packages/core/tests/serialization
git commit -m "feat(core): serializer/deserializer narrow on class-shaped schema only"
```

---

## Task 9: `kavo-engine.ts` — delete `config.dto.resolve(...)` calls, branch `applyOutputSchema`/`deserializeWithSchema` on kind

**Files:**
- Modify: `packages/core/src/engine/kavo-engine.ts`
- Test: `packages/core/tests/engine/kavo-engine.spec.ts` (and any other `engine/*.spec.ts` covering create/update/patch/find flows — search for `dto:` in `packages/core/tests/engine/`)

**Interfaces:**
- Consumes: `isSchemaClass` from `../schema/schema-class.js`.
- Produces: `applyOutputSchema<T>(schema: SchemaLike<unknown> | null, value: T): T` only calls `.safeParse` when `!isSchemaClass(schema)`; for a class-shaped schema it returns `value` unchanged (narrowing for that case already happened in the serializer, Task 8). `deserializeWithSchema` likewise: skip `.safeParse`/`SchemaValidationException` entirely when the resolved schema is class-shaped — return the deserializer's own output as-is (matching `dto`'s "no validation subsystem attached" posture).

- [ ] **Step 1: Locate every `config.dto.resolve(...)` call**

Run: `grep -n "config.dto\|descriptor.input\|descriptor.output\|descriptor.query" packages/core/src/engine/kavo-engine.ts`

Confirm the call sites match the earlier read (lines ~949-950, 994, 1156, 1534, 1592) — read each surrounding ~15 lines before editing, since exact line numbers may have shifted after Tasks 1-8.

- [ ] **Step 2: Write the failing tests**

Add to `packages/core/tests/engine/kavo-engine.spec.ts` (adapt to the file's existing `createEngine`/entity fixtures):

```ts
it("createOne with a class-shaped schema.input.create runs no engine-level validation", async () => {
  class CreateSchema {
    name = "";
  }
  const engine = createTestEngine({ schema: { input: { create: CreateSchema } } });
  // A body missing every required field still succeeds — there is no safeParse to reject it.
  const result = await engine.execute({ operation: "createOne", body: {} /* ...other required request fields */ });
  expect(result.status).not.toBe(400);
});

it("createOne with a validator-shaped schema.input.create raises SchemaValidationException on a bad body", async () => {
  const validator = {
    safeParse: (input: unknown) =>
      typeof (input as { name?: unknown }).name === "string"
        ? { success: true as const, data: input }
        : { success: false as const, error: { issues: [{ path: ["name"], message: "required" }] } },
  };
  const engine = createTestEngine({ schema: { input: { create: validator } } });
  await expect(
    engine.execute({ operation: "createOne", body: {} /* ...other required request fields */ }),
  ).rejects.toThrow(/name/);
});
```

(Replace `createTestEngine`/`engine.execute`'s exact call shape with whatever the existing spec file already uses — read it first; this plan cannot guess the exact fixture helper names without risking a mismatch, so the executor must match the file's established pattern rather than invent a new one.)

- [ ] **Step 3: Run tests to verify they fail (or already pass if the branch coincidentally works) — establish the baseline**

Run: `pnpm vitest run packages/core/tests/engine/kavo-engine.spec.ts -t "class-shaped schema"`

- [ ] **Step 4: Update `applyOutputSchema`**

```ts
private applyOutputSchema<T>(schema: SchemaLike<unknown> | null, value: T): T {
  if (schema === null || isSchemaClass(schema)) {
    return value;
  }
  const result = schema.safeParse(value);
  return result.success ? (result.data as T) : value;
}
```

Add `import { isSchemaClass, type SchemaLike } from "../schema/schema-class.js";` (replacing the old `import type { KavoSchema } from "../dto/kavo-schema.js";`).

- [ ] **Step 5: Update `deserializeWithSchema`**

```ts
private deserializeWithSchema(
  raw: unknown,
  schema: SchemaLike<unknown> | null,
  descriptor: OperationDescriptor<Entity>,
  context: KavoContext<Entity>,
): unknown {
  const candidate = this.deps.deserializer.deserialize(raw, schema, context);
  if (schema === null || isSchemaClass(schema)) {
    return candidate;
  }
  const result = schema.safeParse(candidate);
  if (result.success) {
    return result.data;
  }
  throw new SchemaValidationException(
    result.error.issues.map((issue): QueryIssueDto => ({
      field: issue.path.length === 0 ? "(root)" : issue.path.map(String).join("."),
      detail: issue.message,
    })),
    { context: { entityName: context.entityName, operation: descriptor.id, correlationId: context.correlationId } },
  );
}
```

Note the signature drops the separate `dto` parameter entirely — `this.deps.deserializer.deserialize(raw, schema, context)` now passes the single merged `schema` value straight through (Task 8 already made `Deserializer.deserialize` accept `SchemaLike | null` as its one shape parameter). Update every call site of `deserializeWithSchema` (found via the same grep as Step 1) to drop whatever `dto` argument they were passing and pass only `schema`.

- [ ] **Step 6: Delete every remaining `config.dto.resolve(...)` fallback and its dto-specific error-message branch**

At each of the other located call sites (the `findOne`/`findMany` item/list schema resolution around lines ~951, ~1535, ~1593 per the earlier read): delete `?? config.dto.resolve(slot, descriptor.id)` fallbacks — `descriptor.schemaOutput`/`descriptor.schemaInput`/`descriptor.schemaQuery` (Task 7) already carry the fully-resolved value (registry resolution already folds the entity-default fallback in), so nothing needs to additionally consult `config.dto` (which no longer exists on `ResolvedEntityConfig` after Task 6). If any error-message code path branches on "was this a `dto`-narrowed shape or a `schema`-narrowed one" (the `projectedAgainst` helper mentioned in the earlier research, lines ~1862-1996), collapse it to a single message that doesn't distinguish the two — reword any "DTO" wording in that message to "schema".

- [ ] **Step 7: Run tests to verify they pass, then the whole core suite**

Run: `pnpm --filter @kavo/core test && pnpm --filter @kavo/core typecheck && pnpm --filter @kavo/core build`

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/engine packages/core/tests/engine
git commit -m "feat(core): engine validates only validator-shaped schemas, deletes dto fallback"
```

---

## Task 10: `KavoService` typed surface and `index.ts` barrel

**Files:**
- Modify: `packages/core/src/service/kavo-service.ts`
- Modify: `packages/core/src/service/default-kavo-service.ts`
- Modify: `packages/core/src/service/custom-operation.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/types/kavo-service.test-d.ts` (locate — this is a `*.test-d.ts` type-only test per repo convention, checked by `pnpm typecheck` not `pnpm test`)

**Interfaces:**
- Produces: `index.ts`'s public barrel drops every `Dto*`-named export (`Dto`, `DtoClass`, `DtoSlot`, `DtoResolver`, `OperationDtoMap`, `OperationDtoOverride`, `DtoInputOf`, `DtoOutputOf`, `DtoQueryOf`, `FieldsShorthand` if it was re-exported from the old location, `WriteApply`, `WriteFieldsConfig`) and adds the `schema` module's surface: `KavoSchema`, `SchemaOutput`, `SchemaClass`, `SchemaLike`, `EntitySchema`, `EntitySchemaMap`, `SchemaResolver`, `DefaultSchemaResolver`, `OperationSchemaOverride`, `SchemaInputOf`, `SchemaOutputOf`, `SchemaQueryOf`, `WritableSchemaFieldsConfig`, plus `WriteApply`/`WriteFieldsConfig`/`FieldsShorthand` re-pointed to `./config/write-fields.js`.

- [ ] **Step 1: Confirm no runtime code changes needed in `kavo-service.ts`/`default-kavo-service.ts`/`custom-operation.ts`**

Per the spec and the earlier read of `kavo-service.ts`, these already import `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf` from `../dto/entity-schema.js` and never reference `DtoInputOf`/etc. directly. Update only their import paths from `../dto/entity-schema.js` to `../schema/entity-schema.js`, and `../dto/dto.js`'s `OperationEntryOf` (if `custom-operation.ts` imports it directly) to `../operations/operation-entry.js` (Task 2).

- [ ] **Step 2: Update the type-level acceptance test**

Locate `packages/core/tests/types/*.test-d.ts` files referencing `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`/`OperationDtoMap` (run `grep -rl "DtoInputOf\|DtoOutputOf\|DtoQueryOf\|OperationDtoMap" packages/core/tests/types/`). Rewrite each assertion to use `schema: { input: { ... } }`/`schema: { output: { ... } }` config shapes and `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf` instead — since these are `expectTypeOf`/`@ts-expect-error` assertions checked by `tsc` only (never executed), each one needs its literal config object updated to the new shape, not just its imports.

- [ ] **Step 3: Update `index.ts`**

Remove the `Dto*` export block (reported at lines 55-67, 304-305 in the research). Add:

```ts
export type {
  KavoSchema,
  SchemaOutput,
} from "./schema/kavo-schema.js";
export type { SchemaClass, SchemaLike } from "./schema/schema-class.js";
export type {
  EntitySchema,
  EntitySchemaMap,
  SchemaInputSlot,
  SchemaOutputSlot,
  SchemaResolver,
  OperationSchemaOverride,
  WritableSchemaFieldsConfig,
} from "./schema/entity-schema.js";
export { DefaultSchemaResolver } from "./schema/entity-schema.js";
export type { SchemaClass as SchemaConstructor } from "./schema/schema-class.js"; // remove this duplicate line — SchemaClass is already exported above; do not double-export
export type { WriteApply, WriteFieldsConfig, FieldsShorthand } from "./config/write-fields.js";
```

(Drop the accidental duplicate `SchemaClass as SchemaConstructor` line shown above — it's there only as a reminder not to introduce one; the real edit exports `SchemaClass` exactly once.) Check whether `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf` were already exported from `index.ts` before this task (the spec says they're part of the public surface already) — if so, just retarget their import path; if not, add them.

- [ ] **Step 4: Verify `tests/core-barrel.spec.ts`'s ADR-0010 check still passes**

Run: `pnpm vitest run tests/core-barrel.spec.ts` (repo-root test, not package-scoped — confirm the path with `find . -iname "core-barrel.spec.ts"`)

- [ ] **Step 5: Run the full core package gate**

Run: `pnpm --filter @kavo/core build && pnpm --filter @kavo/core typecheck && pnpm --filter @kavo/core test && pnpm --filter @kavo/core lint`

- [ ] **Step 6: Delete the now-empty `dto/` directory if anything remains in it**

```bash
ls packages/core/src/dto/ 2>/dev/null && echo "STILL HAS FILES — investigate before deleting" || rmdir packages/core/src/dto
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/service packages/core/src/index.ts packages/core/tests/types
git commit -m "feat(core): retarget KavoService typed surface and public barrel to schema, delete dto/"
```

---

## Task 11: `@kavo/nest` — `kavo.decorator.ts`'s `ValidationPipe` wiring moves to `schema`

**Files:**
- Modify: `packages/frameworks/nest/src/kavo.decorator.ts`
- Test: `packages/frameworks/nest/tests/kavo.decorator.spec.ts` (confirm path)

**Interfaces:**
- Consumes: `DefaultSchemaResolver`, `SchemaResolver`, `isSchemaClass` from `@kavo/core`.
- Produces: `defineRoute`/`applyRouteDecorators`/`applyParamDecorators` take a `schemaResolver?: SchemaResolver<object>` parameter (renamed from `dtoResolver?: DtoResolver<object>`); `applyParamDecorators`'s `design:paramtypes` write only happens when `bodyDtoFor`'s resolved value is class-shaped (`isSchemaClass`), never for a validator.

- [ ] **Step 1: Read the current `bodyDtoFor` definition**

Run: `sed -n '1690,1720p' packages/frameworks/nest/src/swagger.ts` (it's exported from `swagger.ts`, imported into `kavo.decorator.ts` per line 56 of the earlier read) to get its exact current signature before editing — Task 12 also touches this function, so coordinate: this task only needs to consume its *new* return type (`SchemaLike<object> | null` instead of `ClassRef | null`), and Task 12 is the one that actually changes `bodyDtoFor`'s body. Do this task second if execuing serially, after Task 12 — reorder if using subagent-driven execution so `bodyDtoFor`'s signature is already updated when this task runs. **If executing tasks in order, do Task 12 before Task 11.**

- [ ] **Step 2: Write the failing test**

Add to `kavo.decorator.spec.ts`, asserting on the generated route's `design:paramtypes` metadata:

```ts
it("writes design:paramtypes metadata for a generated createOne route with a class-shaped schema.input.create", () => {
  class CreateBookSchema {
    title = "";
  }
  @Kavo(Book, { schema: { input: { create: CreateBookSchema } } })
  class BookController {}
  const paramTypes = Reflect.getMetadata("design:paramtypes", BookController.prototype, "createOne");
  expect(paramTypes).toBeDefined();
  // The body parameter's position is whatever the fixed layout puts it at for a write with no id param.
  expect(paramTypes[0]).toBe(CreateBookSchema);
});

it("writes no design:paramtypes metadata when schema.input.create is a validator, not a class", () => {
  const validator = { safeParse: () => ({ success: true as const, data: {} }) };
  @Kavo(Book, { schema: { input: { create: validator } } })
  class BookController {}
  const paramTypes = Reflect.getMetadata("design:paramtypes", BookController.prototype, "createOne");
  expect(paramTypes).toBeUndefined();
});
```

(Match the existing file's `@Kavo`/entity-fixture conventions — read it first; the exact parameter index for `createOne`'s body depends on `route.hasIdParam`/`descriptor.kind`, confirm against the file's other `design:paramtypes` assertions if any exist, or against `applyParamDecorators`'s documented fixed layout.)

- [ ] **Step 3: Run tests to verify the first passes already (behavior parity) and the second is new**

Run: `pnpm --filter @kavo/nest vitest run tests/kavo.decorator.spec.ts -t "design:paramtypes"`

- [ ] **Step 4: Update `kavo.decorator.ts`**

- Replace the import `DefaultDtoResolver`/`DtoResolver`/`OperationDtoMap` (wherever imported, likely from `@kavo/core`) with `DefaultSchemaResolver`/`SchemaResolver`/`isSchemaClass`.
- In `defineRoute`: replace `new DefaultDtoResolver(config?.dto as OperationDtoMap<object> | undefined, { create: config?.create, update: config?.update })` with `new DefaultSchemaResolver(config?.schema, { create: config?.create, update: config?.update })`, and rename the local `dtoResolver` variable to `schemaResolver`.
- In `applyRouteDecorators`: rename the `dtoResolver?: DtoResolver<object>` parameter to `schemaResolver?: SchemaResolver<object>` and thread the renamed variable through to `applyParamDecorators`.
- In `applyParamDecorators`: rename the parameter the same way; change:

```ts
if (bodyIndex === -1 || dtoResolver === undefined) {
  return;
}
const bodyDto = bodyDtoFor(descriptor, dtoResolver);
if (bodyDto === null) {
  return;
}
```

  to:

```ts
if (bodyIndex === -1 || schemaResolver === undefined) {
  return;
}
const bodySchema = bodyDtoFor(descriptor, schemaResolver);
if (bodySchema === null || !isSchemaClass(bodySchema)) {
  return;
}
```

  and rename `paramTypes[bodyIndex] = bodyDto;` to `paramTypes[bodyIndex] = bodySchema;`. Update the doc comment above `applyParamDecorators` (the one explaining issue #281) to say "a class-shaped `schema.input.<slot>`" instead of "a registered `dto.create`/`dto.update`/`dto.patch` class," and add one sentence noting a validator-shaped `schema.input.<slot>` intentionally writes no metadata — `ValidationPipe` has nothing to bind to, and engine-level `safeParse` validation covers it instead.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kavo/nest vitest run tests/kavo.decorator.spec.ts`

- [ ] **Step 6: Run the full `@kavo/nest` package gate**

Run: `pnpm --filter @kavo/nest build && pnpm --filter @kavo/nest typecheck && pnpm --filter @kavo/nest test`

(Expect failures here from `swagger.ts`/`kavo.module.ts` still referencing the old `dto` symbols — those are Task 12/13's job. If this task is executed strictly in order and Task 12 hasn't landed yet, this step will fail; that's expected per the reordering note in Step 1 — resolve by doing Task 12 first.)

- [ ] **Step 7: Commit**

```bash
git add packages/frameworks/nest/src/kavo.decorator.ts packages/frameworks/nest/tests/kavo.decorator.spec.ts
git commit -m "feat(nest): ValidationPipe metadata wiring reads class-shaped schema instead of dto"
```

---

## Task 12: `@kavo/nest` — `swagger.ts`'s `bodyDtoFor`/`schemaFromDto`/OpenAPI generation merge onto `schema`

**Files:**
- Modify: `packages/frameworks/nest/src/swagger.ts`
- Test: `packages/frameworks/nest/tests/swagger.spec.ts` (confirm path)

**Interfaces:**
- Produces: `bodyDtoFor(descriptor: OperationDescriptor<object>, schemaResolver: SchemaResolver<object>): SchemaLike<object> | null` (renamed parameter and resolver type; return type widens from `ClassRef | null` to `SchemaLike<object> | null`). `schemaFromDto` is renamed `openApiSchemaFor` and gains a branch: class-shaped input → today's instantiate-and-reflect behavior (renamed, unchanged logic); validator-shaped input → call `.toJSONSchema?.()` if present, else fall back to the entity-derived default (the same fallback an unconfigured slot already takes).

- [ ] **Step 1: Read `swagger.ts` in full around every reported line (190-222, 338, 352, 368, 1013, 1252, 1278-1332, 1351-1424, 1487-1494, 1575-1650, 1694-1710)**

This file is large (~1700+ lines) and load-bearing for OpenAPI generation; do not edit blind. Read each region before touching it. The existing `schemaResolver` (already built alongside `dtoResolver` at line 338, per the earlier grep) is the thing this task's renamed `dtoResolver`-successor **merges into** — after this task there is exactly one resolver (`schemaResolver: SchemaResolver<object>`, built via `new DefaultSchemaResolver(...)`), not two.

- [ ] **Step 2: Write the failing test**

Add to `swagger.spec.ts` two cases: one asserting a class-shaped `schema.output.item` still produces an OpenAPI response schema from its reflected own-keys (parity with today's `dto.item`-driven behavior), and one asserting a validator-shaped `schema.output.item` with a `toJSONSchema()` method produces a response schema from that method's return value:

```ts
it("generates the response schema by reflecting a class-shaped schema.output.item", () => {
  class BookItemSchema {
    id = 0;
    title = "";
  }
  const document = buildOpenApiDocument(BookController /* with @Kavo(Book, { schema: { output: { item: BookItemSchema } } }) */);
  const responseSchema = document.paths["/books/{id}"].get.responses["200"].content["application/json"].schema;
  expect(responseSchema.properties).toHaveProperty("id");
  expect(responseSchema.properties).toHaveProperty("title");
});

it("generates the response schema from a validator's toJSONSchema()", () => {
  const validator = {
    safeParse: () => ({ success: true as const, data: {} }),
    toJSONSchema: () => ({ type: "object", properties: { id: { type: "number" } } }),
  };
  const document = buildOpenApiDocument(BookController /* with schema.output.item: validator */);
  const responseSchema = document.paths["/books/{id}"].get.responses["200"].content["application/json"].schema;
  expect(responseSchema.properties).toHaveProperty("id");
});
```

(`buildOpenApiDocument`/`BookController`'s exact construction must match the existing test file's harness — read it first; this plan cannot fabricate the exact Nest-testing-module boilerplate without risking mismatch against the file's real setup.)

- [ ] **Step 3: Run tests to verify they fail (or the second one does; the first may already pass via `dto` before this task's edits — confirm which)**

Run: `pnpm --filter @kavo/nest vitest run tests/swagger.spec.ts -t "schema.output.item"`

- [ ] **Step 4: Merge `dtoResolver` into `schemaResolver`, rename `schemaFromDto`**

- Delete the separate `dtoResolver` construction (line 338's `new DefaultDtoResolver(...)`) — keep only the `schemaResolver` construction (`new DefaultSchemaResolver(config?.schema, { create: config?.create, update: config?.update })`, widening its `writable` argument to match Task 5's new second parameter if it doesn't already).
- Rename every `dtoResolver` local/parameter to `schemaResolver`, typed `SchemaResolver<object>`.
- Rename `bodyDtoFor(descriptor, dtoResolver)` calls to `bodyDtoFor(descriptor, schemaResolver)`; update `bodyDtoFor`'s own definition (line ~1694) to resolve via `schemaResolver.resolveInput(slot, descriptor.id)` instead of `dtoResolver.resolve(slot, descriptor.id)`, returning `SchemaLike<object> | null`. Its doc comment mentioning "a `dto.<slot>` `{ fields }` shorthand" is reworded to "a `schema.<slot>` `{ fields }` shorthand" (behavior unchanged — the shorthand is already resolved to a class by `DefaultSchemaResolver` before `bodyDtoFor` ever sees it, per Task 4/5).
- Rename `schemaFromDto` (line 1575) to `openApiSchemaFor`, and branch its body:

```ts
function openApiSchemaFor(schema: SchemaLike<object> | null, entityName: string): OpenApiSchema | null {
  if (schema === null) {
    return null;
  }
  if (isSchemaClass(schema)) {
    // ...today's schemaFromDto body, unchanged: instantiate `schema`, reflect own-enumerable keys, build the OpenAPI object schema...
    return classShapeToOpenApiSchema(schema, entityName); // keep whatever the existing implementation was actually named internally — this line documents intent, not a new helper to invent if one doesn't already exist as a separable function; if `schemaFromDto`'s body wasn't already factored into a sub-helper, just keep its existing logic inline under this branch
  }
  return schema.toJSONSchema?.() as OpenApiSchema | undefined ?? null;
}
```

  Update every call site of `schemaFromDto` (lines 1252, 1326, 1332, 1640 per the earlier grep) to call `openApiSchemaFor` instead, and where a caller previously fell back to the entity-derived default when `schemaFromDto` returned `null` for an unconfigured slot, confirm that same fallback still fires when `openApiSchemaFor` returns `null` for a validator with no `toJSONSchema` — this should already be the existing control flow (no `dto` → entity-derived default), just re-triggered by a different `null`-producing condition now.
- Update `successBodyFor`'s signature (line 1278) — it currently takes both `dtoResolver: DtoResolver<object>` and, per the spec excerpt at line 218-222, an already-separate `schemaResolver` — collapse to the single `schemaResolver: SchemaResolver<object>` parameter, and update its body's `dtoResolver.resolve(slot, descriptor.id)` (line 1321) to `schemaResolver.resolveOutput(slot, descriptor.id)`.
- Update `applyBodySchemaDocs`/wherever line 1487-1494's `dtoResolver.resolve(slot, descriptor.id) !== null` check lives, retargeting to `schemaResolver.resolveInput(slot, descriptor.id) !== null` (or `resolveOutput`, matching whichever slot kind that check was already gating).
- Sweep every remaining `dto.output`/`dto.input`/"DTO" wording in doc comments and error/warning strings in this file to `schema.output`/`schema.input`/"schema".

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @kavo/nest vitest run tests/swagger.spec.ts`

- [ ] **Step 6: Run Task 11's tests again (now unblocked) and the full `@kavo/nest` gate**

Run: `pnpm --filter @kavo/nest vitest run tests/kavo.decorator.spec.ts tests/swagger.spec.ts && pnpm --filter @kavo/nest build && pnpm --filter @kavo/nest typecheck`

- [ ] **Step 7: Commit**

```bash
git add packages/frameworks/nest/src/swagger.ts
git commit -m "feat(nest): swagger generation merges dto/schema resolvers, adds toJSONSchema branch"
```

---

## Task 13: `@kavo/nest` — `kavo.module.ts` and `register-schemas.ts`

**Files:**
- Modify: `packages/frameworks/nest/src/kavo.module.ts`
- Modify: `packages/frameworks/nest/src/register-schemas.ts`
- Test: `packages/frameworks/nest/tests/kavo.module.spec.ts` (confirm path)

**Interfaces:**
- Produces: `kavo.module.ts`'s `dtoResolver` (built at lines ~398, ~450 per the earlier grep) becomes the same merged `schemaResolver: SchemaResolver<object>` pattern from Task 12 — no separate `dto`-only resolver remains anywhere in `@kavo/nest`.

- [ ] **Step 1: Read the two reported construction sites in full**

Run: `sed -n '380,460p' packages/frameworks/nest/src/kavo.module.ts` to see both `dtoResolver` constructions (`metadata.config?.dto` and `service.engine.config.dto`) in context before editing.

- [ ] **Step 2: Write the failing test**

Add a case to `kavo.module.spec.ts` asserting that OpenAPI docs generated for an `@Override`'d route (the scenario these two fallback constructions exist for, per the file's doc comments) still resolve a body/response schema correctly when the entity is configured with a class-shaped `schema.output.item` instead of `dto.item`:

```ts
it("resolves an overridden route's response schema from schema.output.item, not dto", async () => {
  class BookItemSchema {
    id = 0;
  }
  // ...build a KavoModule-wired app with @Kavo(Book, { schema: { output: { item: BookItemSchema } } })
  // and an @Override'd findOne method, per the file's existing override-testing pattern...
  const document = /* however this file already extracts the generated OpenAPI document */;
  expect(document.paths["/books/{id}"].get.responses["200"].content["application/json"].schema.properties).toHaveProperty("id");
});
```

(Match the file's existing override/module-wiring test harness exactly — read it first.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @kavo/nest vitest run tests/kavo.module.spec.ts -t "schema.output.item"`

- [ ] **Step 4: Update `kavo.module.ts`**

At both construction sites, replace `new DefaultDtoResolver(metadata.config?.dto as OperationDtoMap<object> | undefined, {...})` / `new DefaultDtoResolver(service.engine.config.dto as OperationDtoMap<object> | undefined, {...})` with `new DefaultSchemaResolver(metadata.config?.schema, {...})` / `new DefaultSchemaResolver(service.engine.config.schema, {...})`, renaming the local variables from `dtoResolver` to `schemaResolver` and updating every downstream call (`bodyDtoFor`, `successBodyFor`, whatever else consumes it in this file) to the new parameter type. Update imports accordingly.

- [ ] **Step 5: Update `register-schemas.ts`**

Per the earlier research, this file has no direct `dto` import — only doc-comment wording. Grep for `dto.output`/`DtoClass` in its comments and reword to `schema.output`/`SchemaClass`.

- [ ] **Step 6: Run test to verify it passes, then the full `@kavo/nest` gate**

Run: `pnpm --filter @kavo/nest test && pnpm --filter @kavo/nest build && pnpm --filter @kavo/nest typecheck && pnpm --filter @kavo/nest depcruise && pnpm --filter @kavo/nest lint`

- [ ] **Step 7: Commit**

```bash
git add packages/frameworks/nest/src/kavo.module.ts packages/frameworks/nest/src/register-schemas.ts
git commit -m "feat(nest): kavo.module.ts's override-docs fallback reads schema, not dto"
```

---

## Task 14: `@kavo/graphql`, `@kavo/mcp`, `@kavo/next` — cosmetic wording, `@kavo/orms/*` test fixtures

**Files:**
- Modify: `packages/protocols/graphql/src/schema.ts`
- Modify: `packages/frameworks/next/src/openapi/entity-schemas.ts`
- Modify: `packages/orms/typeorm/tests/soft-delete.spec.ts`, `packages/orms/typeorm/tests/adapter.spec.ts`
- Modify: `packages/orms/prisma/tests/soft-delete.spec.ts`
- Modify: `packages/orms/mongoose/tests/soft-delete.spec.ts`
- Modify: `packages/orms/mikroorm/tests/soft-delete.spec.ts`

**Interfaces:** None new — no production code behavior changes in `graphql`/`mcp`/`next` per the confirmed research (`@kavo/mcp` needs no edit at all — its `dto`-named symbols are generic parameters, not references to the deleted module).

- [ ] **Step 1: Update `graphql/src/schema.ts`'s error-message wording**

Find the "dto.output"/"dto.input" text at lines ~364-376 (confirm exact lines first) and reword to "schema.output"/"schema.input".

- [ ] **Step 2: Update `next/src/openapi/entity-schemas.ts`'s comment**

Find the `dto.create/item/…` doc-comment mention and reword to `schema.create/item/…` — or more precisely `schema.input.create`/`schema.output.item`, matching the real config shape.

- [ ] **Step 3: Rename `dto:` config keys to `schema:` in the four ORM test fixture files**

In each of `soft-delete.spec.ts` (typeorm, prisma, mongoose, mikroorm) and `typeorm/tests/adapter.spec.ts`, find every `dto: { ... }` test-fixture config object and convert it to the equivalent `schema: { input: { ... }, output: { ... } }` shape, using a plain class for each slot that was previously a `DtoClass` (no behavior change intended — these are fixtures, not new coverage).

- [ ] **Step 4: Run each affected package's tests**

Run: `pnpm --filter @kavo/graphql test && pnpm --filter @kavo/next test && pnpm --filter @kavo/typeorm test && pnpm --filter @kavo/prisma test && pnpm --filter @kavo/mongoose test && pnpm --filter @kavo/mikroorm test`

- [ ] **Step 5: Commit**

```bash
git add packages/protocols/graphql/src packages/frameworks/next/src packages/orms
git commit -m "chore: reword dto references to schema in graphql/next docs and ORM test fixtures"
```

---

## Task 15: Workspace-wide gate, ADR addendum, docs sweep

**Files:**
- Modify: `docs/internals/adr/0055-schema-is-the-source-of-truth-for-dto-and-validation.md`
- Modify: every `docs/**/*.md` file matching `dto:`/`dto.create`/`dto.item`/etc. config examples (find with `grep -rl "dto:" docs/ --include=*.md`)
- Modify: `.claude/skills/add-config-key/*`, `.claude/skills/add-operation/*` if they reference `dto` as a worked example (find with `grep -rl "dto" .claude/skills/add-config-key .claude/skills/add-operation`)

**Interfaces:** None — documentation only.

- [ ] **Step 1: Add the ADR-0055 addendum**

Append a `## Update (2026-09-18)` section to `docs/internals/adr/0055-schema-is-the-source-of-truth-for-dto-and-validation.md`:

```markdown
## Update (2026-09-18)

`dto` is now fully deleted (not just superseded) — see
`docs/superpowers/specs/2026-09-18-remove-dto-design.md`. The
"Consequences" section above is resolved as follows:

- The DTO-class type-inference chain was re-derived: `SchemaInputOf`/
  `SchemaOutputOf`/`SchemaQueryOf` no longer fall back to the old
  `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf` helpers, which are deleted.
- `class-validator` body validation and `schema` no longer overlap as two
  mechanisms: a `schema` slot now accepts either a `KavoSchema` validator
  or a plain/decorated class (`SchemaClass`) — the class-validator path is
  the class-shaped variant of the same `schema` config key, not a
  separate one.
- `@kavo/graphql` and `@kavo/mcp` needed no migration — neither ever read
  DTO metadata off `createCrud` directly.
```

- [ ] **Step 2: Sweep the 22 ADRs flagged for `dto`-wording audit**

Run: `grep -l "\bdto\b" docs/internals/adr/00{06,09,11,14,19,20,21,23,24,26,29,31,32,33,34,36,42,44,46,48,50,52}-*.md`

For each match, read the surrounding paragraph and reword `dto`/`DTO` references to `schema` **only where they describe current behavior** (a historical "at the time, `dto` did X" sentence describing why a past decision was made stays as-is — these are historical records, not living specs; only present-tense claims about how the system behaves today need the wording fix).

- [ ] **Step 3: Sweep `docs/**` guide/reference pages**

Run: `grep -rl "dto:" docs/ --include=*.md`

For each file, convert `dto:`-keyed config examples to `schema:`-keyed ones (input/output split), following the writing-kavo-docs skill's voice guidance if further prose changes are needed beyond the code samples.

- [ ] **Step 4: Sweep the `add-config-key`/`add-operation` skills**

Run: `grep -rl "dto" .claude/skills/add-config-key .claude/skills/add-operation 2>/dev/null`

Update any worked example that configures `dto` to configure `schema` instead.

- [ ] **Step 5: Run the full workspace gate**

Run: `pnpm check`
Expected: PASS — this is the first point in the plan where the entire monorepo (all packages, all examples) has been exercised together; if anything outside the packages this plan explicitly touched still references `dto` (an example app under `examples/*`, say), fix it here.

- [ ] **Step 6: Run the docs-specific gates**

Run: `pnpm docs:build && pnpm docs:links`

- [ ] **Step 7: Commit**

```bash
git add docs .claude/skills
git commit -m "docs: close out ADR-0055's dto-removal follow-up, sweep dto wording from docs and skills"
```

---

## Final verification

- [ ] Run `pnpm check` one more time from a clean `git status` to confirm nothing was left uncommitted.
- [ ] Run `grep -rn "\bdto\b\|\bDto\b" packages/*/src packages/*/*/src --include=*.ts` (excluding `packages/core/src/schema/` doc comments that legitimately describe the historical `dto` mechanism in the ADR addendum's own wording, and excluding generic parameter names like `CreateDto`/`UpdateDto` in `@kavo/graphql`/`@kavo/mcp`, which the spec explicitly leaves as-is since they're just type-parameter names, not references to the deleted module) and confirm every remaining hit is one of those two allowed categories.
