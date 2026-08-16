# Caching & ETags

Every single-item response, `POST /books`, `GET /books/1`, `PUT`, `PATCH`, and `PATCH /books/1/restore`, carries a strong `ETag`:

```http
ETag: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

It is a hash of the exact representation being returned, so it changes whenever any field in the response does. List responses (`GET /books`) do not carry one.

## `If-None-Match`: skip a body you already have

```http
GET /books/1
If-None-Match: "9f86d0…"
```

If your copy is still current you get `304 Not Modified` with an empty body and the same `ETag`. If it isn't, you get the ordinary `200` and a fresh tag. `*` matches any existing representation.

## `If-Match`: don't overwrite a version you never saw

```http
PATCH /books/1
If-Match: "9f86d0…"
```

Supported on every route that targets one book: `PUT /books/1`, `PATCH /books/1`, `DELETE /books/1`, and the soft-delete routes `PATCH /books/1/restore` and `DELETE /books/1/purge`.

If the book's current tag is one you named, the write goes ahead and the response carries the new tag. If it isn't, because somebody else changed the book since you read it, the write is refused with `412 Precondition Failed` and a `KAVO_PRECONDITION_FAILED` problem document naming the current tag. Nothing is written. `*` matches any existing representation, so `If-Match: *` means "only if it still exists".

For restore and purge, the tag to send is the one from `GET /books/1?withDeleted=true`. A soft-deleted book is what those routes act on, and an ordinary `GET /books/1` will not show it to you.

If the book doesn't exist at all, or is in a state the route refuses, you get that route's own error rather than a `412`: `404` for a book that isn't there, `409 KAVO_ALREADY_DELETED` for `DELETE` on one that is already soft-deleted. Sending a conditional header never changes which error you get, only whether the write happens.

## `If-Match` where Kavo can't check it

Kavo refuses rather than quietly proceeds. A `412 KAVO_PRECONDITION_UNSUPPORTED` means the header was understood and the write did **not** happen, but the guard could not be evaluated at all, so retrying it unchanged will not help. Three ways to see it:

- **On a route that doesn't target one row.** `POST /books`, and any custom operation you add. Kavo knows what row `PATCH /books/1` is about; it cannot know what a custom `POST /books/1/publish` is about.
- **When [`caching.etag`](/guides/configuration/settings#caching) is off** for that route, at any scope. No tags are issued, so there is nothing to compare, and answering `200` would tell you a guard was applied when none was.
- **When `findOne` is disabled** on the entity. The check compares against the representation `GET /books/1` would return; with no such route there is none.

`If-Match` on a `GET` is the one case Kavo ignores instead of refusing: a read cannot overwrite anything, and `If-None-Match` above is the read-side conditional.

**A hand-written or `@Override`'d route enforces nothing by itself.** The check runs inside Kavo's engine, so a controller method you wrote replaces it. It receives the `If-Match` tokens as its last parameter and must pass them on (`this.base.updateOne(id, data, { preconditions })`) for the guard to apply.

The `ETag` is the exception: an `@Override` on a single-item operation gets it without asking, because `@Kavo` hashes whatever the method returns. A plain hand-written route (no `@Override`) is outside that and carries no Kavo tag at all. See [`caching`](/guides/configuration/settings#caching).

## Two things to know

**The `If-Match` check is not atomic.** Kavo reads the row, compares the tag, and then writes. There is a real window between the check and the write in which another writer can slip in, so this narrows the last-write-wins race, it does not eliminate it. It is not a database-level compare-and-swap, and Kavo does not claim to be one. If you need that guarantee, enforce it in your own transaction.

**An `If-Match` token has to come from an unnarrowed read.** An ETag identifies one representation, so `GET /books/1?fields=title` produces a different tag from `GET /books/1`. Preconditions are evaluated against the full default representation, so a tag taken from a `fields=`- or `include=`-narrowed read will 412. Use the tag from a plain `GET /books/1`.

The tag on a write response works too; it is the tag of the body you just got back. But that's only true while that body is the same representation a plain `GET` returns, which stops being true once a relation is configured `defaultInclude`: a write resolves no query, so write responses never carry relations. On such an entity, take the token from a `GET`.

Both halves are one setting, [`caching.etag`](/guides/configuration/settings#caching) (on by default). Turning it off at any scope stops the tags being generated and stops the conditional headers being honored.
