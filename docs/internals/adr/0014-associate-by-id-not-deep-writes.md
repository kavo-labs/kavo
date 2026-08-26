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

Relations join the derived write shape by default, so association works
with zero config. An entity with a registered `create`/`update` DTO opts
in by declaring the property (`owner: number | null = null`), which also
documents it in Swagger.

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
