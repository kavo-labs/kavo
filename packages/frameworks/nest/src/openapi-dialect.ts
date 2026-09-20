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
  const nullable = schema.nullable;
  delete schema.nullable;
  if (nullable !== true) {
    return;
  }
  if (typeof schema.type === "string") {
    schema.type = [schema.type, "null"];
    appendNullToEnum(schema);
    return;
  }
  if (Array.isArray(schema.type)) {
    if (!schema.type.includes("null")) {
      schema.type = [...schema.type, "null"];
    }
    appendNullToEnum(schema);
    return;
  }
  const rest: DialectSchema = { ...schema };
  for (const key of Object.keys(schema)) {
    delete schema[key];
  }
  schema.anyOf = [rest, { type: "null" }];
}

/**
 * `type`/`enum` are ANDed under JSON Schema 2020-12, so unioning `null` into
 * `type` alone leaves a sibling `enum` still rejecting it — a self-
 * contradictory schema. Append `null` to the enum too, mirroring
 * `@nestjs/swagger`'s own OAS 3.1 conversion.
 */
function appendNullToEnum(schema: DialectSchema): void {
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
    schema.enum = [...schema.enum, null];
  }
}

/** Schema-level `example` → the JSON Schema `examples` array OpenAPI 3.1 prefers. */
function upgradeExample(schema: DialectSchema): void {
  if (!("example" in schema)) {
    return;
  }
  schema.examples = [schema.example];
  delete schema.example;
}
