# OpenAPI 3.1/3.2 support in `@kavo/nest`'s Swagger integration

**Date:** 2026-09-20
**Status:** approved for implementation planning

## Context

`@kavo/nest`'s Swagger generation (`swagger.ts`, `register-schemas.ts`) targets
`@nestjs/swagger`'s document model, whose `DocumentBuilder` hardcodes
`document.openapi = "3.0.0"` in `buildDocumentBase()` unless a caller
overrides it. `DocumentBuilder` already exposes `.setOpenAPIVersion(version)`
for that override (any `\d+\.\d+\.\d+` string is accepted verbatim), so an
app can already ask `@nestjs/swagger` to stamp `"3.1.0"` or `"3.2.0"` on the
document today — but Kavo's own schema-generation code has no idea that
happened, and keeps emitting OpenAPI-3.0-only keywords regardless.

Two of those keywords are genuine correctness bugs once the document
declares 3.1+, not stylistic mismatches:

- **`nullable: true`.** OpenAPI 3.1 adopted the JSON Schema 2020-12 dialect
  for the Schema Object outright; `nullable` was a 3.0-only OpenAPI
  extension to JSON Schema and was dropped. Spec-compliant 3.1/3.2 tooling
  (validators, client generators) silently ignores it — a nullable Kavo
  field would validate as non-nullable, or a generated client type would
  omit `| null`. Kavo emits `nullable: true` throughout `swagger.ts`:
  `fieldSchema` (every nullable column, request and response), the list
  envelope's `total`, `associationBodySchema` (relation reference objects),
  and the class-validator/Zod-DTO translation paths.
- **Schema-level `example`.** OpenAPI 3.1 deprecates the singular `example`
  keyword on a Schema Object in favor of JSON Schema's own `examples` array.
  `example` is still accepted by 3.1/3.2 tooling today, so this is lower
  severity than `nullable`, but the same "declares 3.1, still speaks 3.0"
  gap. (The `Example Object` used at the parameter/media-type level —
  `ApiHeader`'s `ETAG_RESPONSE_HEADER`, etc. — is a different, unrelated
  part of the spec and keeps `example` there; only _schema-level_ `example`
  is in scope.)

