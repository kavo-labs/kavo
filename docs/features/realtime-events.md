# Realtime events

`realtime` (default `false`) is the entity's realtime subtree. `false` disables it entirely; any object — even `{}` — turns it on.

- `events` (optional, unset behaves like `{}`): a per-event opt-out. `{ patched: false }` suppresses `patched` publishes; `created`/`updated`/`deleted`/`restored` still fire.
- `subscribableFields` (unset by default): an allowlist a transport (for example `@kavo/sse`) can read and enforce on a subscription's outgoing payload. Core carries the value but does not narrow anything with it itself; that's the transport's job.
- `onPublishError` (unset by default): called when a transport's `publish` rejects or throws. A transport failure never fails the write that produced the event. This is the only way to observe that failure, since core has no ambient logger (ADR-0005).

Publishing needs both halves: `realtime` set to an object on the entity (set here or via `defaults`), and at least one transport in `realtimeTransports` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)). Either alone is a no-op.

A custom operation ([Custom operations](/core/custom-operations)) publishes nothing by default. A `kind: "write"`, `cardinality: "one"` custom operation can opt in by naming which of the five event ids its write counts as:

```ts
operations: {
  markPaidOne: {
    kind: "write",
    handler: { execute: (input, context) => context.repository.patch(input.id, { paidAt: new Date() }) },
    realtimeEvent: "updated",
  },
}
```

Declaring `realtimeEvent` on a read, or on a `cardinality: "many"` operation, is a bootstrap error — a realtime event describes exactly one row.

**Events are not authorized per subscriber.** A published event goes to every subscriber of its channel. `policy`, `filter.apply`, and the field allowlists shape what REST returns, but they are not evaluated again for each subscriber of a realtime event. A subscription's own `filter` narrows which events it receives, not whether the subscriber may see them. `@kavo/sse` performs no authentication or authorization of its own. Gate who may open a stream in the host (a guard or proxy on the mounted route), and only enable `realtime` on an entity whose every row may reach every subscriber that gate admits. Use `subscribableFields` to keep fields off the wire.

See [Realtime](/internals/architecture/18-realtime) for the full event and channel model, and `@kavo/sse`'s own README for the first transport implementation: collection channels, subscribe-time filtering, and `subscribableFields` payload narrowing.

See [Settings](/guides/configuration/settings) for the rest of `KavoSettings`.
