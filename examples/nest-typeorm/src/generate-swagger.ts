import "reflect-metadata";
import { DocumentBuilder } from "@nestjs/swagger";
import { KAVO_API_GUIDE, writeKavoSwaggerFile } from "@kavo/nest";
import { AppModule } from "./app.module.js";

/**
 * `pnpm swagger:json` — writes the same document `setupKavoSwagger` serves
 * at `/docs-json` (`main.ts`) to `swagger.json`, through `@kavo/nest`'s
 * `writeKavoSwaggerFile` (`swagger-export.ts`) rather than any app-local
 * document-building logic, so every Kavo app generates its static document
 * the same way. Bootstraps `AppModule.forRoot()` (in-memory SQLite, no
 * realtime transports) purely to let `KavoModule`'s discovery binder resolve
 * every entity's config before the document is built — no server is
 * started.
 */
async function main(): Promise<void> {
  await writeKavoSwaggerFile(AppModule.forRoot(), {
    outFile: "swagger.json",
    config: new DocumentBuilder()
      .setTitle("Kavo — Pet example")
      .setDescription(
        "Cats, dogs, and owners: full CRUD over HTTP with filtering, sorting, pagination, " +
          "layered config, and RFC 9457 problem-details errors.\n\n" +
          KAVO_API_GUIDE,
      )
      .setVersion("0.0.0")
      .build(),
  });
}

void main();
