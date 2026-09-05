# Allowed

What a request may filter, sort, select, include, and write, including relation paths. Anything outside a query-side allowlist is rejected with a 400, never silently dropped; the write-side allowlists (`create.fields`/`update.fields`) narrow silently, the same way an unknown body key already does:

```ts
@Kavo(Book, {
  allowed: {
    filterable: ["id", "title", "author"],
    sortable: ["id", "title"],
    selectable: ["id", "title", "author"],
    includable: ["author"],
    searchable: ["title", "author"],
  },
  create: { fields: ["title", "author"] },
  update: { fields: ["title"] },
})
```

- `filterable` (`readonly FieldPath[]` \| `{ exclude: readonly FieldPath[] }`): fields usable in `filter[...]`.
- `sortable` (same shape): fields usable in `sort=`.
- `selectable` (`readonly FieldPath<Entity, 1>[]` \| `{ exclude: ... }`, plus declared computed-field names): fields usable in `select=`, and what a response carries. Capped to depth 1 — this entity's own columns and computed-field names only, so a relation-dotted entry (`"dictionary.id"`) neither type-checks nor boots ([ADR-0045](/internals/adr/0045-relation-projection-ceiling-removed)). An included relation's projection is governed by the **target** entity's own `selectable` ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)); to restrict it, configure the target entity, or drop it from `includable`.
- `includable` (`readonly IncludePath<Entity, 1>[]` \| `{ exclude: readonly IncludePath<Entity, 1>[] }`): relation names usable in `include=`, one segment at a time from the root ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).
- `searchable` (`readonly FieldPath[]` \| `{ exclude: readonly FieldPath[] }`): fields `search[query]`/`search[fields]` may search. Relation paths are permitted here, unlike `filterable`/`sortable`. Default: every own string-kind column, not every own column. Also gated by `search` (`false` by default — set it to an object to turn search on); see [Search](/querying/search).
- `create.fields` (`readonly FieldPath<Entity, 1>[]` \| `{ exclude: readonly FieldPath<Entity, 1>[] }`): fields `createOne` may write. Default: every non-generated own column except the primary key, plus every relation (associable by id). Capped to one path segment — a write body addresses the entity's own fields and relations, never a dotted path into a relation's own fields. Configured as a sibling of `allowed`, not nested inside it — see the example above.
- `update.fields` (same shape as `create.fields`): fields `updateOne`/`patchOne` may write. `update` (PUT) and `patch` (PATCH) share this one list, since both mutate an existing row. On a composite-key entity (`@kavo/typeorm` only, [ADR-0039](/internals/adr/0039-composite-primary-keys-are-typeorm-only)) the two defaults diverge: the key columns stay in `create.fields`'s default (a natural key the client supplies on create) but are excluded from `update.fields`'s (immutable afterward) — the one case where `create.fields` and `update.fields` don't share the same base set.

`{ exclude: [...] }` means "every own column except these" (plus, for `selectable`, every selectable computed field; for `includable`, every own relation; for `searchable`, every own string-kind column; for `create.fields`/`update.fields`, every relation too). It resolves at bootstrap against exactly the base set that key's plain default uses.

**`create.fields`/`update.fields` only narrow — they never widen.** They intersect with the writable projection [`DefaultDeserializer` already derives](/internals/architecture/04-dto-system#_3-runtime-derivation-rules): naming the primary key or the soft-delete marker there has no effect, since neither is in that base set to begin with. A registered `create`/`update`/`patch` DTO with a runtime shape replaces the projection outright rather than intersecting with it — exactly as a registered `item`/`list` DTO outranks `selectable` below — so register the DTO as the narrowing statement where you use one.

**`includable` is the one key here that does not default to "everything".** Omit `filterable`/`sortable`/`selectable` and it derives from the `query` DTO or entity metadata, every own column. Omit `includable` and it resolves to `[]`, no relation is includable, the same opt-in posture `relations.edges` had before this key existed. Write `{ exclude: [] }` to opt every own relation in at once; that is the one spelling that crosses the fail-closed default rather than narrowing a fail-open one.

When `@nestjs/swagger` is installed, an explicit array here also names the generated `filter`/`sort`/`select`/`include` `ApiQuery` descriptions with the entity's actual allowed fields and relations. `{ exclude: [...] }` and an omitted `filterable`/`sortable`/`selectable` key carry no per-route description at all, because resolving either needs ORM metadata, which doesn't exist yet at `@Kavo` decoration time (see [ADR-0012](/internals/adr/0012-decoration-time-route-generation)). `includable`'s omitted case is different: the empty-set default needs no ORM metadata, so an omitted `includable` still gets a description ("No relation is includable on this entity"). Only its own `{ exclude: [...] }` form is undescribed, for the same decoration-time reason. The generic `filter`/`sort`/`limit`/`offset`/`select`/`include` syntax itself isn't repeated on every route; it's exported once as `KAVO_API_GUIDE` from `@kavo/nest`, for splicing into your own `DocumentBuilder().setDescription(...)` (see the reference apps' `main.ts`).

