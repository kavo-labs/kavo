import type { EntityId } from "../types/entity-id.js";

/**
 * Realtime event ids — the closed vocabulary a `RealtimeTransport` publishes
 * under. One per standard write outcome; `deleteOne` and `purgeOne` both map
 * to `"deleted"` (a subscriber only needs to know the row is gone, not which
 * delete strategy produced that). A custom operation has no fixed mapping —
 * its `kind`/`cardinality` don't say what it means the way the standard
 * eight's do — so it declares which of these five it publishes as via
 * `CustomOperationConfig.realtimeEvent` (issue #175); one that declares
 * nothing emits nothing, the same silent default every custom operation had
 * before that field existed. The vocabulary itself stays closed: a custom
 * operation publishes as one of these five, never under its own id.
 *
 * Issue #160 / ADR-0024 (filtered collection subscriptions) considered, and rejected,
 * adding ids for a row entering/leaving a filtered subscriber's view on an
 * ordinary `updated`/`patched` write — see `RealtimeTransport`'s doc for the
 * chosen policy. The vocabulary stayed closed: a filtered subscriber's
 * "this row left my view" case reuses `"deleted"` rather than earning a new
 * id, and "entered my view" reuses whichever real event id the write
 * already produced. The `deleted` overload does mean `"deleted"` no longer
 * implies the row itself is gone — only that this subscriber should stop
 * expecting to see it.
 */
export type RealtimeEventId = "created" | "updated" | "patched" | "deleted" | "restored";

/**
 * The wire payload a `RealtimeTransport` publishes for one write. The
 * engine builds exactly one of these per emitted event and hands it to
 * every registered transport's `publish()` unchanged — a transport formats
 * it for its own wire (an SSE frame, a WebSocket message, …) but never
 * recomputes it.
 */
export interface RealtimeEventDto<ItemDto = unknown> {
  readonly event: RealtimeEventId;
  /** The entity's name, exactly as `EntityMetadata.name`/`config.entityName` report it. */
  readonly entity: string;
  readonly id: EntityId;
  /**
   * `<entity>.<id>` — the item-level subscription channel a transport
   * routes this event to. The **collection**-level channel (every event for
   * the entity, not just one id) is deliberately not a separate field:
   * it is exactly `entity` above, so a transport that wants to fan one
   * event out to both an item-channel subscriber and a collection-channel
   * subscriber reads `channel` for the former and `entity` for the latter
   * off this same payload (issue #160) — the engine still builds and
   * publishes exactly one `RealtimeEventDto` per write. Field-level
   * channels (a topic per field) are still not built; `RealtimeSettings.
   * subscribableFields` instead bounds which fields a transport may
   * *include* in the item it delivers on either channel above.
   */
  readonly channel: string;
  /** ISO-8601, set once by the engine so every transport agrees on it. */
  readonly occurredAt: string;
  /**
   * The same output-DTO serialization already computed for the REST
   * response — no second serialization pass. `null` on `"deleted"`, where
   * there is nothing left to serialize.
   */
  readonly item: ItemDto | null;
  /**
   * `"updated"`/`"patched"` only — the field names present in the write
   * payload. This is "what the client asked to change," not a diff against
   * the row's previous value (which would need an extra read); documented
   * here so a consumer doesn't assume the stronger guarantee.
   */
  readonly changed?: readonly string[];
}
