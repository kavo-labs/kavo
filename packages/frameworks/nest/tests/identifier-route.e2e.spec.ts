import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * `identifier` config key (ADR-0052): the generated `…One` routes still
 * bind `:id`, but the engine resolves it against the configured field
 * (`title`, here) instead of `Todo`'s primary key.
 */

let app: INestApplication;
let adapter: InMemoryTodoAdapter;
let httpServer: SupertestTarget | undefined;

@Kavo(Todo, { identifier: { field: "title" } })
@Controller("todos")
class TodoByTitleController {}

async function bootstrap(): Promise<void> {
  adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter) }),
      KavoModule.forFeature([TodoByTitleController]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
}

afterEach(async () => {
  httpServer = undefined;
  await app.close();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

describe("identifier config key — @kavo/nest route generation (ADR-0052)", () => {
  it("resolves the generated :id param against the configured field", async () => {
    await bootstrap();
    const created = await request(server()).post("/todos").send({ title: "write-docs", priority: 2 }).expect(201);
    expect(created.body).toMatchObject({ title: "write-docs" });

    // The real primary key (`1`) no longer resolves — `identifier` replaced
    // the lookup axis, it did not add a second one.
    await request(server()).get("/todos/1").expect(404);

    const found = await request(server()).get("/todos/write-docs").expect(200);
    expect(found.body).toMatchObject({ title: "write-docs", priority: 2 });

    await request(server())
      .patch("/todos/write-docs")
      .send({ priority: 5 })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ priority: 5 }));

    await request(server()).delete("/todos/write-docs").expect(204);
    await request(server()).get("/todos/write-docs").expect(404);
  });
});
