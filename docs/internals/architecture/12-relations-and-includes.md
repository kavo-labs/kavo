# 12 — Relation System & Nested Includes

`GET /owners?include=pets&select[pets]=id,name` — everything between that
query string and the SQL is documented here.

```ts
@Kavo(Owner, {
  allowlists: { includable: ["pets"] },
})
```

Inclusion is an **allowlist**, exactly like filtering and sorting: ORM
metadata supplies the shape of a relation (name, target, cardinality) and
config supplies permission, which metadata can never know. A relation
nobody opted in is a 400, never a silent omission. Permission and loading
tuning are two different config keys (ADR-0028): `allowlists.includable`
(entity-config.ts) grants `include=` access, one relation segment at a time
from the root; `relations.edges.<name>` (settings.ts) only tunes
`defaultInclude`/`maxDepth`/`strategy` for a relation once it is already
includable — naming a relation in `edges` grants nothing by itself.

## 1. The registry

`DefaultRelationRegistry` merges three sources at bootstrap into one
`RelationDescriptor` per edge:

| Key                             | Source                  | Default                                                                                             |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `name`, `target`, `cardinality` | metadata                | —                                                                                                   |
| `includable`                    | `allowlists.includable` | `false` — unconfigured means no relation is includable, unlike every other allowlist key (ADR-0028) |
| `defaultInclude`                | `relations.edges`       | `false`                                                                                             |
| `maxDepth`                      | `relations.edges`       | inherit `relations.maxIncludeDepth`                                                                 |
| `strategy`                      | `relations.edges`       | `auto`                                                                                              |

A name in `allowlists.includable`, or in `relations.edges`, that the entity
does not have is a bootstrap `ConfigurationException`: an allowlist typo
that silently permits nothing looks exactly like working config until the
first client asks.

## 2. Resolution (`DefaultIncludeResolver`)

1. **Parse** dot-paths into a tree; overlapping paths merge, so `posts`
   and `posts.comments` produce one `posts` node with a `comments` child.
2. **Validate** each edge against the registry of the entity that _owns_
   it — unknown or non-includable → `KAVO_QUERY_INVALID_FIELD` (400).
3. **Limit**: `relations.maxIncludeDepth` (default 2) as a budget spent
   per level, a relation's own `maxDepth` replacing that budget for its
   subtree, and `relations.maxIncludedNodes` (default 10) across the whole
   tree → `KAVO_QUERY_LIMIT_EXCEEDED`.
4. **Cycle guard is depth, and only depth.** `manager.manager.manager` is
   legal until the budget runs out. Visited-type tracking would forbid a
   legitimate self-relation, and depth is the rule a client can predict.
5. **Fieldsets**: `select[posts.comments]=id,body` attaches to that node,
   validated against the _target_ entity's selectable allowlist only —
   never the owning entity's (ADR-0026 decision 4; the ADR-0044 parent-side
   ceiling was removed in ADR-0045). With no `select[<path>]=` in the
   request the node carries no fieldset and the target's own default
   projection applies.
