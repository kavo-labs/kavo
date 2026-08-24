import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import {
  ConflictException,
  NotFoundException,
  PatchNoChangesException,
  PersistenceException,
  QueryValidationException,
  type DefaultKavoService,
  type KavoInstance,
  type RepositoryAdapter,
} from "@kavo/core";
import { createInfrastructure, createMongooseKavo } from "@kavo/mongoose";
import {
  clearCollections,
  ensureIndexes,
  rejectionOf,
  startTestDatabase,
  type TestDatabase,
} from "./support/database.js";

interface Author {
  _id: string;
  email: string;
  name: string;
  age: number;
  status: string;
  bio: string | null;
  role: string;
}

interface Book {
  _id: string;
  title: string;
  author: string | null;
}

/** A well-formed ObjectId that is never inserted. */
const ABSENT_ID = "507f1f77bcf86cd799439011";

/**
 * Declared through a factory so the models keep their *inferred* Mongoose
 * types — annotating them with `ReturnType<connection["model"]>` would
 * collapse them to `Model<unknown>`.
 */
function defineModels(connection: TestDatabase["connection"]) {
  return {
    Author: connection.model(
      "Author",
      new Schema(
        {
          email: { type: String, required: true, unique: true },
          name: String,
          age: Number,
          status: { type: String, default: "active" },
          bio: { type: String, default: null },
          role: { type: String, enum: ["ADMIN", "MEMBER"], default: "MEMBER" },
        },
        { timestamps: true },
      ),
    ),
    Book: connection.model(
      "Book",
      new Schema({ title: String, author: { type: Schema.Types.ObjectId, ref: "Author" } }),
    ),
    // `select: false` is where a password hash or API key lives.
    Account: connection.model(
      "Account",
      new Schema({
        email: { type: String, required: true },
        apiKey: { type: String, select: false, default: () => "SECRET-abc123" },
      }),
    ),
  };
}

let database: TestDatabase;
let kavo: KavoInstance;
let models: ReturnType<typeof defineModels>;
let authors: DefaultKavoService<Author>;

beforeAll(async () => {
  database = await startTestDatabase();
  models = defineModels(database.connection);
  await ensureIndexes(models.Author, models.Book);

  kavo = createMongooseKavo(database.connection);
  // Double cast on purpose: Mongoose's model type describes a *hydrated
  // document*, while Kavo serves lean data with `_id` already rendered as a
  // string. The interfaces above are the shape the service actually
  // returns, which is what these tests assert.
  authors = kavo.createCrud(models.Author) as unknown as DefaultKavoService<Author>;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await clearCollections(database.connection);
});

async function seed(): Promise<void> {
  const rows = [
    { email: "ada@x.io", name: "Ada", age: 36, status: "active" },
    { email: "grace@x.io", name: "Grace", age: 45, status: "active" },
    { email: "alan@x.io", name: "Alan", age: 41, status: "banned" },
    { email: "joan@x.io", name: "Joan", age: 28, status: "pending" },
  ];
  for (const row of rows) await authors.createOne(row as never);
}

/** A normalized query with no filter — what a custom handler hands the reader. */
function unfilteredQuery() {
  return {
    filter: { root: null },
    sort: [],
    include: {},
    fields: { root: null, relations: {} },
    pagination: { limit: 10, offset: 0 },
    count: false,
    withDeleted: false,
    onlyDeleted: false,
  };
}

/** The context core resolves for `Author`, which configures no soft delete. */
function hardDeleteContext() {
  return { entityName: "Author", operation: "findOne", config: { softDelete: { strategy: "hard" } } };
}

function authorAdapter(): RepositoryAdapter<Author> {
  return createInfrastructure(database.connection).adapterFor(models.Author as never) as RepositoryAdapter<Author>;
}

