import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Column, DataSource, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from "typeorm";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * `arrayMutation.strategy: "resource"` (ADR-0029's resource amendment)
 * driven over real HTTP, against a real SQLite database — closing the one
 * gap the rest of this feature's test suite (core's fake-adapter engine
 * tests, `@kavo/typeorm`'s adapter-level tests, `@kavo/nest`'s
 * route-metadata-only tests) leaves open: whether NestJS actually delivers
 * a request body on `DELETE :id/<relation>`. Every other `DELETE` route
 * Kavo generates (`deleteOne`, `purgeOne`) is bodyless, so `remove<Relation>`
 * is the one route in the framework where this is a genuine question, not
 * an assumption route metadata alone can answer.
 *
 * Builds its own module rather than reusing `AppModule`, matching
 * `pagination-caching.e2e.spec.ts`'s own precedent: the reference app is
 * adopter-facing documentation and should not carry entities that exist
 * only for a test.
 *
 * `add`/`remove<Relation>`'s body is documented as "a single scalar id or
 * an `{id}` reference" — both are legal JSON and both narrow the same way
 * through `KavoEngine`'s own deserializer. Only the `{id}` form is
 * exercised here: `@nestjs/platform-express`'s default `body-parser.json()`
 * runs in `strict` mode, which — unlike the JSON grammar itself — refuses a
 * bare top-level scalar (`"3"` in the raw body) before the request ever
 * reaches Nest's routing, let alone Kavo's engine. That is a host-framework
 * body-parser default, not anything `@kavo/nest`/`@kavo/core` enforce — a
 * bare-scalar body still deserializes correctly at the engine level
 * (`packages/core/tests/array-mutation-resource.spec.ts` covers it
 * directly) for any caller whose body already arrived as parsed JSON
 * (a non-Express host adapter, a `strict: false` body parser, or a
 * programmatic caller) — but a real Nest+Express deployment on its
 * defaults only ever delivers the `{id}` form, so that is what this file
 * pins as the one HTTP-reachable shape.
 */

@Entity()
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

@Entity()
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];
}

@Kavo(Tag)
@Controller("resource-tags")
class TagController {}

@Kavo(Book, {
  arrayMutation: { strategy: "resource" },
  relations: { edges: { tags: { write: true } } },
} as never)
@Controller("resource-books")
class BookController {}

let dataSource: DataSource;
let app: INestApplication;
let httpServer: SupertestTarget | undefined;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Book, Tag],
    synchronize: true,
  });
  await dataSource.initialize();

  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: createInfrastructure(dataSource) }),
      KavoModule.forFeature([TagController, BookController]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
});

afterAll(async () => {
  httpServer = undefined;
  if (app !== undefined) {
    await app.close();
  }
  if (dataSource !== undefined) {
    await dataSource.destroy();
  }
});

beforeEach(async () => {
  await dataSource.getRepository(Book).clear();
  await dataSource.getRepository(Tag).clear();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

async function seed(): Promise<{ bookId: number; tagIds: number[] }> {
  const book = await dataSource.getRepository(Book).save({ title: "Dune" });
  const tags = await dataSource.getRepository(Tag).save([{ name: "sci-fi" }, { name: "classic" }]);
  return { bookId: book.id, tagIds: tags.map((tag) => tag.id) };
}

describe("resource strategy sub-collection routes over real HTTP", () => {
  it("GET :id/tags lists current membership", async () => {
    const { bookId, tagIds } = await seed();
    await dataSource.createQueryBuilder().relation(Book, "tags").of(bookId).add([tagIds[0]]);

    const response = await request(server()).get(`/resource-books/${bookId}/tags`).expect(200);
    expect((response.body.tags as { id: number }[]).map((tag) => tag.id)).toEqual([tagIds[0]]);
  });

  it("POST :id/tags adds one member by id", async () => {
    const { bookId, tagIds } = await seed();
    await request(server()).post(`/resource-books/${bookId}/tags`).send({ id: tagIds[0] }).expect(200);

    const reloaded = await dataSource.getRepository(Book).findOne({ where: { id: bookId }, relations: { tags: true } });
    expect(reloaded?.tags.map((tag) => tag.id)).toEqual([tagIds[0]]);
  });

  it("POST :id/tags is idempotent when the id is already a member", async () => {
    const { bookId, tagIds } = await seed();
    await dataSource.createQueryBuilder().relation(Book, "tags").of(bookId).add([tagIds[0]]);

    await request(server()).post(`/resource-books/${bookId}/tags`).send({ id: tagIds[0] }).expect(200);

    const reloaded = await dataSource.getRepository(Book).findOne({ where: { id: bookId }, relations: { tags: true } });
    expect(reloaded?.tags.map((tag) => tag.id)).toEqual([tagIds[0]]);
  });

  it("POST :id/tags 404s for a member id with no matching row", async () => {
    const { bookId } = await seed();
    await request(server()).post(`/resource-books/${bookId}/tags`).send({ id: 999999 }).expect(404);
  });

  // The gap this file exists to close: a real DELETE request's body,
  // delivered through NestJS's routing and body-parsing, must actually
  // reach the handler and the adapter — not just the route metadata that
  // says a body param is wired.
  it("DELETE :id/tags removes one member by id, the body naming it", async () => {
    const { bookId, tagIds } = await seed();
    await dataSource.createQueryBuilder().relation(Book, "tags").of(bookId).add([tagIds[0]!, tagIds[1]!]);

    await request(server()).delete(`/resource-books/${bookId}/tags`).send({ id: tagIds[0] }).expect(200);

    const reloaded = await dataSource.getRepository(Book).findOne({ where: { id: bookId }, relations: { tags: true } });
    expect(reloaded?.tags.map((tag) => tag.id)).toEqual([tagIds[1]]);
  });

  it("DELETE :id/tags 404s (KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND) for an id that is not currently a member", async () => {
    const { bookId, tagIds } = await seed();
    const response = await request(server())
      .delete(`/resource-books/${bookId}/tags`)
      .send({ id: tagIds[0] })
      .expect(404);
    expect(response.body.code).toBe("KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND");
  });

  it("PUT :id/tags still replaces the whole array, unchanged from the replace strategy", async () => {
    const { bookId, tagIds } = await seed();
    await request(server()).put(`/resource-books/${bookId}/tags`).send([tagIds[0], tagIds[1]]).expect(200);

    const reloaded = await dataSource.getRepository(Book).findOne({ where: { id: bookId }, relations: { tags: true } });
    expect(reloaded?.tags.map((tag) => tag.id).sort()).toEqual([...tagIds].sort());
  });
});
