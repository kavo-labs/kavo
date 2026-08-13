import "reflect-metadata";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { DefaultKavoService, EntityMetadata, ResolvedEntityConfig } from "@kavo/core";
import { KAVO_API_GUIDE, getKavoServiceToken } from "@kavo/nest";
import { createTransport } from "@kavo/sse";
import { AppModule } from "./app.module.js";
import { Owner } from "./owner/owner.entity.js";

// `dist/main.js`'s own directory, ESM-style (`import.meta.url`, no `__dirname`)
// — `public/` sits one level up, alongside `dist/` and `src/`.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function bootstrap(): Promise<void> {
  // Filled in once the app finishes bootstrapping, below — `filterableEntities`
  // is only ever invoked at subscribe-request time (well after that), so
  // the forward reference through this mutable box is safe, the same
  // pattern `@kavo/sse`'s own README uses.
  let ownerService: DefaultKavoService<Owner> | undefined;

  const sse = createTransport({
    // Same erasure cast `kavo.ts`'s own `catalog.register` uses internally
    // — `ownerService.engine.config` is concretely typed per entity
    // (`ResolvedEntityConfig<Owner>`), while `FilterableEntity` serves
    // every entity through one callback and is not.
    filterableEntities: (entityName: string) =>
      entityName === "Owner" && ownerService !== undefined
        ? {
            metadata: ownerService.engine.metadata as EntityMetadata,
            config: ownerService.engine.config as unknown as ResolvedEntityConfig,
          }
        : undefined,
    // Narrows every outgoing Owner item to just these three fields —
    // unconditionally, whether or not a subscriber names `fields` (see
    // `@kavo/sse`'s own doc on why). `startedAt`/`createdAt`/`deletedAt`
    // stay off the wire.
    subscribableFields: (entityName: string) => (entityName === "Owner" ? ["id", "name", "email"] : undefined),
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(undefined, [sse]));
  // `provideServices: true` (app.module.ts) already registers this as a
  // real DI provider — resolvable synchronously right after `create`.
  ownerService = app.get(getKavoServiceToken(Owner));

  // Wide open, deliberately: this is a local reference app, not a
  // production service. Without it, a browser page on any other origin —
  // including a plain `file://` test page — has its `/realtime`
  // `EventSource` (and any `fetch`) silently blocked by CORS, which looks
  // indistinguishable from the server never responding.
  app.enableCors();

  // `search[...]`/conditional-request Swagger docs finish in `KavoModule`'s
  // discovery binder, an `onModuleInit` hook that hasn't run yet at this
  // point in `bootstrap` — it fires inside `app.listen()` below. A factory
  // here (rather than a plain document) defers `createDocument()` until the
  // first request for the docs, by which point that hook has completed.
  const buildDocument = (): ReturnType<typeof SwaggerModule.createDocument> =>
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Kavo — Pet example")
        .setDescription(
          "Cats, dogs, and owners: full CRUD over HTTP with filtering, " +
            "sorting, pagination, layered config, and RFC 9457 problem-details " +
            "errors. Single-table inheritance (Cat/Dog) and an Owner relation " +
            "model the schema, with opt-in relation includes " +
            "(`?include=owner`, `?include=pets`) and soft delete on owners.\n\n" +
            "### Realtime (SSE)\n\n" +
            "Owner writes also publish over SSE — see the realtime example " +
            "in the README (`GET /realtime?channel=Owner` or `Owner.<id>`, " +
            "optionally `&filter[...]=...`).\n\n" +
            KAVO_API_GUIDE,
        )
        .setVersion("0.0.0")
        .build(),
    );
  SwaggerModule.setup("docs", app, buildDocument);

  // `@kavo/sse` has no authentication of its own and is host-framework-
  // agnostic (plain `IncomingMessage`/`ServerResponse`, which Express's
  // request/response extend) — mounted here as an ordinary GET route
  // alongside the generated `@Kavo` controllers.
  app
    .getHttpAdapter()
    .getInstance()
    .get("/realtime", (req: unknown, res: unknown) => {
      void sse.handleRequest(req as never, res as never);
    });

  // A manual SSE test page (public/realtime-test.html), served same-origin
  // at GET /realtime-test.html — `enableCors()` above already makes a
  // cross-origin page work too, but same-origin needs no CORS at all, and
  // sidesteps browser-embedded-webview quirks (e.g. VS Code Live Preview)
  // that can behave differently from a real browser tab even with CORS
  // headers present.
  app.useStaticAssets(join(packageRoot, "public"));

  await app.listen(3000);
}

void bootstrap();
