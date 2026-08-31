# ADR-0042 — `Filter` and `Query` are documented-only aggregate component schemas

**Status:** accepted

## Context

Issue #310 hoisted the DTO shapes (`<Entity>Create`/`Item`/`List`/…) into
named `components.schemas`; issue #313 did the same for the derivable
query shapes `<Entity>Pagination`/`Include`/`Sort`. Two shapes were left
out of both: the filter grammar (`filter[field][operator]=value`, `and`/
`or`/`not` groups, the `filter={...}` JSON escape hatch — doc 05) and the
aggregate "everything a read can be parameterized by" shape GraphQL/MCP
and programmatic callers reason about (`filter` + `sort` + `pagination` +
`select` + `include` + `search`). #310 explicitly ruled out migrating the
REST query-param wiring to `style: deepObject` unless a later decision
adopted it — this ADR is that decision point.

Two questions had no default the codebase implied:

1. **Does `Query` replace the REST wire format?** The aggregate shape
   could either (a) merely document, as a named schema, the same
   parameters REST already accepts as flat bracket keys (`filter[age]
[gte]=18`, `sort=-createdAt`, …), or (b) become the actual OpenAPI
   parameter shape via `style: deepObject`, changing how every list route
   declares its query params. Option (b) is a breaking change to
   `KAVO_API_GUIDE` and every generated route's `ApiQuery` set, for a
   grammar (doc 05) this ADR is barred from altering.
2. **How faithfully does `Filter` model the operator grammar?** A loose
   `{ type: "object" }` escape hatch documents nothing; a fully faithful
   per-operator, recursively-grouped schema is more work but lets a
   client generator actually type filter construction.

## Decision

**`Query` is a documented-only aggregate; REST is untouched.** `filter`,
`sort`, `limit`/`offset`, `select`, `include`, `search[...]` stay exactly
the flat bracket query params `KAVO_API_GUIDE` and `05-query-grammar.md`
already document — no `deepObject` migration, no change to
`listQueryParams`/`applyPaginationDocs`/`applySearchQueryDocs`. `Query` is
published as a `components.schemas` entry for a GraphQL/MCP resolver or a
programmatic (`QueryContext`) caller to reference — the OpenAPI document's
one place to see the whole query surface as a single typed shape — but no
REST parameter `$ref`s it, and no REST behavior changes.

**`Filter` models the operator grammar structurally, per field.** For each
of the entity's own scalar columns on the resolved `filterable` allowlist,
`Filter` carries a property named for that field, valued by an operator
object exposing exactly the operators doc 05 grants every kind
(`eq`/`ne`/`in`/`notIn`/`isNull`/`isNotNull`/`gt`/`gte`/`lt`/`lte`/
`between`, typed to the field's own kind), narrowed to doc 05's one
kind-specific rule: `like`/`ilike` appear only on string-kind fields.
`and`/`or` are arrays of `Filter`, `not` is one `Filter` — mirroring the
wire parser's unary `NOT`, not the AST's variadic one (doc 05 §1). A
relation-path filter (`profile.city`) is valid on the wire but not
enumerable as a property at bind time — the same "known gap, not a lie"
limitation `includableRelations`'s own doc comment already accepts for
nested include paths — so `Filter` carries no `additionalProperties:
false`; closing the schema would reject a filter Kavo actually accepts.

**Both ride the same seam #313 built, extended rather than duplicated.**
`applyQuerySchemaDocs` (`swagger.ts`) gains two more slots — `filter` and
`query` — on the `x-kavo-query-schemas` extension it already stamps on
list routes at bind time (`KavoBinder.onModuleInit`, ADR-0012);
`hoistQuerySchemas`'s `bySlot` map (`register-schemas.ts`) gains
`filter: "Filter"` and `query: "Query"`, so both resolve to
`<Entity>Filter` / `<Entity>Query` through the exact collision/clone rules
(#310) the other five query-shape and DTO components already use. Both
are `isList`-gated like `pagination`/`sort` — REST's own `filter=` param
is itself list-only (`listQueryParams`'s `isList` guard in
`applySwaggerMetadata`), so a shape documenting that grammar has no
single-row route to ride either.

**`Filter`'s `and`/`or`/`not` self-reference the entity's own expected
component name.** The `$ref` recursion is built at bind time as
`#/components/schemas/<Entity>Filter` — the name `hoistQuerySchemas` will
in fact register the schema under, absent a genuine cross-entity name
collision. This is the same assumption `<Entity>Pagination_2`'s existing
precedent already lives with (`applyQuerySchemaDocs`'s own doc comment):
a `_2` in the final document is a signal to disambiguate with an explicit
name, not a case either bind time or hoist time computes for. `Query`
composes the same way — `$ref`s to the entity's own expected
`Filter`/`Sort`/`Pagination`/`Include` names, plus inline (non-hoisted)
`select`/`search` shapes built from the same resolved allowlists
`applySearchQueryDocs`/the response-projection docs already read.

## Consequences

- No REST behavior changes. `KAVO_API_GUIDE` and every flat query param
  stay exactly as documented; this ADR only adds two named schemas no
  existing parameter `$ref`s.
- A genuine cross-entity name collision on `<Entity>Filter` (two
  registered entities sharing a class name) leaves `Filter`'s own
  recursive `$ref`s pointing at the losing `_2` name rather than the
  actual stored schema — the same accepted edge case `<Entity>Pagination`
  already has when one entity's own operations disagree on pagination
  strategy. Not solved here; disambiguating with an explicit component
  name is the existing remedy for the whole family.
- `Filter`'s operator set is uniform across scalar kinds except the one
  rule doc 05 states outright (`like`/`ilike`, string-only); it does not
  invent additional per-kind restrictions (e.g. barring `gt`/`lt` on
  `boolean`/`enum`) that doc 05 itself does not draw — a client that sends
  a nonsensical comparison still gets the same 400 doc 05 already
  documents, from the normalizer, not from the schema.

## Amendment (2026-08-31, issue #344)

The sparse-fieldset query parameter was renamed from `fields` to `select`
(wire `select=` / `select[<relation>]=`, `QueryContext.select`,
`NormalizedQueryContext.select`). This ADR's text and the `<Entity>Query`
aggregate's property were updated in place to match. `search[fields]` (a
sub-key of `search`, unrelated to projection) and the `allowlists.selectable`
config key are unchanged. No backward-compatible `fields` alias was kept —
a request still sending `fields=` is now an unrecognized query parameter and
is ignored, so the response falls back to the default representation.