describe("MongooseRepositoryAdapter — CRUD", () => {
  it("creates, reads, updates, patches, deletes against a real MongoDB", async () => {
    const created = (await authors.createOne({ email: "ada@x.io", name: "Ada", age: 36 } as never)) as Author;
    expect(created).toMatchObject({ name: "Ada", status: "active", role: "MEMBER" });

    const fetched = await authors.findOne(created._id);
    expect(fetched).toMatchObject({ email: "ada@x.io" });

    await authors.updateOne(created._id, { email: "ada@x.io", name: "Ada L", age: 37 } as never);
    const patched = await authors.patchOne(created._id, { age: 38 } as never);
    expect(patched).toMatchObject({ name: "Ada L", age: 38 });

    await authors.deleteOne(created._id);
    await expect(authors.findOne(created._id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns _id as a hex string, never a raw ObjectId", async () => {
    // This is the whole reason core's EntityId never grew a third member:
    // the conversion happens at the adapter boundary.
    const created = (await authors.createOne({ email: "hex@x.io", name: "Hex", age: 1 } as never)) as Author;
    expect(typeof created._id).toBe("string");
    expect(created._id).toMatch(/^[0-9a-f]{24}$/);

    const listed = (await authors.findMany()).items[0] as Author;
    expect(typeof listed._id).toBe("string");
  });

  it("omits Mongoose's __v bookkeeping from responses", async () => {
    await authors.createOne({ email: "v@x.io", name: "V", age: 1 } as never);
    expect((await authors.findMany()).items[0]).not.toHaveProperty("__v");
  });

  it("throws NotFound for reads, updates, and deletes on an absent id", async () => {
    const missing = await rejectionOf(authors.findOne(ABSENT_ID));
    expect(missing).toBeInstanceOf(NotFoundException);
    expect(missing.code).toBe("KAVO_NOT_FOUND");
    await expect(authors.updateOne(ABSENT_ID, { name: "x" } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(authors.deleteOne(ABSENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers 404 — not 500 — for an id that is not a valid ObjectId", async () => {
    // A malformed id names a document that cannot exist, so it is
    // indistinguishable from a well-formed id that simply isn't there.
    const error = await rejectionOf(authors.findOne("not-an-objectid"));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.code).toBe("KAVO_NOT_FOUND");
    await expect(authors.deleteOne("not-an-objectid")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("maps duplicate-key violations to ConflictException", async () => {
    await authors.createOne({ email: "dup@x.io", name: "A", age: 1 } as never);
    const error = await rejectionOf(authors.createOne({ email: "dup@x.io", name: "B", age: 2 } as never));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.code).toBe("KAVO_CONFLICT");
  });

  it("rejects a patch that carries no fields with KAVO_PATCH_NO_CHANGES", async () => {
    const created = (await authors.createOne({ email: "noop@x.io", name: "Noop", age: 5 } as never)) as Author;
    const error = await rejectionOf(authors.patchOne(created._id, {} as never));
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect(error.code).toBe("KAVO_PATCH_NO_CHANGES");
  });

  it("rejects a patch whose only field is the immutable id", async () => {
    const created = (await authors.createOne({ email: "id-only@x.io", name: "IdOnly", age: 5 } as never)) as Author;
    const error = await rejectionOf(authors.patchOne(created._id, { _id: created._id } as never));
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect(error.code).toBe("KAVO_PATCH_NO_CHANGES");
  });

  it("rejects an empty patch before checking whether the document exists", async () => {
    // The emptiness check is client-input validation, so it fires ahead of
    // any existence check — an absent id gets the same 400 a present one
    // would, not a 404.
    const error = await rejectionOf(authors.patchOne(ABSENT_ID, {} as never));
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect(error.code).toBe("KAVO_PATCH_NO_CHANGES");
  });
});

describe("MongooseRepositoryAdapter — reads that only a custom handler reaches", () => {
  // Every engine read addresses a document by id and goes through
  // `findOneById` with a query object, so neither `findOne(query, …)` nor a
  // null query has a generated route standing behind it. Both are still part
  // of the adapter's contract — a custom handler or a programmatic caller is
  // the way in — which is why they are exercised against the adapter
  // directly here rather than through a service.

  it("returns the single row a by-query read matches", async () => {
    await seed();
    const row = await authorAdapter().findOne(
      {
        ...unfilteredQuery(),
        filter: { root: { kind: "condition", field: "name", operator: "EQ", value: "Grace" } },
      } as never,
      hardDeleteContext() as never,
    );
    expect(row).toMatchObject({ name: "Grace", age: 45 });
  });

  it("answers null for a by-query read that matches nothing, rather than throwing", async () => {
    await seed();
    const row = await authorAdapter().findOne(
      {
        ...unfilteredQuery(),
        filter: { root: { kind: "condition", field: "name", operator: "EQ", value: "Nobody" } },
      } as never,
      hardDeleteContext() as never,
    );
    expect(row).toBeNull();
  });

  it("applies the by-query read's sort, so the row it returns is a chosen one", async () => {
    // `findOne` builds its own sort — the unsorted call would answer in
    // MongoDB's natural order, so "the youngest author" would be right only
    // by accident, and a dropped sort would never fail a hit/miss test.
    await seed();
    const row = await authorAdapter().findOne(
      { ...unfilteredQuery(), sort: [{ field: "age", direction: "asc" }] } as never,
      hardDeleteContext() as never,
    );
    expect(row).toMatchObject({ name: "Joan" });
  });

  it("reads by id with no query at all, and answers null for an absent one", async () => {
    // `findOneById`'s signature admits a null query — a caller with nothing
    // to ask beyond the id passes one — so every optional-chained read of
    // `include`/`withDeleted`/`onlyDeleted` has to hold with no query object
    // present rather than throwing on a property of null.
    const created = (await authors.createOne({ email: "byid@x.io", name: "ById", age: 3 } as never)) as Author;
    const adapter = authorAdapter();

    expect(await adapter.findOneById(created._id, null, hardDeleteContext() as never)).toMatchObject({ name: "ById" });
    expect(await adapter.findOneById(ABSENT_ID, null, hardDeleteContext() as never)).toBeNull();
  });
});

describe("MongooseRepositoryAdapter — query translation", () => {
  it("filters, sorts, and paginates in the database", async () => {
    await seed();
    const list = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "EQ", value: "active" },
      sort: [{ field: "age", direction: "desc" }],
      limit: 1,
      offset: 1,
    });
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Ada"]);
    expect(list.total).toBe(2); // total counts all matches, not the page
    expect(list.limit).toBe(1);
    expect(list.offset).toBe(1);
  });

  it("sorts by several keys in the order given", async () => {
    await seed();
    const list = await authors.findMany({
      sort: [
        { field: "status", direction: "asc" },
        { field: "age", direction: "desc" },
      ],
    });
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Grace", "Ada", "Alan", "Joan"]);
  });

  it("translates OR groups and NOT nodes", async () => {
    await seed();
    const either = await authors.findMany({
      filter: {
        kind: "group",
        operator: "OR",
        children: [
          { kind: "condition", field: "name", operator: "EQ", value: "Ada" },
          { kind: "condition", field: "status", operator: "EQ", value: "banned" },
        ],
      },
      sort: [{ field: "name", direction: "asc" }],
    });
    expect(either.items.map((author) => (author as Author).name)).toEqual(["Ada", "Alan"]);

    const negated = await authors.findMany({
      filter: {
        kind: "group",
        operator: "NOT",
        children: [{ kind: "condition", field: "status", operator: "EQ", value: "active" }],
      },
      sort: [{ field: "age", direction: "asc" }],
    });
    expect(negated.items.map((author) => (author as Author).name)).toEqual(["Joan", "Alan"]);
  });

  it("translates IN, BETWEEN, LIKE, ILIKE and null checks", async () => {
    await seed();
    const joan = (await authors.findMany()).items.map((a) => a as Author).find((a) => a.name === "Joan")!;
    await authors.patchOne(joan._id, { bio: "wrote code" } as never);

    const inSet = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "IN", value: ["banned", "pending"] },
    });
    expect(inSet.items).toHaveLength(2);

    const between = await authors.findMany({
      filter: { kind: "condition", field: "age", operator: "BETWEEN", value: [40, 50] },
    });
    expect(between.items.map((a) => (a as Author).name).sort()).toEqual(["Alan", "Grace"]);

    const like = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "LIKE", value: "A%" },
    });
    expect(like.items.map((a) => (a as Author).name).sort()).toEqual(["Ada", "Alan"]);

    const ilike = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "ILIKE", value: "a%" },
    });
    expect(ilike.items.map((a) => (a as Author).name).sort()).toEqual(["Ada", "Alan"]);

    const caseSensitive = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "LIKE", value: "a%" },
    });
    expect(caseSensitive.items).toHaveLength(0);

    const withBio = await authors.findMany({
      filter: { kind: "condition", field: "bio", operator: "IS_NOT_NULL", value: true },
    });
    expect(withBio.items.map((a) => (a as Author).name)).toEqual(["Joan"]);
  });

  it("treats a LIKE pattern as literal text, not as a regular expression", async () => {
    await authors.createOne({ email: "re@x.io", name: "a.b", age: 1 } as never);
    await authors.createOne({ email: "re2@x.io", name: "axb", age: 2 } as never);

    // `.` is regex syntax; escaped, it must match only the literal dot.
    const literal = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "LIKE", value: "a.b" },
    });
    expect(literal.items.map((a) => (a as Author).name)).toEqual(["a.b"]);

    // `_` *is* a grammar wildcard, so it matches both.
    const wildcard = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "LIKE", value: "a_b" },
      sort: [{ field: "name", direction: "asc" }],
    });
    expect(wildcard.items.map((a) => (a as Author).name)).toEqual(["a.b", "axb"]);
  });

  it("cannot be tricked into matching everything by an operator-shaped value", async () => {
    await seed();
    // `{ $ne: null }` as a *value* is the classic NoSQL injection payload:
    // under the bare `{ field: value }` shorthand it would be spliced in as
    // a query operator and match every document. Two things stop it here —
    // the translator nests it under an explicit `$eq` (see
    // filter-translator.spec.ts), and Mongoose then refuses to cast an
    // object to the path's declared type. The observable result is a 400,
    // never a widened match.
    const error = await rejectionOf(
      authors.findMany({
        filter: { kind: "condition", field: "status", operator: "EQ", value: { $ne: null } as never },
      }),
    );
    expect(error).toBeInstanceOf(QueryValidationException);
    expect((error as QueryValidationException).issues[0]).toMatchObject({
      field: "status",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });

  it("matches nothing on an empty IN set instead of erroring", async () => {
    await seed();
    const list = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "IN", value: [] },
    });
    expect(list.items).toHaveLength(0);
  });

  it("skips the count query when counting is disabled", async () => {
    await seed();
    const list = await authors.findMany(undefined, { settings: { pagination: { count: false } } });
    expect(list.total).toBeNull();
    expect(list.items).toHaveLength(4);
  });

  it("refuses an operator outside the AST enum rather than dropping the predicate", async () => {
    await seed();
    await expect(
      authors.findMany({
        filter: { kind: "condition", field: "status", operator: "SOUNDS_LIKE" as never, value: "active" },
      }),
    ).rejects.toBeInstanceOf(PersistenceException);
  });

  it("still rejects non-allowlisted programmatic filters", async () => {
    await expect(
      authors.findMany({
        filter: { kind: "condition", field: "books.title" as never, operator: "EQ", value: "x" },
      }),
    ).rejects.toBeInstanceOf(QueryValidationException);
  });
});

