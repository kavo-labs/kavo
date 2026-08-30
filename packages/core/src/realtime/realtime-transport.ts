import type { RealtimeEventDto } from "./realtime-event.js";

/**
 * A sink a realtime event is published to — WebSocket, SSE, a message
 * broker, or anything else. `@kavo/core` defines only this seam and ships
 * no implementation (ADR-0005: core has zero runtime dependencies, and a
 * transport library is exactly the kind of dependency that stays out).
 *
 * `publish` rejecting never fails the mutation that produced the event —
 * the engine catches it and reports it through `RealtimeSettings.
 * onPublishError`, if the app supplied one (core has no ambient logger to
 * fall back on, ADR-0005). A transport that needs at-least-once delivery
 * semantics is responsible for its own retry/durability; the engine calls
 * `publish` once per event, per transport.
 *
 * **Authorization is entirely this transport's responsibility.** `publish`
 * receives the same whole-item `RealtimeEventDto` the writing caller's
 * own REST response was serialized from — core attaches no caller,
 * tenant, or per-subscriber scope to it, and `channel`/`entity` are bare
 * strings with no access-control meaning of their own (`subscribableFields`
 * bounds which *fields* a subscription may reach, not *who* may reach
 * them). A transport that fans `channel`/`entity` straight into a pub/sub
 * topic without checking, for each subscriber, whether that caller
 * could have read this row over REST will leak one caller's full item
 * projection to every subscriber of that entity/id, or — once a
 * collection-channel subscriber can also scope itself with a `filter`
 * query string (issue #160, ADR-0024) — to every subscriber of a filtered view over
 * the whole entity. Row-level/tenant scoping of subscribers (`authorize`)
 * is deliberately out of this seam — see the discussion on issue
 * #154/#155/#160 — until a future issue adds it.
 *
 * **A subscription `filter` is a convenience boundary, not a confidentiality
 * one.** It narrows *which* events a subscriber receives; it does not
 * change *whether* they were authorized to receive them. In particular,
 * `deleted`/`purgeOne`'s `deleted` event carries `item: null`, so a
 * filter has nothing to evaluate against it — a filtered collection
 * subscriber therefore receives every `deleted` event on the channel
 * unconditionally (it might be their row leaving the filtered view; there
 * is no way to tell without the item that no longer exists to check). That
 * means a subscriber on `filter[ownerId][eq]=me` still learns the `id` of
 * every row deleted on that entity, including ones they never had
 * visibility into — acceptable only because subscriber-level authorization
 * is already out of scope here, not because the filter hid anything.
 */
export interface RealtimeTransport {
  /** Identifies the transport in logs — e.g. `"websocket"`, `"sse"`. */
  readonly name: string;
  publish(event: RealtimeEventDto): Promise<void>;
}
