import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  EntityMetadata,
  FilterExpression,
  QueryIssueDto,
  RealtimeEventDto,
  RealtimeFieldSelector,
  RealtimeTransport,
  ResolvedEntityConfig,
} from "@kavo/core";
import { DefaultFilterParser, QueryValidationException, evaluateFilter } from "@kavo/core";

/**
 * Bytes buffered in a connection's underlying socket before it is dropped
 * rather than blocking `publish` for every other subscriber. `res.
 * writableLength` (Node's `http.ServerResponse` is a `stream.Writable`) is
 * the amount queued but not yet flushed to the OS — a slow reader grows
 * this, a healthy one keeps it near zero. 64 KiB is generous for
 * `RealtimeEventDto`-sized JSON frames while still catching a genuinely
 * stuck client quickly.
 */
const DEFAULT_BUFFER_LIMIT_BYTES = 64 * 1024;

/**
 * What a subscribe request needs to parse and validate a `filter` query
 * string for one entity — the same two pieces `DefaultFilterParser` and
 * `Filter.parse` already need for REST: `metadata` for column-kind-aware
 * value coercion, `config` for the `filterable` allowlist and the
 * `query.maxFilterDepth`/`maxInValues` limits. `@kavo/sse` has no config
 * resolution of its own (same reason `subscribableFields` is a callback,
 * not a lookup this package performs itself), so the host app supplies
 * both — typically `service.engine.metadata`/`service.engine.config` off
 * the `DefaultKavoService` `createCrud` already returned for that entity.
 * That property is concretely typed per entity (`ResolvedEntityConfig<
 * Book>`), while this interface — serving every entity through one
 * callback — is not; assigning the former to the latter needs the same
 * erasure cast `kavo.ts`'s own `catalog.register` already uses internally
 * (`config as unknown as ResolvedEntityConfig`), not a sign of a type
 * mismatch.
 */
export interface FilterableEntity {
  readonly metadata: EntityMetadata;
  readonly config: ResolvedEntityConfig;
}

/**
 * What `handleRequest` needs to scope one subscription. `@kavo/sse` has no
 * authentication of its own — every subscribe request that otherwise
 * validates is accepted. A deployment that needs to gate who may open a
 * stream does so in front of `handleRequest` (a reverse proxy, a host
 * framework's own guard/middleware on the mounted route, …) — see
 * `RealtimeTransport`'s doc comment on why subscriber-level access control
 * is out of this seam entirely.
 */
export interface SseTransportOptions {
  /**
   * Per-entity `RealtimeSettings.subscribableFields`, the same allowlist an
   * app already configured via `createCrud` — this package has no config
   * resolution of its own, so the caller supplies the lookup. A request
   * naming a `fields` query param outside the allowlist is rejected with
   * `400` before the stream opens, the same way `allowlists.selectable`
   * rejects an unlisted field over REST. Returning `undefined` (including
   * when the callback itself is omitted) means no allowlist is configured
   * for that entity, so any requested field is accepted.
   *
   * Once configured, this allowlist is also enforced **unconditionally** on
   * every outgoing `item` for that entity — not only when a subscriber
   * names `fields` — the same way `allowlists.selectable` bounds a REST
   * response whether or not the caller asked for a subset. A `fields`
   * query param narrows further *within* that bound; it can never widen
   * past it.
   */
  subscribableFields?(entityName: string): RealtimeFieldSelector | undefined;
  /**
   * Enables subscribe-time filtering (`filter[field][operator]=value`,
   * issue #160) for one entity. Returning `undefined` (including when the
   * callback itself is omitted) means that entity does not support
   * subscribe-time filtering — a request naming any `filter[...]`/`filter`
   * query param for it is rejected with `400` before the stream opens,
   * rather than silently ignoring the filter and delivering everything.
   */
  filterableEntities?(entityName: string): FilterableEntity | undefined;
  /** See `DEFAULT_BUFFER_LIMIT_BYTES`. */
  bufferLimitBytes?: number;
}

