# ADR-0032 — Kavo reverses its no-policy-layer non-goal and adopts a policy stage

**Status:** superseded by [ADR-0037](/internals/adr/0037-policy-collapses-to-a-single-predicate) —
the `PolicyNode` DSL this ADR introduced (node constructors, `and`/`or`/`not`
composition, `policyNeedsEntity`-driven pre-fetch) is gone; `policy` is now a
single plain function, still resolved at the three scopes ADR-0036 added.
Kept for history. (While it stood, this ADR was amended by
[ADR-0033](/internals/adr/0033-policy-moves-to-operation-scope-only) —
`operations.<id>.policy` as the only configuration surface — by
[ADR-0034](/internals/adr/0034-when-predicate-takes-a-single-object-argument) —
`when(predicate)`'s single object argument — and by
[ADR-0036](/internals/adr/0036-policy-gains-entity-and-global-defaults) —
entity- and global-scope defaults. All three are superseded by ADR-0037 too.)

## Context

`docs/internals/architecture/01-system-architecture.md` named "a policy/
authorization layer — `principal` is carried, never judged" a deliberate v6
non-goal (§8), and repeated it at §2 and §7. `KavoContext.principal` is
`unknown`, and its own doc comment says Kavo "never inspects, validates or
caches the value." Two issues sit adjacent to this decision without crossing
it: #138 (a row-scoping predicate seam, explicitly excluding "role and
permission modeling, policy evaluation, and anything resembling CASL or
Casbin") and #182 (401/403 vocabulary for a custom operation's own handler,
explicitly "not asking for an authorization system"). Issue #234 asked
whether Kavo should cross that line and ship an actual authorization DSL:
per-operation rules a `@Kavo` config declares, evaluated against
`context.principal` and (where relevant) the loaded row, before a request
reaches its handler.

This ADR decides that question and settles the design questions #234 raised
independently of #138/#182 — a policy stage is unrelated machinery from
either, not something that waits on them.

## Decision

**Kavo adds a `policy` config surface and an engine-level policy stage.**
`principal` is still never _shaped_ by Kavo on its own — an application
opts a node into a shape by using it — but a request can now be refused
before it reaches a handler.

### The node types

A policy value is a `PolicyNode<Entity>` — a plain, mostly-inspectable
decision tree, not a bare closure:

- `permission(name)` — `principal.permissions.includes(name)`.
- `role(name)` — `principal.roles.includes(name)`.
- `owner(field = 'userId')` — `entity[field] === principal.userId`, dotted
  paths supported for nested/embedded values (`owner('address.city')`).
  A dotted path whose **first** segment names a relation is a bootstrap
  `ConfigurationException`, not a runtime always-deny: the pre-fetch that
  loads the row for `owner`/`when` (Enforcement point, below) loads no
  relations, so `owner('author.id')` on a relation named `author` could
  never pass. Checking a value across a relation needs `when()`, which
  receives `context` and can load the relation itself.
- `authenticated()` — `principal.userId != null`.
- `when(predicate)` — an arbitrary `(args) => boolean | Promise<boolean>`
  escape hatch, `args` a single object (`{ context, entity, resource,
operation, params }` — amended by [ADR-0034](/internals/adr/0034-when-predicate-takes-a-single-object-argument)).
  This is the one node that is **not** inspectable — there is no way to make
  an arbitrary predicate data — and the AST advantage below applies to every
  node except this one.
- `and(...)` / `or(...)` / `not(...)` — composition, short-circuiting.

`permission`/`role`/`owner`/`authenticated` read a documented,
**optional-field** `KavoPrincipal` shape (`userId?`, `roles?`, `permissions?`,
plus an index signature) cast off `context.principal`. `principal` itself
stays `unknown` on `KavoContext` — using the built-in nodes is what an
application opts into; `when()` can read `context.principal` however it
likes instead, index signature and all, without Kavo widening its own
contract to match.

