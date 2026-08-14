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

## Amendment — `jsonPatch` (issue #211)

`replace` disables partial mutation outright; this amendment ships the
strategy that restores it: incremental `add`/`remove` of a write-opted
relation's membership, and ordinary field patches, both through RFC 6902
patch documents. `resource` and the non-`@kavo/typeorm` adapters remain
out of scope, unchanged from the original decision above.

**The overlap with `patchOne`.** `PATCH /entity/:id` already exists as the
standard `patchOne` operation, and this strategy's request is also a
`PATCH /entity/:id` — a second route would either collide or need its own
disambiguating path segment nothing in the domain motivates. Instead
`jsonPatch` reuses `patchOne`'s route outright and tells the two body
shapes apart structurally: `patchOne`'s own DTO body is always a JSON
_object_; an RFC 6902 patch document is always a JSON _array_. That is not
a new rule invented for this amendment — `KavoEngine.resolveInput`'s
`replace<Relation>` branch already turned exactly this same object-vs-array
distinction into a routing decision for a different operation, so extending
it to `patchOne` itself is the same seam, not a new one. An entity that
never sets `arrayMutation.strategy: "jsonPatch"` sees `patchOne`'s contract
completely unchanged: an array body there still degrades to `{},` exactly
as `DefaultDeserializer.deserialize` has always treated any non-object
body.

**The patch vocabulary — two path shapes, deliberately narrow.** "No
arbitrary path traversal" is enforced by only recognizing two shapes at
all, not by a denylist checked after the fact:

- `/<field>` (`add`/`replace` only) — a scalar, non-generated column. The
  resulting `{ [field]: value, … }` is fed through the exact same `patch`
  DTO deserializer an ordinary object body already goes through, so field
  validation does not fork into a second code path. `remove` on a field
  path is rejected: a partial-update payload has nothing to literally
  delete — a client meaning "don't touch this field" already expresses
  that by omitting the op.
- `/<relation>/-` (`add`/`remove` only) — a relation with
  `relations.edges.<name>.write: true`. `value` names the member: a scalar
  id or an `{id}` reference, exactly `replace`'s own shape, resolved
  through the same `associate()` normalization `create`/`update`/`replace`
  already share. Addressing by **identity** rather than by RFC 6902's own
  array-index convention is the "matching/orphan rules stated rather than
  assumed" ADR-0014's Consequences section calls for: to-many relation
  membership has no persisted order for an index to mean anything against,
  so `-` (RFC 6902's append marker) is reused for both directions and the
  member is always named by `value`, never by position. `replace` is
  rejected on this shape outright — whole-array replacement is
  `arrayMutation.strategy: "replace"`'s own surface, and the two strategies
  stay mutually exclusive per relation rather than overlapping.

Anything else — a malformed op, an `op` illegal for its path's shape, a
path naming neither a writable field nor a write-opted relation, more than
two segments — is `JsonPatchInvalidDocumentException`
(`KAVO_JSON_PATCH_INVALID_DOCUMENT`, 400), raised by parsing the document
alone, before any read or write is attempted.

**The matching/orphan rules, stated.** Member existence is not a parsing
question — the parser never sees the database — so it is answered by the
write path instead, and each answer is a deliberate choice, not an
assumption:

- `add` naming an id with no matching row raises the same
  `NotFoundException` `replaceRelation`'s own existence check already
  raises for `replace` — one rule for "you named something that doesn't
  exist," regardless of strategy.
- `add` naming an id already a member is an idempotent no-op — set
  semantics, the same as RFC 6902's own `add`-on-an-existing-object-member
  behavior.
- `remove` naming an id that is **not** currently a member raises
  `JsonPatchTargetNotFoundException` (`KAVO_JSON_PATCH_TARGET_NOT_FOUND`, 404) rather than a silent no-op — RFC 6902 requires a `remove`'s target
  location to exist, and a client that asked for a removal that already
  isn't there finds out, rather than reading a 200 as confirmation that
  something changed.

**The write path and its atomicity.** `EntityWriter` gains a second
optional method, `patchRelation?(id, relation, { add, remove }, context)`,
alongside `replaceRelation` — same optionality reasoning: `createCrud`
checks for it at bootstrap the moment a relation opts into `write` under
`arrayMutation.strategy: "jsonPatch"` (`ConfigurationException` if absent).
`@kavo/typeorm`'s implementation wraps the read that decides "is this
`remove` target currently a member?" and the write it gates in one
`dataSource.transaction`, closing the read-then-write race
`replaceRelation`'s own doc comment names as a known gap — a concurrent
writer can never make that judgment stale between the check and the
removal. A document touching several relations is _not_ one transaction
spanning all of them, though: `patchOne`'s built-in handler applies field
changes first (`EntityWriter.patch`), then one `patchRelation` call per
relation the document touched, each its own atomic unit. This is a stated
scope limit, one level more atomic than `replace` already is, not a claim
of whole-document atomicity — a later change could widen it without
breaking the request or response shape.

**Route generation stays mutually exclusive per strategy.** Before this
amendment, `registerArrayMutationOperations` ran unconditionally for every
write-opted relation, because `"replace"` was the only strategy that could
ever reach it. Now that `"jsonPatch"` is real, both call sites
(`createCrud` and `@Kavo`) gate that call on the resolved strategy being
`"replace"` — an entity on `"jsonPatch"` gets no `replace<Relation>`
route or registry entry at all, since that surface belongs to `replace`
alone. `@Kavo`'s decoration-time view (`declaredArrayMutationStrategy`,
`kavo.decorator.ts`) can only see what the entity itself declares
(ADR-0012), not a global default, so an entity that relies on a _global_
`arrayMutation.strategy: "jsonPatch"` default without declaring it locally
would otherwise get a `replace<Relation>` route generated (decoration time
assumes `"replace"`, the built-in default) that `createCrud`'s registry has
no operation for.

Unlike ADR-0013's own decoration/bootstrap split — which leaves an
equivalent cardinality mismatch for `restoreOne`/`purgeOne` to surface as a
runtime error — this one gets an explicit bootstrap-time guard, because
`@kavo/nest` has a place both facts are knowable at once before the app ever
serves traffic: `KavoModule`'s discovery binder (`KavoBinder.onModuleInit`,
`kavo.module.ts`) runs after both the decorated entity's own config (which
decoration time already used to decide whether to generate the route) and
the bound service's fully resolved settings (which `createCrud` only
produces once real infrastructure and global defaults exist) are available.
`requireArrayMutationStrategyAgreement` re-derives
`declaredArrayMutationStrategy` there and compares it against the resolved
`arrayMutation.strategy`; a disagreement is a bootstrap `ConfigurationException`
naming the entity, the relation(s), and the fix — the same "fail loudly at
startup" posture `requireArrayMutationSupport`/`requireJsonPatchSupport`
already have for adapter-capability gaps. Plain programmatic
(non-`@kavo/nest`) usage has no decoration-time route to disagree with in
the first place, so `createCrud` itself carries no such check — only the
framework binding, which is where the two views can actually diverge, does.

## Consequences

- `resource` remains unimplemented; choosing it is a bootstrap error naming
  this ADR and the tracking issue, not a silently inert config value or a
  500 at request time. `jsonPatch` is implemented per the amendment above
  (issue #211).
- `@kavo/prisma`, `@kavo/mongoose`, and `@kavo/mikroorm` do not implement
  `replaceRelation` or `patchRelation` yet. An app on one of them that opts
  a relation into `write` fails at bootstrap with a clear message, not a
  runtime surprise.
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
