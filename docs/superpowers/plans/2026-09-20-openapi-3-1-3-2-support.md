# OpenAPI 3.1/3.2 Support in `@kavo/nest` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@kavo/nest`'s generated OpenAPI schemas spec-correct under OpenAPI 3.1/3.2 (JSON Schema 2020-12 dialect) when a caller opts their document into one of those versions via `@nestjs/swagger`'s existing `DocumentBuilder.setOpenAPIVersion`, with zero change to the default 3.0 output.

**Architecture:** A new pure-function module, `openapi-dialect.ts`, walks a finished `components.schemas` map and rewrites two OpenAPI-3.0-only keywords — `nullable: true` and schema-level `example` — into their JSON Schema 2020-12 equivalents (`type` union with `"null"`, and `examples` array). `registerKavoSchemas` (`register-schemas.ts`) calls it as the last step of its existing document post-processing pass, gated on reading `document.openapi` back — no new Kavo config surface.

**Tech Stack:** TypeScript, Vitest + SWC (existing `@kavo/nest` test setup), `@nestjs/swagger` (optional peer, already a test dependency).

**Spec:** `docs/superpowers/specs/2026-09-20-openapi-3-1-3-2-support-design.md`

## Global Constraints

- No new Kavo config key, and no new parameter on `registerKavoSchemas` — detection is entirely `document.openapi`-driven, per the spec's "Detection" section.
- Decoration-time and bind-time code in `swagger.ts` (`applySwaggerMetadata`, `applyBodySchemaDocs`, `applyResponseSchemaDocs`, etc.) is **not modified** — it keeps emitting today's 3.0-shaped `nullable: true`/`example` unconditionally, per the spec's "What does not change" section.
- Only two keywords are in scope: `nullable` and schema-level `example`. Webhooks, `const`, hierarchical tags, and everything else surveyed in the spec's "Out of scope" section are not touched by this plan.
- `pnpm check` (build + depcruise + lint + test) must pass before this work is considered done, per this repo's own workflow rules — never work around a red gate.

---

## Task 1: `openapi-dialect.ts` — pure schema-dialect upgrade module

**Files:**

- Create: `packages/frameworks/nest/src/openapi-dialect.ts`
- Test: `packages/frameworks/nest/tests/openapi-dialect.spec.ts`

**Interfaces:**

