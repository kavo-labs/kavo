import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, Injectable, Module } from "@nestjs/common";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule, type KavoGraphQLOption } from "@kavo/nest";
import { registerKavoGraphQLTypes } from "@kavo/graphql";
import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { listen } from "./support/listen.js";

/**
 * `graphql: { guards }` (issue #498): the zero-config GraphQL route carries
 * the guards it is given, resolved through DI like any controller's, and a
 * denying guard stops the request before any resolver — so any engine
 * call — runs. `default-graphql-controller.e2e.spec.ts` covers the
 * unguarded mount.
 */
const TodoType = new GraphQLObjectType({
  name: "Todo",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLInt) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    done: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});
const CreateTodoInput = new GraphQLInputObjectType({
  name: "CreateTodoInput",
  fields: {
    title: { type: new GraphQLNonNull(GraphQLString) },
    done: { type: GraphQLBoolean },
  },
});
registerKavoGraphQLTypes(Todo, { itemType: TodoType, createInputType: CreateTodoInput });

@Kavo(Todo)
@Controller("todos")
class TodoController {}

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class AllowAll implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** A dependency the guard below can only get through DI. */
@Injectable()
class ApiKeys {
  readonly valid = new Set(["secret"]);
}

@Module({ providers: [ApiKeys], exports: [ApiKeys] })
class ApiKeysModule {}

@Injectable()
class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeys) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
      "x-api-key"
    ];
    return header !== undefined && this.keys.valid.has(header);
  }
}

let app: INestApplication;

afterEach(async () => {
  await app.close();
});

const createMutation = { query: `mutation { createTodo(input: { title: "guarded", done: false }) { id title } }` };

async function boot(adapter: InMemoryTodoAdapter, graphql: KavoGraphQLOption) {
  const moduleRef = await Test.createTestingModule({
    imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), graphql })],
    controllers: [TodoController],
  }).compile();
  app = moduleRef.createNestApplication();
  return listen(app);
}

describe("KavoModule.forRoot({ graphql: { guards } })", () => {
  it("still serves the route unguarded when no guards are given", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { path: "graphql" });

    const created = await request(server).post("/graphql").send(createMutation).expect(200);

    expect(created.body.errors).toBeUndefined();
    expect(adapter.rows).toHaveLength(1);
  });

  it("refuses with 403 when a guard denies, before any resolver or engine call runs", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [DenyAll] });

    await request(server).post("/graphql").send(createMutation).expect(403);
    await request(server).post("/graphql").send({ query: "{ todos { items { id } } }" }).expect(403);
    await request(server).post("/graphql").send({ query: "{ __typename }" }).expect(403);
    // Neither the write nor the read reached the adapter.
    expect(adapter.rows).toEqual([]);
    expect(adapter.lastQuery).toBeNull();
  });

  it("is covered by an app-wide APP_GUARD with no guards option", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), graphql: true })],
      controllers: [TodoController],
      providers: [{ provide: APP_GUARD, useClass: DenyAll }],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await request(server).post("/graphql").send(createMutation).expect(403);
    expect(adapter.rows).toEqual([]);
  });

  it("serves the route when every guard allows", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [AllowAll] });

    const created = await request(server).post("/graphql").send(createMutation).expect(200);

    expect(created.body.errors).toBeUndefined();
    expect(created.body.data.createTodo).toEqual({ id: 1, title: "guarded" });
  });

  it("applies a guard given as an instance rather than a class", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [new DenyAll()] });

    await request(server).post("/graphql").send(createMutation).expect(403);
    expect(adapter.rows).toEqual([]);
  });

  it("keeps a custom path alongside the guards", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { path: "api/graphql", guards: [DenyAll] });

    await request(server).post("/api/graphql").send(createMutation).expect(403);
    await request(server).post("/graphql").send(createMutation).expect(404);
  });

  it("resolves a guard's own dependency through DI under forRootAsync", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          imports: [ApiKeysModule],
          useFactory: () => ({ infrastructure: fakeInfrastructure(adapter) }),
          graphql: { guards: [ApiKeyGuard] },
        }),
      ],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await request(server).post("/graphql").send(createMutation).expect(403);
    await request(server).post("/graphql").set("x-api-key", "wrong").send(createMutation).expect(403);
    expect(adapter.rows).toEqual([]);

    const created = await request(server).post("/graphql").set("x-api-key", "secret").send(createMutation).expect(200);
    expect(created.body.errors).toBeUndefined();
    expect(adapter.rows).toHaveLength(1);
  });
});
