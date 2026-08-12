import "reflect-metadata";
import mongoose from "mongoose";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { KAVO_API_GUIDE } from "@kavo/nest";
import { AppModule } from "./app.module.js";

/**
 * The Blog example over MongoDB, the counterpart to `nest-typeorm`'s Pet
 * example. Point `MONGO_URL` at any MongoDB instance:
 *
 *   docker run --rm -p 27017:27017 mongo:8
 */
async function bootstrap(): Promise<void> {
  await mongoose.connect(process.env["MONGO_URL"] ?? "mongodb://127.0.0.1:27017/kavo");

  const app = await NestFactory.create(AppModule.forRoot());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Kavo — Blog example (Mongoose)")
      .setDescription(
        "Authors and articles: full CRUD over HTTP through @kavo/mongoose, " +
          "with filtering, sorting, pagination, layered config, RFC 9457 " +
          "problem-details errors, an `?include=author` relation loaded by " +
          "populate, and soft delete with restore/purge. Ids are MongoDB " +
          "`_id` values, rendered as hex strings.\n\n" +
          KAVO_API_GUIDE,
      )
      .setVersion("0.0.0")
      .build(),
  );
  SwaggerModule.setup("docs", app, document);

  await app.listen(3001);
}

void bootstrap();
