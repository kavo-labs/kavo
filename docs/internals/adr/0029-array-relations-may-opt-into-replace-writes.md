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
`write` is independent of `allowed.includable`: a relation can be
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
(`associate()`) unchanged — each element must be an `{id}` reference
(a bare scalar element is rejected, `AssociationInvalidShapeException`,
per ADR-0014's later amendment), resolved against the target entity's real
id field exactly the way `create`/`update` already resolve them. A body
that is not an array or `null` at
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

## Amendment — `resource` (issue #210)

`replace` and `jsonPatch` both keep one route per relation (`PUT
:id/<relation>`, or `patchOne`'s own route). This amendment ships the third
named strategy, which trades that for a genuine per-relation
sub-collection: `GET`/`POST`/`DELETE`/`PUT` all at `/entity/:id/<relation>`,
one operation per HTTP method rather than one operation overloading a
single method's body shape.

**The operations.** `registerArrayMutationOperations`
(`array-mutation-operations.ts`) is the same seam `replace` already uses,
extended rather than duplicated: it now takes the resolved `strategy`
(`"replace" | "resource"`) and, under `"resource"`, registers four
operations per write-opted relation instead of one —
`replace<Relation>` (unchanged from `replace`'s own semantics),
`list<Relation>` (`GET`, current membership), `add<Relation>` (`POST`, one
member by id) and `remove<Relation>` (`DELETE`, one member by id). Each
descriptor's `meta.arrayMutation` carries both the resolved `strategy` and
its own `action` (`"replace" | "list" | "add" | "remove"`) — `action` is
what `KavoEngine.resolveInput` and `@kavo/nest`'s route generator branch on
(the field ADR-0029's original text called `strategy` before this
amendment generalized it), since a single `strategy` value no longer
determines a single route shape the way it did when `replace` was the only
implemented one.

**The route.** `@kavo/nest`'s `resolveRoute` keys the HTTP method off
`action` (`replace → PUT`, `list → GET`, `add → POST`, `remove → DELETE`),
all at the same `:id/<relation>` path `replace` already used — there is
still no static route table to key a dynamic per-relation id against, the
same reason `replace`'s own route is derived rather than looked up.
`remove<Relation>` is the one route whose body an HTTP method never
predicts on its own: `DELETE` carries no id path segment for the member it
targets (the path only names the _parent_), so the member id travels in
the body instead — the one `DELETE` Kavo generates that takes one, unlike
`deleteOne`/`purgeOne`, whose path segment already names everything they
need.

**The request bodies.** `list<Relation>` takes none (an ordinary read).
`add<Relation>`/`remove<Relation>` each take a single scalar id or `{id}`
reference — never an array (that shape stays `replace`'s own surface) and
never absent; either violation raises `ArrayMutationInvalidShapeException`
(`KAVO_ARRAY_MUTATION_INVALID_SHAPE`, 400), the same code `replace`'s own
shape violations raise, now carrying an `{expected}` param so the message
states which shape the offending action actually wanted rather than always
describing `replace`'s.

**The matching/orphan rules, stated — deliberately the same rules
`jsonPatch` already committed to, under strategy-neutral naming.** `add`
naming an id with no matching row raises the same `NotFoundException`
`replaceRelation`'s own existence check already raises — one rule for "you
named something that doesn't exist," regardless of strategy, restated from
the original decision above. `add` naming an id already a member is an
idempotent no-op. `remove` naming an id that is **not** currently a member
raises `ArrayMutationMemberNotFoundException`
(`KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND`, 404) — the same rule
`JsonPatchTargetNotFoundException` enforces for `jsonPatch`'s own `remove`,
under its own code rather than a reused one: a `resource` client's
`DELETE` never carries a JSON Patch document, so raising the `jsonPatch`
exception's own `"JSON Patch target not found"` title at it would name the
wrong feature in the response.

**The response shape.** `add`/`remove`/`replace<Relation>` keep the exact
"parent, not the relation's own member list" contract the original decision
states for `replace`, byte-for-byte unchanged: the parent entity, projected
through its own `item` DTO slot the way it always has been — an existing
`replace`-strategy entity's response shape does not change by this
amendment existing at all. `list<Relation>` is not held to that same
contract, because holding it there would make the operation unable to
answer the question its own name promises: `KavoEngine`'s response mapping
forces exactly one include node onto `list<Relation>`'s response alone
(`contextForArrayMutationResponse`), reusing the existing include-projection
machinery — not new cross-entity serialization machinery — but applying it
unconditionally rather than waiting on a client `include=` that this
operation has no query parameter to carry, and bypassing
`allowed.includable` on purpose: `write` and `includable` are
independent opt-ins, so a relation opted into `write` but never into
`includable` must still appear on the one response whose entire purpose is
showing that relation's membership. `add`/`remove`/`replace<Relation>` do
not get this treatment — a later change could extend it to them without
breaking the request shape, the same opening the original decision left for
`replace`, but this amendment does not take it.

**The adapter seam.** `EntityWriter` gains three more optional primitives
beyond `replaceRelation` — `readRelation`, `addRelationMember`,
`removeRelationMember` — each returning the parent row with `relation`
loaded, `replaceRelation`'s own contract. `createCrud` checks for all four
`resource` primitives once, at bootstrap, the moment any relation opts in
under `arrayMutation.strategy: "resource"` (`ConfigurationException` naming
whichever is missing) — the same ORM caveat the original decision states
for `replaceRelation` applies to each of the three new ones. `@kavo/typeorm`
implements all three: `readRelation` is a plain read (no transaction
needed); `addRelationMember`/`removeRelationMember` commit their
membership read (which decides "is this id currently a member?") and the
write it gates in one `dataSource.transaction`, the same reason
`patchRelation` does — a concurrent writer can never make that judgment
stale between the check and the change.

**Route generation stays mutually exclusive per strategy.** Exactly as the
`jsonPatch` amendment already established between `replace` and
`jsonPatch`: both call sites (`createCrud` and `@Kavo`) gate `resource`'s
four-operation registration on the resolved/declared strategy being
`"resource"` — an entity on `"replace"` or `"jsonPatch"` gets none of
`resource`'s routes, and vice versa. `KavoModule`'s
`requireArrayMutationStrategyAgreement` needed no change to cover this: its
existing "declared assumed `'replace'`, but resolved differently" check
already catches an entity that omits `arrayMutation` while relying on a
_global_ `"resource"` default, and an entity that declares `"resource"`
locally can never disagree with what resolves, for the same "entity-level
always wins the merge" reason a local `"jsonPatch"` declaration already
couldn't.

## Amendment — the strategy is no longer defaulted (issue #221)

The original decision above states plainly that `"replace"` is the intentional
default: `BUILT_IN_DEFAULTS.arrayMutation` resolved every entity to `{
strategy: "replace" }` unless it explicitly set `arrayMutation: false` or a
different strategy, and `declaredArrayMutationStrategy` (`kavo.decorator.ts`)
mirrored that at decoration time. In practice this meant a relation opted
into `relations.edges.<name>.write: true` silently got a whole-array `PUT`
surface the moment anyone flipped that one boolean — nobody had to choose
`"replace"` on purpose. This amendment reverses that: `arrayMutation.strategy`
now has no built-in default. A write-opted relation demands the strategy be
declared explicitly somewhere in the global → entity precedence chain.

**The unset state, distinct from `false`.** `ArrayMutationSettings.strategy`
becomes optional (`strategy?: ArrayMutationStrategy`) rather than required.
`BUILT_IN_DEFAULTS.arrayMutation` is now the empty object `{}`, not `{
strategy: "replace" }` — still an object rather than `false`, so a partial
`arrayMutation: {...}` override still merges against a complete base instead
of replacing a `false` wholesale (the same reasoning `cache`'s `ttl: 0`
object default documents; `realtime`'s own default became `false` itself in
issue #247, since it had no other key left once the redundant `enabled`
switch was removed). `arrayMutation: false` (feature off wholesale)
and `arrayMutation: {}`/`{ strategy: undefined }` (feature on, no strategy
chosen yet) stay two different states: only the first disables the feature;
the second still lets an entity with no write-opted relations resolve
`arrayMutation.strategy` to nothing and boot cleanly; a write-opted relation
is what turns "unset" into a bootstrap failure.

**The bootstrap check.** `validateArrayMutationRelations`
(`resolve-entity-config.ts`) already rejected `arrayMutation: false` under a
write-opted relation; it now rejects an unset `strategy` the same way, with
its own message naming the fix (`set 'arrayMutation.strategy' to "replace",
"resource", or "jsonPatch"`). `kavo.ts`'s `createCrud` still relies on this
running first: a non-empty write-opted relation list there continues to
guarantee the strategy resolved to one of the three implemented ones.

**Decoration time generates no route without a local declaration.**
`declaredArrayMutationStrategy` no longer falls back to `"replace"` when
`config?.arrayMutation` is absent — it returns `undefined`, and `@Kavo`'s
route generation (gated on the declared strategy being `"replace"` or
`"resource"`) synthesizes nothing for that entity's write-opted relations.
This is deliberately conservative: decoration time cannot see a global
default (ADR-0012), so where it previously assumed `"replace"` and
occasionally guessed wrong (the original jsonPatch-amendment gap this ADR's
agreement check was built for), it now assumes nothing and generates no
route it cannot be sure of.

**The new gap that opens, and why the agreement check still exists.**
Generating no route when nothing is declared closes the old failure mode (a
route pointing at an operation the registry never registered) but opens a
quieter one: an entity that omits `arrayMutation` locally while a _global_
default resolves `"replace"` or `"resource"` gets the operation registered by
`createCrud` — real and callable programmatically — with no HTTP route
reaching it at all. `requireArrayMutationStrategyAgreement`
(`kavo.module.ts`) is repurposed rather than removed to catch exactly this:
once a write-opted relation's declared strategy is `undefined` and the fully
resolved strategy needs a synthesized route (`"replace"` or `"resource"`),
`KavoModule`'s discovery binder fails bootstrap with a message telling the
adopter which `arrayMutation.strategy` to declare locally. `"jsonPatch"`
never triggers this check — it reuses `patchOne`'s existing route rather than
synthesizing one, so there is no route to be missing. A locally declared
strategy still never disagrees with what resolves (entity-level always wins
the merge, ADR-0013's "more specific wins"), so the check only ever fires on
the undeclared-and-relying-on-a-global-default case, same as before this
amendment — just inverted from "wrong route generated" to "no route
generated."

**Migration.** Any entity relying on the implicit `"replace"` default for a
write-opted relation now fails at bootstrap with a `ConfigurationException`
naming the entity and relation; the fix is adding
`arrayMutation: { strategy: "replace" }` (or `"resource"`/`"jsonPatch"`) to
that entity's config, or to a global default all such entities share.

## Amendment — the strategy becomes a per-relation choice (issue #223)

Every amendment above still resolves exactly one `arrayMutation.strategy`
per entity, through the ordinary global → entity → operation → per-call
precedence chain, and applies it uniformly to every relation the entity
write-opts in. That forecloses a real shape: an entity with two write-opted
to-many relations that genuinely want different write surfaces — one a
single whole-array `PUT` (`replace`), the other the narrower four-operation
sub-collection (`resource`), or one relying on incremental `jsonPatch`
membership changes while another wants `replace`'s all-or-nothing semantics.
This amendment moves the strategy choice down to the relation itself,
without touching the entity-level default's own meaning.

**The config surface.** `RelationEdgeSettings.write` (`settings.ts`) widens
from `boolean` to `boolean | { strategy: ArrayMutationStrategy }`. `write:
true` keeps its exact original meaning — opt in, strategy inherited from
this entity's own resolved `arrayMutation.strategy` — so every existing
config that only ever used the boolean form is unaffected. `write: {
strategy }` is new: it opts the relation in _and_ pins its own strategy,
independent of what the entity resolves to. `arrayMutation: false` at
entity scope still disables the feature wholesale and now explicitly wins
over any per-relation override too — a relation cannot re-enable
array-mutation writes for itself while its entity has them off; asking to is
a bootstrap `ConfigurationException`, not a silent no-op.

**Resolution and validation move into `DefaultRelationRegistry`.** Previously
`resolve-entity-config.ts`'s `validateArrayMutationRelations` cross-checked
the entity's single resolved strategy against every write-opted relation
after the registry was already built. That split stops making sense once
strategy resolution is itself per-relation and needs both `edges` and the
entity's `arrayMutation` default at once — the two inputs
`DefaultRelationRegistry`'s constructor already receives. Resolution and
validation now happen together, in the same place the existing "`write` on a
to-one relation" check already lived: `RelationDescriptor.write` changes
from `boolean` to the **resolved** `ArrayMutationStrategy | undefined` — a
concrete strategy, or `undefined` if the relation never opted in — so every
downstream consumer (`createCrud`, the engine, `@kavo/nest`) reads a single
source of truth instead of re-deriving the merge itself. This is the one
piece of this amendment that is breaking rather than additive: `write` was
`boolean | undefined`, and is now `ArrayMutationStrategy | undefined` — a
type-level break for any external reader of the barrel-exported
`RelationDescriptor` type (a custom adapter or a hand-built relation
registry), not for the config surface itself. The back-compat guarantee
above is about `RelationEdgeSettings.write`, the input shape adopters
write — `write: true` still means exactly what it always did — not about
`RelationDescriptor.write`, the resolved value core computes from it.

**Registering routes and operations per relation.**
`registerArrayMutationOperations` (`array-mutation-operations.ts`) no longer
takes one `strategy` for a whole call; it takes a list of `{ name, strategy
}` entries, one per relation, and each entry's own strategy decides its
action set (`replace` → one operation, `resource` → four). `jsonPatch`
relations are filtered out before this call, exactly as before — `jsonPatch`
still synthesizes no operation of its own, since it reuses `patchOne`'s
existing route. `createCrud` (`kavo.ts`) groups an entity's write-opted
relations by their own resolved strategy, runs only the capability check
each group's strategy needs (so a mixed entity never demands `resource`'s
four adapter primitives just because one of its relations happens to use
them), and makes one registration call carrying the full four-action handler
factory set — a factory is keyed by _action_, not strategy, so the same
factories serve a `replace`-only relation and a `resource` one alike.
`@kavo/nest`'s decoration-time route generation (`kavo.decorator.ts`) mirrors
this: `declaredRelationArrayMutationStrategy` resolves each relation's
_declared_ strategy the same way (`write: true` inherits the entity's own
local declaration, `write: { strategy }` names its own, unconditionally —
decoration time stays optimistic about cross-validating against a real
`arrayMutation: false`, the same as it already was blind to ORM cardinality),
and generates a route per relation accordingly.

**The route-reachability check becomes per-relation too.**
`requireArrayMutationRouteReachable` (`kavo.module.ts`) — which closes the
gap between decoration time's config-only view and `createCrud`'s fully
resolved one — now evaluates each write-opted relation independently rather
than the entity as a whole: a relation that pins its own strategy locally
(`write: { strategy }`) never disagrees with what resolves and is never
flagged, even when a sibling relation on the same entity relies on an
undeclared global default and _is_ flagged. The thrown exception still names
every unreachable relation in one message, now with each one's own resolved
strategy attached, since two relations on the same entity can legitimately
resolve to two different strategies.

**The jsonPatch gate is now "any relation, or the entity default."**
`KavoEngine.resolvePatchOneInput` decided whether a `patchOne` array body
parses as an RFC 6902 document by checking the entity's own resolved
`arrayMutation.strategy` alone. That is no longer sufficient: an entity whose
own default is `"replace"` (or unset) must still accept jsonPatch bodies the
moment _any_ of its relations resolves to `"jsonPatch"` via its own
`write: { strategy: "jsonPatch" }`. The gate is now `entityDefault ===
"jsonPatch" || some relation resolves to "jsonPatch"`, and the
`writeOptedRelations` set that the `/<relation>/-` path shape validates
against is narrowed to jsonPatch-strategy relations specifically — a
relation opted into `replace` or `resource` is not a legal jsonPatch member
path, keeping the strategies mutually exclusive per relation the same way
they were always mutually exclusive per entity.

**The one adopter-visible surprise this introduces, stated plainly:**
opting a _single_ relation into `jsonPatch` changes `patchOne`'s body
contract for the **whole entity** — an array body is now parsed as an RFC
6902 document for every writable field, not just that one relation. This was
already true at the entity level before this amendment; it is now also true
when the trigger is a single relation's own override rather than the
entity's declared default, which is easy to miss when skimming a relation's
own `write` config in isolation.

**No route collisions.** A `replace`-strategy relation's `PUT
:id/<relation>`, a `resource`-strategy relation's `GET`/`POST`/`DELETE`/`PUT
:id/<relation>`, and every `jsonPatch`-strategy relation sharing the
entity's one `PATCH :id` route can all coexist on the same entity without
colliding: the first two are keyed by relation name in their path segment,
and the third is a body-shape distinction on a route every entity already
has.

**Example.** `examples/nest-typeorm`'s `Cat` now demonstrates this directly:
`tags` stays on `replace` (inheriting the entity's own
`arrayMutation.strategy: "replace"` default via `write: true`), while the
new `photos` relation pins `write: { strategy: "resource" }`, trading the
single `PUT /cats/:id/tags`-shaped route for
`GET`/`POST`/`DELETE`/`PUT /cats/:id/photos` instead.

## Consequences

- All three named strategies — `replace`, `jsonPatch`, `resource` — are
  implemented today, each behind its own bootstrap capability check and its
  own mutually-exclusive route surface.
- `@kavo/prisma`, `@kavo/mongoose`, and `@kavo/mikroorm` do not implement
  `replaceRelation`, `patchRelation`, `readRelation`, `addRelationMember`,
  or `removeRelationMember` yet. An app on one of them that opts a relation
  into `write` fails at bootstrap with a clear message, not a runtime
  surprise.
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
- Since the per-relation amendment (issue #223), two relations on the same
  entity can resolve to two different strategies — the entity-level
  `arrayMutation.strategy` is now a _default_ a relation inherits via
  `write: true`, not a ceiling every write-opted relation must share.
  Opting one relation into `jsonPatch` still changes `patchOne`'s body
  contract for the whole entity, the same as it always did at the entity
  level — that scope was never per-relation and this amendment does not
  narrow it.
