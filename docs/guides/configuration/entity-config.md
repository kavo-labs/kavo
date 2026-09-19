# Entity config

`@Kavo(Entity, config)` accepts every `KavoSettings` field from [Settings](/guides/configuration/settings) one level above global, plus fields that only make sense per entity and never merge through the scope chain: `schema`, `set` (below, the write-side sibling of `apply`), `policy` (below, an entity-wide default), `operations` (its own page, see [Operations](/guides/configuration/operations#operations-1)), and the per-axis query blocks `filter`, `sort`, `select`, `search`, and `include` — each holding that axis's `fields` allowlist, its `default` for an omitted request, its `apply` server-side override (ADR-0048), and (for `filter`/`include`) its request-cost `limits`. Per-relation read tuning and array-mutation write policy is `relations`. [Allowed](/features/allowed) covers the `fields` allowlists in full — including `schema.input.create`/`schema.input.update`'s own `{ fields }` shorthand, the write side's allowlist — and [Config keys](/reference/config-keys) is the field-by-field table for all of them.

## schema

Configures a class or validator per slot, split into `input` and `output`. Every slot is independently optional and falls back to an entity-derived default when omitted:

```ts
@Kavo(Book, {
  schema: { input: { create: CreateBookSchema, update: UpdateBookSchema }, output: { item: BookItemSchema, list: BookListSchema } },
})
```

| Slot     | Default when omitted                                |
| -------- | --------------------------------------------------- |
| `create` | Entity's own shape, minus generated/relation fields |
| `update` | Same default as `create`                            |
| `patch`  | `Partial<update>` if set, else `Partial<Entity>`    |
| `query`  | Generic `QueryContext<Entity>`                      |
| `item`   | Entity, subject to field selection                  |
| `list`   | Same as `item`'s resolved type                      |

There's no `patch` schema to write on its own; it derives from `update`. See [Schemas](/core/schemas) and [Schema system](/internals/architecture/04-schema-system) for full derivation rules.

## set

Forces field values into a `createOne`/`updateOne` body, overwriting whatever the client sent for that key — the write-side sibling of `filter.apply`/`sort.apply`/`select.apply`/`include.apply` (ADR-0048, ADR-0049). A bare function applies the same values to both operations; a `{ create?, update? }` object lets them diverge:

```ts
@Kavo(Order, {
  set: ({ context }) => ({ tenantId: context.app.tenantId }), // same value on create and update
})

@Kavo(Order, {
  set: {
    create: ({ context }) => ({ tenantId: context.app.tenantId }),
    update: ({ context }) => ({ tenantId: context.app.tenantId }),
  },
})
```

`set.create` (or the bare-function form) runs on `createOne`, `set.update` on `updateOne` only — never `patchOne`, whose omitting a field means "leave it unchanged," not "reset it." It composes with `schema.input.create`/`update`'s writable-field allowlist rather than replacing it: the allowlist narrows what the client's own body may set, `set` unconditionally overwrites a field regardless of what the allowlist let through or the client sent. See [Apply](/features/apply) for the full argument shape and composition rules.

## filter / sort / select / search / include

See [Allowed](/features/allowed) for the `fields` allowlists in full. Response fields with no backing storage column come from the ORM's own virtual/generated-column mechanism instead of a config key — see [Virtual fields](/features/virtual-fields).

## policy

Authorization (ADR-0037), resolved nearest-scope-wins across `operations.<id>.policy`, the entity's own `policy` (one default function, applied to every operation that configures none of its own), and a root-level `createKavo({ policy })` default. An operation with no policy at any of the three scopes runs unrestricted:

```ts
import type { Policy } from "@kavo/core";

// `context.app` is typed by the interface your app declares — see Wiring your own auth.
function hasPermission(name: string): Policy<Post> {
  return ({ context }) => (context.app.permissions ?? []).includes(name);
}

const isOwner: Policy<Post> = ({ context, entity }) => {
  const { userId } = context.app;
  return userId != null && entity?.authorId === userId;
};

@Kavo(Post, {
  policy: hasPermission("post:read"), // default for every operation on this entity
  operations: {
    // Naming any operation here makes `operations` an exclusive whitelist
    // (see [Operations](/guides/configuration/operations)) — a real config
    // would also name createOne/findOne/patchOne/restoreOne/purgeOne to
    // keep them on.
    updateOne: { policy: (args) => hasPermission("post:update")(args) && isOwner(args) }, // overrides the default
    deleteOne: { policy: (args) => hasPermission("post:delete")(args) && hasPermission("admin")(args) }, // every name required
    findMany: { policy: false }, // explicitly public, opts out of the entity-level default
  },
})
```

A single-row operation (`findOne`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) with a resolved policy always gets the loaded row as `entity`, whether the policy is declared on the operation directly or inherited from an entity/global default; `createOne`/`findMany` always call the policy with `entity: undefined`, since neither has a single row to load. See [Policy](/features/policy) for the full shape, the scope-resolution rules, and how the stage behaves, and [Wiring your own auth](/guides/wiring-your-own-auth) for building `context.app` and typing it.
