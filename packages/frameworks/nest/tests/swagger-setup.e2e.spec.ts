import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ConfigurationException } from "@kavo/core";
import { Kavo, KavoModule, registerKavoSchemas, setupKavoSwagger } from "@kavo/nest";
import { swaggerCallOrderError, swaggerPeerMissingError } from "../src/swagger-setup.js";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { listen } from "./support/listen.js";

/**
 * `setupKavoSwagger` (issue #348) is the one call that gets both of
 * Swagger's undiscoverable ordering rules right: register the `/docs`
 * routes before `app.init()`, but defer building the document until after
 * `KavoBinder.onModuleInit` has attached the query-schema / validation-
 * error components. These specs pin that it actually serves a *complete*
 * document, and that the after-`init()` misuse fails loudly rather than
 * 404ing in silence.
 */
@Kavo(Todo)
@Controller("todos")
class TodoController {}

const apps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature([TodoController]),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  apps.push(app);
  return app;
}

function baseConfig(): ReturnType<DocumentBuilder["build"]> {
  return new DocumentBuilder().setTitle("t").setVersion("0").build();
}

function schemaNames(document: unknown): string[] {
  return Object.keys((document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {});
}

describe("setupKavoSwagger — serves a complete document", () => {
  it("GET /docs and /docs-json 200, with the onModuleInit passes reflected", async () => {
    const app = await createApp();

    // Negative control: a document built *before* `app.init()` has not
    // seen `KavoBinder.onModuleInit`, so `registerKavoSchemas` finds no
    // `x-kavo-query-schemas` / entity-scoped 400 blob to hoist — no
    // `TodoQuery` / `TodoValidationError` component. (Pre-init
    // `createDocument` can also throw outright; either way the pass has
    // not run.)
    let beforeInit: string[] = [];
    try {
      beforeInit = schemaNames(registerKavoSchemas(SwaggerModule.createDocument(app, baseConfig())));
    } catch {
      /* pre-init createDocument threw — the point stands */
    }
    expect(beforeInit).not.toContain("TodoValidationError");
    expect(beforeInit).not.toContain("TodoQuery");

    setupKavoSwagger(app, { config: baseConfig() });
    const server = await listen(app);

    const json = await request(server).get("/docs-json").expect(200);
    // Every onModuleInit-only component is present in the *served* document.
    expect(schemaNames(json.body)).toEqual(
      expect.arrayContaining(["TodoValidationError", "TodoQuery", "TodoFilter", "TodoSort", "TodoPagination"]),
    );
    // And the route bodies `$ref` the hoisted components rather than
    // carrying an anonymous inline schema.
    const okSchema = (
      json.body as {
        paths: Record<
          string,
          { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } }
        >;
      }
    ).paths["/todos/{id}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema as { $ref?: string };
    expect(okSchema?.$ref).toMatch(/^#\/components\/schemas\//);

    await request(server).get("/docs").expect(200);
  });

  it("mounts under a custom path", async () => {
    const app = await createApp();
    setupKavoSwagger(app, { config: baseConfig(), path: "api-docs" });
    const server = await listen(app);

    await request(server).get("/api-docs-json").expect(200);
    await request(server).get("/docs-json").expect(404);
  });
});

describe("setupKavoSwagger — call-order safety", () => {
  it("throws a descriptive KAVO_CONFIG_INVALID when called after app.init(), never a silent 404", async () => {
    const app = await createApp();
    await app.init();

    expect(() => setupKavoSwagger(app, { config: baseConfig() })).toThrow(ConfigurationException);
    try {
      setupKavoSwagger(app, { config: baseConfig() });
      expect.unreachable("setupKavoSwagger should have thrown");
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as Error).message).toMatch(/app\.init/);
    }
  });
});

describe("setupKavoSwagger — error helpers", () => {
  it("swaggerPeerMissingError names the missing peer and how to install it", () => {
    const error = swaggerPeerMissingError();
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.message).toMatch(/@nestjs\/swagger/);
    expect(error.message).toMatch(/install|pnpm add/i);
  });

  it("swaggerCallOrderError names the offending path and the fix", () => {
    const error = swaggerCallOrderError("api-docs");
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.message).toMatch(/\/api-docs/);
    expect(error.message).toMatch(/app\.init/);
  });
});
