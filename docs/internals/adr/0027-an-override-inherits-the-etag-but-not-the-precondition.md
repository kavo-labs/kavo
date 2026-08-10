# ADR-0027 — An `@Override` inherits the `ETag`, but not the precondition

**Status:** accepted

## Context

`KavoResponseInterceptor` turns the engine's `KavoResponse` into an HTTP
response: it sets `ETag` from the envelope, answers a not-modified read with
a bodyless `304`, and unwraps the rest. `@Kavo` applies it to every method it
routes, generated and `@Override`'d alike, and it acts only on an envelope
(`isKavoResponse`), so an override returning its own value is left alone.

That guard was meant to be permissive. In practice it was the bug, because
the natural way to write an override is to delegate to the typed service:

```ts
@Override()
async patchOne(id: EntityId, body: Partial<Todo>, _p: RequestPreconditions | null, request: Request) {
  const principal = boundKavoPrincipal(this, request);
  return this.base.patchOne(id, body, { principal });
}
```

`DefaultKavoService` is `execute` plus an unwrap. The unwrap discards the
envelope — that is its entire purpose — so the override returns a bare item,
the interceptor sees no envelope, and the route sets no `ETag`.

**The host framework then fills one in, and that is what made this
dangerous.** Express's default weak tag is convincing:

- reads carry an `ETag` header;
- `If-None-Match` on an unchanged row answers `304`;
- the tag changes when the representation changes.

Three of the four observable behaviours are right. The missing one is the
`412`, and it is the only one that protects data. An application checking
"do conditional requests work?" by hand sees ETags and 304s and concludes
yes, while every `If-Match` write is a silent lost update.

An application on 0.8.0 found it (#186) with all six of an entity's routes
overridden — which is not exotic: overriding is the documented answer to
row scoping having no seam (#138). Taking the recommended workaround for one
gap silently disabled a shipped feature across every entity, with no type
error, no bootstrap error, and no log line.

It also found the trap in the obvious repair. Forwarding `preconditions`
from the override makes it **worse**: the engine then evaluates `If-Match`
against its content hash while the client is holding Express's weak tag, so
every conditional write answers `412`. Silently-ignored becomes
permanently-refused.

## Decision

**1. `@Kavo` promotes an override's bare return to an envelope, so the route
carries Kavo's `ETag`.** The wrapper runs on the controller instance, which
is the one place that can see both the operation's resolved settings and the
value actually being served. It is a no-op when the override already returns
an engine envelope, when the operation's cardinality is `many` (a collection
has no tag, ADR-0020), when the result is `null`/`undefined` (a void
operation), when the controller is unbound, and when
`caching.etag` is off for that operation.

`computeEtag` is exported from `@kavo/core` for it. The barrel note held it
back while nothing in the workspace needed it; this is the consumer ADR-0010
asks for. What the export promises is "the tag Kavo would set for this
representation", not the algorithm, so ADR-0020's option to supersede the
content hash with a version column stays open.

**2. `If-Match` stays the override's to forward, and is documented as
such.** Evaluating it is engine work: it needs a canonical read of the row
before the write, which is inside `execute`, past the point the override
replaced. A wrapper cannot do it after the fact, and doing it before would
mean a second read on every conditional request whether or not the override
delegates.

What changes is that **forwarding now works**. The client holds Kavo's tag
rather than the host framework's, so the strong comparison can succeed. The
dead end #186 hit was a consequence of decision 1 being missing, not an
independent defect.

**3. A bootstrap refusal was considered and rejected.** #186 offered it as
the cheap option, and it is: refuse when `caching.etag` is on for an
operation whose route is overridden. But `caching.etag` defaults to `true`
and overriding is the documented workaround for #138, so the check would
fire on essentially every multi-tenant application and force a config change
to keep starting — including on overrides that already return the envelope
and were always correct. A rule that cannot tell a correct program from an
incorrect one is not a guard.

**4. What an override inherits is stated in one table**, on `@Override`
itself, because "it keeps the route wiring and loses the engine behavior"
is the distinction nobody derives unprompted.

## Consequences

**An `@Override`'d single-item route now sets an `ETag` where it previously
set none**, or where the host framework's weak tag stood in. Conditional
reads against those routes start answering with a strong tag; a client that
cached the framework's weak tag revalidates once and gets a `200`.

**A reshaping override still cannot use `If-Match`.** The tag on the way out
describes what the override served; the check on the way in compares against
what `findOne` would serve. If those differ, every conditional write is a
`412`. That is the honest outcome — a precondition on a representation the
engine cannot reconstruct is not a precondition — and it is documented on
`@Override` with the two ways out: serve the canonical shape, or turn
`caching.etag` off for the operation and own the concurrency control.

**One existing test changed.** `caching.e2e.spec.ts` asserted that an
override dropping its `preconditions` parameter served no `ETag`. That was
true of the framework and false of the wire, since the suite turns Express's
own tag off; with it on, the route served a weak tag and looked protected.
The test now asserts Kavo's tag shape, and a new one runs with Express's tag
enabled — the configuration #186 actually hit, and the one the rest of the
file could not see.

**"An ETag exists" is not a test.** #186 was caught only because the
assertion was written against Kavo's documented tag shape
(`/^"[0-9a-f]{64}"$/`) rather than against the header's presence. The tests
added here keep that standard.

## References

- #186, and the application that found it.
- ADR-0020 (content-hash ETags and `If-Match`), whose guarantees this
  restores on overridden routes.
- #138, on why so many routes are overridden in the first place.
- ADR-0012 (routes are generated at decoration time), which is why the
  wrapper is applied by `@Kavo` rather than resolved per request.
