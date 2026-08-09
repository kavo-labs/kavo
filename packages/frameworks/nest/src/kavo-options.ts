import type { KavoInfrastructure, KavoSettings, DeepPartial, PaginationStrategy, RealtimeTransport } from "@kavo/core";
import type { KavoPrincipalOption } from "./principal.js";

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
   * `realtime: { enabled: true, events: {...} }` — in `defaults` here or
   * in that entity's own `@Kavo` config — before any of its writes publish
   * anything; registering a transport alone does not turn realtime on.
   */
  readonly realtimeTransports?: readonly RealtimeTransport[];
  /**
   * Where a generated route finds the authenticated caller to put on
   * `KavoContext.principal` — `true` for `request.user`, or a function for
   * anything else. Module scope rather than an assumption, because a Nest
   * app's guard may leave the caller anywhere; and an option rather than a
   * default, because populating it silently would change what every
   * existing `principal`-reading computed field or handler returns on
   * upgrade. Unset means `principal` stays `null`, as it always has.
   *
   * It is `@kavo/nest`'s own concern and never reaches `createKavo`: core
   * takes the principal per call (`KavoCallOptions.principal`) and has no
   * idea what an HTTP request is (ADR-0005).
   */
  readonly principal?: KavoPrincipalOption;
}