- Produces: `targetsJsonSchemaDialect(openapi: unknown): boolean` — `true` for a parseable `"3.1"`/`"3.2"`(+)-prefixed version string, `false` otherwise (including non-string, absent, or malformed input).
- Produces: `upgradeToJsonSchemaDialect(schemas: Record<string, unknown>): void` — mutates every schema object reachable from `schemas` in place, converting `nullable: true` to a `type` union with `"null"` (or an `anyOf` fallback when there's no `type` to union against) and schema-level `example` to `examples: [value]`.

This task has no dependency on `register-schemas.ts` or any Nest/Swagger machinery — it operates on plain objects, so it's tested in complete isolation.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/frameworks/nest/tests/openapi-dialect.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { targetsJsonSchemaDialect, upgradeToJsonSchemaDialect } from "../src/openapi-dialect.js";

describe("targetsJsonSchemaDialect", () => {
  it("is false for a 3.0.x document", () => {
    expect(targetsJsonSchemaDialect("3.0.0")).toBe(false);
  });

  it("is true for a 3.1.x document", () => {
    expect(targetsJsonSchemaDialect("3.1.0")).toBe(true);
  });

  it("is true for a 3.2.x document", () => {
    expect(targetsJsonSchemaDialect("3.2.0")).toBe(true);
  });

  it("is false for an absent or non-string openapi field", () => {
    expect(targetsJsonSchemaDialect(undefined)).toBe(false);
    expect(targetsJsonSchemaDialect(null)).toBe(false);
    expect(targetsJsonSchemaDialect(3.1)).toBe(false);
  });

  it("is false for a malformed version string", () => {
    expect(targetsJsonSchemaDialect("not-a-version")).toBe(false);
  });
});

describe("upgradeToJsonSchemaDialect", () => {
  it("converts a typed nullable schema into a type union, dropping nullable", () => {
    const schemas: Record<string, unknown> = {
      TodoItem: {
        type: "object",
        properties: {
          deletedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    };

    upgradeToJsonSchemaDialect(schemas);

    const deletedAt = (schemas.TodoItem as { properties: { deletedAt: Record<string, unknown> } }).properties.deletedAt;
    expect(deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("appends null to an existing type array instead of overwriting it", () => {
    const schemas: Record<string, unknown> = {
      Widget: { type: ["string", "number"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ type: ["string", "number", "null"] });
  });

  it("does not duplicate null if the type array already includes it", () => {
    const schemas: Record<string, unknown> = {
      Widget: { type: ["string", "null"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ type: ["string", "null"] });
  });

  it("wraps an untyped nullable schema in anyOf instead of guessing a type", () => {
    const schemas: Record<string, unknown> = {
      Widget: { enum: ["a", "b"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ anyOf: [{ enum: ["a", "b"] }, { type: "null" }] });
  });

  it("converts a schema-level example into an examples array", () => {
    const schemas: Record<string, unknown> = {
      Code: { type: "string", example: "KAVO_NOT_FOUND" },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Code).toEqual({ type: "string", examples: ["KAVO_NOT_FOUND"] });
  });

  it("recurses into properties, items, and allOf to upgrade nested schemas", () => {
    const schemas: Record<string, unknown> = {
      Todo: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string", nullable: true } },
        },
        allOf: [{ type: "object", properties: { note: { type: "string", example: "hi" } } }],
      },
    };

    upgradeToJsonSchemaDialect(schemas);

    const todo = schemas.Todo as {
      properties: { tags: { items: Record<string, unknown> } };
      allOf: [{ properties: { note: Record<string, unknown> } }];
    };
    expect(todo.properties.tags.items).toEqual({ type: ["string", "null"] });
    expect(todo.allOf[0].properties.note).toEqual({ type: "string", examples: ["hi"] });
  });

  it("leaves a schema with neither nullable nor example untouched", () => {
    const schemas: Record<string, unknown> = {
      Plain: { type: "string" },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Plain).toEqual({ type: "string" });
  });
});
```

The file has two `describe` blocks: `targetsJsonSchemaDialect` (5 `it`s) and `upgradeToJsonSchemaDialect` (7 `it`s) — 12 tests total.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/frameworks/nest/tests/openapi-dialect.spec.ts`
Expected: FAIL — `Cannot find module '../src/openapi-dialect.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement `openapi-dialect.ts`**

Create `packages/frameworks/nest/src/openapi-dialect.ts`:

```ts
/**
 * Upgrades the OpenAPI-3.0-shaped schema keywords Kavo's own decoration/
 * bind-time code emits (`swagger.ts`) into the JSON Schema 2020-12 dialect
 * OpenAPI 3.1/3.2 adopted for the Schema Object, when the document declares
 * one of those versions. `registerKavoSchemas` (`register-schemas.ts`) runs
 * this as its last pass, after every component has been hoisted into
 * `components.schemas` — see that file's own module doc for why detection
 * lives there rather than as a new Kavo config key: `@nestjs/swagger`'s
 * `DocumentBuilder.setOpenAPIVersion` already lets a caller stamp
 * `document.openapi`, so this only has to read it back.
 *
 * Two keywords are in scope, both genuine correctness gaps under 3.1+ (not
 * stylistic mismatches) — see the design spec
 * (`docs/superpowers/specs/2026-09-20-openapi-3-1-3-2-support-design.md`)
 * for the full rationale:
 *
 * - `nullable: true` — a 3.0-only OpenAPI extension to JSON Schema, dropped
 *   in 3.1's adopted dialect. Spec-compliant 3.1/3.2 tooling silently
 *   ignores it, so a nullable Kavo field would validate/generate as
 *   non-nullable. Rewritten as a `type` union (`["string", "null"]`), or —
 *   when there's no `type` to union against — an `anyOf` fallback.
 * - Schema-level `example` — deprecated in 3.1 in favor of JSON Schema's own
 *   `examples` array. Rewritten as `examples: [value]`.
 *
 * Decoration-time and bind-time code in `swagger.ts` is untouched and keeps
 * emitting the 3.0 shape unconditionally — it runs before
 * `SwaggerModule.createDocument` even exists, so it cannot know the target
 * version. This module is the only place that shape ever changes.
 */

/** The minimal shape this walk reads/writes; every other key passes through untouched via the index signature. */
interface DialectSchema {
  nullable?: boolean;
  type?: string | readonly string[];
  example?: unknown;
  examples?: readonly unknown[];
  properties?: Record<string, unknown>;
  items?: unknown;
  allOf?: unknown[];
  anyOf?: unknown[];
  oneOf?: unknown[];
  additionalProperties?: unknown;
  [key: string]: unknown;
}

/**
 * `true` for an `openapi` version whose Schema Object dialect is JSON Schema
 * 2020-12 (3.1 and above) — `false` for 3.0.x, and for anything that isn't a
 * parseable `<major>.<minor>` version (an absent/malformed field stays on
 * today's 3.0 behavior rather than throwing).
 */
export function targetsJsonSchemaDialect(openapi: unknown): boolean {
  if (typeof openapi !== "string") {
    return false;
  }
  const match = /^(\d+)\.(\d+)/.exec(openapi);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 1);
}

/** Walk every schema object in `schemas`, upgrading `nullable`/`example` in place. */
export function upgradeToJsonSchemaDialect(schemas: Record<string, unknown>): void {
  for (const schema of Object.values(schemas)) {
    walkDialectUpgrade(schema);
  }
}

function walkDialectUpgrade(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walkDialectUpgrade(child);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  const schema = node as DialectSchema;
  upgradeNullable(schema);
  upgradeExample(schema);

  if (schema.properties !== undefined && typeof schema.properties === "object") {
    for (const value of Object.values(schema.properties)) {
      walkDialectUpgrade(value);
    }
  }
  if (schema.items !== undefined) {
    walkDialectUpgrade(schema.items);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) {
      walkDialectUpgrade(schema[key]);
    }
  }
  if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
    walkDialectUpgrade(schema.additionalProperties);
  }
}

/**
 * `{ type: "string", nullable: true }` → `{ type: ["string", "null"] }`. A
 * schema with no `type` to union against (an untyped/`$ref`-sibling
 * schema — not a shape `swagger.ts` produces today, see the design spec)
 * falls back to wrapping the original schema in `anyOf` alongside a bare
 * `{ type: "null" }`, rather than guessing a `type`.
 */
function upgradeNullable(schema: DialectSchema): void {
  if (schema.nullable !== true) {
    return;
  }
  delete schema.nullable;
  if (typeof schema.type === "string") {
    schema.type = [schema.type, "null"];
    return;
  }
  if (Array.isArray(schema.type)) {
    if (!schema.type.includes("null")) {
      schema.type = [...schema.type, "null"];
    }
    return;
  }
  const rest: DialectSchema = { ...schema };
  for (const key of Object.keys(schema)) {
    delete schema[key];
  }
  schema.anyOf = [rest, { type: "null" }];
}

/** Schema-level `example` → the JSON Schema `examples` array OpenAPI 3.1 prefers. */
function upgradeExample(schema: DialectSchema): void {
  if (!("example" in schema)) {
    return;
  }
  schema.examples = [schema.example];
  delete schema.example;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/frameworks/nest/tests/openapi-dialect.spec.ts`
Expected: PASS — all 12 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm oxlint packages/frameworks/nest/src/openapi-dialect.ts packages/frameworks/nest/tests/openapi-dialect.spec.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add packages/frameworks/nest/src/openapi-dialect.ts packages/frameworks/nest/tests/openapi-dialect.spec.ts
git commit -m "feat(nest): add pure OpenAPI 3.1/3.2 schema-dialect upgrade

Not wired into registerKavoSchemas yet — this is the isolated, pure
transform (nullable -> type union, example -> examples) with its own
unit tests. Next commit wires it in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Wire into `registerKavoSchemas` + end-to-end tests

**Files:**

- Modify: `packages/frameworks/nest/src/register-schemas.ts`
- Test: `packages/frameworks/nest/tests/swagger-openapi-dialect.e2e.spec.ts` (new file)

**Interfaces:**

- Consumes: `targetsJsonSchemaDialect(openapi: unknown): boolean` and `upgradeToJsonSchemaDialect(schemas: Record<string, unknown>): void` from Task 1's `openapi-dialect.ts`.
- Consumes (existing, unchanged): `registerKavoSchemas<T extends object>(document: T): T`'s current signature and behavior — this task only adds one more mutation step inside it.

- [ ] **Step 1: Write the failing e2e tests**

Create `packages/frameworks/nest/tests/swagger-openapi-dialect.e2e.spec.ts`:

```ts
import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Kavo, KavoModule, registerKavoSchemas } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `registerKavoSchemas`'s new dialect-upgrade pass (`openapi-dialect.ts`)
 * only runs when `document.openapi` declares 3.1 or 3.2 — these pin the
 * full pipeline end to end, through a real `@Kavo`-decorated controller and
 * a real `DocumentBuilder.setOpenAPIVersion` call, rather than only the
 * pure-function unit tests in `openapi-dialect.spec.ts`.
 */

const apps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createDocument(openapiVersion?: string): Promise<Record<string, unknown>> {
  @Kavo(Todo, {})
  @Controller("todos")
  class TodosController {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature([TodosController]),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  apps.push(app);
  await app.init();

  const builder = new DocumentBuilder().setTitle("t").setVersion("0");
  if (openapiVersion !== undefined) {
    builder.setOpenAPIVersion(openapiVersion);
  }
  const document = registerKavoSchemas(SwaggerModule.createDocument(app, builder.build()));
  return document as unknown as Record<string, unknown>;
}

function schemaNamed(document: Record<string, unknown>, name: string): Record<string, unknown> {
  const schemas = (document.components as { schemas?: Record<string, unknown> }).schemas ?? {};
  return schemas[name] as Record<string, unknown>;
}

describe("registerKavoSchemas — OpenAPI 3.1/3.2 dialect upgrade", () => {
  it("leaves nullable: true untouched when no openapi version is set (today's 3.0 default)", async () => {
    const document = await createDocument();
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("leaves nullable: true untouched under an explicit 3.0.0", async () => {
    const document = await createDocument("3.0.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("upgrades nullable: true to a type union under 3.1.0", async () => {
    const document = await createDocument("3.1.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("upgrades nullable: true to a type union under 3.2.0 identically to 3.1.0", async () => {
    const document = await createDocument("3.2.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("upgrades the shared KavoProblemDetails schema's example fields to examples arrays under 3.1.0", async () => {
    const document = await createDocument("3.1.0");
    const problemDetails = schemaNamed(document, "KavoProblemDetails") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(problemDetails.properties.type).toMatchObject({ examples: ["https://kavo.dev/errors/kavo-not-found"] });
    expect(problemDetails.properties.type.example).toBeUndefined();
    expect(problemDetails.properties.code).toMatchObject({ examples: ["KAVO_NOT_FOUND"] });
  });

  it("leaves KavoProblemDetails's example fields as-is under 3.0.0", async () => {
    const document = await createDocument("3.0.0");
    const problemDetails = schemaNamed(document, "KavoProblemDetails") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(problemDetails.properties.type).toMatchObject({ example: "https://kavo.dev/errors/kavo-not-found" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/frameworks/nest/tests/swagger-openapi-dialect.e2e.spec.ts`
Expected: FAIL on the 3.1.0/3.2.0 cases — `deletedAt` still shows `nullable: true` instead of a `type` union, because `registerKavoSchemas` doesn't call the new module yet. The 3.0.0/default cases should already PASS (they assert today's unchanged behavior).

- [ ] **Step 3: Wire the new pass into `registerKavoSchemas`**

In `packages/frameworks/nest/src/register-schemas.ts`:

Add the import near the top of the file (after the existing doc comment, before the `interface SchemaObject` block):

```ts
import { targetsJsonSchemaDialect, upgradeToJsonSchemaDialect } from "./openapi-dialect.js";
```

Add `openapi` to the `OpenApiDocument` interface:

```ts
interface OpenApiDocument {
  openapi?: unknown;
  paths?: Record<string, Record<string, OperationObject> | undefined>;
  components?: { schemas?: Record<string, SchemaObject> };
}
```

In `registerKavoSchemas`, add the new step right after the existing `resolveIncludableRefs` call and before `return document;`:

```ts
// Every `<Entity>Item` name is now known, so an includable-relation marker
// (`applyResponseSchemaDocs`) can be resolved to a
// `$ref` to its target's item component — or degraded to a plain object
// when that target has no synthesized item schema. Runs over every
// registered component so a marker on `<Entity>Item` and its structural
// twin on `<Entity>ListItem` are both rewritten.
resolveIncludableRefs(schemas, itemComponentByEntity);

// OpenAPI 3.1/3.2 dialect upgrade (nullable -> type union, example ->
// examples) — only when the caller's own DocumentBuilder declared one of
// those versions (`.setOpenAPIVersion`). See `openapi-dialect.ts`'s own
// doc comment and the design spec
// (docs/superpowers/specs/2026-09-20-openapi-3-1-3-2-support-design.md).
if (targetsJsonSchemaDialect(doc.openapi)) {
  upgradeToJsonSchemaDialect(schemas);
}

return document;
```

(The surrounding `resolveIncludableRefs` line and its comment already exist in the file — only the new `if (targetsJsonSchemaDialect(...))` block and its comment are additions.)

Also add one short paragraph to the file's top-level module doc comment, immediately after the existing "**Includable-relation `$ref`s (issue #356).**" paragraph and before "The helper mutates and returns the document...":

```
 * **OpenAPI 3.1/3.2 dialect upgrade.** After every schema is hoisted and
 * every includable-relation marker resolved, `upgradeToJsonSchemaDialect`
 * (`openapi-dialect.ts`) rewrites `nullable`/`example` into their JSON
 * Schema 2020-12 equivalents when `document.openapi` declares 3.1 or 3.2 —
 * see that module's own doc comment and the design spec
 * (`docs/superpowers/specs/2026-09-20-openapi-3-1-3-2-support-design.md`)
 * for why detection lives here rather than as new Kavo config.
 *
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/frameworks/nest/tests/swagger-openapi-dialect.e2e.spec.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Run the full existing Swagger/register-schemas test suites to check for regressions**

Run: `pnpm vitest run packages/frameworks/nest/tests/swagger-validation-schema.e2e.spec.ts packages/frameworks/nest/tests/swagger-setup.e2e.spec.ts`
Expected: PASS — these exercise the default (no `setOpenAPIVersion`) path and must show byte-identical `nullable`/`example` output to before this change.

If any of these fail, do not weaken the test — find why `targetsJsonSchemaDialect(doc.openapi)` returned `true` when it shouldn't have (most likely cause: `@nestjs/swagger`'s default `document.openapi` value changed between installed versions — check `buildDocumentBase()` in the installed `@nestjs/swagger` version's `dist/fixtures/document.base.js`).

- [ ] **Step 6: Run the full package test suite and typecheck**

Run: `pnpm --filter @kavo/nest test && pnpm typecheck`
Expected: both clean.

- [ ] **Step 7: Run the full repo gate**

Run: `pnpm check`
Expected: PASS. This is the repo's standing rule — report the real result if anything fails, and fix root causes rather than skip checks.

- [ ] **Step 8: Commit**

```bash
git add packages/frameworks/nest/src/register-schemas.ts packages/frameworks/nest/tests/swagger-openapi-dialect.e2e.spec.ts
git commit -m "feat(nest): wire OpenAPI 3.1/3.2 dialect upgrade into registerKavoSchemas

Detected off document.openapi (set via @nestjs/swagger's own
DocumentBuilder.setOpenAPIVersion) with no new Kavo config surface, per
docs/superpowers/specs/2026-09-20-openapi-3-1-3-2-support-design.md.
The 3.0 default path is untouched and covered by regression tests.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Done Criteria

- `pnpm check` passes.
- A document built with no `.setOpenAPIVersion()` call, or an explicit `"3.0.0"`, emits byte-identical `nullable`/`example` output to before this plan.
- A document built with `.setOpenAPIVersion("3.1.0")` or `"3.2.0"` emits `type` unions instead of `nullable: true`, and `examples` arrays instead of schema-level `example`, across every component `registerKavoSchemas` hoists (verified via the shared `KavoProblemDetails` component and a real entity's nullable field).
- No change to any file under `packages/core` or to `swagger.ts`'s decoration/bind-time emission.
