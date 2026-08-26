import type {
  ClassRef,
  KavoContext,
  KavoInfrastructure,
  EntityId,
  EntityMetadata,
  NormalizedQueryContext,
  RepositoryAdapter,
} from "@kavo/core";
import { AlreadyDeletedException, NotDeletedException, NotFoundException, hasKeyset } from "@kavo/core";

/**
 * Test entity for binding tests — no ORM anywhere near this package. The
 * `deletedAt` marker makes it soft-deletable, which is what the
 * restore/purge route tests need.
 */
export class Todo {
  id = 0;
  title = "";
  done = false;
  priority = 0;
  deletedAt: Date | null = null;
  /** To-one relation, so `include=list` exercises the join path. */
  list: TodoList | null = null;
}

/**
 * The other side of the relation — never routed, only included. Its own
 * `list` relation (deliberately reusing the name `Todo.list` uses) reaches
 * a third entity, so tests can exercise a two-level include tree — e.g.
 * `relations.maxIncludeDepth`/`maxIncludedNodes` budgets, which a
 * single-level relation can never exceed once a positive integer is the
 * smallest legal setting.
 */
export class TodoList {
  id = 0;
  name = "";
  list: TodoTag | null = null;
}

/** Third entity in the relation chain — never routed, only included. */
export class TodoTag {
  id = 0;
  name = "";
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
    { name: "deletedAt", kind: "date", nullable: true, generated: true },
  ],
  relations: [
    {
      name: "list",
      target: () => TodoList,
      cardinality: "one",
      includable: false,
      strategy: "auto",
    },
  ],
  softDeleteField: "deletedAt",
};

export const todoListMetadata: EntityMetadata<TodoList> = {
  entity: TodoList,
  name: "TodoList",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
  ],
  relations: [
    {
      name: "list",
      target: () => TodoTag,
      cardinality: "one",
      includable: false,
      strategy: "auto",
    },
  ],
};

export const todoTagMetadata: EntityMetadata<TodoTag> = {
  entity: TodoTag,
  name: "TodoTag",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
  ],
  relations: [],
};

/**
 * In-memory adapter for the binding tests: pagination honored, the last
 * normalized query recorded so tests can assert the wire → AST wiring.
 * Filter *evaluation* belongs to real adapters (covered in
 * @kavo/typeorm's suite); the binding's job ends at handing the adapter
 * a validated query.
 */
export class InMemoryTodoAdapter implements RepositoryAdapter<Todo> {
  rows: Todo[] = [];
  lastQuery: NormalizedQueryContext<Todo> | null = null;
  private nextId = 1;

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Todo> | null,
    context: KavoContext<Todo>,
  ): Promise<Todo | null> {
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null) {
      return null;
    }
    return this.visible(row, context, query?.withDeleted ?? false, query?.onlyDeleted ?? false) ? row : null;
  }

  async findOne(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<Todo | null> {
    this.lastQuery = query;
    return this.live(query, context)[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<readonly Todo[]> {
    this.lastQuery = query;
    const { limit } = query.pagination;
    // Offset-only fixture: narrow rather than assume (ADR-0021).
    const offset = hasKeyset(query.pagination) ? 0 : query.pagination.offset;
    return this.live(query, context).slice(offset, offset + limit);
  }

  async count(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): Promise<number> {
    return this.live(query, context).length;
  }

  async create(data: Partial<Todo>): Promise<Todo> {
    const row = { ...new Todo(), ...data, id: this.nextId++ };
    // A relation arrives as an `{ id }` reference; a real
    // adapter would resolve it, and this fake keeps it as-is so the
    // binding tests can see what deserialization produced.
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    const row = await this.require(id);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<Todo>): Promise<Todo> {
    return this.update(id, data);
  }

  async delete(id: EntityId, context: KavoContext<Todo>): Promise<void> {
    const row = await this.require(id);
    if (context.config.softDelete.strategy === "hard") {
      this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
      return;
    }
    if (row.deletedAt !== null) {
      throw new AlreadyDeletedException({
        messageParams: { entity: context.entityName, id: String(id) },
      });
    }
    row.deletedAt = new Date();
  }

  /**
   * Soft delete, driven by the strategy the engine resolved rather than by
   * this fake's own opinion — `deletedAt` is a plain property here, which
   * is exactly what a marker column is.
   */
  async restore(id: EntityId, context: KavoContext<Todo>): Promise<Todo> {
    const row = await this.require(id);
    if (row.deletedAt === null) {
      throw new NotDeletedException({
        messageParams: { entity: context.entityName, id: String(id) },
      });
    }
    row.deletedAt = null;
    return row;
  }

  async purge(id: EntityId, context: KavoContext<Todo>): Promise<void> {
    const row = await this.require(id);
    if (context.config.softDelete.strategy === "soft" && row.deletedAt === null) {
      throw new NotDeletedException({
        messageParams: { entity: context.entityName, id: String(id) },
      });
    }
    this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
  }

  private live(query: NormalizedQueryContext<Todo>, context: KavoContext<Todo>): readonly Todo[] {
    return this.rows.filter((row) => this.visible(row, context, query.withDeleted, query.onlyDeleted));
  }

  /**
   * The three soft-delete views a read can ask for: live rows (the
   * default), everything (`withDeleted`), and the trash (`onlyDeleted`).
   * Driven by the resolved strategy rather than this fake's own opinion.
   */
  private visible(row: Todo, context: KavoContext<Todo>, withDeleted: boolean, onlyDeleted: boolean): boolean {
    if (context.config.softDelete.strategy !== "soft") {
      return true;
    }
    if (onlyDeleted) {
      return row.deletedAt !== null;
    }
    return withDeleted || row.deletedAt === null;
  }

  private async require(id: EntityId): Promise<Todo> {
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
      if ((entity as ClassRef) === TodoList) {
        return todoListMetadata as unknown as EntityMetadata<Entity>;
      }
      if ((entity as ClassRef) === TodoTag) {
        return todoTagMetadata as unknown as EntityMetadata<Entity>;
      }
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
