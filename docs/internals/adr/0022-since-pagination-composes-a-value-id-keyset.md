# ADR-0022 — `since` pagination composes a `value|id` keyset, forced sort, plain token

**Status:** accepted

## Context

ADR-0021 added `cursor` pagination for page-by-page traversal of a bounded
result set. A different, common client shape is polling/sync: "give me
everything that changed since timestamp T" — typically unbounded, with a
plain, human-readable boundary instead of an opaque token, and no
expectation that the client ever chooses its own sort. This is a distinct
`PaginationStrategy` (`"since"`), not a variant of `cursor` from the wire's
point of view, but the issue that proposed it (#130) explicitly asked to
reuse #129/ADR-0021's keyset machinery — `readFilter`, the built-in
`findMany` handler's `limit + 1` over-fetch, `CursorPagination.keyset`'s
shape, `keysetExpression` — rather than have adapters implement anything
new.

**A single-scalar wire token looks like the natural design, and is wrong.**
The first design tried was `?since=<value>` alone: `resolveSince` decoded
one value and built `sinceField >= value` directly, with `idField` sitting
in the forced sort only to make ordering deterministic. This is inclusive
(`>=`) rather than cursor's strict `>`, deliberately: a strict bound would
silently drop rows sharing the boundary's exact value but cut off by
`limit` — data loss. But inclusive-with-no-tiebreaker has a fatal
consequence: once a group of rows sharing one `since.field` value exceeds
`limit`, every poll re-fetches the _same_ leading slice of that group
forever. Three rows tied at `T`, `limit: 2`: poll 1 returns rows 1–2,
`nextSince = T`; poll 2 asks `since.field >= T` again, gets rows 1–2 again
(same `ORDER BY since.field, id` — nothing changed on either side); row 3
is **never delivered**, and the poll **never advances**. This is not a rare
edge case — it triggers under the documented default (`since.field:
"updatedAt"`, `defaultLimit: 20`) after any bulk update that stamps
several rows with an identical timestamp, which coarse-precision timestamp
columns do routinely.

The fix is to give the wire token what a row-wise comparison actually
needs: an id to break the tie with, exactly what cursor's token already
carries per sort key. But a since token is not free to carry an arbitrary
tuple the way a cursor's opaque payload can — issue #130's own criteria
asked for a **plain, human-readable** value, not a JSON+base64 blob, so
the fix has to add exactly one thing (an id) without becoming opaque.

## Decision

**1. `SincePagination` is a third `Pagination` union member, discriminated
structurally, mirroring `CursorPagination`:**

```ts
interface SincePagination<Entity = unknown> {
  readonly limit: number;
  readonly since: string | null; // raw wire value, undecoded; null = first poll
  readonly keyset: FilterExpression<Entity> | null; // filled by QueryNormalizer
}
```

`isSincePagination` narrows on `"since" in pagination`, the same pattern
`isCursorPagination` uses. Because `CursorPagination` and `SincePagination`
are the _only_ two variants that carry a `keyset` field, a third guard,
`hasKeyset`, narrows to either without caring which — `readFilter`, the
built-in `findMany` handler's over-fetch decision, and the envelope's
`offset: 0` case all use `hasKeyset` instead of `isCursorPagination(p) ||
isSincePagination(p)`, so a future third keyset strategy needs no
additional arm at those call sites. `nextCursor`/`nextSince` computation is
_not_ shared this way — `KavoEngine.listMeta` still branches on
`isSincePagination` there, because the two payloads are genuinely
different work, not the same work under two names.

**2. The wire token is `"<since.field value>|<id>"` — plain text, not
opaque, but compound.** `?since=2024-03-01T10:00:00.000Z|42`. It is still
entirely readable and constructible by hand (an adopter can build one from
a row they already have), which is what "not opaque" actually asked for;
what it gives up is only the pretense that the boundary needs no id at
all. `QueryNormalizer.resolveSince` splits on the _last_ `|` (a `date` or
UUID-style `string` value never contains one), decodes each half with the
ordinary wire-value coercion (`coerceScalar` — the same one `filter[…]`
values use), and composes them with the **existing**
`keysetExpression(forcedSort, [value, id])` — the identical row-wise
`(a > va) OR (a = va AND id > vid)` comparison cursor pagination already
builds. No new predicate-building code exists in `since.ts`; the only new
code is the split/decode.

**3. The sort is forced, not merely constrained.**
`QueryNormalizer.resolveSince` sets the effective sort to
`[pagination.since.field, idField]` ascending unconditionally, from config
alone, and **rejects** a client-supplied `sort` outright
(`KAVO_QUERY_CONFLICTING_PARAMS`) rather than silently overriding it — the
same treatment ADR-0021 gives a stray `cursor=`/`since=` under the wrong
strategy: silently dropping it would leave a client believing its `sort`
took effect when it didn't. A configured `query.defaultSort`, by contrast,
is silently overridden — being overridden by a more specific setting is
what a default is for.

**4. `since` pagination is exactly-once within a poll session, the same
guarantee cursor pagination has** — a direct consequence of §2: the id
half breaks every tie, so no group of rows sharing one `since.field` value
can ever stall a poll or be repeated. This is the property the
single-scalar design (§ Context) could not deliver. `since`'s remaining
differences from `cursor` are only:

- the token is plain text, not opaque (§2);
- `meta.nextSince` advances from the last returned row **regardless of
  `hasMore`**, not only on a full page — a poll has no "last page" to wait
  for, so `KavoEngine.sinceListMeta` reads
  `result.entities[result.entities.length - 1]` unconditionally. A client
  polling for 30 rows with `limit: 100` that gets 12 back must still
  advance past those 12 next time, not re-fetch them because the page
  wasn't full;
- on a **genuinely empty** page — no rows at or after the boundary at all,
  which with the id tiebreaker now really does mean "caught up," not "tie
  exceeded `limit`" — the response echoes the request's own `since` back
  rather than inventing an end-of-results `null`. There is no "last page"
  to signal the end of, and a caught-up client needs a value to poll with
  next, not nothing. That echo is genuinely `null` on a _first_ poll
  (`since` absent) against zero matching rows — there is no prior boundary
  to echo — so `nextSince` is falsy exactly there, and nowhere else.

**Deliberately not ported: cursor's "did not advance" `ConfigurationException`.**
With the id half now breaking every tie, an unchanged `nextSince` across
polls is no longer an ambiguous signal (the case that check existed to
distinguish from a misbehaving adapter) — it genuinely means nothing new
has arrived. Treating it as an error would be wrong, not merely
unnecessary.

**5. Column values are read and encoded by `sinceValueOf`**
(`packages/core/src/query/since.ts`), the since-pagination mirror of
`cursorValuesOf`: it stringifies both `since.field` and `idField` off the
raw row (`.toISOString()` for a `Date`, `String(value)` otherwise) and
raises `ConfigurationException` for a `bigint`/`Decimal`-shaped runtime
value — the identical limitation ADR-0021 documents for cursor's `idField`
tiebreaker, inherited here because `since` now reuses the same comparison
`idField` participates in. `meta` never passes through the serializer, so
leaving a `Date` un-stringified would reach a REST client as JSON's ISO
spelling while a programmatic caller held a live `Date` object feeding
back into a `string`-typed `since` param — the same REST/programmatic
divergence ADR-0021 already closes for `nextCursor`.

**A `null` column value is encoded, not refused, and rejected on replay
instead** — the same half-guard ADR-0021 §4 documents for a null cursor
sort key. `sinceValueOf` writes the literal text `"null"` for a `null`/
`undefined` value (the same spelling `coerceScalar` already reads back);
`resolveSince` then rejects a decoded `null` with `KAVO_QUERY_INVALID_VALUE`
naming the column, exactly mirroring `decodeCursor`'s treatment. A
nullable `since.field` is not rejected at bootstrap, for the same reason
ADR-0021 §4 gives for cursor: an ORM's `nullable` flag is not always a
trustworthy signal (Mongoose reports every non-`required` path that way),
so gating on it would make the feature unusable on one adapter rather than
safe on four.

**6. `since.field`'s kind is restricted to `date` or `string`, and its
existence, kind, and allowlist membership are bootstrap-checked, not
request-checked.** Unlike cursor's effective sort (client-chosen,
therefore validated per request in `resolveKeyset`), `since`'s forced sort
is entirely config-known before any request arrives — the same reason
`resolveSoftDelete` validates its marker field at bootstrap rather than on
first use. `resolveEntityConfig` (`validateSincePagination`) raises
`ConfigurationException` when `pagination.strategy` is literally `"since"`
and the configured `since.field` is missing, wrong-kind, or excluded from
`filterable`/`selectable` — the same two extra allowlists cursor's sort
keys are held to and for the same reasons. `idField` is checked the same
way, since it now participates in the actual comparison rather than only
the sort. This check is name-gated on the literal string `"since"`, not
structural — bootstrap has no strategy instance to probe (`QueryNormalizer`'s
`extraStrategies` are supplied later), unlike the request-time structural
checks elsewhere in this ADR and ADR-0021.

