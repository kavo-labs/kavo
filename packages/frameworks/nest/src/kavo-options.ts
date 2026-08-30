import type {
  CacheStore,
  KavoInfrastructure,
  KavoSettings,
  DeepPartial,
  PaginationStrategy,
  RealtimeTransport,
} from "@kavo/core";
import type { KavoAppContextExtractor } from "./app-context.js";

/**
 * `KavoModule.forRoot` options — the NestJS skin over core's
 * `createKavo`: `defaults` is the same global-scope settings
 * tree, passed through untouched.
 *
 * `infrastructure` arrives from the application (e.g.
 * `createInfrastructure(dataSource)`), not from an `orm: "typeorm"`
 * string: `@kavo/nest` must not import ORM adapters (adapters reach Nest
 * via DI, not imports), and an explicit
 * object keeps the door open for any adapter without a registry of names.
 */
export interface KavoModuleOptions {
  readonly infrastructure?: KavoInfrastructure;
  readonly defaults?: DeepPartial<KavoSettings>;
  readonly paginationStrategies?: readonly PaginationStrategy[];
  /**
   * Realtime transports every entity's write events publish to — the same
   * root-scope option `createKavo`'s own `KavoOptions.realtimeTransports`
   * is, threaded through unchanged. Registered once, process-wide, not
   * per entity (ADR-0023: a transport is a live object and cannot live
   * inside `defaults`/the settings tree). An entity still needs its own
   * `realtime: { events: {...} }` (any object; only `false` turns it off) —
   * in `defaults` here or
   * in that entity's own `@Kavo` config — before any of its writes publish
   * anything; registering a transport alone does not turn realtime on.
   */
  readonly realtimeTransports?: readonly RealtimeTransport[];
  /**
   * The result-cache store every entity reads/writes when `cache` is
   * enabled — the same root-scope option `createKavo`'s own
   * `KavoOptions.cacheStore` is, threaded through unchanged. Registered
   * once, process-wide, not per entity (ADR-0031 applies the ADR-0023
   * reasoning to caching: a store is a live object — a Redis client, say —
   * and cannot live inside `defaults`/the settings tree). Unset, each root
   * gets its own private in-memory store; hand the same instance here for
   * one process-wide cache. An entity still needs its own `cache:
   * { ttl: … }` — in `defaults` here or in that entity's own `@Kavo`
   * config — before any of its reads are served from the store; registering
   * a store alone does not turn caching on.
   */
  readonly cacheStore?: CacheStore;
  /**
   * Builds the application's request-scoped context (`KavoAppContext`) that
   * every generated route puts on `KavoContext.app` — a function off the
   * incoming request, e.g. `(request) => request.user as KavoAppContext`.
   * Module scope rather than an assumption, because a Nest app's guard may
   * leave the caller anywhere and the context's shape is the app's to
   * define. Unset means `KavoContext.app` stays `{}`.
   *
   * It is `@kavo/nest`'s own concern and never reaches `createKavo`: core
   * takes the app context per call (`KavoCallOptions.app`) and has no idea
   * what an HTTP request is (ADR-0005).
   */
  readonly app?: KavoAppContextExtractor;
}
