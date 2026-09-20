/**
 * `generateKavoSwaggerDocument` / `writeKavoSwaggerFile` — produce a static
 * `swagger.json` for any Kavo Nest app, with no per-project script.
 *
 * `setupKavoSwagger` (`swagger-setup.ts`) serves the document live at
 * `/docs-json`, but "check the schema" workflows — a CI diff, a client
 * generator, a one-off inspection — want the document as a file, without
 * standing up an HTTP server. This bootstraps the given module in an
 * application context (`NestFactory.create`, never `.listen()`), waits for
 * `app.init()` — the same point `KavoModule`'s discovery binder has finished
 * attaching the search params, conditional-request headers, and
 * `<Entity>Query`/`Filter`/`Sort`/`Pagination`/`ValidationError` component
 * schemas (`buildSwaggerDocument`'s own ordering note) — builds the
 * document through the exact same `buildSwaggerDocument` path
 * `setupKavoSwagger` uses, then closes the app. One document-building code
 * path for both the live and the static route, so they can never drift.
 *
 * ```ts
 * // scripts/generate-swagger.ts, any Kavo app
 * import { writeKavoSwaggerFile } from "@kavo/nest";
 * import { DocumentBuilder } from "@nestjs/swagger";
 * import { AppModule } from "../src/app.module.js";
 *
 * await writeKavoSwaggerFile(AppModule, {
 *   outFile: "swagger.json",
 *   config: new DocumentBuilder().setTitle("My API").setVersion("1.0.0").build(),
 * });
 * ```
 */
import { writeFile } from "node:fs/promises";
import type { INestApplication } from "@nestjs/common";
import { buildSwaggerDocument, type KavoSwaggerOptions } from "./swagger-setup.js";

type NestFactoryStatic = {
  create(module: unknown, options?: object): Promise<INestApplication>;
};

/**
 * `@nestjs/core` is a required peer of `@kavo/nest` already (route
 * generation needs it), unlike `@nestjs/swagger` — so this loads eagerly
 * rather than through the optional-peer `createRequire` pattern
 * `swagger-setup.ts` uses for Swagger itself.
 */
async function loadNestFactory(): Promise<NestFactoryStatic> {
  const core = (await import("@nestjs/core")) as unknown as { NestFactory: NestFactoryStatic };
  return core.NestFactory;
}

export interface GenerateKavoSwaggerOptions extends KavoSwaggerOptions {
  /**
   * Suppress the bootstrapped app's own logger — a document-generation run
   * has no request to log, so Nest's default startup banner is just noise.
   * Default `true`.
   */
  readonly silent?: boolean;
}

/**
 * Bootstrap `module` in an application context, build its Kavo OpenAPI
 * document, close the app, and return the plain document object — no file
 * I/O. `writeKavoSwaggerFile` is the same thing plus a `writeFile`, for the
 * common "give me a `swagger.json`" case.
 */
export async function generateKavoSwaggerDocument(
  module: unknown,
  options: GenerateKavoSwaggerOptions,
): Promise<object> {
  const NestFactory = await loadNestFactory();
  const app = await NestFactory.create(module, {
    logger: options.silent === false ? undefined : false,
  });
  try {
    await app.init();
    return buildSwaggerDocument(app, options);
  } finally {
    await app.close();
  }
}

export interface WriteKavoSwaggerFileOptions extends GenerateKavoSwaggerOptions {
  /** Path to write the JSON document to, e.g. `"swagger.json"`. */
  readonly outFile: string;
}

/**
 * `generateKavoSwaggerDocument` plus a pretty-printed `writeFile` to
 * `outFile` — the one call a project's `scripts/generate-swagger.ts` needs.
 */
export async function writeKavoSwaggerFile(module: unknown, options: WriteKavoSwaggerFileOptions): Promise<object> {
  const document = await generateKavoSwaggerDocument(module, options);
  await writeFile(options.outFile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}
