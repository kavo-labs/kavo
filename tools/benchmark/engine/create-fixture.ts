import type {
  ClassRef,
  KavoContext,
  KavoInfrastructure,
  EntityId,
  EntityMetadata,
  NormalizedQueryContext,
  RepositoryAdapter,
} from "@kavo/core";
import { NotFoundException, NotDeletedException, hasKeyset } from "@kavo/core";
import { createKavo } from "@kavo/core";

export class Todo {
  id = 0;
  title = "";
  done = false;
  priority = 0;
}

export const todoMetadata: EntityMetadata<Todo> = {
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

const SEED_COUNT = 1_000;

export class InMemoryTodoAdapter implements RepositoryAdapter<Todo> {
  rows: Todo[] = [];
  private nextId = 1;

  constructor(seedCount = SEED_COUNT) {
    for (let i = 0; i < seedCount; i++) {
      this.rows.push({
        id: this.nextId++,
        title: `Todo ${i}`,
        done: i % 3 === 0,
        priority: i % 10,
      });
    }
  }

  async findOneById(
    id: EntityId,
    _query: NormalizedQueryContext<Todo> | null,
    _context: KavoContext<Todo>,
  ): Promise<Todo | null> {
    return this.rows.find((row) => row.id === Number(id)) ?? null;
  }

  async findOne(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<Todo | null> {
    return this.live(query, context)[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<readonly Todo[]> {
    const { limit } = query.pagination;
    const offset = hasKeyset(query.pagination) ? 0 : query.pagination.offset;
    return this.live(query, context).slice(offset, offset + limit);
  }

  async count(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<number> {
    return this.live(query, context).length;
  }

  async create(data: Partial<Todo>): Promise<Todo> {
    const row = { ...new Todo(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    const row = this.require(id);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    return this.update(id, data);
  }

  async delete(id: EntityId, _context: KavoContext<Todo>): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== Number(id));
  }

  async restore(id: EntityId, _context: KavoContext<Todo>): Promise<Todo> {
    throw new NotDeletedException({ messageParams: { entity: "Todo", id: String(id) } });
  }

  async purge(id: EntityId, _context: KavoContext<Todo>): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== Number(id));
  }

  private live(query: NormalizedQueryContext<Todo>, _context: KavoContext<Todo>): readonly Todo[] {
    return this.rows;
  }

  private require(id: EntityId): Todo {
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null) {
      throw new NotFoundException({
        messageParams: { entity: "Todo", id: String(id) },
      });
    }
    return row;
  }
}

export function fakeInfrastructure(adapter: InMemoryTodoAdapter): KavoInfrastructure {
  return {
    metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
      if ((entity as ClassRef) !== Todo) {
        throw new Error(`no metadata for ${entity.name}`);
      }
      return todoMetadata as unknown as EntityMetadata<Entity>;
    },
    adapterFor<Entity extends object>() {
      return adapter as unknown as RepositoryAdapter<Entity>;
    },
  };
}

export interface Fixture {
  adapter: InMemoryTodoAdapter;
  service: ReturnType<ReturnType<typeof createKavo>["createCrud"]>;
}

export function createFixture(seedCount = SEED_COUNT): Fixture {
  const adapter = new InMemoryTodoAdapter(seedCount);
  const infrastructure = fakeInfrastructure(adapter);
  const service = createKavo({ infrastructure }).createCrud(Todo) as Fixture["service"];
  return { adapter, service };
}
