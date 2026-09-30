import type { EntityId, KavoContext, NormalizedQueryContext, RepositoryAdapter } from "@kavo/core";
import { NotFoundException, evaluateFilter } from "@kavo/core";
import type { Vault } from "./fixture.js";

/**
 * A `RepositoryAdapter` over an array, for the surfaces whose own tests run
 * without a database (core, Nest, Next, GraphQL, MCP). It evaluates the full
 * filter AST with core's own `evaluateFilter` (the realtime transports'
 * evaluator), honours `query.filter` on the id lookup the way the adapter
 * contract requires, and orders, pages and counts — enough that every
 * corpus case exercises the same engine path a database adapter would.
 */
export class MemoryVaultAdapter implements RepositoryAdapter<Vault> {
  readonly rows: Vault[] = [];
  private nextId = 1;

  seed(rows: readonly (Omit<Vault, "id" | "rank"> & { rank?: number })[]): number[] {
    return rows.map((row) => {
      const id = this.nextId++;
      this.rows.push({ rank: 0, ...row, id });
      return id;
    });
  }

  read(id: EntityId): Vault | null {
    return this.rows.find((row) => row.id === Number(id)) ?? null;
  }

  async findOneById(id: EntityId, query: NormalizedQueryContext<Vault> | null): Promise<Vault | null> {
    const row = this.read(id);
    return row !== null && matches(row, query) ? { ...row } : null;
  }

  async findOne(query: NormalizedQueryContext<Vault>): Promise<Vault | null> {
    return (await this.findMany(query))[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<Vault>): Promise<readonly Vault[]> {
    const sorted = this.rows.filter((row) => matches(row, query)).sort((left, right) => compare(left, right, query));
    const offset = "offset" in query.pagination ? query.pagination.offset : 0;
    return sorted.slice(offset, offset + query.pagination.limit).map((row) => ({ ...row }));
  }

  async count(query: NormalizedQueryContext<Vault>): Promise<number> {
    return this.rows.filter((row) => matches(row, query)).length;
  }

  async create(data: Partial<Vault>): Promise<Vault> {
    const row: Vault = { apiKey: null, name: "", tenant: "", rank: 0, ...data, id: this.nextId++ };
    this.rows.push(row);
    return { ...row };
  }

  async update(id: EntityId, data: Partial<Vault>, context: KavoContext<Vault>): Promise<Vault> {
    return this.patch(id, data, context);
  }

  async patch(id: EntityId, data: Partial<Vault>, context: KavoContext<Vault>): Promise<Vault> {
    const row = this.read(id);
    if (row === null) {
      throw notFound(id, context);
    }
    Object.assign(row, data, { id: row.id });
    return { ...row };
  }

  async delete(id: EntityId, context: KavoContext<Vault>): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === Number(id));
    if (index === -1) {
      throw notFound(id, context);
    }
    this.rows.splice(index, 1);
  }

  async restore(id: EntityId, context: KavoContext<Vault>): Promise<Vault> {
    throw notFound(id, context);
  }

  async purge(id: EntityId, context: KavoContext<Vault>): Promise<void> {
    throw notFound(id, context);
  }
}

function matches(row: Vault, query: NormalizedQueryContext<Vault> | null): boolean {
  const root = query?.filter.root ?? null;
  return root === null || evaluateFilter(root as never, row as unknown as Record<string, unknown>);
}

function compare(left: Vault, right: Vault, query: NormalizedQueryContext<Vault>): number {
  for (const { field, direction } of query.sort) {
    const a = (left as unknown as Record<string, string | number>)[field as string]!;
    const b = (right as unknown as Record<string, string | number>)[field as string]!;
    if (a !== b) {
      return (a < b ? -1 : 1) * (direction === "desc" ? -1 : 1);
    }
  }
  return left.id - right.id;
}

function notFound(id: EntityId, context: KavoContext<Vault>): NotFoundException {
  return new NotFoundException({
    messageParams: { entity: context.entityName, id: String(id) },
    context: { entityName: context.entityName, operation: context.operation, correlationId: context.correlationId },
  });
}
