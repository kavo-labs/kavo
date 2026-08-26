import type {
  KavoContext,
  EntityId,
  EntityMetadata,
  FilterExpression,
  NormalizedQueryContext,
  RepositoryAdapter,
  Sort,
} from "@kavo/core";
import { NotFoundException, hasKeyset, readFilter } from "@kavo/core";

/** Test entity: plain class, fields initialized so shapes exist at runtime. */
export class User {
  id = 0;
  name = "";
  email = "";
  age = 0;
  status: "active" | "pending" | "banned" = "active";
  createdAt: Date = new Date(0);
}

export const userMetadata: EntityMetadata<User> = {
  entity: User,
  name: "User",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
    { name: "email", kind: "string", nullable: false, generated: false },
    { name: "age", kind: "number", nullable: false, generated: false },
    {
      name: "status",
      kind: "enum",
      nullable: false,
      generated: false,
      enumValues: ["active", "pending", "banned"],
    },
    { name: "createdAt", kind: "date", nullable: false, generated: true },
  ],
  relations: [],
};

/**
 * In-memory adapter for engine tests: honors sorting and pagination, records
 * the queries it receives, and evaluates just enough of the filter AST
 * (`EQ`/`NE`/`GT`/`GTE`/`LT`/`LTE` plus `AND`/`OR`/`NOT`) for keyset
 * pagination to page for real. Full filter translation is the *database's*
 * job and is covered by the per-ORM integration suites.
 */
export class InMemoryUserAdapter implements RepositoryAdapter<User> {
  rows: User[] = [];
  lastQuery: NormalizedQueryContext<User> | null = null;
  private nextId = 1;

  async findOneById(id: EntityId): Promise<User | null> {
    return this.rows.find((row) => row.id === Number(id)) ?? null;
  }

  async findOne(query: NormalizedQueryContext<User>): Promise<User | null> {
    this.lastQuery = query;
    return this.rows[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<User>): Promise<readonly User[]> {
    this.lastQuery = query;
    // `readFilter`, not `query.filter` — the same call every real adapter
    // makes, so the keyset predicate is applied here too.
    const matched = this.match(readFilter(query).root).sort(comparatorFor(query.sort));
    const { pagination } = query;
    if (hasKeyset(pagination)) {
      return matched.slice(0, pagination.limit);
    }
    return matched.slice(pagination.offset, pagination.offset + pagination.limit);
  }

  async count(query: NormalizedQueryContext<User>): Promise<number> {
    // `query.filter`, deliberately: `total` spans the whole match set, so a
    // cursor never narrows it.
    return this.match(query.filter.root).length;
  }

  async create(data: Partial<User>): Promise<User> {
    const row = {
      ...new User(),
      ...data,
      id: this.nextId++,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<User>): Promise<User> {
    const row = await this.require(id);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<User>): Promise<User> {
    return this.update(id, data);
  }

  async delete(id: EntityId): Promise<void> {
    await this.require(id);
    this.rows = this.rows.filter((row) => row.id !== Number(id));
  }

  async restore(): Promise<User> {
    throw new Error("User is not soft-deletable");
  }

  async purge(id: EntityId): Promise<void> {
    await this.delete(id);
  }

  private match(root: FilterExpression<User> | null): User[] {
    return this.rows.filter((row) => matches(row, root));
  }

  private async require(id: EntityId): Promise<User> {
    const row = await this.findOneById(id);
    if (row === null) {
      throw new NotFoundException({
        messageParams: { entity: "User", id: String(id) },
      });
    }
    return row;
  }
}

export function contextStub(): KavoContext<User> {
  return {} as KavoContext<User>;
}

/**
 * A `KavoContext.repository` for a test whose subject never reaches for it
 * (ADR-0025 makes the field required). Every method throws rather than
 * returning a plausible empty answer, so a test that starts depending on
 * persistence says so instead of quietly passing against nothing.
 */
export function unusedRepository<Entity extends object = object>(): RepositoryAdapter<Entity> {
  const refuse = (method: string) => (): never => {
    throw new Error(`unusedRepository.${method} was called — this fixture only satisfies KavoContext.repository`);
  };
  return {
    findOneById: refuse("findOneById"),
    findOne: refuse("findOne"),
    findMany: refuse("findMany"),
    count: refuse("count"),
    create: refuse("create"),
    update: refuse("update"),
    patch: refuse("patch"),
    delete: refuse("delete"),
    restore: refuse("restore"),
    purge: refuse("purge"),
  } as unknown as RepositoryAdapter<Entity>;
}

/** Multi-key comparator; list order is precedence, as `Sort` documents. */
function comparatorFor(sort: readonly Sort<User>[]): (left: User, right: User) => number {
  return (left, right) => {
    for (const entry of sort) {
      const sign = compare(valueOf(left, entry.field as string), valueOf(right, entry.field as string));
      if (sign !== 0) {
        return entry.direction === "desc" ? -sign : sign;
      }
    }
    return 0;
  };
}

function matches(row: User, node: FilterExpression<User> | null): boolean {
  if (node === null) {
    return true;
  }
  if (node.kind === "group") {
    if (node.operator === "NOT") {
      return !matches(row, node.children[0]!);
    }
    const test = (child: FilterExpression<User>): boolean => matches(row, child);
    return node.operator === "AND" ? node.children.every(test) : node.children.some(test);
  }
  const actual = valueOf(row, node.field as string);
  const expected = node.value as number | string | boolean | Date | null;
  switch (node.operator) {
    case "EQ":
      return compare(actual, expected) === 0;
    case "NE":
      return compare(actual, expected) !== 0;
    case "GT":
      return compare(actual, expected) > 0;
    case "GTE":
      return compare(actual, expected) >= 0;
    case "LT":
      return compare(actual, expected) < 0;
    case "LTE":
      return compare(actual, expected) <= 0;
    default:
      throw new Error(`InMemoryUserAdapter does not evaluate '${node.operator}'`);
  }
}

function valueOf(row: User, field: string): number | string | boolean | Date | null {
  return (row as unknown as Record<string, number | string | boolean | Date | null>)[field] ?? null;
}

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) {
    return 0;
  }
  return (a as never) < (b as never) ? -1 : 1;
}
