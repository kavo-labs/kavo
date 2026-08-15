# Relations

`maxIncludeDepth` (default `2`) is the max nesting depth for `include=` chains (`include=owner.tags` is depth 2). `maxIncludedNodes` (default `10`) is the max total number of included relation nodes per request, across every branch of the include tree.

`edges` (default `{}`) is per-relation **loading tuning**, keyed by relation property name — see `relations.edges` below. Whether a relation may be included at all is `allowlists.includable`'s question, entity scope only — see `allowlists` in [Allowlists & computed fields](/features/allowlists-and-computed-fields#allowlists) ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).

**`relations.edges.<name>`** (`RelationEdgeSettings`):

`defaultInclude` (default `false`) includes this relation even when the client doesn't ask for it. It requires the relation to also be named in `allowlists.includable` — a bootstrap error otherwise. `maxDepth` (default inherits `relations.maxIncludeDepth`) overrides the include-depth limit for the subtree below this relation only. `strategy` (default `"auto"`, or `"join"`/`"batch"`) controls how the relation loads: `join` (single query, correct for to-one), `batch` (per-level `WHERE parentId IN (...)`, correct for to-many), or `auto` (picks per cardinality). `write` (default `false`) opts a **to-many** relation into `arrayMutation` writes (below) — see `arrayMutation` for the strategy this then applies. `true` on a to-one relation, or with no `arrayMutation` strategy resolved for the entity, is a bootstrap error. It's independent of `allowlists.includable`: a relation can be write-opted without being read-includable, or the reverse.

An entry here tunes loading for a relation that is already includable; it
grants no permission by itself — naming a relation in `edges` alone does not
open it to `include=`.

**Migrating from before v0.10 ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)):**
`relations.edges.<name>.includable: true` was the opt-in — naming a relation
here, with no `includable` key at all, opened it by default. That key is
gone. Move each opted-in relation name to `allowlists.includable` (see
[Allowlists & computed fields](/features/allowlists-and-computed-fields#allowlists));
keep any `maxDepth`/`strategy` on `relations.edges.<name>` exactly where it
was. `allowlists.includable` is entity-scope-only config (no global
`defaults`, no per-operation override), so a permission previously granted
through a global default now needs its own `createCrud`/`@Kavo` registration
per entity.

**`defaultInclude` needs its own care if it was set at global (`defaults`)
scope.** Before this change, naming a relation in a global
`defaults.relations.edges.<name>` was itself the opt-in, so a global
`defaultInclude: true` was safe by construction. It is not safe to leave
where it was: `allowlists.includable` cannot be set globally, so a global
`defaultInclude: true` with no _entity-level_ `allowlists.includable` naming
that relation is now a **bootstrap crash** (`ConfigurationException`) on
every entity that happens to have a relation of that name — not a silent
no-op. Move `defaultInclude: true` down to each entity's own
`relations.edges.<name>` alongside that entity's `allowlists.includable`
grant, rather than leaving it at global scope.

## arrayMutation

`strategy` (default `"replace"`, or `"resource"`/`"jsonPatch"`) picks which write shape a `relations.edges.<name>.write: true` relation gets. All three are implemented. `false` for the whole `arrayMutation` key (instead of an object) disables the feature entirely; a relation still naming `write: true` under it is a bootstrap error.

`"replace"` gives each write-opted to-many relation `PUT /<entity>/:id/<relation>`, generated the same way every other route is (one registry entry per relation, at `@Kavo` decoration time). The body is a full replacement array — ids, `{id}` references, or `null` — still id-only per [ADR-0014](/internals/adr/0014-associate-by-id-not-deep-writes), with partial mutation disabled outright: no `{ add: [...] }`/`{ remove: [...] }` shape, no patch ops. Any other top-level body shape is a `400 KAVO_ARRAY_MUTATION_INVALID_SHAPE`. The response is the parent entity's own `item` shape, not the relation's member list.

```ts
@Kavo(Book, {
  relations: { edges: { tags: { write: true } } },
  // arrayMutation: { strategy: "replace" } is the default once a relation opts in — no need to repeat it.
})
class BookController {}
```

`"resource"` gives each write-opted relation four operations under the same `/<entity>/:id/<relation>` path instead of one: `PUT` (identical to `"replace"`'s own `replace<Relation>`), `GET` (`list<Relation>`, current membership), `POST` (`add<Relation>`, one member by id) and `DELETE` (`remove<Relation>`, one member by id — the member id travels in the body, since the path only names the parent). `add`/`remove` bodies are a single scalar id or `{id}` reference, never an array. In practice, send `{id}`: `@nestjs/platform-express`'s default JSON body parser runs in `strict` mode, which refuses a bare top-level scalar before the request reaches Nest at all — `{id}` is the one shape guaranteed to arrive over a real deployment's defaults. Matching/orphan rules: adding an id with no matching row is `404 KAVO_NOT_FOUND`; adding an id already a member is an idempotent no-op; removing an id that isn't currently a member is `404 KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND` rather than a silent no-op.

```ts
@Kavo(Book, {
  arrayMutation: { strategy: "resource" },
  relations: { edges: { tags: { write: true } } },
})
class BookController {}
```

`replaceRelation`/`readRelation`/`addRelationMember`/`removeRelationMember` are all _optional_ adapter methods — `@kavo/typeorm` implements every one of them today; an app on an adapter that doesn't yet is told so at bootstrap (`ConfigurationException`), the moment a relation opts in, rather than failing on the first request. `jsonPatch` reuses `patchOne`'s existing `PATCH /<entity>/:id` route instead of adding a new one — an array body is parsed as an RFC 6902 patch document, while an object body keeps `patchOne`'s ordinary contract unchanged. See [ADR-0029](/internals/adr/0029-array-relations-may-opt-into-replace-writes) and [doc 12 §5](/internals/architecture/12-relations-and-includes#array-relation-mutation-arraymutation-adr-0029) for the full design and the follow-up issues tracking the remaining ORM adapters.

See [Settings](/guides/configuration/settings) for the rest of `KavoSettings`.