A survey of the rest of 3.1 (webhooks, `const`, `patternProperties`,
`contentMediaType`/`contentEncoding`, `$schema` dialect declarations) and all
of 3.2 (hierarchical tags, the `query` HTTP method, streaming API support,
OAuth2 Device Authorization Flow, formalized path-templating ABNF, expanded
`components.mediaTypes`/example fields, `$self`) was checked against what
`swagger.ts` actually generates — CRUD entity request/response schemas and
their query/path parameters. None of those features have a natural mapping
onto that surface today (no webhook-shaped concept exists anywhere in Kavo;
tags are one flat name per entity; no non-standard HTTP verbs; no streaming
or OAuth flow of Kavo's own to describe). They are out of scope for this
spec, not deferred by oversight — a future feature that actually needs one
of them (e.g. `@kavo/sse` growing a webhook-shaped mode) should motivate its
own spec instead of being smuggled in here.

## Decision

### Detection: read `document.openapi`, no new Kavo config

`registerKavoSchemas(document)` already performs one full mutate-in-place
pass over the finished `OpenAPIObject` — hoisting inline schemas to
`components.schemas`, resolving `x-kavo-includable-ref` markers, deleting
`x-kavo-query-schemas` extensions after promoting them. This spec adds one
more pass to that same function, gated on `document.openapi`:

```ts
const majorMinor = document.openapi.match(/^(\d+)\.(\d+)/);
const targetsJsonSchemaDialect = majorMinor !== null && (Number(majorMinor[1]) > 3 || Number(majorMinor[2]) >= 1);
```

`"3.0.x"` (or a missing/unparseable `openapi` field — `@nestjs/swagger`
always sets one, but this stays defensive rather than throwing) leaves the
document exactly as today. `"3.1.x"`/`"3.2.x"` runs the new step,
`upgradeToJsonSchemaDialect(document)`, after every existing pass finishes —
so it walks the final shape once, and never has to reason about markers or
hoisting mid-flight.

No new Kavo config key, no new parameter on `registerKavoSchemas`. The only
thing an integrator changes is calling `.setOpenAPIVersion("3.1.0")` on their
own `DocumentBuilder` — a capability `@nestjs/swagger` already ships. This
keeps the feature purely additive: an app that never calls
`setOpenAPIVersion` sees byte-identical output before and after this change.

### The walk

`upgradeToJsonSchemaDialect` recursively visits every schema object reachable
from `document.components.schemas`, `document.components.parameters`, and
inline request/response schemas still attached to path items (anything
`registerKavoSchemas`'s existing hoisting pass didn't already move into
`components.schemas`) — the same traversal shape `registerKavoSchemas`'s
existing marker-resolution pass already uses, reused rather than
reimplemented. At each schema object:

**1. `nullable: true` → JSON Schema union type.**

- The common case — a typed schema (`{ type: "string", nullable: true, ... }`)
  — becomes `{ type: ["string", "null"], ... }` with the `nullable` key
  removed. `type` may already be an array (rare in Kavo's own output today,
  but the enum/`isIn` translation path could in principle produce one) —
  append `"null"` rather than overwrite.
- A schema with `nullable: true` but no `type` at all — an
  enum-without-explicit-type or a bare `{}` — has no `type` to union against
  in 2020-12. Kavo's own `enum`/`const`-shaped output always carries an
  explicit `type` alongside (`classValidatorKeyword`'s `isEnum`/`isIn`
  branches, `schemaForHint`'s enum case), so this is a defensive branch, not
  a shape Kavo emits today: fall back to wrapping the schema in
  `{ anyOf: [original-without-nullable, { type: "null" }] }` rather than
  guessing a `type`.
- A `$ref`-only schema carrying a sibling `nullable: true` — a shape Kavo
  never emits (every `$ref` Kavo produces, e.g. `filterRef`, is bare) — gets
  the same `anyOf` treatment as the untyped case, since 2020-12 permits
  siblings alongside `$ref` but wrapping is simpler and correct either way.

**2. Schema-level `example` → `examples`.**

`{ ..., example: value }` becomes `{ ..., examples: [value] }`, deleting
`example`. Only applied to schema objects (the walk this function does);
parameter- and media-type-level `Example`/`Examples` objects are untouched
because the walk never descends into `parameters[].example` or
`content[].example` as schema objects — they are a different Object type
with the same field name, not a `Schema Object` this pass visits.

### What does not change

- Decoration-time and bind-time code (`applySwaggerMetadata`,
  `applyBodySchemaDocs`, `applyResponseSchemaDocs`, etc.) keeps emitting
  today's 3.0-shaped `nullable: true`/`example` unconditionally. They run
  before `SwaggerModule.createDocument` even exists, so they cannot know the
  target version; correctness for 3.1+ is entirely the new post-pass's job.
- `registerKavoSchemas`'s existing passes (hoisting, `x-kavo-*` marker
  resolution) are untouched and run first, exactly as today.
- Nothing in `packages/core` changes — this is wholly a `@kavo/nest`
  Swagger-integration concern.

## Testing

New cases in `packages/frameworks/nest/tests/`, following the existing
`swagger-validation-schema.e2e.spec.ts` pattern (build a document via
`Test.createTestingModule` + `SwaggerModule.createDocument`, run
`registerKavoSchemas`, assert on the resulting component schemas):

- A document built with no `.setOpenAPIVersion` call (or an explicit
  `"3.0.0"`) still shows `nullable: true` verbatim on a nullable field — the
  regression guard proving this feature is opt-in by version, not global.
- A document built with `.setOpenAPIVersion("3.1.0")`: a nullable field
  (e.g. `Todo.deletedAt`, or a `@kavo/nest`-decorated optional class-validator
  property) shows `type: [<kind>, "null"]` and no `nullable` key.
- The same assertion under `"3.2.0"`, confirming 3.2 gets identical
  treatment to 3.1 (3.2 did not change the schema dialect from 3.1's).
- A schema-level `example` that already exists in `swagger.ts` today —
  `PROBLEM_DETAILS_SCHEMA`'s `type`/`code` properties (`packages/frameworks/
nest/src/swagger.ts`) — becomes `examples: [value]` under
  `"3.1.0"`/`"3.2.0"`, and stays `example` under `"3.0.0"`.
- The defensive `anyOf` fallback for an untyped-but-nullable schema, even
  though nothing in `swagger.ts` produces that shape today — a synthetic
  schema fed directly to `upgradeToJsonSchemaDialect` in a unit-level test
  rather than through the full decoration pipeline, mirroring how
  `swagger.ts`'s other pure functions are tested in isolation elsewhere in
  the suite.
- `document.openapi` set to an unparseable or absent string does not throw
  and leaves the document as `registerKavoSchemas`'s other passes produced
  it (today's 3.0 behavior).

## Out of scope (explicitly deferred, not forgotten)

- OpenAPI 3.1's `webhooks`, `const`, `patternProperties`,
  `contentMediaType`/`contentEncoding`, `$schema` dialect declarations.
- All of OpenAPI 3.2's additive surface (hierarchical tags, `query` HTTP
  method, streaming, OAuth2 Device Authorization Flow, path-templating ABNF,
  `components.mediaTypes`, `$self`).
- Upgrading `@nestjs/swagger`'s own peer range — this spec works within
  what `@nestjs/swagger@^8||^11||^12` already exposes
  (`.setOpenAPIVersion`).

Each of those, if ever pursued, needs its own spec: none of them maps onto
`swagger.ts`'s current generation surface the way the nullability/example
fix does, and bundling them here would violate the single-sub-project scope
this spec was narrowed to during brainstorming.
