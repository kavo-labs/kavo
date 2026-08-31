import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder } from "@nestjs/swagger";
import { setupKavoSwagger } from "@kavo/nest";
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

  // `setupKavoSwagger` registers `/docs` now and defers the document build
  // to the first request — see `@kavo/nest`'s `swagger-setup.ts` for why
  // both halves of that ordering matter.
  setupKavoSwagger(app, {
    config: new DocumentBuilder()
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
  });

  await app.listen(3000);
}

void bootstrap();