`number` is deliberately excluded as a `since.field` kind: an
auto-increment id has no meaningful "point in time" semantics `since`
polling implies, even though it happens to be totally ordered. A `string`
column (a UUIDv7-style id, lexicographically time-ordered) is explicitly
supported for entities with no separate timestamp column at all.

**7. The default `since.field` is `"updatedAt"`, a documented convention,
not a detected column.** Unlike soft delete's marker field (which
`EntityMetadata.softDeleteField` can detect from ORM-level declarations
like `@DeleteDateColumn`), core has no equivalent metadata concept for "the
column that changes on every write." `"updatedAt"` is the default an
adopter following the common convention gets for free;
`pagination.since.field` overrides it, and a `"since"`-strategy entity with
neither an `updatedAt` column nor an override fails at bootstrap (§6)
rather than silently defaulting to something else.

**8. `@kavo/graphql` and `@kavo/mcp` refuse a `since`-configured entity at
bootstrap, extending ADR-0021 §7's identical refusal for `cursor`.** Both
bindings' list surfaces take `limit`/`offset` only, `offset` is meaningless
under a keyset strategy, and `meta` — where `nextCursor`/`nextSince` live —
is not part of either binding's list shape. The same
`requireOffsetPageable` check in each package (duplicated, per ADR-0002 —
`protocols/*` packages may not import each other) now name-checks both
`"cursor"` and `"since"`.

## Consequences

- **A `since` boundary is not portable across `since.field` changes**,
  exactly as a cursor is not portable across `sort` changes: changing the
  configured field mid-poll makes an in-flight `since` value compare
  against a different column.
- **`pagination.since.field` is one more bootstrap-checked config key**,
  following `delete.field`'s precedent rather than inventing a new
  validation home.
- **The token is one `|`-join heavier than the issue's literal
  `?since=<value>` framing implied**, but still plain text an adopter can
  construct or inspect by hand — the property the issue's "not opaque, no
  encoding needed" requirement actually asked for.
