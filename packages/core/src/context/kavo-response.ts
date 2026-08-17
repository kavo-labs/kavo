import type { ListResultDto } from "../dto/list-result.js";
import type { OperationId } from "../operations/operation.js";

/**
 * The transport-agnostic result envelope the engine returns. Exactly one
 * result shape is populated, matching the operation's cardinality:
 * `item` for `*One` results and `list` for `findMany`; both are `null`
 * for void results (`deleteOne`, `purgeOne`).
 */
export interface KavoResponse<ItemDto = unknown, ListDto = ItemDto> {
  readonly operation: OperationId;
  readonly item: ItemDto | null;
  readonly list: ListResultDto<ListDto> | null;
  /**
   * The strong entity-tag of `item`, quoted and ready to be an `ETag`
   * header (ADR-0020) — `null` when there is no item, or when
   * `cache.etag` is off for this call. Collection responses never carry
   * one.
   */
  readonly etag: string | null;
  /**
   * The request's `If-None-Match` matched `etag` on a read: the client's
   * cached copy is current, and a transport should answer `304 Not
   * Modified` with no body. `item` stays populated regardless — a content
   * hash cannot be known without serializing, so there is no work to skip
   * and no reason to hide the result from a programmatic caller.
   */
  readonly notModified: boolean;
}
