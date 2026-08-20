# Realtime events

`realtime` (default `false`) is the entity's realtime subtree. `false` disables it entirely; any object — even `{}` — turns it on.

- `events` (optional, unset behaves like `{}`): a per-event opt-out. `{ patched: false }` suppresses `patched` publishes; `created`/`updated`/`deleted`/`restored` still fire.
- `subscribableFields` (unset by default): an allowlist a transport (for example `@kavo/sse`) can read and enforce on a subscription's outgoing payload. Core carries the value but does not narrow anything with it itself; that's the transport's job.
- `onPublishError` (unset by default): called when a transport's `publish` rejects or throws. A transport failure never fails the write that produced the event. This is the only way to observe that failure, since core has no ambient logger (ADR-0005).

Publishing needs both halves: `realtime` set to an object on the entity (set here or via `defaults`), and at least one transport in `realtimeTransports` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)). Either alone is a no-op.

See [Realtime](/internals/architecture/18-realtime) for the full event and channel model, and `@kavo/sse`'s own README for the first transport implementation: collection channels, subscribe-time filtering, and `subscribableFields` payload narrowing.

See [Settings](/guides/configuration/settings) for the rest of `KavoSettings`.
