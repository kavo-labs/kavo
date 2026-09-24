import "reflect-metadata";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, Module } from "@nestjs/common";
import { DocumentBuilder } from "@nestjs/swagger";
import { Kavo, KavoModule, generateKavoSwaggerDocument, writeKavoSwaggerFile } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `generateKavoSwaggerDocument` / `writeKavoSwaggerFile` bootstrap a module
 * on their own — no `app` from the caller — so these pin that the static
 * document is the same *finished* one `setupKavoSwagger` serves (its
 * `onModuleInit`-dependent components included), and that the file variant
 * writes exactly the document it returns.
 */
@Kavo(Todo)
@Controller("todos")
class TodoController {}

@Module({
  imports: [
    KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
    KavoModule.forFeature([TodoController]),
  ],
})
class AppModule {}

function config(): ReturnType<DocumentBuilder["build"]> {
  return new DocumentBuilder().setTitle("t").setVersion("0").build();
}

function schemaNames(document: object): string[] {
  return Object.keys((document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {});
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generateKavoSwaggerDocument", () => {
  it("returns the finished document, with the components only onModuleInit contributes", async () => {
    const document = await generateKavoSwaggerDocument(AppModule, { config: config() });

    expect(Object.keys((document as { paths: object }).paths)).toContain("/todos");
    expect(schemaNames(document)).toEqual(expect.arrayContaining(["TodoItem", "TodoQuery", "TodoValidationError"]));
  });
});

describe("writeKavoSwaggerFile", () => {
  it("writes the returned document to outFile as pretty-printed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kavo-swagger-"));
    dirs.push(dir);
    const outFile = join(dir, "swagger.json");

    const document = await writeKavoSwaggerFile(AppModule, { config: config(), outFile, silent: false });

    const written = await readFile(outFile, "utf8");
    expect(written).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});
