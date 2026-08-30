# Custom operations

Kavo has no separate lifecycle-hook system, no `beforeCreate`/`afterUpdate`. The two extension points below cover that ground: replace a standard operation's behavior, or declare an entirely new operation of your own. Both go through the exact same pipeline every built-in route does: DTO resolution, deserialization, serialization, the `ETag`, problem-details errors, and the module's `app` context.

## Replacing a standard operation's handler

The config-level equivalent of `@Override` (see [Routes & controllers](/core/routes-and-controllers)): swap the behavior behind a standard id without touching its route.

```ts
@Kavo(Book, {
  operations: {
    createOne: {
      handler: {
        async execute(body, context) {
          return context.repository.create({ ...body, title: body.title.trim() }, context);
        },
      },
    },
  },
})
```

`context.repository` is the entity's own [`RepositoryAdapter`](/guides/custom-adapter), reached the same way a built-in handler reaches it. This is a plain object literal, evaluated at `@Kavo` decoration time, before any `DataSource` exists, so nothing is closed over. Everything a handler needs comes off `context`.

## Declaring a custom operation

An `operations` key that isn't one of the standard eight declares a whole new operation: its own registry entry, its own route, its own place in the [precedence chain](/guides/configuration/).

```ts
@Kavo(Order, {
  operations: {
    markPaidOne: {
      dto: { input: MarkPaidDto },
      handler: {
        async execute({ id, body }: { id: number; body: MarkPaidDto }, context) {
          const order = await context.repository.findOneById(id, null, context);
          if (order === null) {
            throw new NotFoundException({ messageParams: { entity: context.entityName, id: String(id) } });
          }
          return context.repository.patch(id, { paidAt: new Date(), reference: body.reference }, context);
        },
      },
      meta: { routes: { method: "POST", path: ":id/mark-paid" } },
    },
  },
})
@Controller("orders")
export class OrderController {}
```

A custom entry needs a `handler` (there's no built-in to fall back to) and accepts:

- **`kind`** (`"read"` | `"write"`, default `"write"`): a read runs query resolution and takes no body; a write takes one.
- **`cardinality`** (`"one"` | `"many"`, default `"one"`): `"many"` returns the list envelope, so the handler must return `{ entities, total }` the way `findMany` does.
- **`dto`**: since a custom operation has no root `dto` slot, this is the only way to give it a shape. With no `dto.output`, the result is projected through the entity's own columns. A result sharing nothing with them raises a `KAVO_CONFIG_INVALID` naming the operation, rather than silently serializing to `{}`.
- **`meta.routes`**: same route options every standard operation gets. With none, the route defaults to `POST /<operation id>`.

Naming follows the same convention as the built-ins: camelCase, always spelling out cardinality (`markPaidOne`, not `markPaid`).

Call it in code through `run`:

```ts
await service.run("markPaidOne", { id: 7, body: { reference: "INV-42" } });
```

## Things worth knowing before reaching for one

- **`If-Match` is refused, not ignored.** Nothing in the schema says which row a custom operation targets, so a conditional request against one answers `412 KAVO_PRECONDITION_UNSUPPORTED` rather than writing unguarded.
- **Custom routes are matched first.** Registered ahead of the standard table, so a custom `GET /orders/pending` reaches its own handler rather than falling through to `GET /orders/:id`.
- **A handler that needs an injected application service, not just the database, is a case for `@Override` or a hand-written route instead.** A config-level handler is a plain object with no `this` and nothing to inject into.
- **Realtime events are keyed by standard operation id.** A custom operation emits nothing, however it changes a row. See [Realtime events](/features/realtime-events).
- **Custom operations are REST and programmatic only.** The GraphQL and MCP bindings expose the standard operations; a custom one has no counterpart there.

See [Guides/Configuration/Operations](/guides/configuration/operations#custom-operations) for the full field reference, including custom list metadata (adding data to `findMany`'s `meta` bag without replacing the whole handler), and [CRUD engine](/internals/architecture/07-crud-engine) for the pipeline internals.
