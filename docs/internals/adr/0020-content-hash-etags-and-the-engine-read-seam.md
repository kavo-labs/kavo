# ADR-0020 — ETags are content hashes of the representation, and preconditions are evaluated by the engine through its own reader

**Status:** accepted (issue #120)

## Context

Conditional requests need two things Kavo did not have: a value that
identifies the current state of a resource, and a place to compare an
incoming `If-Match` against it before a write is applied.

For the **value**, the obvious alternative is a version or `updatedAt`
column, declared in config and read from the row. It is stronger — the
adapter could fold it into the `UPDATE ... WHERE version = ?` and get a
real compare-and-swap — but it lands in every ORM adapter at once
(`@kavo/typeorm`, `@kavo/prisma`, `@kavo/mongoose`, `@kavo/mikroorm`),
needs a migration story per adapter, and asks every entity to carry a
column it may not want. A hash of the serialized representation needs
none of that: the representation is already being produced, and hashing
it is pure.

For the **place**, the engine's lifecycle had no read of its own.
`KavoEngineDependencies` carried no adapter and no reader
(`kavo-engine.ts`); the adapter is closed over privately inside
`builtInHandlers`, and `updateOne`/`patchOne`/`deleteOne` each call
straight through to `adapter.update`/`patch`/`delete` with no pre-read at
all. So "compare the target's current ETag" had nowhere to live.
Pushing it down into the handlers does not work either: a handler has
the adapter but not the serializer, and the tag is a hash of the
_serialized_ representation, not of the entity row.

Two further tensions come with the hash approach:

- A hash depends on key order unless something makes it not. A DTO field
  reorder would otherwise silently invalidate every cached copy.
- An ETag identifies a **representation**, not a resource (RFC 9110
  §8.8.3). `GET /users/1?select=name` and `GET /users/1` are different
  representations, so hashing what is actually sent gives them different
  tags — which is correct, and also means the tag from a narrowed read
  cannot be used as an `If-Match` token, because a write has no
  `select` to narrow by.

## Decision

**1. The ETag is a SHA-256 of the canonicalized serialized
representation.** `computeEtag` (`core/src/caching/etag.ts`) canonicalizes
with object keys **sorted** before hashing, so the tag depends on content
and not on the order a DTO projection produced. SHA-256 rather than a
cheap non-cryptographic hash because for `If-Match` a collision is a
silently lost update. Web Crypto and `TextEncoder` are reached through a
typed `globalThis` accessor, the way `randomUuid` already reaches
`crypto.randomUUID` — a `node:crypto` import would violate ADR-0005 and
fail `pnpm depcruise`, not merely bend a convention.

**2. Tags are per representation.** A response's `etag` is the hash of
that response's own serialized item, so `select`/`include` change it.
Collection responses (`findMany`) carry none — a list's identity spans
pagination, sort and filter, which is a different feature.

**3. `KavoEngineDependencies` gains a `reader: EntityReader<Entity>`,**
and the engine — not a handler — evaluates `If-Match`. It performs the
pre-read itself, immediately before handler execution, and hashes the
target row's **canonical read representation**: what `findOne` on that id
with no `select`/`include`/`sort` params would return (the `item` DTO
resolved for `findOne`). That is the representation an `If-Match` token
came from, so it is the one the token is compared against. `createCrud`
already holds the adapter, which is both halves, so the wiring costs
nothing.

The pre-read asks for `withDeleted` on a soft-deletable entity
(`normalizeInput({ withDeleted: true }, config)`). That flag widens the
_filter_ and never touches the projection, so the tag is byte-identical
to the one `GET /books/1` served for a live row and to
`GET /books/1?withDeleted=true` for a soft-deleted one. One pre-read
therefore serves every operation in point 4, including the two that act
on deleted rows.

**4. `If-Match` is evaluated for every standard write that targets one
identified row** — `updateOne`, `patchOne`, `deleteOne`, `restoreOne`,
`purgeOne` — and is never silently discarded anywhere else. The three
other cases:

- **Reads ignore it.** `If-Match` is a lost-update guard and a safe
  method cannot lose an update; `If-None-Match` is the read-side
  conditional (point 5). This is the one place a token is dropped, and it
  is dropped because honoring it could not prevent anything.
- **Unevaluable writes are refused**, with 412
  `KAVO_PRECONDITION_UNSUPPORTED`, not performed. Three ways to get
  there: the operation targets no identified row (`createOne`, and every
  custom operation — nothing in the schema says what one acts on);
  `cache.etag` is off for the operation in force (see point 6); or
  `findOne` is not an enabled operation, so the entity exposes no
  canonical representation to compare against. RFC 9110 §13.1.1 forbids
  performing the method when the condition evaluates false, and a
  condition that cannot be evaluated cannot be shown true — answering
  2xx for a guard that was never applied is precisely the lost update
  this ADR exists to prevent. An earlier revision returned silently here,
  which meant `DELETE /books/1/purge` accepted an `If-Match` and
  hard-deleted anyway.
- **A target with no current representation is left to the handler.**
  The check falls through rather than raising 404 of its own, so the
  operation's own error survives: `NotFoundException` for a row that is
  gone, `AlreadyDeletedException` (409) for a `deleteOne` on a
  soft-deleted row. An error's identity must not change because the
  client sent a cache header.

`If-Match: *` short-circuits ahead of the pre-read. `*` means "only if it
exists", which the comparison answers without looking at any tag, and a
target that does not exist still raises from the handler — so the read,
the serialization and the SHA-256 would all be discarded.

**5. `If-None-Match` is answered for reads only.** A matching tag sets
`KavoResponse.notModified`; `item` stays populated, because a content
hash cannot be known without serializing and so there is no work to skip.
The transport decides what to do with it — `@kavo/nest` answers `304`
with no body. On a write, RFC 9110 gives `If-None-Match` "only if absent"
semantics, which is a conditional-create feature this decision
deliberately leaves out rather than half-implements.

**6. `cache.etag` gates both halves at once, and gates them loudly.**
One key, resolved through the ordinary precedence chain (doc 08): `false`
at any scope computes no tag and ignores `If-None-Match`. `If-Match` is
**refused** rather than ignored, per point 4 — the per-operation scope
makes the asymmetric configuration easy to reach by accident
(`operations: { findOne: { cache: { etag: true } }, updateOne: { cache: { etag: false } } }`
serves tags on `GET` and would otherwise drop the header on `PUT`), and
the client cannot tell the difference from a 2xx.

**7. `If-Match` cannot be enforced for a replaced method.** `@Kavo`
applies the `ConditionalRequest` parameter to `@Override`'d methods as
well as generated ones, so the tokens are handed over — but enforcement
lives in the engine, and a method that does not call the engine cannot
have it applied on its behalf. An override forwards them, either as
`{ preconditions }` on the typed service surface or by returning
`service.engine.execute({ …, preconditions })`, which also restores the
`ETag` header. `KavoResponseInterceptor` is applied to both paths for
that reason; it acts only on an engine envelope, so an override returning
its own value is untouched.

## Consequences

- **This is check-then-write, not compare-and-swap.** Between the
  pre-read and the adapter's write there is a real race window: two
  writers can both pass the check and the second silently wins. It
  narrows the window that a naive last-write-wins API leaves wide open;
  it does not close it. A version column with adapter-level conditional
  writes is the change that would, and it is deliberately out of scope —
  if it ever lands, it supersedes point 1 here, not the reader seam.
- **An `If-Match` token must come from an unnarrowed read.** An ETag
  taken from `GET /users/1?select=name` identifies a different
  representation and will not match the canonical one, so it 412s. This
  is spec-conformant and surprising in equal measure, which is why it is
  documented for adopters and not only here. A **write** response's tag
  is usable as a token for the same reason and with the same limit: it
  is the tag of that response's own body, which matches the canonical
  read only while the two representations agree. They stop agreeing the
  moment a relation is `defaultInclude`d — a write resolves no query, so
  a write response never carries relations while the canonical read
  does. On such an entity only a plain read yields a usable token.
- **`KavoEngineDependencies` gained a required member.** Anything
  constructing a `KavoEngine` by hand must now supply a reader; in-repo
  that is only `createKavo`.
- **`KavoResponse` gained `etag` and `notModified`.** Both are always
  present, so a transport never has to guess whether the engine
  considered caching; code that _constructs_ a `KavoResponse` (a fake
  engine in a test, a custom transport) must supply them.
- The pre-read is one extra `findOneById` per write **that carries a
  non-wildcard `If-Match`**. A request with no precondition pays nothing,
  `If-Match: *` short-circuits ahead of it, and the hash on a response
  costs one SHA-256 over a representation that was going to be
  serialized regardless.
- **A conditional write against an entity with `findOne` disabled is a
  412, not a write.** That configuration is unusual, and the alternative
  — evaluating anyway — would embed the hash of a representation the API
  never serves in the 412's `detail`, which is an offline oracle over a
  low-entropy row. `computeEtag` and `canonicalize` are deliberately not
  on the core barrel for the same reason.
- **The `ETag` is computed inside the engine, before any app-level
  interceptor runs.** An interceptor that rewrites the response body
  downstream of `KavoResponseInterceptor` emits a tag for the
  representation the engine produced, not the one on the wire.
  Field-level shaping belongs in the DTO.

**Amendment (issue #152):** the dependency added in point 3 is now
`repository: RepositoryAdapter<Entity>`, not `reader: EntityReader<Entity>`.
Only the name and the declared type changed. `createCrud` always passed the
whole adapter, and the pre-read described above is unchanged; the engine
also hands that adapter to every handler on the request context (ADR-0025),
which is a use the narrower name no longer described.

**Amendment (issue #186, ADR-0027):** point 7's rule — "it acts only on an
engine envelope, so an override returning its own value is untouched" — no
longer holds, and the consequence bullet excluding `computeEtag` from the
core barrel is withdrawn.

`@Kavo` now promotes an `@Override`'d single-item route's bare return into an
envelope carrying the tag, so the header is set on both paths and
`computeEtag` is exported for it. What point 7 got right and ADR-0027 keeps
is the split: the **precondition** is still only evaluated when the override
forwards it, because that needs a canonical read from inside `execute`.

The barrel exclusion was argued here on two grounds. The consumer ground is
spent — there is one now. The offline-hash-oracle ground does not transfer:
it is about disclosing a tag to a remote client, which is unchanged, not
about whether an in-process package can compute one. `@kavo/nest` could
already read any tag it liked off `KavoResponse`.

What ADR-0027 does not change is the reasoning behind the exclusion's
_other_ half: `canonicalize` stays unexported, and the export promises "the
tag Kavo would set for this representation" rather than the algorithm, so
this ADR's option to supersede the content hash with a version column stays
open.
