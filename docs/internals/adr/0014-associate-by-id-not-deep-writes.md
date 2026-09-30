# ADR-0014 — Write-side relations: associate by id, no deep nested writes

**Status:** accepted

## Context

Once responses can embed relations (`include=owner`), the symmetric
request is obvious: if a read returns a nested object, why can't a write
send one? The two are not symmetric, though. A deep nested write —
`POST /cats {"name":"Kit","owner":{"name":"Rae","email":"…"}}` — has to
decide, for every node in the payload: create or update? match on what?
what happens to children that are absent, is that "leave alone" or
"delete"? which failures roll back which parts? Every one of those is a
policy decision the framework would be inventing on the caller's behalf,
and getting any of them wrong corrupts data rather than returning a 400.

## Decision

v6 supports **association by id** and nothing deeper. On `create`,
`update`, and `patch`, a single-key relation property accepts:

- a reference object — `{"owner": {"id": 7}}`;
- an array of them for a to-many — `{"tags": [{"id": 1}, {"id": 2}]}`;
- `null` to disassociate.

A bare scalar (`{"owner": 7}`) is **rejected**, not accepted as shorthand
(`AssociationInvalidShapeException`, `KAVO_ASSOCIATION_INVALID_SHAPE`, 400).
Earlier v6 releases treated a bare scalar as equivalent to `{"id": 7}`, but
that shorthand left the caller's intent ambiguous — is the scalar the
related row's id, or a mistyped value meant for some other field of the
same name? — and, resolved wrong, surfaced as an opaque FK-constraint
failure from the database instead of a 400 naming the actual problem
(issue #291). A composite-key target (ADR-0039) is unaffected: it has no
single column a bare scalar could be mistaken for, so its own `~`-delimited
scalar shorthand (`{"owner": "u1~billing"}`) remains supported.

The default deserializer normalizes a reference object to `{ id }` and
**narrows anything else away**: `{"owner": {"id": 7, "name": "Rae"}}`
writes the association and drops `name`. A nested object is never a
cascade; the framework does not partially honor a deep write.

**Amendment (issue #493):** a single reference must actually name the id.
A reference object with no id (`{"owner": {"create": {…}}}`,
`{"owner": {"email": "…"}}`) used to narrow to `null`, which an update
reads as "clear the association", so a malformed or smuggled nested write
silently unlinked the row. It is now a 400 `KAVO_ASSOCIATION_INVALID_SHAPE`,
as is an id that is not a string or number (`{"owner": {"id": {"gt": 0}}}`).
`null` remains the one way to clear a to-one association. Array elements
keep the narrowing described above.

To-one relations join the derived write shape by default, so association
works with zero config. An entity with a registered `create`/`update` DTO
opts in by declaring the property (`owner: number | null = null`), which
also documents it in Swagger. Without a write DTO, the synthesized fallback
body schema documents the relation too — as a `{ id }` reference object, an
array of them for an opted-in to-many — from `metadata.relations` (see
`docs/internals/architecture/10-nestjs-integration.md`, issue #339).

**Amendment (GHSA-p8cm-xwp6-gvrc): to-many association is opt-in.** A
to-many relation is no longer part of the derived write shape. Associating
one rewrites the foreign keys of _other_ rows, and the policy stage
(ADR-0037) only ever judges the row being written, so a default that
accepted it let a write to one row move related rows whose own policy
never ran. A to-many joins the write shape only when the entity chooses
it, in either of two ways:

- a write schema that names it (`schema.input` as a class, a validator's
  registered class, or the `{ fields }` shorthand), which every adapter
  supports; or
- `relations.<name>.write`, the array-mutation opt-in (ADR-0029), on an
  adapter that implements it.

Either way the app has accepted that surface and owns its authorization,
for example with a `when()` policy that reads the body. To-one association
is unchanged: its foreign key sits on the row being written, which that
row's own policy already covers.

Deep nested writes are **out of scope**, not merely unimplemented.

## Consequences

- The write surface stays predictable: one request writes one row plus
  its foreign keys. Failure modes are the ones CRUD already has.
- Multi-entity writes are expressed where their policy is visible — a
  hand-written controller method (an `@Override`'d standard operation, or
  a fully custom route per issue #26) that spells out the order, the
  matching rule, and the failure behavior for that specific case.
- ORM caveat, deliberately not papered over: setting a _to-many_ by id
  only persists where the ORM supports it from the non-owning side
  (TypeORM needs `cascade` or the owning side / a join table). Kavo maps
  the payload; it does not synthesize writes the ORM declined to make.
- The extension point, if a later version wants deep writes: they belong
  at the deserializer seam plus an explicit per-relation `write` policy
  on the relation descriptor — additive, and it would arrive with the
  matching/orphan rules stated rather than assumed.
