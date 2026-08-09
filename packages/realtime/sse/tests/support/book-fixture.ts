import type { EntityId, EntityMetadata, RepositoryAdapter } from "@kavo/core";
import { NotFoundException } from "@kavo/core";

/**
 * The smallest entity this package's integration test needs: enough for
 * `createOne`/`patchOne` to round-trip through a real `KavoEngine` and
 * trigger the realtime emit hook, wired to a real `createTransport`
 * over a real HTTP server. Not a general-purpose fixture — every method
 * the engine doesn't exercise in these tests throws instead of pretending
 * to work.
 */
export class Book {
  id = 0;
  title = "";
  status: "draft" | "published" = "draft";
  price = 0;
}

export const bookMetadata: EntityMetadata<Book> = {
  entity: Book,
  name: "Book",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "title", kind: "string", nullable: false, generated: false },
    { name: "status", kind: "enum", nullable: false, generated: false, enumValues: ["draft", "published"] },
    { name: "price", kind: "number", nullable: false, generated: false },
  ],
  relations: [],
};

export class InMemoryBookAdapter implements RepositoryAdapter<Book> {
  rows: Book[] = [];
  private nextId = 1;

  async findOneById(id: EntityId): Promise<Book | null> {
    return this.rows.find((row) => row.id === Number(id)) ?? null;
  }

  async findOne(): Promise<Book | null> {
    return this.rows[0] ?? null;
  }

  async findMany(): Promise<readonly Book[]> {
    return this.rows;
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async create(data: Partial<Book>): Promise<Book> {
    const row = { ...new Book(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<Book>): Promise<Book> {
    const row = await this.require(id);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<Book>): Promise<Book> {
    return this.update(id, data);
  }

  async delete(id: EntityId): Promise<void> {
    await this.require(id);
    this.rows = this.rows.filter((row) => row.id !== Number(id));
  }

  async restore(): Promise<Book> {
    throw new Error("Book is not soft-deletable");
  }

  async purge(id: EntityId): Promise<void> {
    await this.delete(id);
  }

  private async require(id: EntityId): Promise<Book> {
    const row = await this.findOneById(id);
    if (row === null) {
      throw new NotFoundException({ messageParams: { entity: "Book", id: String(id) } });
    }
    return row;
  }
}