6. **Resolve decisions**: `auto` becomes `join` or `batch`, and the
   target's delete strategy is attached — so the adapter translates
   answers rather than re-deriving them. A `key` node additionally carries
   `keyField` (the target's pk), has its fieldset forced to `[keyField]`
   (any other `select[<path>]=` field is a 400), and may carry no
   children (a nested path through it is a 400).

Every issue across the tree is collected before throwing: one round trip,
all problems, like the rest of the query pipeline.

Nested levels read the **target entity's own resolved config** through the
`EntityCatalog` — its allowlists, DTOs, delete strategy, and further
relations. That is the mechanism behind the rule that _a relation never
widens what its target exposes_. Lookup is per-request, not a bootstrap
snapshot, because `createCrud(Owner)` may run before `createCrud(Pet)` and
neither order should change what `include=pets` does. A target that never
went through `createCrud` is derived from metadata alone: readable, but
opening no further relations, since nothing opted in.

## 3. Loading strategies

| Strategy | What happens                                                                                                              | Default for |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `join`   | `leftJoinAndSelect` in the main query                                                                                     | to-one      |
| `batch`  | one extra query per relation level, parents batched by id, stitched in memory                                             | to-many     |
| `key`    | the parent's local FK id alone, materialized as `{ <pk>: value }` / `null` — no join, no row-multiplication (to-one only) | —           |
| `auto`   | the `join`/`batch` rules above                                                                                            | everything  |

`key` (issue #364) is for the case where a caller wants only a to-one
edge's foreign key in the response and a join buys nothing — the FK is
already a column on the parent row. It is rejected at bootstrap on a
to-many edge (no local FK), grants no permission of its own (the edge is
still includable only via `allowlists.includable`, ADR-0028), and — unlike
`join`/`batch` — every adapter acts on it: `@kavo/typeorm` via TypeORM's
batched relation-id loader (`loadRelationIdAndMap`), `@kavo/prisma` via a
nested `select` of the pk, `@kavo/mongoose` and `@kavo/mikroorm` by
leaving the edge un-populated and rewriting its raw FK. A composite-key
target is not supported yet (first cut assumes a single-column pk).

**Pagination correctness (normative): root pagination always counts and
slices distinct root entities, never joined rows.** Batching to-many
relations is what makes that free — the main query never multiplies its
rows. When a to-many is _explicitly_ joined anyway, the fallback holds the
line: TypeORM's `skip`/`take` paginate root ids in a subquery first, and
`count` is a dedicated query with no include joins at all. A page of one
blog is one blog with all of its articles, never half a blog.

In `@kavo/typeorm`, join aliases are deterministic (`Owner__pets__owner`)
and share `FilterTranslator`'s scheme, so `filter[blog.name][eq]=…`
alongside `include=blog` reuses the one selecting join instead of adding a
second, non-selecting one under a duplicate alias.

**Eager loading for detail views.** `strategy: "join"` is not restricted to
to-one edges — forcing it onto a to-many edge folds that relation into the
main query too, so `findOne`/`findOneById` resolves in a single round trip
instead of the main query plus one batch query per relation level. This is
the pattern for a detail endpoint over a relation with modest cardinality
(an owner's pets, a blog's articles), where the extra joined rows are cheap
and a second query is pure overhead:

```ts
joinedBlogs = kavo.createCrud(Blog, {
  allowlists: { includable: ["articles"] },
  relations: { edges: { articles: { strategy: "join" } } },
});
```

It is opt-in per edge, never the default — `auto` still resolves a to-many
to `batch`, and a list endpoint over the same relation should keep it that
way: joining a large to-many into a paginated main query is correct (the
skip/take-on-distinct-roots fallback above holds) but wastes bandwidth on
rows the batch strategy would fetch once per page instead of once per root.
Because `strategy` is entity-wide config, not per-operation, giving a detail
route eager loading while a list route keeps batching means two `createCrud`
registrations of the same entity — one per route, each with its own
strategy — exactly as `blogs` and `joinedBlogs` do in
`packages/orms/typeorm/tests/includes.spec.ts`.

The join/batch distinction is a concern of _writing SQL by hand_, and
only `@kavo/typeorm` acts on it. Prisma's `include`, Mongoose's
`populate`, and MikroORM's `populate` each resolve a relation with their
own separate queries and apply `limit`/`offset` to the root regardless —
never a row-multiplying join the caller has to compensate for — so a
to-many include cannot disturb root pagination there whatever strategy
core resolved. Those three adapters therefore ignore the `join`/`batch`
distinction (doc 14 §3, doc 15 §3, doc 17 §3) — they still act on `key`,
which is not about join-vs-batch but about not loading the target at all;
core still resolves the `join`/`batch` split anyway, because the contract
is the same everywhere and an adapter that _does_ join needs the answer.

A many-to-many edge is nothing special here: metadata maps
`isManyToMany` to cardinality `"many"` exactly like `isOneToMany`, so it
gets the same `batch` default and the same distinct-roots pagination
guarantee — the join table never reaches the main query. `Pet.tags` (the
example app) is what first exercises this path; no adapter or core change
was needed to support it.

`Owner.address` (`@OneToOne`, owning side on `Owner`) is the example app's
one-to-one relation: cardinality falls out of the metadata adapter's
existing `isOneToMany || isManyToMany ? "many" : "one"` rule with no special
case, and `auto` resolves it to `join` exactly like `Pet.owner`.

## 4. Interplay

- **Sparse fieldsets:** keys needed for stitching are always fetched and
  stripped at serialization — "kept internally, stripped late". Root
  `select=` selects the root's own columns; relation shapes are selected
  through `select[<path>]`.
- **DTOs:** an included node is projected through the target's registered
  `item` DTO (`list` for a to-many, which falls back to `item`), else the
  target's derived default. A relation key on the _parent's_ DTO is
  documentation, not a load: it stays absent until the node is included.
- **No parent-side ceiling (ADR-0045):** an included relation's projection
  is the target entity's own `selectable` (or its derived default). The
  including entity's `allowlists.selectable` takes root paths only — a
  relation-dotted entry is a bootstrap error, in the array and the
  `{ exclude }` form alike. ADR-0044's ceiling mechanism is fully removed.
- **Soft delete:** soft-deleted related rows are excluded from
  includes. Root-level `withDeleted` applies to the **root only** — the
  adapter spells the child predicate out rather than leaving it to the
  ORM's default, so widening the root never silently widens the relation.
  A per-include `withDeleted` is deliberately out of scope in v6.
- **`findOne` supports `include`** with identical semantics.
- **Swagger:** `include` and one `select[<relation>]` per includable
  relation are documented from the entity config's allowlist — the only
  relation knowledge decoration time has (ADR-0012). The synthesized
  `<Entity>Item` schema `$ref`s each includable relation's `<Target>Item`
  component (ADR-0045; the ADR-0044 inline-ceiling branch is gone).

## 5. Writes

Association by id, never deep nested writes — the rationale and the
extension point are **ADR-0014**. `{"owner": {"id": 7}}`,
`{"tags": [{"id": 1}, {"id": 2}]}`, and `null` all work; anything more
inside a relation object is narrowed to the id rather than half-honored. A
bare scalar (`{"owner": 7}`) is rejected with `AssociationInvalidShapeException`
(`KAVO_ASSOCIATION_INVALID_SHAPE`) rather than accepted as shorthand — a
composite-key target (ADR-0039) is the one exception, keeping its own
`~`-delimited scalar shorthand.

### Array-relation mutation (`arrayMutation`, ADR-0029)

ADR-0014's named extension point — an explicit per-relation write policy —
is `KavoSettings.arrayMutation: { strategy } | false`, resolved through the
usual precedence chain as the entity's own default, plus a per-relation
opt-in: `relations.edges.<name>.write: true`. A relation not opted in keeps
the plain associate-by-id behavior above; nothing here changes for it.

The opt-in has a second spelling since issue #223 (ADR-0029's per-relation
amendment): `write: { strategy }` opts in **and** pins that one relation's
own strategy, overriding the entity default — so two relations on the same
entity can use two different strategies (one `replace`, another `resource`,
say). `write: true` still means exactly what it always did: inherit the
entity's own resolved `arrayMutation.strategy`.

Three strategies are named — `"replace"`, `"resource"`, `"jsonPatch"` —
and all three are implemented today.

`replace` is a whole-array `PUT` on the relation, still id-only per
ADR-0014, with partial mutation disabled — no `{ add: [...] }`/
`{ remove: [...] }` shape, no JSON Patch ops:

- For each relation with `write: true`, Kavo synthesizes one operation,
  `replace<Relation>` (`replaceTags` for `tags`), routed at
  `PUT /<entity>/:id/<relation>`. This is a registry entry like any other
  (ADR-0006) — synthesized post-hoc by `registerArrayMutationOperations`
  rather than declared through `EntityConfig.operations`, since nothing
  there names it, but generated at decoration time exactly like every
  other route (ADR-0012).
- The body is an array of ids/`{id}` references, or `null` (empty array
  and `null` both disassociate every current member). Any other top-level
  shape raises `ArrayMutationInvalidShapeException`
  (`KAVO_ARRAY_MUTATION_INVALID_SHAPE`, 400).
- `write: true` is checked against the relation's real cardinality at
  `createCrud` (`ConfigurationException` on a to-one relation — nothing to
  replace), and a write-opted relation on an adapter without
  `EntityWriter.replaceRelation` also fails at `createCrud` — the ORM
  caveat ADR-0014 already states for association by id applies here too.
- The response is the parent entity (its own `item` DTO slot), not the
  relation's own member list.

### `resource` (ADR-0029's resource amendment)

`resource` synthesizes **four** operations per write-opted relation instead
of one, all under the same `/<entity>/:id/<relation>` path, distinguished
by HTTP method — a per-relation sub-collection, rather than one whole-array
endpoint:

| Operation           | Method   | Semantics                                          |
| ------------------- | -------- | -------------------------------------------------- |
| `replace<Relation>` | `PUT`    | Whole-array replace — identical to `replace`'s own |
| `list<Relation>`    | `GET`    | Current membership                                 |
| `add<Relation>`     | `POST`   | Add one member by id                               |
| `remove<Relation>`  | `DELETE` | Remove one member by id                            |

All four are registered by the same `registerArrayMutationOperations` seam
`replace` uses, gated on `strategy: "resource"` (`meta.arrayMutation.action`
distinguishes them — `@kavo/nest`'s route generator keys the HTTP method off
it, since there is no static route table for a dynamic per-relation id).

- `replace<Relation>` behaves exactly as it does under the `replace`
  strategy — same body shape, same `ArrayMutationInvalidShapeException` on
  a malformed one, same response.
- `list<Relation>` takes no body (an ordinary read) and returns the parent
  entity, but — unlike `add`/`remove`/`replace<Relation>`, which keep the
  ordinary "parent only, nothing grafted on" contract byte-for-byte — with
  the relation itself forced onto the response through the existing
  include-projection machinery, bypassing `allowlists.includable`: the
  operation's entire purpose is showing that relation's current membership,
  so a relation opted into `write` but never into `includable` must still
  appear here even though it can never be reached with `?include=`.
- `add<Relation>`/`remove<Relation>` each take a single scalar id or `{id}`
  reference as the body — never an array (that shape is `replace`'s own
  surface) and never absent; either violation raises
  `ArrayMutationInvalidShapeException`. `DELETE` is the one route whose
  body an HTTP method never predicts on its own: unlike `deleteOne`/
  `purgeOne`, `remove<Relation>` has no id path segment to carry the member
  it targets, so the member id travels in the body instead.
- Matching/orphan rules mirror `jsonPatch`'s own, under strategy-neutral
  codes: `add` naming an id with no matching row raises `NotFoundException`
  (`KAVO_NOT_FOUND`) — one rule for "you named something that doesn't
  exist," regardless of strategy; `add` naming an id already a member is an
  idempotent no-op; `remove` naming an id that is **not** currently a
  member raises `ArrayMutationMemberNotFoundException`
  (`KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND`, 404) rather than a silent no-op.
- `EntityWriter` gains three more optional primitives beyond
  `replaceRelation` — `readRelation`, `addRelationMember`,
  `removeRelationMember` — each returning the parent row with the relation
  loaded. `@kavo/typeorm` implements all three; a write-opted relation on
  an adapter missing any of the four `resource` primitives fails at
  `createCrud`, the same bootstrap posture `replace`/`jsonPatch` have.
  `addRelationMember`/`removeRelationMember` commit their membership read
  and write in one transaction, the same reason `patchRelation` does.
- `list`/`add`/`remove<Relation>` routes are **not** generated for a
  relation whose entity resolved `arrayMutation.strategy` to anything other
  than `"resource"` — the three strategies' write surfaces stay mutually
  exclusive per entity, the same rule `replace`/`jsonPatch` already have
  between them.

### `jsonPatch` (ADR-0029's jsonPatch amendment)

`jsonPatch` does not add a route. It reuses `patchOne`'s existing
`PATCH /<entity>/:id` and tells its two legal body shapes apart
structurally: an **object** body is `patchOne`'s ordinary partial-update
DTO, unchanged; a bare **array** body is parsed as an RFC 6902 patch
document instead — the one shape an ordinary patch DTO body never is. An
entity that never opts into `jsonPatch` sees no change at all: an array
body there still degrades to `{}`, exactly as `DefaultDeserializer` has
always treated a non-object body.

The document's ops are validated structurally before anything is written —
"no arbitrary path traversal" is enforced by only accepting two path
shapes, not by a denylist:

- `{ "op": "add" | "replace", "path": "/<field>", "value": … }` — a scalar,
  non-generated column (the id field is never one). `remove` on this shape
  is rejected: there is nothing to literally delete from a partial-update
  payload. The resulting `{ [field]: value, … }` object is fed through the
  same `patch` DTO deserializer an ordinary object body already goes
  through, so field-level validation is unchanged.
- `{ "op": "add" | "remove", "path": "/<relation>/-", "value": … }` — a
  relation with `write: true`. `value` is a scalar id or an `{id}`
  reference, exactly `replace`'s own member shape, resolved through the
  same `associate()` normalization `create`/`update`/`replace` already use.
  Addressing by **identity** (`value`) rather than by array index is a
  deliberate, stated deviation from RFC 6902's array convention: to-many
  relation membership has no persisted order for an index to mean anything
  against. `replace` is rejected on this shape — whole-array replacement is
  `arrayMutation.strategy: "replace"`'s own surface, kept distinct.

Anything else — a malformed op, an unsupported `op` for its path shape, a
path naming neither a writable field nor a write-opted relation, more than
two path segments — raises `JsonPatchInvalidDocumentException`
(`KAVO_JSON_PATCH_INVALID_DOCUMENT`, 400) before any write is attempted.

Member existence is a request-time question the write path answers, not
the parser: an `add` naming an id with no matching row raises the same
`NotFoundException` `replace`'s own existence check raises; an `add`
naming an id already a member is an idempotent no-op; a `remove` naming an
id that is **not** currently a member raises
`JsonPatchTargetNotFoundException` (`KAVO_JSON_PATCH_TARGET_NOT_FOUND`, 404) — RFC 6902 requires a `remove`'s target location to exist, and Kavo
enforces that explicitly rather than silently doing nothing.

A document may touch scalar fields and one or more relations together.
Field changes commit first (through `EntityWriter.patch`), then one
`EntityWriter.patchRelation` call per relation touched. Each
`patchRelation` call is its own atomic unit — `@kavo/typeorm`'s
implementation wraps the read that decides "is this remove target
currently a member?" and the write it gates in one database transaction,
so a concurrent writer can never make that judgment stale — but a document
touching several relations is _not_ one cross-call transaction spanning
all of them: an interrupted process between two `patchRelation` calls
commits the first and not the second. This is the stated scope for now,
one level more atomic than `replace` (whose own read-then-write is not
transactional at all, a gap its own doc comment names), not a claim of
whole-document atomicity.

`write: true` on a relation is still checked against real cardinality at
`createCrud`, and a write-opted relation on an adapter without
`EntityWriter.patchRelation` fails at `createCrud` too — the same
bootstrap posture `replace`'s `EntityWriter.replaceRelation` check has.
`replace<Relation>` routes are **not** generated for a relation whose
entity resolved `arrayMutation.strategy` to `"jsonPatch"` — the two
strategies' write surfaces stay mutually exclusive per entity.

### Per-relation strategy (issue #223, ADR-0029's per-relation amendment)

Every rule above ("relation whose entity resolved `arrayMutation.strategy`
to X") now reads as "relation whose own resolved strategy is X" — each
relation's strategy is resolved individually (`write: true` inherits the
entity default, `write: { strategy }` pins its own), and the three
strategies' route surfaces stay mutually exclusive **per relation**, not
just per entity. `createCrud` groups an entity's write-opted relations by
their own resolved strategy and only runs the adapter capability check each
group actually needs — a `replace`-and-`resource` entity never demands
`resource`'s four primitives for its `replace`-strategy relation.

The one cross-relation effect that survives: opting a single relation into
`jsonPatch` still turns on RFC 6902 body parsing for `patchOne` across the
whole entity (scalar `/<field>` ops included), the same as declaring
`arrayMutation.strategy: "jsonPatch"` at entity scope always did — that was
never a per-relation question, since `patchOne`'s route itself is shared.

See **ADR-0029** and its resource, jsonPatch, and per-relation amendments
for the full design, including why the non-`@kavo/typeorm` adapters are
deliberately out of scope for now for both `jsonPatch` and `resource`.

## 6. Not included

Filtering or sorting _on_ an included node's rows (`include=posts` where
only published posts come back) is not v6: `filter` restricts root rows,
and an included node returns the target's rows as they are. The seam for
it is the include node, which already carries per-node state.
