# CRUD operations

Every `@Kavo`-decorated entity gets eight standard operations, each with a fixed id, an HTTP route, and a status code:

| Operation id | Route                | Status | Enabled by default                                                  |
| ------------ | -------------------- | ------ | ------------------------------------------------------------------- |
| `createOne`  | `POST /`             | 201    | Yes                                                                 |
| `findOne`    | `GET /:id`           | 200    | Yes                                                                 |
| `findMany`   | `GET /`              | 200    | Yes                                                                 |
| `updateOne`  | `PUT /:id`           | 200    | Yes                                                                 |
| `patchOne`   | `PATCH /:id`         | 200    | Yes                                                                 |
| `deleteOne`  | `DELETE /:id`        | 204    | Yes                                                                 |
| `restoreOne` | `PATCH /:id/restore` | 200    | No, unless the entity declares [soft delete](/features/soft-delete) |
| `purgeOne`   | `DELETE /:id/purge`  | 204    | No, until named explicitly                                          |

Names always spell out cardinality (`findOne`/`findMany`, never bare `find`) — a convention every operation on every entity follows, standard or custom.

## The operation registry

Every operation — standard or custom — is an entry in one **operation registry**, built fresh for each entity from `createOperationRegistry` ([ADR-0006](/internals/adr/0006-registry-driven-operations)). This single registry is what both the request engine and `@kavo/nest`'s route generator read from, which is why adding an operation is adding a registry entry rather than touching two separate systems that have to be kept in sync.

Each entry carries a handler (the behavior), metadata (route options, in `@kavo/nest`'s case), and its own slice of the [configuration precedence chain](/guides/configuration/) — so an operation can override settings (pagination, caching, allowlists — anything in [`KavoSettings`](/reference/config-keys)) independently of its entity's defaults.

## Enabling and disabling operations

Any operation can be turned off — globally, per entity, or the reverse (on by default, disabled per entity):

```ts
@Kavo(Book, {
  operations: {
    patchOne: false, // shorthand: disable outright
  },
})
```

A disabled operation gets **no route** — `@kavo/nest`'s generator only emits a route for an enabled entry — and calling it programmatically (`service.patchOne(...)`, or `service.run(...)` for a custom id) raises `OperationDisabledException`, answered as `405 KAVO_OPERATION_DISABLED` over HTTP. That is deliberate: a caller that hits the disabled route gets a clear "this exists but isn't turned on," never a bare 404 that would suggest the route was never mapped, and never a silent success.

`restoreOne`/`purgeOne` follow a different default because there's nothing to restore or purge until soft delete is declared: `restoreOne` turns on automatically the moment an entity's `softDelete` config resolves to `"soft"` ([ADR-0013](/internals/adr/0013-config-declared-soft-delete-operations)), and `purgeOne` stays off until you opt in explicitly (`operations: { purgeOne: true }`) — permanently deleting a row is worth stating on purpose. See [Soft delete](/features/soft-delete) for the full walkthrough.

The batch counterparts (`createMany`, `updateMany`, …) are reserved in the registry but registered **disabled** — calling one raises `OperationDisabledException` and no route generates. Bulk operations aren't implemented yet.

## Per-operation configuration

Beyond enable/disable, any standard operation accepts a full override object — a replacement handler, route options, a narrower DTO, or settings that apply to that operation only:

```ts
@Kavo(Book, {
  operations: {
    restoreOne: { enabled: true, meta: { routes: { path: ":id/undelete" } } },
    findMany: { pagination: { defaultLimit: 50 } },
  },
})
```

See [Guides/Configuration/Operations](/guides/configuration/operations) for the full field reference, and [Custom operations](/core/custom-operations) for operations beyond the standard eight.
