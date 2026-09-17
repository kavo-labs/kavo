import { buildKavoSchemas } from "@kavo/next";
import { authors } from "../../../entities/author/author.service";
import { books } from "../../../entities/book/book.service";

export function GET(): Response {
  const { schemas } = buildKavoSchemas({ authors, books });
  return Response.json({
    openapi: "3.1.0",
    info: { title: "next-prisma example", version: "0.1.0" },
    paths: {},
    components: { schemas },
  });
}
