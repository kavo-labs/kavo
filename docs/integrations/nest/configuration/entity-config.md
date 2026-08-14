# Entity config

`@Kavo(Entity, config)` accepts every settings field from [Settings](/integrations/nest/configuration/settings) one level above global, plus four fields that only make sense per entity: `dto`, `allowlists`, `computed`, and `operations` (its own page, see [Operations](/integrations/nest/configuration#operations)).

## dto

Registers DTO classes per slot — every slot is independently optional and falls back to an entity-derived default when omitted:

```ts
@Kavo(Book, {
  dto: {
    create: CreateBookDto,
    update: UpdateBookDto,
    item: BookItemDto,
    list: BookListDto,
  },
})
```

| Slot     | Default when omitted                                |
| -------- | --------------------------------------------------- |
| `create` | Entity's own shape, minus generated/relation fields |
| `update` | Same default as `create`                            |
| `patch`  | `Partial<update>` if set, else `Partial<Entity>`    |
| `query`  | Generic `QueryContext<Entity>`                      |
| `item`   | Entity, subject to field selection                  |
| `list`   | Same as `item`'s resolved type                      |

There's no `patch` DTO class to write on its own — it derives from `update`. See [DTO system](/internals/architecture/04-dto-system) for full derivation rules.

## allowlists

What a request may filter, sort, select, and include — including relation paths. Anything outside an allowlist is rejected with a 400, never silently dropped:

```ts
@Kavo(Book, {
  allowlists: {
    filterable: ["id", "title", "author"],
    sortable: ["id", "title"],
    selectable: ["id", "title", "author"],
    includable: ["author"],
    searchable: ["title", "author"],
  },
})
```

- `filterable` (`readonly FieldPath[]` \| `{ exclude: readonly FieldPath[] }`) — fields usable in `filter[...]`.
- `sortable` (same shape) — fields usable in `sort=`.
- `selectable` (same shape) — fields usable in `fields=`, **and what a response carries**.
- `includable` (`readonly IncludePath<Entity, 1>[]` \| `{ exclude: readonly IncludePath<Entity, 1>[] }`) — relation names usable in `include=`, one segment at a time from the root ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).
- `searchable` (`readonly FieldPath[]` \| `{ exclude: readonly FieldPath[] }`) — fields `search[query]`/`search[fields]` may search — relation paths permitted (unlike `filterable`/`sortable`). Default: every own **string-kind** column, not every own column. Also gated by `query.search.enabled` (off by default) — see [Search](/using-the-api#search).

`{ exclude: [...] }` means "every own column (plus, for `selectable`, every selectable computed field; for `includable`, every own relation; for `searchable`, every own **string-kind** column) except these", resolved at bootstrap against exactly the base set that key's plain default uses.

**`includable` is the one key here that does not default to "everything".** Omit `filterable`/`sortable`/`selectable` and it derives from the `query` DTO or entity metadata — every own column. Omit `includable` and it resolves to `[]` — **no relation is includable** — the same opt-in posture `relations.edges` had before this key existed. Write `{ exclude: [] }` to opt every own relation in at once; that is the one spelling that crosses the fail-closed default rather than narrowing a fail-open one.

When `@nestjs/swagger` is installed, an explicit array here also names the generated `filter`/`sort`/`fields`/`include` `ApiQuery` descriptions with the entity's actual allowed fields/relations. `{ exclude: [...] }` and an omitted `filterable`/`sortable`/`selectable` key carry no per-route description at all — resolving either needs ORM metadata, which doesn't exist yet at `@Kavo` decoration time (see [ADR-0012](/internals/adr/0012-decoration-time-route-generation)). `includable`'s omitted case is different: the empty-set default needs no ORM metadata, so an omitted `includable` still gets a description ("No relation is includable on this entity") — only its own `{ exclude: [...] }` form is undescribed, for the same decoration-time reason. The generic `filter`/`sort`/`limit`/`offset`/`fields`/`include` syntax itself isn't repeated on every route — it's exported once as `KAVO_API_GUIDE` from `@kavo/nest`, for splicing into your own `DocumentBuilder().setDescription(...)` (see the reference apps' `main.ts`).

**How to keep a column out of every response.** Name `selectable` and leave the column off it, or exclude it — both forms do the same thing:

```ts
@Kavo(User, {
  allowlists: { selectable: { exclude: ["apiKey"] } },
})
```

`apiKey` is then absent from `findOne`, `findMany`, `restoreOne`, any custom operation's result, and the row echoed back by `createOne`/`updateOne`/`patchOne`; naming it in `fields=` is a 400. Writing the key at all is what turns it on: omit `selectable` entirely and the projection is every column plus every declared computed field, exactly as before ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)).

::: danger `selectable` alone is not a credential control
It closes the **response body**. Three other doors stay open, and a column you actually need to protect has to close all four.

| Door                      | Still open after `selectable`                                                                                                             | Close it with                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `filter[apiKey][like]=a%` | yes — `filterable` defaults to every column, and `LIKE`/`GT`/`LT` binary-search the value in `O(log n)` requests                          | name `filterable` explicitly, without the column                    |
| `sort=apiKey`             | yes — `sortable` defaults to every column, and ordering leaks the column across pages                                                     | name `sortable` explicitly, without the column                      |
| `PATCH {"apiKey":"…"}`    | yes — writable columns are derived separately, and after this change the write is **invisible**, because the response no longer echoes it | register `dto.update` (`patch` falls back to it) without the column |
| response body             | no                                                                                                                                        | `selectable`                                                        |

The filter and sort doors are the same oracle [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union) refuses for cursor sort keys. Narrow all three allowlists together, and add the write DTO.
:::

Two more edges. A registered `dto.item`/`dto.list` with a runtime shape **replaces** the projection rather than intersecting with it, so `selectable` does not fence a column the DTO names — even where the DTO is _wider_. Register the DTO as the narrowing statement when you use one. And an included relation is projected by its **own** target's `selectable`, never the root's, so hiding a column on `User` keeps it hidden wherever `user` is included — provided `User` itself went through `@Kavo`/`createCrud`. A relation target that never did gets a derived config, which configures nothing and serves its full column set.

## computed

Response fields with no backing column, derived from an entity that has already been fetched:

```ts
@Kavo(Book, {
  computed: {
    displayTitle: { resolve: (book) => (book.title === null ? null : `${book.title} (${book.year})`) },
    canEdit: { resolve: (book, context) => book.ownerId === (context.principal as User)?.id },
  },
})
```

`resolve` is `(entity, context: KavoContext) => unknown` — it derives the value, called once per served item, **synchronously** (see the caveats below). `selectable` is a `boolean` (default `true`) controlling whether `fields=` may name the field; `false` makes naming it a 400 — read the note below carefully.

A declared computed field is in the default `item`/`list` projection with no DTO registration, and in the `selectable` allowlist by default. It is **never** filterable, sortable, or writable — naming one in `allowlists.filterable`/`sortable` is both a type error and a bootstrap `ConfigurationException`, and so is naming one in a registered `create`/`update`/`patch` DTO. (A raw body key is still just dropped, like any other unknown key; the DTO case is a declaration, and every other computed misdeclaration fails at bootstrap too. It also has a wire consequence a silent drop cannot reach: `@ApiBody` is built from the DTO's runtime shape, so OpenAPI would advertise a property the engine unconditionally discards.)

`resolve` returning `undefined` omits the key; `null` emits it — the same distinction a column draws.

**`resolve` must be total, not merely pure.** It runs once per served item and nothing catches it, so **one** row whose resolver throws turns the whole collection endpoint into a 500 — not for that row, for every caller, until the row is fixed. Write it against everything the column can actually hold, including `null`: `resolve: (todo) => todo.title?.toLowerCase() ?? null`, never `todo.title.toLowerCase()` on a nullable column. A `POST` that sets `title: null` succeeds (computed fields are stripped from the payload; `title` is an ordinary column), and `GET /todos` is dead from then on. A throwing resolver surfaces as a 500 `KAVO_PERSISTENCE_FAILED` with the cause attached and the message not leaked.

A resolver reading `context.principal`, like `canEdit` above, needs the module's [`principal`](/integrations/nest/configuration/module-setup#the-principal) option set — over HTTP that option is the only thing that fills the field, and without it the caller is `null` on every request, so `canEdit` is uniformly `false` and its inverse uniformly `true`.

Keep it a pure function of the entity as well (plus `context.principal` where a field has to vary by caller). It runs per row, so a resolver that queries the database or calls out over the network reintroduces exactly the N+1 that batched includes exist to avoid. Declaring it `async` is a bootstrap error rather than a slow success: the serializer never awaits, so the promise would be emitted as-is and serialize to `{}`.

**`resolve` receives the full fetched row**, not the projected object — selection is "kept internally, stripped late", so every column is present regardless of `fields=` or the registered `item` DTO. A computed field can therefore surface a value a narrowed DTO or `selectable` list deliberately hides. That is deliberate (`resolve` is server-authored code, the same trust level as `exposeInternals`), but it makes the resolver part of the exposure decision: narrowing the DTO does not narrow what the resolver can see.

**What `selectable: false` does and does not mean.** It removes the name from the allowlist, so `?fields=auditNote` is a 400. It does **not** pin the field into every response: selection narrows the projection uniformly, so any request that sends `fields=` at all still drops it, and the client has no way to ask for it back. Read it as "not individually selectable", not "always present".

The flag and an explicit `allowlists.selectable` list say different things, deliberately. The flag is a default about _nameability_ and leaves the projection alone. An explicit list is a statement about the **response**, so a list that omits the field — or excludes it — drops it from responses too. Where both are present the explicit list wins, as it always has ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)).

On an **included relation target**, `resolve` receives the _root_ request's `KavoContext` — serving `GET /posts/1?include=author` hands an `Author` computed field a context whose `entityName`, `operation`, `config`, `query` and `repository` describe Post. Only `principal`, `correlationId`, `transaction` and `state` mean what they say from a relation target — `principal` being whatever the module's [`principal`](/integrations/nest/configuration/module-setup#the-principal) option extracted for the root request, or `null` when no option is set.

The generated OpenAPI response schema does not mention a computed field when no `item`/`list` DTO is registered, since the schema falls back to the entity class while the runtime response carries the computed key; registering an `item`/`list` DTO naming the field fixes both the document and the static response type.

Let the computed-key type parameter be inferred: pass the config inline to `@Kavo(...)` (or use `satisfies`) rather than pinning an `EntityConfig<Book>` annotation or explicit type arguments on the call — either fixes `Computed` to `never`, which erases `computed`'s value types and leaves `resolve`'s parameter implicitly `any`.

See [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for the reasoning and [DTO system §7](/internals/architecture/04-dto-system) for how it interacts with DTO narrowing and field selection.