/** A `RealtimeTransport` plus the HTTP entry point a host wires a route to. */
export interface SseTransport extends RealtimeTransport {
  /**
   * Handles one incoming SSE subscribe request:
   * `GET ?channel=<entity>.<id>` (item channel) or `GET ?channel=<entity>`
   * (collection channel, issue #160) with `Accept: text/event-stream`.
   * Host-framework-agnostic — takes Node's own
   * `IncomingMessage`/`ServerResponse`, which every Node HTTP framework's
   * request/response either extends or wraps directly. Resolves once the
   * response is settled (an error status was written, or the stream was
   * opened) — the connection itself then lives for as long as the client
   * keeps it open, torn down by the request's own `close`.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Number of currently open subscriptions, across every channel. */
  readonly connectionCount: number;
  /** Ends every open connection and forgets them. For graceful shutdown and tests. */
  close(): void;
}

interface Connection {
  readonly res: ServerResponse;
  readonly channel: string;
  readonly entityName: string;
  /** `null` means "no filter configured" — every event on the channel matches. */
  readonly filter: FilterExpression<object> | null;
  /** Already validated against `subscribableFields`; `undefined` means no `fields` param was given. */
  readonly fields: readonly string[] | undefined;
  /** Captured once at subscribe time — see `subscribableFields`'s doc on why it applies unconditionally. */
  readonly selector: RealtimeFieldSelector | undefined;
}

/**
 * Same array-or-`exclude` semantics `resolveFieldSelector` (core,
 * internal) applies for REST's `selectable`/`filterable`/`sortable` — but
 * with no "base" field list to fall back on, because `RealtimeFieldSelector`
 * carries none (`settings.ts`'s own doc on why: this schema has no `Entity`
 * type parameter to check a field name against). An explicit array is a
 * positive allowlist; `{ exclude }` is checked negatively instead — "not
 * excluded" rather than "in some base set minus excluded" — since there is
 * no base set here to subtract from.
 */
function isFieldAllowed(selector: RealtimeFieldSelector | undefined, field: string): boolean {
  if (selector === undefined) return true;
  // `"exclude" in selector`, not `Array.isArray` — `Array.isArray`'s guard is
  // `arg is any[]`, and a `readonly string[]` is not assignable to `any[]`,
  // so it fails to narrow the union in the negative branch. Same reason
  // core's own `resolveFieldSelector` (resolve-entity-config.ts) checks it
  // this way.
  if ("exclude" in selector) return !selector.exclude.includes(field);
  return selector.includes(field);
}

/**
 * Bounds an outgoing `item` to `selector` (unconditional, once configured)
 * and then further to `fields` (a subscriber-requested subset, already
 * validated ⊆ the allowlist at subscribe time). `undefined` for both means
 * no narrowing — the item is delivered whole, today's behavior for an
 * entity that never configured `subscribableFields`.
 */
