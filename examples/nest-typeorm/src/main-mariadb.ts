import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";

// Matches the `docker run` command in examples/nest-typeorm/README.md.
const MARIADB_OPTIONS = {
  type: "mariadb",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "kavo",
  database: "kavo",
} as const;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.forRoot(MARIADB_OPTIONS));

  // See main.ts's own `buildDocument` factory for why this is deferred
  // rather than built eagerly here.
  const buildDocument = (): ReturnType<typeof SwaggerModule.createDocument> =>
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("Kavo — Pet example (MariaDB)")
        .setDescription(
          "Cats, dogs, and owners: full CRUD over HTTP with filtering, " +
            "sorting, pagination, layered config, and RFC 9457 problem-details " +
            "errors. Single-table inheritance (Cat/Dog) and an Owner relation " +
            "model the schema, with opt-in relation includes " +
            "(`?include=owner`, `?include=pets`) and soft delete on owners.",
        )
        .setVersion("0.0.0")
        .build(),
    );
  SwaggerModule.setup("docs", app, buildDocument);

  await app.listen(3000);
}

void bootstrap();
