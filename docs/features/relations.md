# Relations

- `maxIncludeDepth` (default `2`): the max nesting depth for `include=` chains. `include=owner.tags` is depth 2.
- `maxIncludedNodes` (default `10`): the max total number of included relation nodes per request, across every branch of the include tree.
- `edges` (default `{}`): per-relation loading tuning, keyed by relation property name. See `relations.edges` below.

Whether a relation may be included at all is a separate question, answered by `allowed.includable` (entity scope only). See [Allowed](/features/allowed) ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).

An entry in `edges` tunes loading for a relation that is already includable. It grants no permission by itself: naming a relation in `edges` alone does not open it to `include=`.

## `relations.edges.<name>` (`RelationEdgeSettings`)

- `defaultInclude` (default `false`): includes this relation even when the client doesn't ask for it. It requires the relation to also be named in `allowed.includable`, or it's a bootstrap error.
- `maxDepth` (default inherits `relations.maxIncludeDepth`): overrides the include-depth limit for the subtree below this relation only.
- `strategy` (default `"auto"`, or `"join"`/`"batch"`/`"key"`): controls how the relation loads. `join` runs a single query and is correct for to-one relations. `batch` runs a per-level `WHERE parentId IN (...)` and is correct for to-many relations. `auto` picks one of the two based on cardinality. `key` (owning-side to-one only) is the cheapest option when a caller wants nothing but the foreign key: it materializes the edge as `{ <pk>: value }` read straight off the parent row's own FK column — no join — and serializes a `null` FK as `null`. It grants no permission of its own (the edge is still includable only via `allowed.includable`), `select[<rel>]` may name only the primary key, and it is rejected at bootstrap on a to-many edge or an inverse `@OneToOne` (neither has a local FK). A composite-key target is not supported yet. How cheap it is depends on the ORM: MikroORM and Mongoose drop the edge's load entirely, TypeORM reads it from the row it already fetched for a many-to-one (one extra id-only query for an owning one-to-one), and Prisma still issues its own relation query but selects only the id.
- `write` (default `false`): opts a to-many relation into `arrayMutation` writes (below). Two spellings: `write: true` opts in and inherits the entity's own `arrayMutation.strategy`. `write: { strategy }` opts in and pins this relation's own strategy, independent of the entity default, so two relations on the same entity can use two different strategies.

Either spelling on a to-one relation is a bootstrap error, and so is a spelling where no strategy resolves (`write: true` under an entity with no `arrayMutation.strategy` declared, or `write: {...}` under `arrayMutation: false`).

`write` is independent of `allowed.includable`: a relation can be write-opted without being read-includable, or the other way around.

Migrating from before v0.10? See [Migrating relation config from before v0.10](/guides/migrating-relations-v0-10).

## arrayMutation

`strategy` (`"replace"`, `"resource"`, or `"jsonPatch"`, no built-in default) picks which write shape a `relations.edges.<name>.write: true` relation gets, unless that relation pins its own strategy directly with `write: { strategy }` (see `relations.edges.<name>.write` above). All three are implemented.

`false` for the whole `arrayMutation` key (instead of an object) disables the feature entirely and wins over any per-relation override. A relation still naming `write: true` or `write: { strategy }` under it, or `write: true` under an object with no `strategy` set anywhere, is a bootstrap error.

Two relations on the same entity may use two different strategies:

```ts
@Kavo(Book, {
  arrayMutation: { strategy: "replace" }, // the entity default
  relations: {
    edges: {
      tags: { write: true }, // inherits "replace"
      photos: { write: { strategy: "jsonPatch" } }, // pins its own strategy
    },
  },
})
class BookController {}
```

Opting even one relation into `"jsonPatch"` this way turns on RFC 6902 body parsing for `patchOne` across the whole entity, the same as declaring `arrayMutation.strategy: "jsonPatch"` at entity scope does, not just for that one relation.

### `"replace"`

Gives each write-opted to-many relation `PUT /<entity>/:id/<relation>`, generated the same way every other route is: one registry entry per relation, at `@Kavo` decoration time. The body is a full replacement array of `{id}` references, or `null`, still id-only per [ADR-0014](/internals/adr/0014-associate-by-id-not-deep-writes) — a bare scalar element is rejected (`400 KAVO_ASSOCIATION_INVALID_SHAPE`). Partial mutation is disabled outright: no `{ add: [...] }`/`{ remove: [...] }` shape, no patch ops. Any other top-level body shape is a `400 KAVO_ARRAY_MUTATION_INVALID_SHAPE`. The response is the parent entity's own `item` shape, not the relation's member list.

```ts
@Kavo(Book, {
  arrayMutation: { strategy: "replace" },
  relations: { edges: { tags: { write: true } } },
})
class BookController {}
```

### `"resource"`

Gives each write-opted relation four operations under the same `/<entity>/:id/<relation>` path instead of one:

- `PUT` (identical to `"replace"`'s own `replace<Relation>`)
- `GET` (`list<Relation>`, current membership)
- `POST` (`add<Relation>`, one member by id)
- `DELETE` (`remove<Relation>`, one member by id; the member id travels in the body, since the path only names the parent)

`add`/`remove` bodies are a single scalar id or `{id}` reference, never an array. In practice, send `{id}`: `@nestjs/platform-express`'s default JSON body parser runs in `strict` mode, which refuses a bare top-level scalar before the request reaches Nest at all. `{id}` is the one shape guaranteed to arrive over a real deployment's defaults.

Matching and orphan rules: adding an id with no matching row is `404 KAVO_NOT_FOUND`. Adding an id that's already a member is an idempotent no-op. Removing an id that isn't currently a member is `404 KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND` rather than a silent no-op.

```ts
@Kavo(Book, {
  arrayMutation: { strategy: "resource" },
  relations: { edges: { tags: { write: true } } },
})
class BookController {}
```

`replaceRelation`/`readRelation`/`addRelationMember`/`removeRelationMember` are all optional adapter methods. `@kavo/typeorm` implements every one of them today; an app on an adapter that doesn't yet is told so at bootstrap (`ConfigurationException`), the moment a relation opts in, rather than failing on the first request.

One narrower case gets the same bootstrap treatment: opting a **composite-key** entity's own **many-to-many** relation into array-mutation writes. TypeORM's `RelationQueryBuilder.add`/`.set` validate the member value's shape against the _owning_ side's join-column count, which is 2+ for a composite-key owner and unsatisfiable by any bare member id on the related entity's side — an upstream TypeORM limitation, not a Kavo restriction. A composite-key entity's **one-to-many** relations are unaffected. See [Composite primary keys](/features/composite-primary-keys) and [ADR-0039](/internals/adr/0039-composite-primary-keys-are-typeorm-only) for the full detail.

`jsonPatch` reuses `patchOne`'s existing `PATCH /<entity>/:id` route instead of adding a new one: an array body is parsed as an RFC 6902 patch document, while an object body keeps `patchOne`'s ordinary contract unchanged.

See [ADR-0029](/internals/adr/0029-array-relations-may-opt-into-replace-writes) and [doc 12 §5](/internals/architecture/12-relations-and-includes#array-relation-mutation-arraymutation-adr-0029) for the full design and the follow-up issues tracking the remaining ORM adapters.

See [Settings](/guides/configuration/settings) for the rest of `KavoSettings`.
