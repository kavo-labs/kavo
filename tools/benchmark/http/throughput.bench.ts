import "reflect-metadata";
import { describe, it, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { Controller, Inject } from "@nestjs/common";
import { Kavo, KavoModule, getKavoServiceToken } from "@kavo/nest";
import type {
  ClassRef,
  DefaultKavoService,
  KavoInfrastructure,
  EntityId,
  EntityMetadata,
  NormalizedQueryContext,
  RepositoryAdapter,
} from "@kavo/core";
import { NotFoundException, NotDeletedException } from "@kavo/core";
import autocannon from "autocannon";

class Todo {
  id = 0;
  title = "";
  done = false;
  priority = 0;
}

const todoMetadata: EntityMetadata<Todo> = {
  entity: Todo,
  name: "Todo",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "title", kind: "string", nullable: false, generated: false },
    { name: "done", kind: "boolean", nullable: false, generated: false },
    { name: "priority", kind: "number", nullable: false, generated: false },
  ],
  relations: [],
};

class InMemoryTodoAdapter implements RepositoryAdapter<Todo> {
  rows: Todo[] = [];
  private nextId = 1;

  constructor() {
    for (let i = 0; i < 1_000; i++) {
      this.rows.push({ id: this.nextId++, title: `Todo ${i}`, done: i % 3 === 0, priority: i % 10 });
    }
  }

  async findOneById(id: EntityId): Promise<Todo | null> {
    return this.rows.find((r) => r.id === Number(id)) ?? null;
  }
  async findOne(): Promise<Todo | null> {
    return this.rows[0] ?? null;
  }
  async findMany(_q: NormalizedQueryContext<Todo>): Promise<readonly Todo[]> {
    return this.rows.slice(0, 20);
  }
  async count(): Promise<number> {
    return this.rows.length;
  }
  async create(data: Partial<Todo>): Promise<Todo> {
    const row = { ...new Todo(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }
  async update(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    const row = this.rows.find((r) => r.id === Number(id));
    if (!row) throw new NotFoundException({ messageParams: { entity: "Todo", id: String(id) } });
    Object.assign(row, data);
    return row;
  }
  async patch(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    return this.update(id, data);
  }
  async delete(_id: EntityId): Promise<void> {}
  async restore(id: EntityId): Promise<Todo> {
    throw new NotDeletedException({ messageParams: { entity: "Todo", id: String(id) } });
  }
  async purge(_id: EntityId): Promise<void> {}
}

function fakeInfrastructure(adapter: InMemoryTodoAdapter): KavoInfrastructure {
  return {
    metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
      if ((entity as ClassRef) !== Todo) throw new Error(`no metadata for ${entity.name}`);
      return todoMetadata as unknown as EntityMetadata<Entity>;
    },
    adapterFor<Entity extends object>() {
      return adapter as unknown as RepositoryAdapter<Entity>;
    },
  };
}

@Kavo(Todo, {
  operations: { createOne: true, findOne: true, findMany: true, updateOne: true, patchOne: true, deleteOne: true },
})
@Controller("todos")
class TodoController {
  constructor(@Inject(getKavoServiceToken(Todo)) readonly base: DefaultKavoService<Todo>) {}
}

let port: number;
let app: import("@nestjs/common").INestApplication;

beforeAll(async () => {
  const adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter) }),
      KavoModule.forFeature([TodoController]),
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") throw new Error("server not bound");
  port = address.port;
});

afterAll(async () => {
  await app?.close();
});

async function bench(label: string, url: string, method: string, body?: string): Promise<void> {
  const result = await autocannon({
    url,
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    body,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    connections: 50,
    duration: 10,
    pipelining: 10,
  });

  console.log(
    `  ${label.padEnd(30)} ${result.requests.average.toFixed(0).padStart(10)} req/sec` +
      `  p50=${result.latency.p50.toFixed(2).padStart(8)}ms` +
      `  p99=${result.latency.p99.toFixed(2).padStart(8)}ms` +
      `  total=${String(result.requests.total).padStart(10)}`,
  );
}

describe("HTTP throughput — fake (in-memory)", () => {
  it("GET /todos", async () => {
    await bench("GET /todos", `http://127.0.0.1:${port}/todos?limit=20&sort=-priority`, "GET");
  });

  it("GET /todos/:id", async () => {
    await bench("GET /todos/:id", `http://127.0.0.1:${port}/todos/500`, "GET");
  });

  it("POST /todos", async () => {
    await bench(
      "POST /todos",
      `http://127.0.0.1:${port}/todos`,
      "POST",
      JSON.stringify({ title: "bench", done: false, priority: 1 }),
    );
  });

  it("PATCH /todos/:id", async () => {
    await bench("PATCH /todos/:id", `http://127.0.0.1:${port}/todos/500`, "PATCH", JSON.stringify({ done: true }));
  });

  it("DELETE /todos/:id", async () => {
    await bench("DELETE /todos/:id", `http://127.0.0.1:${port}/todos/500`, "DELETE");
  });
});