/**
 * `pagination.strategy: "none"` (ADR-0030, issue #225) reports
 * `NONE_PAGINATION_LIMIT` (`2147483647`, `2^31 - 1`) as the envelope's
 * `limit`, and `MongooseRepositoryAdapter.findMany` passes that value
 * straight to the query builder's `.limit(...)` — the ADR's reasoning for
 * choosing that exact value over `Number.MAX_SAFE_INTEGER` is that it
 * survives MongoDB's int32 wire `limit`. Proven here against a real
 * `mongod` (`mongodb-memory-server`, not a Docker container — this suite
 * already runs without one) rather than inferred from the driver's
 * documented range.
 */
describe("MongooseRepositoryAdapter — pagination.strategy: 'none'", () => {
  it("returns the whole match set with limit 2147483647, not truncated or errored", async () => {
    await seed();
    const unpaginated = kavo.createCrud(models.Author, {
      pagination: { strategy: "none" },
    } as never) as unknown as DefaultKavoService<Author>;

    const list = await unpaginated.findMany({});

    expect(list.items).toHaveLength(4);
    expect(list.total).toBe(4);
    expect(list.limit).toBe(2147483647);
    expect(list.offset).toBe(0);
  });
});

describe("MongooseRepositoryAdapter — schema constraints hold on every write", () => {
  it("enforces schema validators on update and patch, not only on create", async () => {
    // Mongoose runs validators on `create` but *not* on any update unless
    // `runValidators` is set, so without it the same body is rejected on
    // POST and accepted on PATCH.
    const created = (await authors.createOne({ email: "v1@x.io", name: "V", age: 1 } as never)) as Author;

    // Assert the *shape* of the rejection, not merely that one happened: a
    // bare `toBeTruthy()` here would also pass for a TypeError from a
    // mis-shaped `findOneAndUpdate` call, which is exactly how a regression
    // in the `runValidators` wiring would present.
    for (const rejected of [
      authors.createOne({ email: "v2@x.io", name: "V", role: "SUPERUSER" } as never),
      authors.patchOne(created._id, { role: "SUPERUSER" } as never),
    ]) {
      const error = await rejectionOf(rejected);
      expect(error).toBeInstanceOf(PersistenceException);
      expect(error.code).toBe("KAVO_PERSISTENCE_FAILED");
      // The schema refused it — not the adapter falling over on its own.
      expect((error.cause as Error).name).toBe("ValidationError");
    }

    const stored = (await authors.findOne(created._id)) as Author;
    expect(stored.role).toBe("MEMBER"); // the out-of-enum value never landed
  });
});

