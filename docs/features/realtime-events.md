# Realtime events

`enabled` (default `false`) controls whether this entity's standard writes publish a `RealtimeEventDto` to every registered transport. `false` for the whole `realtime` key (instead of an object) is the same as `enabled: false`.

`events` (default `{}`) is a per-event opt-out — `{ patched: false }` suppresses `patched` publishes while `created`/`updated`/`deleted`/`restored` still fire.

`subscribableFields` (unset by default) is an allowlist a transport (e.g. `@kavo/sse`) can read and enforce on a subscription's outgoing payload — core carries the value but does not itself narrow anything with it (that's the transport's job).

`onPublishError` (unset by default) is called when a transport's `publish` rejects or throws. A transport failure never fails the write that produced the event; this is the only way to observe it (core has no ambient logger, ADR-0005).

Publishing needs both halves: `realtime.enabled` on the entity (set here or via `defaults`) _and_ at least one transport in `realtimeTransports` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)). Either alone is a no-op. See [Realtime](/internals/architecture/18-realtime) for the full event/channel model, and `@kavo/sse`'s own README for the first transport implementation (collection channels, subscribe-time filtering, `subscribableFields` payload narrowing).

See [Settings](/guides/configuration/settings) for the rest of `KavoSettings`.
