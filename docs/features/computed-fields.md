# Computed fields

How to add response fields that have no backing column.

A response can carry fields that have no database column behind them, like a `fullName` built from two columns, or a formatted total. They are declared once on the entity's config:

```ts
@Kavo(Book, {
  computed: {
    displayTitle: { resolve: (book) => (book.title === null ? null : `${book.title} (${book.year})`) },
  },
})
```

```
GET /books/1     → { "id": 1, "title": "Dune", "year": 1965, "displayTitle": "Dune (1965)" }
GET /books?fields=id,displayTitle
```

From a client's point of view a computed field is an ordinary field: it is in the default response, it can be selected with `fields=`, and it can be narrowed away by an `item`/`list` DTO. Three things it is not:

- **Not filterable or sortable.** `filter[displayTitle][eq]=…` and `sort=displayTitle` are a 400, because there is no column to translate to `WHERE`/`ORDER BY`. Filter and sort on the underlying columns instead (`sort=title`).
- **Not writable.** Sending one in a `POST`/`PUT`/`PATCH` body is silently ignored, like any other non-writable key. A server-side `create`/`update`/`patch` DTO that declares one is a startup error rather than a silent drop.
- **Not database-side.** It is evaluated after the row is fetched, so it costs no extra query but also cannot make one cheaper.

The one thing worth knowing on the server side: `resolve` must handle every value its columns can hold. It runs per served row with nothing catching it, so a single row it cannot handle turns a whole list response into a 500. Write `book.title?.toUpperCase() ?? null`, not `book.title.toUpperCase()`, against a nullable column.

A computed field declared on a related entity shows up when that relation is included (`?include=author`), resolved from the related entity's own config. See [computed](#computed) below for the descriptor's options and [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for why the three limits are permanent rather than pending.

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

`resolve` is `(entity, context: KavoContext) => unknown`. It derives the value, called once per served item, synchronously (see the caveats below). `selectable` is a `boolean` (default `true`) controlling whether `fields=` may name the field; `false` makes naming it a 400, so read the note below carefully.

A declared computed field is in the default `item`/`list` projection with no DTO registration, and in the `selectable` allowlist by default. It is never filterable, sortable, or writable: naming one in `allowlists.filterable`/`sortable` is both a type error and a bootstrap `ConfigurationException`, and so is naming one in a registered `create`/`update`/`patch` DTO. A raw body key is still just dropped, like any other unknown key; the DTO case is a declaration, and every other computed misdeclaration fails at bootstrap too. It also has a wire consequence a silent drop cannot reach: `@ApiBody` is built from the DTO's runtime shape, so OpenAPI would advertise a property the engine unconditionally discards.

`resolve` returning `undefined` omits the key; `null` emits it, the same distinction a column draws.

**`resolve` must be total, not merely pure.** It runs once per served item and nothing catches it, so one row whose resolver throws turns the whole collection endpoint into a 500, not for that row, for every caller, until the row is fixed. Write it against everything the column can actually hold, including `null`: `resolve: (todo) => todo.title?.toLowerCase() ?? null`, never `todo.title.toLowerCase()` on a nullable column. A `POST` that sets `title: null` succeeds (computed fields are stripped from the payload; `title` is an ordinary column), and `GET /todos` is dead from then on. A throwing resolver surfaces as a 500 `KAVO_PERSISTENCE_FAILED` with the cause attached and the message not leaked.

A resolver reading `context.principal`, like `canEdit` above, needs the module's [`principal`](/guides/wiring-your-own-auth) option set. Over HTTP that option is the only thing that fills the field, and without it the caller is `null` on every request, so `canEdit` is uniformly `false` and its inverse uniformly `true`.

Keep it a pure function of the entity as well (plus `context.principal` where a field has to vary by caller). It runs per row, so a resolver that queries the database or calls out over the network reintroduces exactly the N+1 that batched includes exist to avoid. Declaring it `async` is a bootstrap error rather than a slow success: the serializer never awaits, so the promise would be emitted as-is and serialize to `{}`.

**`resolve` receives the full fetched row**, not the projected object. Selection is "kept internally, stripped late", so every column is present regardless of `fields=` or the registered `item` DTO. A computed field can therefore surface a value a narrowed DTO or `selectable` list deliberately hides. That is deliberate (`resolve` is server-authored code, the same trust level as `exposeInternals`), but it makes the resolver part of the exposure decision: narrowing the DTO does not narrow what the resolver can see.

**What `selectable: false` does and does not mean.** It removes the name from the allowlist, so `?fields=auditNote` is a 400. It does not pin the field into every response: selection narrows the projection uniformly, so any request that sends `fields=` at all still drops it, and the client has no way to ask for it back. Read it as "not individually selectable", not "always present".

The flag and an explicit `allowlists.selectable` list say different things, deliberately. The flag is a default about nameability and leaves the projection alone. An explicit list is a statement about the response, so a list that omits the field, or excludes it, drops it from responses too. Where both are present the explicit list wins, as it always has ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)).

On an included relation target, `resolve` receives the root request's `KavoContext`: serving `GET /posts/1?include=author` hands an `Author` computed field a context whose `entityName`, `operation`, `config`, `query`, and `repository` describe Post. Only `principal`, `correlationId`, `transaction`, and `state` mean what they say from a relation target, `principal` being whatever the module's [`principal`](/guides/wiring-your-own-auth) option extracted for the root request, or `null` when no option is set.

The generated OpenAPI response schema lists every declared computed field that survives the resolved `selectable` allowlist, even with no `item`/`list` DTO registered: the synthesized `item`/`list` schema gets a property per computed name, emitted untyped and nullable since a computed descriptor carries no type information. An explicit `allowlists.selectable` that omits or `exclude`s the field, or a `selectable: false` descriptor, drops it from the schema too. Registering an `item`/`list` DTO naming the field is now only about the static response _type_ — the document already reflects the field.

Let the computed-key type parameter be inferred: pass the config inline to `@Kavo(...)` (or use `satisfies`) rather than pinning an `EntityConfig<Book>` annotation or explicit type arguments on the call. Either fixes `Computed` to `never`, which erases `computed`'s value types and leaves `resolve`'s parameter implicitly `any`.

See [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for the reasoning and [DTO system §7](/internals/architecture/04-dto-system) for how it interacts with DTO narrowing and field selection.
