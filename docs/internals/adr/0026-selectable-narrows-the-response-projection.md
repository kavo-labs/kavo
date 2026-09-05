# ADR-0026 — `allowed.selectable` narrows the response, not only the request

**Status:** accepted

## Context

`allowed.selectable` gated what a request could **name** in `select=` and
nothing else. What a response actually carried came from somewhere else
entirely: a registered `item`/`list` DTO if there was one, otherwise every
scalar column plus every declared computed field.

So a column left off `selectable`, or explicitly excluded from it, was still
serialized into every response that did not send `select=`.

An application on 0.7.2 found this the way it gets found (#149). A `User`
entity had an `apiKey` credential column, `selectable` was written to omit
it, and `GET /users` returned it to every caller:

| Request                      | Result                         |
| ---------------------------- | ------------------------------ |
| `GET /users`                 | 200, every item has `apiKey`   |
| `GET /users/:id`             | 200, has `apiKey`              |
| `GET /users?select=apiKey`   | 400 `KAVO_QUERY_INVALID_FIELD` |
| `GET /users?select=id,email` | 200, narrowed correctly        |

The narrow path was guarded and the wide path was open. As a confidentiality
control the key was **vacuous**: a client that could not ask for `apiKey`
received it by not asking for anything.

Three things made this worse than an ordinary gap.

**The documentation asserted the opposite**, in three places, and only one
table cell in the allowed reference page had it right:

- `QueryAllowed`'s own doc comment: "what a request may filter, sort, and
  **select** on".
- ADR-0019 §1: "a computed field can surface a column that a narrowed `item`
  DTO **or `selectable` list hides**".
- ADR-0021 §2, arguing why a cursor needs `selectable` as well as `sortable`:
  "excluding `passwordHash` **via `selectable` or an item DTO** while leaving
  `sortable` at its default — **the natural configuration**".

That last one inverts its own outcome. A reader who followed ADR-0021's
advice, and excluded `passwordHash` via `selectable` alone, got the column in
plaintext in the body of every list response. The mitigation for a
binary-search oracle pointed at a configuration that dumped the column
outright.

**The failure was silent and failed open.** No bootstrap warning, no
request-time warning. The 400 reinforced the wrong reading, because it
enumerates the list as though it described what is served:

```
Field 'apiKey' cannot be used for selection. Selectable fields on User:
createdAt, email, id, isMe, name, role, storeId, updatedAt.
```

Every field it named was served. The one it refused to name was served too.

**The only mechanism that did work is easy to get silently wrong.** A
registered DTO projects by the own enumerable properties of `new Dto()`, and
TypeScript erases an uninitialized field, so `id!: string` declares nothing
at runtime and the class falls back to the full entity. That is documented
and deliberate (`docs/internals/architecture/04-dto-system.md`
§4), and it is the same failure direction: the config looks like narrowing,
nothing complains, the response is wide.

## Decision

**1. An explicitly configured `allowed.selectable` narrows the default
response projection.** Both spellings, the plain list and `{ exclude }`. The
entity-derived key set is intersected with it, so a column off the list is
not serialized by `findOne`, `findMany`, `createOne`, `updateOne` or
`patchOne`.

This is the resolution that makes the name, the doc comment, ADR-0019 §1 and
ADR-0021 §2 all true as written, rather than correcting four passages to
match a behavior nobody wants. It turns one config key into the one-line
answer to "keep this column out of every response", which is a question
every adopter with a credential column has.

**2. Explicit configuration is the trigger, and the provenance is
load-bearing.** `ResolvedEntityConfig` carries a `projection` that is `null`
unless `allowed.selectable` was written. It is not read back off
`allowed.selectable`, because unconfigured that list resolves to a base
set which is _almost_ the derived projection and not quite: it drops computed
fields declaring `selectable: false`, whose documented contract is to stay in
the projection while being unnameable in `select=`. Narrowing by a list
nobody wrote would silently retire that contract, and would break apps that
never configured the key — the one group this change must not touch.

The same reasoning applies one level down, and the first cut of this change
got it wrong. The two spellings resolve against **different bases**: a plain
array is the author's own list and is used verbatim, while `{ exclude }`
resolves against the _readable projection_ — every column plus **every**
declared computed field — not against the selectable base. Resolving
`{ exclude }` against the narrower base meant `{ exclude: ["email"] }`
silently deleted an unrelated `selectable: false` audit field from every
response, which is "narrowing by a list nobody wrote" wearing a different
hat.

The flag and the explicit list therefore now say different things, which is
the point of having both. `selectable: false` is a default about
_nameability_. An explicit list is a statement about the _response_.

**3. A registered `item`/`list` DTO wins outright; the two are not
intersected.** Both narrow, and the DTO is the more specific statement.
Intersecting would mean a DTO that deliberately exposes a field silently
failed to, which is the exact failure this ADR exists to remove.

**4. A relation is projected by its own target's `selectable`, never the
root's.** An include never widens what its target exposes, and that has to
hold for the projection allowlist as it already does for the DTO. Without
it, hiding a credential on `User` would leak it again the moment any other
entity included `user`.

**5. The `select=` 400 message is left alone.** It enumerates the selectable
list as though that described what is served, and after decision 1 that is
accurate in the case the message actually fires in: an explicitly configured
list with no runtime-shaped `item` DTO. It stays inaccurate in two others —
where a DTO wins (decision 3), and where the list is unconfigured and omits
`selectable: false` computed fields that _are_ served. Rewording it to cover
those would make it longer and less useful in the case it is for.

**6. What this does not close.** `selectable` bounds the **response body**,
and a column worth hiding has three other doors, none of which this decision
touches:

| Door                      | Why it stays open                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filter[apiKey][like]=a%` | `filterable` defaults to every column, independently. `LIKE`/`GT`/`LT` binary-search a value in `O(log n)` requests — the same oracle ADR-0021 §2 refuses for cursor sort keys |
| `sort=apiKey`             | `sortable` defaults the same way; ordering leaks the column across pages                                                                                                       |
| `PATCH {"apiKey":"…"}`    | the writable projection is derived separately, and this change makes the write **invisible** by removing the echo                                                              |

They are left open because closing them from `selectable` would mean one key
silently rewriting three others, which is the opposite of the explicitness
this ADR is built on. What changes is the documentation: the adopter-facing
answer to "keep this column out of every response" is now stated as all four
doors, not one. Calling `selectable` "the one-line answer to keeping a
credential out of a response" — as an earlier draft of this ADR did — was
the same overstatement that produced #149 in the first place.

## Consequences

**This is a breaking change**, and it is scoped to configurations that asked
for it: an entity that configured `selectable` narrower than its columns
_and_ depends on the omitted columns still being served. That combination is
far more likely to be an unnoticed leak than an intended contract, which is
why it lands as a behavior change rather than a new opt-in key. Pre-1.0, and
in a minor bump with a changelog note.

**The empty-DTO bootstrap check was proposed and rejected.** #149 asked for a
`ConfigurationException` when a registered `item`/`list` DTO has an empty
runtime key set, on the same fail-open reasoning. It cannot ship: a
declared-only DTO is a **supported, tested path** in `@kavo/nest`, which
hands the class to Swagger so its own `@ApiProperty` decorators answer
instead of publishing an empty inline schema
(`packages/frameworks/nest/tests/binding.e2e.spec.ts`). Rejecting the shape
in core would break the idiomatic NestJS DTO, which does not initialize its
fields. The trap is real and stays documented in doc 04 §4; what changes is
that it is no longer the _only_ way to keep a column out of a response, so an
adopter reaching for a credential control is now pointed at `selectable`,
which fails loudly on a misspelling and narrows for real.

**`ResolvedEntityConfig` gains a required member.** It is barrel-exported, so
anyone hand-constructing one — through a cast, which is how the in-repo tests
do it — now has an incomplete object with no compile error. ADR-0019 recorded
the same break for `computed`; this is its sibling.

**An `If-Match` guard is exactly as wide as the projection.** `canonicalEtag`
hashes the _served_ representation, so a concurrent change confined to a
column off `selectable` no longer changes the tag and no longer trips a 412.
That was already true for a registered `item` DTO; this extends it to a
config key adopters are steered toward. The confidentiality win and the
integrity loss are the same mechanism, and ADR-0020 should be read alongside
this.

**Decision 4 holds only for registered entities.** A relation target that
never went through `createCrud`/`@Kavo` gets a config derived from metadata
alone, which configures nothing — so its full column set is served through
an `include`, however the root is narrowed.

**`{ exclude }` still fails open on a name that matches nothing.**
`resolveFieldSelector` does no existence check, so `{ exclude: ["apikey"] }`
excludes nothing and serves the column. `FieldPath` catches this at compile
time for a properly typed entity and degrades to bare `string` for
`any`/index-signature ones, and is defeated by a cast. The plain-list
spelling fails closed (the field vanishes); the exclude spelling does not.
A bootstrap existence check is the obvious follow-up and is deliberately not
bundled here.

**Adopters get a shorter answer, not a one-line one.** "Keep a column out of
every response" was previously answerable only by "register an `item` DTO,
and remember to initialize every field, and remember to name every computed
field you still want". The response half is now one key; the filter, sort and
write halves are still three more, and decision 6 is where that is stated
rather than glossed.

**`select=` still narrows further and never wider**, unchanged: selection is
applied after the projection resolves, so it can only subset what
`selectable` already allows.

## References

- #149, and the application that found it.
- ADR-0019 (computed fields are serializer-evaluated), whose §1 claim this
  makes true.
- ADR-0021 §2 (cursor sort keys must be on `selectable`), whose security
  argument depended on this being true.
- `docs/internals/architecture/04-dto-system.md` §4, on DTO
  runtime shapes.
