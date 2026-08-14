# ADR-0029 — Array relations may opt into `replace` writes, config-declared per relation

**Status:** accepted

## Context

ADR-0014 fixes write-side relations at associate-by-id, deliberately, and
names its own extension point: "an explicit per-relation `write` policy on
the relation descriptor — additive, and it would arrive with the
matching/orphan rules stated rather than assumed." Issue #206 asked for
three such policies at once — `resource` (per-relation sub-collection
routes: `GET`/`POST`/`DELETE`/`PUT`), `jsonPatch` (RFC 6902 patch documents
applied at the deserializer seam), and `replace` (a whole-array `PUT`,
still id-only, with partial mutation disabled) — across `@kavo/core`,
`@kavo/nest`, and all four ORM adapters.

That is three independent write surfaces, each with its own matching/orphan
rules and its own adapter-capability question, landing together. Scoping
this decision to all three at once would either ship two of them shallow or
delay the one with the clearest semantics on the other two's account. This
ADR records only `replace` — the one closest to ADR-0014's existing
associate-by-id normalization — for `@kavo/core`, `@kavo/nest`, and
`@kavo/typeorm`. `resource` and `jsonPatch`, and `@kavo/prisma`/
`@kavo/mongoose`/`@kavo/mikroorm` support for `replace`, are follow-up work
under the same extension point; the schema below reserves their
discriminators now so they arrive without a breaking config change.

A second tension: route generation runs at class-decoration time, with no
ORM metadata (ADR-0012), the same constraint ADR-0013 resolves for
`restoreOne`/`purgeOne`. A `replace` route is per-relation and its shape
(`PUT :id/<relation>`) has no static table to key against — `STANDARD_ROUTES`
is closed over `StandardOperationId`, and there is no relation name at
decoration time to look one up by.

## Decision

**The config surface.** `KavoSettings` gains `arrayMutation: { strategy }
| false`, resolved through the ordinary global → entity → operation →
per-call precedence chain and validated in `validate-settings.ts`. The
`strategy` union is `"replace" | "resource" | "jsonPatch"` — the same
reserved-discriminator pattern `SearchSettings.driver` uses for a
not-yet-built backend — but `validate-settings.ts` rejects `"resource"` and
`"jsonPatch"` outright today, so choosing one fails at bootstrap instead of
silently doing nothing. `arrayMutation: false` (the same convention
`softDelete`/`realtime` use) disables the feature wholesale.

**The per-relation opt-in.** `RelationDescriptor` gains `write?: boolean`,
config-populated via `relations.edges.<name>.write` — the same "config
tunes an ORM-derived descriptor" seam `defaultInclude`/`maxDepth`/`strategy`
already use, and the same one ADR-0014's Consequences section names.
`write` is independent of `allowlists.includable`: a relation can be
write-opted without being read-includable, or vice versa. `write: true` on
a to-one relation is a bootstrap `ConfigurationException`
(`DefaultRelationRegistry`) — association by id already covers to-one
writes, so there is no array to replace. `write: true` while
`arrayMutation` resolves to `false` is also a bootstrap
`ConfigurationException` (`resolve-entity-config.ts`) rather than a silently
inert opt-in.

**The operation.** For each write-opted-in relation, Kavo synthesizes one
custom operation, `replace<Relation>` (`replaceTags` for a `tags`
relation), registered post-hoc onto the operation registry — not through
`EntityConfig.operations`, since nothing there declares it — by
`registerArrayMutationOperations` (`packages/core/src/relations/
array-mutation-operations.ts`), called identically by `createCrud`
(core, with a real handler) and `@Kavo` (route generation only, an
inspection-only handler — same pattern `createOperationRegistry`'s
`unboundHandler` uses for the standard table).

Both call sites derive the relation name list from **entity-level
`relations.edges` config alone** — the one input decoration time and
bootstrap time share, the same rule ADR-0013 states for
`restoreOne`/`purgeOne`. Decoration time cannot check cardinality (no ORM
metadata yet), so a to-one relation wrongly marked `write: true` still gets
a route generated blindly; `DefaultRelationRegistry` rejects it once
metadata exists, at `createCrud`.

**The route.** `OperationMetadata` (core-owned, not `@kavo/nest`'s
augmentation) gains an optional `arrayMutation?: { relation, strategy:
"replace" }` field, set on the synthesized descriptor's `meta`. Two
consumers read it: `@kavo/nest`'s `resolveRoute` derives `PUT
:id/<relation>` from it directly (no static route table, since the id is
dynamic per relation), and `KavoEngine.resolveInput` routes the operation's
body through a dedicated path instead of the ordinary DTO deserializer — a
`replace` body is a bare array (or `null`), never an entity-shaped object,
so `DefaultDeserializer.deserialize` (which returns `{}` for a
non-object/array raw body) cannot parse it directly. The engine instead
wraps the raw body as `{ [relation]: body }` and re-enters the deserializer
with `dto: null`, reusing its existing relation-association logic
(`associate()`) unchanged — a scalar id, an `{id}` reference, and the
target entity's real id field are resolved exactly the way `create`/
`update` already resolve them. A body that is not an array or `null` at
the top level raises `ArrayMutationInvalidShapeException`
(`KAVO_ARRAY_MUTATION_INVALID_SHAPE`, 400) before deserialization runs —
`replace` disables partial mutation outright, so a `{ add: [...] }`- or
patch-op-shaped body is rejected rather than silently narrowed.

**The adapter seam.** `EntityWriter` gains an _optional_
`replaceRelation?(id, relation, memberIds, context): Promise<Entity>` —
optional because not every adapter implements it yet, and `createCrud`
checks for it once, at bootstrap, the moment any relation opts in
(`ConfigurationException` if absent) — the same ORM caveat ADR-0014's
Consequences section already names for association by id: Kavo maps the
payload, it does not synthesize a write an adapter declined to make.
`@kavo/typeorm`'s implementation diffs the desired membership against the
currently persisted one and calls `RelationQueryBuilder#addAndRemove` —
the primitive that gets `set`-like replace semantics for a to-many edge,
since TypeORM's own `.set()` exists only on the to-one side.

## Consequences

- `resource` and `jsonPatch` remain unimplemented; choosing either is a
  bootstrap error naming this ADR and the tracking issue, not a silently
  inert config value or a 500 at request time.
- `@kavo/prisma`, `@kavo/mongoose`, and `@kavo/mikroorm` do not implement
  `replaceRelation` yet. An app on one of them that opts a relation into
  `write` fails at bootstrap with a clear message, not a runtime surprise.
- The two-stage validation split (decoration-time route generation blind to
  cardinality, bootstrap-time rejection once metadata exists) mirrors
  ADR-0013 exactly, so a reader who already understands `restoreOne`/
  `purgeOne`'s split recognizes this one.
- `OperationMetadata.arrayMutation` is a _core_-owned metadata field, not a
  `@kavo/nest` route concept leaking into core — core states a domain fact
  ("this operation targets relation X"), and `@kavo/nest` is the one that
  translates it into an HTTP route. Core stays framework-agnostic.
- The response to a successful `replace<Relation>` call is the parent
  entity, serialized through its own `item` DTO slot — not the relation's
  own member list. Returning the related collection through its own DTO
  would need cross-entity serialization machinery this ADR does not build;
  a later change can add it without breaking the request shape.
