/**
 * The seam every consumer implements (#491): one way to run a registry
 * operation through a surface — the engine over a real adapter, a REST
 * route, a GraphQL document, an MCP tool call — and read back what a client
 * would see. Drivers live in each consuming package's `tests/`, never here,
 * so the testkit itself imports nothing but `@kavo/core` and `vitest`.
 */
export type SecuritySurface = "engine" | "rest-nest" | "rest-next" | "graphql" | "mcp";

/**
 * What a client sends. `query` is always the **wire** spelling — flat
 * bracket keys (`filter[name][eq]`, `sort`, `select`, `search[query]`) —
 * because that is the one grammar every surface's attacker can reach. A
 * programmatic surface translates what it can express (see
 * `SecurityDriver.grammar`) and answers `unsupported` for the rest.
 */
export interface SecurityInput {
  readonly id?: string | number;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * What the client got back. On success, `body` is normalized across
 * surfaces: `findMany` answers `{ items, total }`, and every single-row
 * operation answers the item itself. `code` is the stable `KAVO_*` code when the
 * surface exposes one; `status` is the HTTP status, or the status the
 * surface's error maps to. `unsupported` means the surface has no way to
 * express this input at all — the case is skipped for that driver, never
 * counted as passing.
 */
export type SecurityResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly code?: string; readonly body: unknown }
  | { readonly unsupported: string };

export interface SecurityDriver {
  readonly surface: SecuritySurface;
  /**
   * `wire`: the driver hands `query` to the surface's own wire parser (REST,
   * the engine's `WireQuery`). `programmatic`: the surface only takes a
   * structured query (GraphQL's `JSON` filter, MCP tool arguments), and the
   * driver translates `filter[field][op]` and `sort` into it.
   */
  readonly grammar: "wire" | "programmatic";
  call(operation: string, input: SecurityInput): Promise<SecurityResult>;
}

export function isUnsupported(result: SecurityResult): result is { readonly unsupported: string } {
  return "unsupported" in result;
}
