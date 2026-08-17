# ETag overrides and redaction

Details on how `cache.etag` (see [Settings](/guides/configuration/settings#cache)) interacts with `@Override`'d routes and redacted responses. Read [Caching & ETags](/features/caching-and-etags) first for the wire-level behavior; this page covers the configuration edge cases.

## Redact in the DTO, not in an interceptor

Kavo's `KavoResponseInterceptor` is method-scoped, so it runs innermost: it sets the `ETag` before any controller- or app-level interceptor runs. An outer interceptor that strips fields per role would ship a hash of the unredacted representation next to a redacted body. A client's `If-Match` built from that body would then never match.

Shape the response with a per-operation `item` DTO instead. The engine serializes through it before hashing, so the tag matches what the client actually receives.

## What an `@Override` gets for free

An `@Override`'d method gets the `ETag` automatically, but only enforces `If-Match` if it forwards the preconditions itself. The two halves come from different places ([ADR-0027](/internals/adr/0027-an-override-inherits-the-etag-but-not-the-precondition)):

- **The tag is automatic.** An override on a single-item operation can return the typed service's item, for example `this.base.patchOne(id, body, { principal })`, and `@Kavo` hashes it into the same strong `ETag` a generated route would serve. There's nothing to opt into.
- **The precondition is not automatic.** `If-Match` is evaluated inside the engine, against a canonical read. It only runs if the method passes its `preconditions` parameter on, either as `{ preconditions }` on the typed service, or by returning `service.engine.execute({ …, preconditions })`.

Before v0.9, the tag was not automatic either, and the host framework filled in its own weak one instead. If you're on an older version, that's the failure to watch for: reads carried an `ETag`, `If-None-Match` answered `304`, and the tag changed with the body. Everything worked except the `412` that protects data, so a route could look fully conditional while every guarded write was a silent lost update. Assert the tag's shape (`/^"[0-9a-f]{64}"$/`) in your tests, not just its presence.

## The one limit that survives

The engine compares `If-Match` against what `findOne` would serve for that id. An override that serves a reshaped representation hands out a tag the check can never match, so every conditional write on it answers `412`. Serve the canonical shape, or set `cache: { etag: false }` for that operation and own the concurrency control yourself.