A single-string-array shorthand originally normalized to `permission` nodes
ANDed together — `policy: { updateOne: ['post:update'] }` was
`and(permission('post:update'))`, and `['post:update', 'admin']` required
both, with an **empty** array rejected at bootstrap rather than treated as
a vacuous `and()` (a zero-child `and` is `true` by definition, so
`policy: { updateOne: [] }` would have read as "lock this down" and behaved
as "allow everyone"). **Removed (issue #242):** the DSL already expresses
everything the shorthand could — `and(permission('post:update'), ...)` is
no longer than the array was — so `policy` now takes a `PolicyNode<Entity>`
only, one canonical way to write a policy.

### Config surface

`policy` is **structural entity-scope config, like `computed`**
(ADR-0019) — outside the settings precedence chain, because `when()`
carries a closure and the settings tree is deep-frozen. It is **not**
threaded through `KavoSettings`' global → entity → operation → per-call
chain: there is no global `policy`, and — unlike every ordinary settings
key — **no per-call override**. A per-call parameter that could loosen a
policy would let a caller weaken its own authorization, which defeats the
point.

- `EntityConfig.policy?: Partial<Record<StandardOperationId, PolicyNode<Entity>>>`
  — entity scope (removed by ADR-0033; see that ADR).
- `OperationConfig.policy?: PolicyNode<Entity>` — per-operation
  override, the same fallback `dto` uses: `operations.<id>.policy` wins over
  `policy.<id>` when both are set (moot after ADR-0033, which removes the
  entity-scope surface this precedence rule was between).
- An operation id absent from the resolved map runs **unrestricted** — the
  same opt-in posture every other Kavo default takes (`exposeInternals`,
  `realtime.enabled`, …). Adding a `policy` entry is how an entity opts in;
  there is no global switch.

Custom operations (issue #145) are **out of scope for this ADR** — their
handler already reaches `context.principal` directly and can refuse a
caller by throwing (`ForbiddenException`, below, or its own exception).

### Where entity-aware nodes are and aren't legal

`owner` and `when` need the row; `permission`, `role`, `authenticated` do
not. `createOne` has no row yet and `findMany` resolves a set rather than
one, so an entity-aware node on either is a bootstrap `ConfigurationException`
(`resolveEntityConfig`), naming the entity and the `policy.<id>` path —
caught before it is baked into the frozen config, the same treatment every
other bootstrap validation in that file gets. `findOne`, `updateOne`,
`patchOne`, `deleteOne`, `restoreOne`, and `purgeOne` all address one row
and accept either kind.

### Enforcement point

The policy stage runs inside `KavoEngine.run`, right after `context` is
built and before preconditions and the cache — a denied request must not
learn whether its `If-Match` would have succeeded, and a cache hit must not
skip authorization just because an earlier request from the same principal
already paid for it (cache keys already include `principal`, so this is
about freshness, not cross-principal leakage).

No built-in handler fetches its row ahead of a write —
`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne` all mutate by id
alone, and the adapter does its own lookup internally. `owner`/`when`
therefore cost one extra read on a single-row write when configured — the
stage fetches the row, evaluates, and only then lets the handler run, which
duplicates the adapter's own lookup. This is accepted as inherent to
row-level authorization, not deferred: denying _after_ a write already
committed is not a coherent design. A context-only policy
(`permission`/`role`/`authenticated`) costs nothing beyond the lookup and
the boolean evaluation — `policyNeedsEntity(node)` decides once, from the
node shape, whether the extra read is needed at all.

That pre-fetch asks for soft-deleted rows too (`withDeleted: true`) —
`restoreOne`/`purgeOne` target a row that is soft-deleted by definition, and
a live-only fetch would never find it, denying the legitimate owner as a
404 before the policy ever ran. It loads no relations: `owner`'s field is
validated at bootstrap to never cross a relation boundary (a dotted path
like `owner('author.id')` is only legal when `author` is an embedded value,
not a relation — see Config surface below), so `when()` is the only node
that can need a relation, and it receives `context`, from which it can load
one itself through `context.repository`.

`findOne` is the one exception to fetching here at all: it already loads
the row as its own result. A context-only `findOne` policy is still
evaluated in this same stage, before the cache read (below), exactly like
every other operation — it needs no fetch, so there is nothing to defer.
An entity-aware `findOne` policy is evaluated after the handler returns,
against the row it already fetched, rather than fetched a second time —
and `findOne` is **not cached** for an entity whose `findOne` policy is
entity-aware, specifically because a cache hit returns before that deferred
check would run; caching and an entity-aware `findOne` policy are mutually
exclusive for the same entity, not layered.

A missing row denies as `NotFoundException` (404), never
`ForbiddenException` (403) — existence must not leak through the status
code, the same requirement #138 states for row-scoping. This applies
whether the row was missing at the pre-fetch (write operations) or would
have 404'd from the handler regardless (`findOne`).

### The new catalog code

`KAVO_FORBIDDEN` (403) is added to the error catalog and
`ForbiddenException` to the hierarchy — the policy stage's own denial, and
also available to a custom operation's handler for the same purpose
(the smaller ask #182 raised, satisfied as a side effect of this decision
rather than as a dependency on it).

### Class-based policies and `filter()` are deferred

#234's design also proposed a third level — `policy: PostPolicy`, one
method per operation on a class — and a `filter()` helper that denies an
_operation_ outright (403) when no scoping filter was configured for it.
Both are **out of v1**:

- A class-based policy's method names, when it ships, are the DTO-slot
  bare verbs (`create`, `update`, `patch`, `delete`, `restore`, `purge`)
  **plus `item` and `list`** for the two read operations — not a unified
  `find` — because `item`/`list` are the actual DTO slot names
  (`CLAUDE.md` Conventions) and `findOne`/`findMany` do not share a slot
  the way `createOne`/`createMany` share `create`. The mapping itself is
  decided and codified now, in `STANDARD_OPERATION_VERB`
  (`operation.ts`) — internal, unread by anything until Level 3 lands —
  so the follow-up issue implements against a settled name, not a fresh
  design question.
- `filter()`'s operation-level denial (no scoping filter configured at all)
  is a different failure shape from `owner`/`when`'s row-level denial
  (a specific row exists but this caller isn't its owner) — this ADR's own
  `owner`/`when` denies an _existing_ row with 403, deliberately, since the
  row's existence is already knowable to the caller through `findOne`'s own
  policy (or through no policy at all on `findOne`); `filter()` would be
  denying access to the _operation itself_, before any row is even
  addressed, which is a different question and deserves its own design pass
  rather than shipping alongside this ADR's already-large surface. Neither
  is the row-scoping 404 #138 describes — that ADR is about a mandatory
  query-level predicate that makes an out-of-scope row invisible to
  `findMany` too, which this ADR does not attempt.

Both are filed as follow-up issues rather than implemented here.

## Consequences

- `01-system-architecture.md` §2 and §8's non-goal statements are narrowed
  from "no policy layer" to "no policy-evaluation _engine_"; §4's request-
  lifecycle diagram gains the policy stage; §10's tradeoff table gains a
  row. §9's ADR index table already stops updating past ADR-0015 and this
  ADR does not attempt to backfill it.
- `KavoContext.principal` stays `unknown` — nothing about this ADR narrows
  the context contract itself. `KavoPrincipal` is a cast target the built-in
  nodes use, documented as an opt-in shape, not a change to what
  `principal` _is_.
- An entity-aware policy on a single-row write is one extra read per
  request. Entities that never configure `policy`, or that use only
  context-only nodes, pay nothing.
- `permission`/`role`/`owner`/`not`/`and`/`or` land as generic-sounding
  barrel exports. They were checked against the filter AST's own `AND`/
  `OR`/`NOT` vocabulary (`LogicalOperator`) and found not to collide —
  that vocabulary is `SCREAMING_SNAKE` string literals, not exported
  identifiers — so the names ship as proposed rather than namespaced.
- Class-based policies, `filter()`, query-scope generation from the AST,
  and an OpenFGA/Casbin adapter are all left for later work this ADR does
  not commit to; the AST shape is chosen so none of them are foreclosed.
