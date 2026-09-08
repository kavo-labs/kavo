import { describe, expect, it } from "vitest";
import type { EntityId, EntityMetadata, KavoContext, NormalizedQueryContext, RepositoryAdapter } from "@kavo/core";
import { ConfigurationException, NotFoundException, createKavo } from "@kavo/core";

/**
 * `identifier` config key (ADR-0052) — the `…One` lookup axis retargeted to
 * a scalar field other than the entity's primary key.
 *
 * Uses a dedicated fixture (`Account`, keyed by `id`, with a unique
 * `username`) rather than `support/user-fixture.ts`'s `InMemoryUserAdapter`:
 * that fixture's `findOneById` ignores its `identifierField` parameter and
 * never implements `supportsIdentifierField`, which is exactly what makes it
 * useful for the "adapter doesn't support this" rejection case below, but
 * unusable for the happy-path round-trip a real adapter needs to honor.
 */

class Account {
  id = 0;
  username = "";
  email = "";
  ownerId = 0;
}

const accountMetadata: EntityMetadata<Account> = {
  entity: Account,
  name: "Account",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "username", kind: "string", nullable: false, generated: false },
    { name: "email", kind: "string", nullable: false, generated: false },
    { name: "ownerId", kind: "number", nullable: false, generated: false },
  ],
  relations: [{ name: "owner", target: () => Object, cardinality: "one", includable: true, strategy: "join" }],
};

const compositeMetadata: EntityMetadata<Account> = {
  ...accountMetadata,
  compositeIdFields: ["id", "ownerId"],
};

/** Looks up by whatever `identifierField` the engine passes, like a real adapter. */
class InMemoryAccountAdapter implements RepositoryAdapter<Account> {
  rows: Account[] = [];
  private nextId = 1;

  async findOneById(
    id: EntityId,
    _query: NormalizedQueryContext<Account> | null,
    _context: KavoContext<Account>,
    identifierField?: string,
  ): Promise<Account | null> {
    const field = identifierField ?? "id";
    return this.rows.find((row) => String((row as unknown as Record<string, unknown>)[field]) === String(id)) ?? null;
  }

  async findOne(): Promise<Account | null> {
    return this.rows[0] ?? null;
  }

  async findMany(): Promise<readonly Account[]> {
    return this.rows;
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async create(data: Partial<Account>): Promise<Account> {
    const row = { ...new Account(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }

  async update(
    id: EntityId,
    data: Partial<Account>,
    context: KavoContext<Account>,
    identifierField?: string,
  ): Promise<Account> {
    const row = await this.require(id, context, identifierField);
    Object.assign(row, data);
    return row;
  }

  async patch(
    id: EntityId,
    data: Partial<Account>,
    context: KavoContext<Account>,
    identifierField?: string,
  ): Promise<Account> {
    return this.update(id, data, context, identifierField);
  }

  async delete(id: EntityId, context: KavoContext<Account>, identifierField?: string): Promise<void> {
    const row = await this.require(id, context, identifierField);
    this.rows = this.rows.filter((candidate) => candidate.id !== row.id);
  }

  async restore(): Promise<Account> {
    throw new Error("Account is not soft-deletable");
  }

  async purge(id: EntityId, context: KavoContext<Account>, identifierField?: string): Promise<void> {
    await this.delete(id, context, identifierField);
  }

  supportsIdentifierField(_field: string): boolean {
    return true;
  }

  private async require(id: EntityId, context: KavoContext<Account>, identifierField?: string): Promise<Account> {
    const row = await this.findOneById(id, null, context, identifierField);
    if (row === null) {
      throw new NotFoundException({ messageParams: { entity: "Account", id: String(id) } });
    }
    return row;
  }
}

/**
 * Same behavior, but never opts into `identifier` — the pre-existing
 * adapters, none of which implement `supportsIdentifierField`.
 */
function nonIdentifierAdapter(): RepositoryAdapter<Account> {
  const adapter = new InMemoryAccountAdapter() as Partial<RepositoryAdapter<Account>>;
  // An own `undefined` shadows the prototype method — `delete` alone would
  // not, since `supportsIdentifierField` is defined on the class prototype.
  adapter.supportsIdentifierField = undefined;
  return adapter as RepositoryAdapter<Account>;
}

describe("identifier config key (ADR-0052)", () => {
  it("defaults to the primary key when unset — byte-identical behavior", async () => {
    const adapter = new InMemoryAccountAdapter();
    const kavo = createKavo();
    const crud = kavo.createCrud(Account, undefined, { metadata: accountMetadata, adapter });
    const created = await crud.engine.execute({
      operation: "createOne",
      id: null,
      body: { username: "alice", email: "a@example.com", ownerId: 1 },
      query: null,
      options: null,
    } as never);
    const id = (created.item as { id: number }).id;
    const found = await crud.engine.execute({
      operation: "findOne",
      id,
      body: null,
      query: null,
      options: null,
    } as never);
    expect((found.item as { id: number }).id).toBe(id);
  });

  it("resolves findOne/updateOne/deleteOne by the configured field", async () => {
    const adapter = new InMemoryAccountAdapter();
    adapter.rows.push({ id: 1, username: "alice", email: "a@example.com", ownerId: 1 });
    const kavo = createKavo();
    const crud = kavo.createCrud(Account, { identifier: { field: "username" } } as never, {
      metadata: accountMetadata,
      adapter,
    });
    const found = await crud.engine.execute({
      operation: "findOne",
      id: "alice",
      body: null,
      query: null,
      options: null,
    } as never);
    expect((found.item as { username: string }).username).toBe("alice");

    const updated = await crud.engine.execute({
      operation: "updateOne",
      id: "alice",
      body: { username: "alice", email: "new@example.com", ownerId: 1 },
      query: null,
      options: null,
    } as never);
    expect((updated.item as { email: string }).email).toBe("new@example.com");

    await crud.engine.execute({
      operation: "deleteOne",
      id: "alice",
      body: null,
      query: null,
      options: null,
    } as never);
    expect(adapter.rows).toHaveLength(0);
  });

  it("rejects an unknown field name at bootstrap", () => {
    const kavo = createKavo();
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "nope" } } as never, {
        metadata: accountMetadata,
        adapter: new InMemoryAccountAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("rejects naming the entity's own primary key", () => {
    const kavo = createKavo();
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "id" } } as never, {
        metadata: accountMetadata,
        adapter: new InMemoryAccountAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("rejects a field of an unsupported kind", () => {
    const kavo = createKavo();
    const boolMetadata: EntityMetadata<Account> = {
      ...accountMetadata,
      fields: [...accountMetadata.fields, { name: "active", kind: "boolean", nullable: false, generated: false }],
    };
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "active" } } as never, {
        metadata: boolMetadata,
        adapter: new InMemoryAccountAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("rejects a relation name", () => {
    const kavo = createKavo();
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "owner" } } as never, {
        metadata: accountMetadata,
        adapter: new InMemoryAccountAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("rejects a composite-key entity", () => {
    const kavo = createKavo();
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "username" } } as never, {
        metadata: compositeMetadata,
        adapter: new InMemoryAccountAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });

  it("rejects an adapter that never implements supportsIdentifierField", () => {
    const kavo = createKavo();
    expect(() =>
      kavo.createCrud(Account, { identifier: { field: "username" } } as never, {
        metadata: accountMetadata,
        adapter: nonIdentifierAdapter(),
      }),
    ).toThrow(ConfigurationException);
  });
});
