import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { listen, type SupertestTarget } from "./support/listen.js";

/**
 * Pins the contract every HTTP suite in this package leans on (issue #91):
 * `listen(app)` leaves the app bound — on the loopback, on a port nobody
 * chose — before the first request, and keeps it bound until the app is
 * closed. Under the `app.init()` bootstrap this replaced, the server was
 * unbound, so supertest bound a fresh wildcard port per request and raced
 * every other local process on the machine for it.
 *
 * Each assertion here fails against a different wrong bootstrap:
 * `app.init()` and a fixed port and a wildcard `listen(0)` are each caught
 * by at least one test below. That matters because the issue rules out a
 * fixed port explicitly — it is one of the three non-fixes (with retries
 * and raised timeouts) that hide the collision rather than removing it.
 */
@Kavo(Todo)
@Controller("todos")
class TodoController {}

/**
 * Every app a test bootstraps, closed in `afterEach`. An array rather than
 * a single `let app`, because one test binds two apps at once and another
 * closes its app mid-test; `splice` makes the double close a no-op, and a
 * `bootstrap` that throws before pushing leaves nothing to close, so the
 * real failure surfaces instead of a `TypeError` here.
 */
const apps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function bootstrap(): Promise<{ app: INestApplication; server: SupertestTarget }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature([TodoController]),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  apps.push(app);
  return { app, server: await listen(app) };
}

function boundAddress(server: SupertestTarget): AddressInfo {
  const address = (server as Server).address();
  if (address === null || typeof address === "string") {
    throw new Error("server is not bound to a TCP address");
  }
  return address;
}

describe("listen — the e2e bootstrap", () => {
  it("binds on the loopback before any request is made", async () => {
    const { server } = await bootstrap();
    expect(boundAddress(server).address).toBe("127.0.0.1");
  });

  it("takes a port the OS chose, so two apps can be bound at once", async () => {
    // A fixed port would satisfy every other test in this file — each of
    // those binds one app and closes it — while making any two suites that
    // run in parallel workers collide. Binding two at once is what tells
    // `listen(0, host)` apart from `listen(3000, host)`.
    const first = await bootstrap();
    const second = await bootstrap();

    const firstPort = boundAddress(first.server).port;
    const secondPort = boundAddress(second.server).port;
    expect(firstPort).toBeGreaterThan(0);
    expect(secondPort).not.toBe(firstPort);

    // Both are live and independent: each answers only for its own state.
    await request(first.server).post("/todos").send({ title: "on the first app" }).expect(201);
    expect((await request(first.server).get("/todos").expect(200)).body.total).toBe(1);
    expect((await request(second.server).get("/todos").expect(200)).body.total).toBe(0);
  });

  it("serves every request over that one binding instead of a new one each time", async () => {
    const { server } = await bootstrap();
    const bound = boundAddress(server).port;

    // Asserting the response body, not just a 200: a foreign process
    // holding the port can answer 200 too, which is exactly how this bug
    // used to disguise itself. Cross-request state is what proves both
    // requests reached *this* app.
    const created = await request(server).post("/todos").send({ title: "same binding" }).expect(201);
    const listed = await request(server).get("/todos").expect(200);
    expect(listed.body).toMatchObject({ limit: expect.any(Number), offset: 0, total: 1 });
    expect(listed.body).not.toHaveProperty("meta");
    expect(listed.body.items).toEqual([expect.objectContaining({ id: created.body.id, title: "same binding" })]);

    // Still ours, still the same port — supertest never took the server
    // over, which it would have done had it needed to bind one itself.
    expect((server as Server).listening).toBe(true);
    expect(boundAddress(server).port).toBe(bound);
  });

  it("releases the port on close, and binds a fresh one next time", async () => {
    const first = await bootstrap();
    const firstPort = boundAddress(first.server).port;

    await first.app.close();
    expect((first.server as Server).address()).toBeNull();
    expect((first.server as Server).listening).toBe(false);

    const second = await bootstrap();
    expect(boundAddress(second.server).port).not.toBe(firstPort);
    await request(second.server).get("/todos").expect(200);
  });
});