**The `createOne`/`updateOne`/`patchOne` request body, when no DTO is registered.** A `create`/`update`/`patch` DTO's runtime shape documents its own `@ApiBody` schema (see [DTOs](/core/dtos)); with none registered, `@kavo/nest` falls back to a schema built from the entity's own columns narrowed to the resolved `create.fields`/`update.fields` set — generated columns excluded the same way `DefaultDeserializer` already strips them from write payloads — rather than leaving the body undocumented. `create.fields`/`update.fields` narrow silently (an unknown body key is dropped, not rejected, per this page's opening line), so the synthesized schema declares no `additionalProperties: false` — it would tell a validating client that a body Kavo actually accepts is invalid. An explicit empty allowlist (`create: { fields: [] }`) still documents a real closed intent via its `description` ("No field is writable."), not silence. The success response gets the same treatment on its `item`/`list` fallback: with no `item`/`list` DTO registered, the response schema is narrowed to the resolved `selectable` set rather than publishing every own column regardless of `selectable`. Unlike the query-param docs above, both need ORM metadata _and_ the fully resolved allowlist, so they can only run once `KavoModule.forRoot`/`forRootAsync` has bootstrapped the entity — an app with neither in its module graph keeps the unnarrowed entity-wide schema on both sides, the same limitation the ETag/search/pagination docs already carry.

**How to keep a column out of every response.** Name `selectable` and leave the column off it, or exclude it. Both forms do the same thing:

```ts
@Kavo(User, {
  allowed: { selectable: { exclude: ["apiKey"] } },
})
```

`apiKey` is then absent from `findOne`, `findMany`, `restoreOne`, any custom operation's result, and the row echoed back by `createOne`/`updateOne`/`patchOne`. Naming it in `select=` is a 400. Writing the key at all is what turns it on: omit `selectable` entirely and the projection is every column plus every declared computed field, exactly as before ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)).

::: danger `selectable` alone is not a credential control
It closes the **response body**. Three other doors stay open, and a column you actually need to protect has to close all four.

| Door                      | Still open after `selectable`                                                                                                        | Close it with                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `filter[apiKey][like]=a%` | Yes. `filterable` defaults to every column, and `LIKE`/`GT`/`LT` binary-search the value in `O(log n)` requests                      | Name `filterable` explicitly, without the column                                                      |
| `sort=apiKey`             | Yes. `sortable` defaults to every column, and ordering leaks the column across pages                                                 | Name `sortable` explicitly, without the column                                                        |
| `PATCH {"apiKey":"…"}`    | Yes. Writable columns are derived separately, and after this change the write is invisible, because the response no longer echoes it | Narrow `update.fields` without the column, or register `dto.update` (`patch` falls back to it) without it |
| response body             | No                                                                                                                                   | `selectable`                                                                                          |

The filter and sort doors are the same oracle [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union) refuses for cursor sort keys. Narrow all three allowlists together, and add the write DTO.
:::

Two more edges. A registered `dto.item`/`dto.list` with a runtime shape replaces the projection rather than intersecting with it, so `selectable` does not fence a column the DTO names, even where the DTO is wider. Register the DTO as the narrowing statement when you use one. And an included relation is projected by its own target's `selectable`, never the root's, so hiding a column on `User` keeps it hidden wherever `user` is included, provided `User` itself went through `@Kavo`/`createCrud`. A relation target that never did gets a derived config, which configures nothing and serves its full column set.

## Restricting an included relation's fields

`selectable` takes this entity's own columns and its declared computed-field names only. A relation-dotted entry (`"dictionary.id"`) is a bootstrap error ([ADR-0045](/internals/adr/0045-relation-projection-ceiling-removed)) — including in the `{ exclude }` form.

An included relation's projection is governed by the **target** entity's own `selectable` ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection) decision 4), never the entity doing the including. To restrict what `?include=dictionary` embeds, narrow `selectable` on the `Dictionary` entity's own config; a `Dictionary` that never went through `@Kavo`/`createCrud` serves its full derived column set, so route it (even service-only) if you need to trim it. To drop the relation entirely, leave it off `allowed.includable`.