describe("MongooseRepositoryAdapter — query.defaultSort", () => {
  function withDefaultSort(direction: "asc" | "desc"): DefaultKavoService<Author> {
    return kavo.createCrud(models.Author, {
      query: { defaultSort: [{ field: "age", direction }] },
    } as never) as unknown as DefaultKavoService<Author>;
  }

  it("applies the configured defaultSort when the caller supplies no sort", async () => {
    // `buildSort` omits the `sort` key entirely for an empty list, so a
    // regression that stopped defaultSort reaching the adapter would degrade
    // silently to MongoDB's natural order rather than fail.
    await seed();
    const list = await withDefaultSort("asc").findMany();
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Joan", "Ada", "Alan", "Grace"]);
  });

  it("lets a caller-supplied sort override it outright", async () => {
    await seed();
    const list = await withDefaultSort("asc").findMany({ sort: [{ field: "age", direction: "desc" }] });
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Grace", "Alan", "Ada", "Joan"]);
  });

  it("keeps defaultSort-ordered pages disjoint and stable across offsets", async () => {
    await seed();
    const service = withDefaultSort("asc");
    const first = await service.findMany({ limit: 2, offset: 0 });
    const second = await service.findMany({ limit: 2, offset: 2 });
    expect(first.items.map((author) => (author as Author).name)).toEqual(["Joan", "Ada"]);
    expect(second.items.map((author) => (author as Author).name)).toEqual(["Alan", "Grace"]);
  });
});

