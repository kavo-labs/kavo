import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { KAVO_API_GUIDE } from "@kavo/nest";
import { AppModule } from "./app.module.js";
import { createPostgresOrm, createSqliteOrm } from "./database.js";

/**
 * The Pet example over MikroORM — the same domain `nest-typeorm` serves,
 * under a different adapter. Runs on in-memory SQLite by default, so
 * `pnpm start` needs nothing installed; set the usual `PG*` variables to
 * point it at a Postgres instead:
 *
 *   docker run --rm -e POSTGRES_PASSWORD=kavo -p 5432:5432 postgres:18-alpine
 *   PGDATABASE=postgres PGPASSWORD=kavo node dist/main.js
 */
async function bootstrap(): Promise<void> {
  const usePostgres = process.env["PGDATABASE"] !== undefined;
  const orm = usePostgres
    ? await createPostgresOrm({
        host: process.env["PGHOST"] ?? "127.0.0.1",
        port: Number(process.env["PGPORT"] ?? 5432),
        user: process.env["PGUSER"] ?? "postgres",
        password: process.env["PGPASSWORD"] ?? "postgres",
        dbName: process.env["PGDATABASE"] ?? "postgres",
      })
    : await createSqliteOrm();

  // `$ilike` is PostgreSQL-only; on any other driver it is a syntax error.
  const app = await NestFactory.create(AppModule.forRoot({ orm, caseInsensitiveFilters: usePostgres }));

  // `search[...]`/conditional-request Swagger docs finish in `KavoModule`'s
  // discovery binder, an `onModuleInit` hook that hasn't run yet at this
  // point in `bootstrap` — it fires inside `app.listen()` below. A factory
  // here (rather than a plain document) defers `createDocument()` until the
  // first request for the docs, by which point that hook has completed.
  const buildDocument = (): ReturnType<typeof SwaggerModule.createDocument> =>
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Kavo — Pet example (MikroORM)")
        .setDescription(
          "Cats, dogs, owners, tags and addresses: full CRUD over HTTP " +
            "through @kavo/mikroorm, with single-table inheritance, filtering, " +
            "sorting, pagination, layered config, RFC 9457 problem-details " +
            "errors, `?include=owner`/`?include=pets`/`?include=tags` " +
            "relations loaded by populate, filtering and sorting across a " +
            "relation path, and soft delete with restore/purge on owners.\n\n" +
            KAVO_API_GUIDE,
        )
        .setVersion("0.0.0")
        .build(),
    );
  SwaggerModule.setup("docs", app, buildDocument);

  await app.listen(3002);
}

void bootstrap();
