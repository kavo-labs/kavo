import { createRequire } from "node:module";
import type { INestApplication } from "@nestjs/common";
import { ConfigurationException } from "@kavo/core";
import { registerKavoSchemas } from "./register-schemas.js";

/**
 * `setupKavoSwagger` — one call that serves the Kavo OpenAPI document at
 * `/{path}` and `/{path}-json`, with both of Swagger's undiscoverable
 * ordering rules already handled.
 *
 * Wiring `@nestjs/swagger` into a `@Kavo` app by hand means threading a
 * needle:
 *
 * - `SwaggerModule.setup()` registers the `/docs` routes on the HTTP
 *   adapter, and that has to happen **before** `app.init()` /
 *   `app.listen()` — a `setup()` after init registers routes the router
 *   scan has already passed, so every `/docs` request 404s with nothing
 *   to explain why;
 * - the document itself cannot be built until **after**
 *   `KavoModule`'s discovery binder has run (`onModuleInit`), which fires
 *   *inside* `app.init()` — the `search[...]` params, the
 *   conditional-request headers, and the `<Entity>Query` / `Filter` /
 *   `Sort` / `Pagination` / `ValidationError` component schemas are all
 *   attached there.
 *
 * The only sequence that satisfies both is: register the routes now, hand
 * `setup()` a *factory* that defers `createDocument()` to the first
 * request for the docs (by which point every `onModuleInit` pass has
 * completed), and memoize its result. This helper is that sequence.
 *
 * ```ts
 * const app = await NestFactory.create(AppModule);
 * setupKavoSwagger(app, {
 *   config: new DocumentBuilder().setTitle("My API").setVersion("1.0.0").build(),
 * });
 * await app.listen(3000);
 * ```
 *
 * `@nestjs/swagger` is an optional peer: when it is not installed this
 * throws a descriptive `ConfigurationException` (`KAVO_CONFIG_INVALID`),
 * not a bare module-resolution error. It also throws — rather than
 * silently registering dead routes — when it is called after the app has
 * initialised.
 */
export interface KavoSwaggerOptions {
  /**
   * The base OpenAPI document, i.e. `new DocumentBuilder()....build()`.
   * Everything except `paths` — Swagger fills those in from the app.
   */
  readonly config: object;
  /**
   * URL segment the docs UI is mounted at. Default `"docs"` — so
   * `GET /docs` (UI) and `GET /docs-json` (the raw document).
   */
  readonly path?: string;
  /** Passed straight through to `SwaggerModule.createDocument`. */
  readonly documentOptions?: object;
  /** Passed straight through to `SwaggerModule.setup`. */
  readonly swaggerOptions?: object;
}

type SwaggerModuleSurface = {
  createDocument(app: INestApplication, config: object, options?: object): object;
  setup(path: string, app: INestApplication, documentOrFactory: object | (() => object), options?: object): void;
};

let cached: { SwaggerModule: SwaggerModuleSurface } | null | undefined;

/**
 * Load `@nestjs/swagger` through `createRequire` — the same optional-peer
 * pattern `swagger.ts` uses, so `tsc -b` never depends on the peer being
 * present. Returns `null` (rather than throwing) when it is absent; the
 * caller turns that into a descriptive error.
 */
function loadSwaggerModule(): { SwaggerModule: SwaggerModuleSurface } | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    cached = require("@nestjs/swagger") as { SwaggerModule: SwaggerModuleSurface };
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The `@nestjs/swagger`-is-not-installed error. Factored out so it can be
 * asserted (code + wording) without uninstalling the workspace peer —
 * `vi.mock` cannot reach a `createRequire` call.
 */
export function swaggerPeerMissingError(): ConfigurationException {
  return new ConfigurationException(
    "setupKavoSwagger",
    "@nestjs/swagger",
    "the optional peer '@nestjs/swagger' is not installed — run `pnpm add @nestjs/swagger` " +
      "to serve the Kavo OpenAPI document with setupKavoSwagger()",
  );
}

/** The called-too-late error — see `isAlreadyInitialised`. */
export function swaggerCallOrderError(path: string): ConfigurationException {
  return new ConfigurationException(
    "setupKavoSwagger",
    "call order",
    `setupKavoSwagger(app, …) was called after app.init()/app.listen(); the '/${path}' routes ` +
      "can no longer be registered and every request to them would 404. Move the call above " +
      "`await app.init()` / `await app.listen(...)`",
  );
}

/**
 * Nest's `NestApplication` sets a public `isInitialized` flag in `init()`
 * (and `listen()` calls `init()`), but the property is absent from the
 * `.d.ts` — so read it defensively and only act on a strict `true`. If a
 * future Nest renames or drops it this degrades to "no order guard"
 * rather than "always throws".
 */
function isAlreadyInitialised(app: INestApplication): boolean {
  return (app as { isInitialized?: boolean }).isInitialized === true;
}

export function setupKavoSwagger(app: INestApplication, options: KavoSwaggerOptions): void {
  const path = options.path ?? "docs";

  const loaded = loadSwaggerModule();
  if (loaded === null) {
    throw swaggerPeerMissingError();
  }

  if (isAlreadyInitialised(app)) {
    throw swaggerCallOrderError(path);
  }

  const { SwaggerModule } = loaded;

  // Deferred and memoised: `createDocument` runs on the first request for
  // the docs — after every `onModuleInit` pass — and its result is reused
  // for every request after that.
  let built: object | undefined;
  const buildDocument = (): object =>
    (built ??= registerKavoSchemas(SwaggerModule.createDocument(app, options.config, options.documentOptions)));

  SwaggerModule.setup(path, app, buildDocument, options.swaggerOptions);
}