describe("MongooseRepositoryAdapter — a `select: false` path is not a Kavo field", () => {
  interface Account {
    _id: string;
    email: string;
  }

  function accounts(): DefaultKavoService<Account> {
    return kavo.createCrud(models.Account) as unknown as DefaultKavoService<Account>;
  }

  it("does not echo the secret from create, the way a read never would", async () => {
    // `create` returns the *hydrated* document, where `select` — a query
    // projection — does not apply. Before the field was excluded from
    // metadata, POST returned a server-generated secret that no GET ever
    // returns.
    const created = await accounts().createOne({ email: "a@b.c" } as never);
    expect(created).not.toHaveProperty("apiKey");

    const listed = (await accounts().findMany()).items[0];
    expect(listed).not.toHaveProperty("apiKey");

    // It is still stored — this is about exposure, not about dropping data.
    const raw = await models.Account.findOne({ email: "a@b.c" }).select("+apiKey").lean();
    expect(raw?.apiKey).toBe("SECRET-abc123");
  });

  it("refuses a filter on it instead of serving a blind extraction oracle", async () => {
    await accounts().createOne({ email: "a@b.c" } as never);

    // The value never appears in a response, but an allowlisted predicate
    // still runs in the database — so a permitted filter would leak it one
    // character at a time. It must not be allowlisted at all.
    const error = await rejectionOf(
      accounts().findMany({
        filter: { kind: "condition", field: "apiKey", operator: "LIKE", value: "SECRET-a%" },
      } as never),
    );
    expect(error).toBeInstanceOf(QueryValidationException);
    expect(error.code).toBe("KAVO_QUERY_INVALID");
  });
});

