import { buildKavoSchemas } from "@kavo/next";
import { authors, books } from "../../../src/kavo";

export function GET(): Response {
  const { schemas } = buildKavoSchemas({ authors, books });
  return Response.json({
    openapi: "3.1.0",
    info: { title: "next-prisma example", version: "0.1.0" },
    paths: {},
    components: { schemas },
  });
}