function narrowItem(
  item: unknown,
  selector: RealtimeFieldSelector | undefined,
  fields: readonly string[] | undefined,
): unknown {
  if (item === null || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;

  let allowed: readonly string[];
  if (fields !== undefined) {
    allowed = fields;
  } else if (selector !== undefined) {
    const keys = Object.keys(record);
    allowed = "exclude" in selector ? keys.filter((key) => !selector.exclude.includes(key)) : selector;
  } else {
    return item;
  }

  const narrowed: Record<string, unknown> = {};
  for (const key of allowed) if (key in record) narrowed[key] = record[key];
  return narrowed;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * `id:` set even though nothing consumes it yet (resume-on-reconnect is a
 * future issue) — a monotonically increasing counter, shared across every
 * channel on this transport instance, so it stays meaningful the day resume
 * is built instead of forcing a wire-format change then. Allocated once per
 * `publish` call (not once per connection/frame) so every subscriber of one
 * logical write sees the same `id:`, even though the `data:` they receive
 * may differ once field-narrowing is applied.
 */
function frame(id: number, event: RealtimeEventDto): string {
  return `id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Every `filter[...]`/`filter` query param, flattened the way
 * `DefaultFilterParser` expects: one entry per literal key, repeated keys
 * (the `filter[status][in][]=a&filter[status][in][]=b` form) collapsed
 * into one array value under that key. Every other query param
 * (`channel`, `fields`, …) rides along harmlessly — the parser only ever
 * reads keys starting with `filter[` or the bare `filter` key.
 */
function collectRawParams(searchParams: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    raw[key] = values.length > 1 ? values : values[0];
  }
  return raw;
}

function hasFilterParams(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (key === "filter" || key.startsWith("filter[")) return true;
  }
  return false;
}

/** Every field name a condition in `expression` compares against, deduplicated. */
function collectConditionFields(expression: FilterExpression<object>): readonly string[] {
  const fields = new Set<string>();
  const visit = (node: FilterExpression<object>): void => {
    if (node.kind === "condition") {
      fields.add(node.field as string);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(expression);
  return [...fields];
}

/**
 * The first real `RealtimeTransport` implementation (issue #155, over the
 * seam #154 added; issue #160 / ADR-0024 added collection and filtered subscriptions):
 * plain HTTP `text/event-stream`, no client or server library required.
 * The channel a connection opens is either the item-level `<entity>.<id>`
 * string `RealtimeEventDto.channel` carries, or the bare `<entity>` name
 * (`RealtimeEventDto.entity`) for every event on that entity — `publish`
 * fans an event out to every connection registered under either string, so
 * one write reaches both an item-level and a collection-level subscriber
 * from the same call.
 *
 * One process, one in-memory channel registry: a subscriber connected to
 * this instance never sees a write handled by another instance of a
 * horizontally-scaled app (see the package README's "Known limitations").
 */
export function createTransport(options: SseTransportOptions): SseTransport {
  const bufferLimitBytes = options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT_BYTES;
  const channels = new Map<string, Set<Connection>>();
  let nextEventId = 1;

  function subscribe(connection: Connection): void {
    let subscribers = channels.get(connection.channel);
    if (!subscribers) {
      subscribers = new Set();
      channels.set(connection.channel, subscribers);
    }
    subscribers.add(connection);
  }

  function unsubscribe(connection: Connection): void {
    const subscribers = channels.get(connection.channel);
    if (!subscribers) return;
    subscribers.delete(connection);
    if (subscribers.size === 0) channels.delete(connection.channel);
  }

  /**
   * `"deleted"` bypasses the filter unconditionally — `event.item` is
   * `null`, so there is nothing to evaluate, and the alternative (silently
   * excluding it) leaves a filtered subscriber with a row in its view that
   * is permanently gone. See `RealtimeTransport`'s doc for the
   * confidentiality tradeoff this implies. Every other event id evaluates
   * normally: a write that makes a row start matching a filter is
   * delivered as whatever its real event id is (`"entering" a filtered
   * view reuses the ordinary event, not a synthesized `"created"`); a
   * write that makes it stop matching simply is not delivered — there is
   * no before-image available to detect that transition without an extra
   * read the engine does not already do, so it is a documented limitation
   * rather than a silently-wrong "leave" event.
   */
  function matches(connection: Connection, event: RealtimeEventDto): boolean {
    if (event.event === "deleted") return true;
    return evaluateFilter(connection.filter, (event.item ?? {}) as Record<string, unknown>);
  }

  function deliverTo(subscribers: Set<Connection> | undefined, event: RealtimeEventDto, id: number): void {
    if (!subscribers || subscribers.size === 0) return;
    // Direct `for...of` over the live `Set`, not a snapshot copy: deleting
    // the current entry mid-iteration (the `unsubscribe` below, for a
    // connection that can't keep up) is well-defined under the Set
    // iteration protocol — already-visited and about-to-be-visited
    // entries are unaffected.
    for (const connection of subscribers) {
      if (!matches(connection, event)) continue;
      if (connection.res.writableLength > bufferLimitBytes) {
        // Can't keep up: dropped rather than left to block publish to
        // every other subscriber of this channel.
        unsubscribe(connection);
        connection.res.end();
        continue;
      }
      const outgoing: RealtimeEventDto = {
        ...event,
        item: (narrowItem(event.item, connection.selector, connection.fields) ?? null) as never,
      };
      connection.res.write(frame(id, outgoing));
    }
  }

  return {
    name: "sse",

    get connectionCount(): number {
      let total = 0;
      for (const subscribers of channels.values()) total += subscribers.size;
      return total;
    },

    async publish(event: RealtimeEventDto): Promise<void> {
      const itemSubscribers = channels.get(event.channel);
      const collectionSubscribers = channels.get(event.entity);
      if (
        (!itemSubscribers || itemSubscribers.size === 0) &&
        (!collectionSubscribers || collectionSubscribers.size === 0)
      ) {
        return;
      }

      // Allocated once per publish, not once per connection — every
      // subscriber of one logical write shares the same `id:` even though
      // the `data:` they receive may differ (field narrowing).
      const id = nextEventId++;
      deliverTo(itemSubscribers, event, id);
      deliverTo(collectionSubscribers, event, id);
    },

    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== "GET") {
        sendJson(res, 400, { error: "SSE subscription requires GET" });
        return;
      }
      const accept = req.headers.accept;
      if (typeof accept !== "string" || !accept.includes("text/event-stream")) {
        sendJson(res, 400, { error: "requires 'Accept: text/event-stream'" });
        return;
      }

      const url = new URL(req.url ?? "", "http://kavo.invalid");
      const channel = url.searchParams.get("channel");
      if (!channel) {
        sendJson(res, 400, {
          error: "a 'channel' query parameter of the form '<entity>' or '<entity>.<id>' is required",
        });
        return;
      }
      const dot = channel.indexOf(".");
      if (dot === 0 || dot === channel.length - 1) {
        sendJson(res, 400, {
          error: "a 'channel' query parameter of the form '<entity>' or '<entity>.<id>' is required",
        });
        return;
      }
      const entityName = dot === -1 ? channel : channel.slice(0, dot);

      const selector = options.subscribableFields?.(entityName);
      const fieldsParam = url.searchParams.get("fields");
      let fields: readonly string[] | undefined;
      if (fieldsParam !== null) {
        const requested = fieldsParam
          .split(",")
          .map((field) => field.trim())
          .filter((field) => field.length > 0);
        const disallowed = requested.filter((field) => !isFieldAllowed(selector, field));
        if (disallowed.length > 0) {
          sendJson(res, 400, { error: `field(s) not subscribable: ${disallowed.join(", ")}` });
          return;
        }
        fields = requested;
      }

      let filter: FilterExpression<object> | null = null;
      if (hasFilterParams(url.searchParams)) {
        const filterable = options.filterableEntities?.(entityName);
        if (filterable === undefined) {
          sendJson(res, 400, { error: `entity '${entityName}' does not support subscribe-time filtering` });
          return;
        }
        const parser = new DefaultFilterParser(filterable.metadata);
        let parsed;
        try {
          parsed = parser.parse(collectRawParams(url.searchParams), filterable.config);
        } catch (error) {
          if (error instanceof QueryValidationException) {
            sendJson(res, 400, { error: "invalid filter", issues: error.issues as QueryIssueDto[] });
            return;
          }
          throw error;
        }
        filter = parsed.root as FilterExpression<object> | null;

        if (filter !== null) {
          const knownFields = new Set(filterable.metadata.fields.map((field) => field.name));
          const conditionFields = collectConditionFields(filter);
          const unevaluable = conditionFields.find((field) => !knownFields.has(field));
          if (unevaluable !== undefined) {
            sendJson(res, 400, {
              error: `filter field '${unevaluable}' cannot be evaluated for a realtime subscription (relation and computed fields are not supported — only the entity's own columns)`,
            });
            return;
          }
          const disallowed = conditionFields.filter((field) => !isFieldAllowed(selector, field));
          if (disallowed.length > 0) {
            sendJson(res, 400, { error: `filter field(s) not subscribable: ${disallowed.join(", ")}` });
            return;
          }
        }
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();

      const connection: Connection = { res, channel, entityName, filter, fields, selector };
      subscribe(connection);
      req.on("close", () => unsubscribe(connection));
      res.on("error", () => unsubscribe(connection));
    },

    close(): void {
      for (const subscribers of channels.values()) {
        for (const connection of subscribers) connection.res.end();
      }
      channels.clear();
    },
  };
}