describe("MongooseRepositoryAdapter — a malformed id is only a 404 when an id was addressed", () => {
  it("answers 400, not 404, for a malformed _id inside a collection filter", async () => {
    await seed();
    // `_id` is on the default filter allowlist, so this raises the very
    // same CastError as `GET /authors/not-an-objectid` — but answering 404
    // here would claim the collection endpoint itself is missing.
    const error = await rejectionOf(
      authors.findMany({ filter: { kind: "condition", field: "_id", operator: "EQ", value: "not-an-objectid" } }),
    );
    expect(error).toBeInstanceOf(QueryValidationException);
    expect(error.code).toBe("KAVO_QUERY_INVALID");
    expect((error as QueryValidationException).issues[0]).toMatchObject({ field: "_id" });
  });

  it("still answers 404 for a malformed id addressed as a document", async () => {
    const error = await rejectionOf(authors.findOne("not-an-objectid"));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.code).toBe("KAVO_NOT_FOUND");
  });
});

describe("MongooseRepositoryAdapter — relation paths are refused, not silently dropped", () => {
  it("rejects a filter on an allowlisted relation path", async () => {
    const books = kavo.createCrud(models.Book, {
      allowlists: { filterable: ["title", "author.name"] },
    } as never) as unknown as DefaultKavoService<Book>;

    const error = await rejectionOf(
      books.findMany({
        filter: { kind: "condition", field: "author.name" as never, operator: "EQ", value: "Ada" },
      }),
    );
    // MongoDB would resolve `author.name` inside the document — where
    // `author` is an ObjectId — and quietly match nothing. A dropped
    // predicate is the one thing an adapter must never do.
    expect(error).toBeInstanceOf(QueryValidationException);
    expect((error as QueryValidationException).issues[0]).toMatchObject({
      field: "author.name",
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    });
  });

  it("exposes the reference id to filtering, and writes it by association", async () => {
    const books = kavo.createCrud(models.Book) as unknown as DefaultKavoService<Book>;
    const author = (await authors.createOne({ email: "ref@x.io", name: "Ref", age: 1 } as never)) as Author;
    await books.createOne({ title: "Owned", author: author._id } as never);
    await books.createOne({ title: "Other", author: ABSENT_ID } as never);

    // A Mongoose ref path is the foreign key, so filtering by it is the
    // equivalent of `?filter[authorId][eq]=…` under the other adapters.
    const list = await books.findMany({
      filter: { kind: "condition", field: "author" as never, operator: "EQ", value: author._id },
    });
    expect(list.items.map((book) => (book as Book).title)).toEqual(["Owned"]);
  });

  it("rejects a sort on an allowlisted relation path", async () => {
    const books = kavo.createCrud(models.Book, {
      allowlists: { sortable: ["title", "author.name"] },
    } as never) as unknown as DefaultKavoService<Book>;

    const error = await rejectionOf(books.findMany({ sort: [{ field: "author.name" as never, direction: "asc" }] }));
    expect(error).toBeInstanceOf(QueryValidationException);
    expect((error as QueryValidationException).issues[0]).toMatchObject({
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    });
  });
});
