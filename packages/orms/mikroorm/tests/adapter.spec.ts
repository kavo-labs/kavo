import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Collection, MikroORM } from "@mikro-orm/core";
import { Entity, ManyToMany, ManyToOne, OneToMany, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import {
  ConfigurationException,
  ConflictException,
  NotFoundException,
  PatchNoChangesException,
  PersistenceException,
  QueryValidationException,
  createCrud,
  type DefaultKavoService,
  type KavoInstance,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createMikroOrmKavo } from "@kavo/mikroorm";
import { clearDatabase, newTestOrm } from "./support/database.js";

// Explicit property types throughout: the swc test transform emits decorator
// metadata, but explicit types keep entities transform-agnostic — the same
// reason `@kavo/typeorm`'s suite spells its column types out.
@Entity()
class Author {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string", unique: true })
  email!: string;

  @Property({ type: "string" })
  name!: string;

  @Property({ type: "number" })
  age!: number;

  @Property({ type: "string" })
  status: string = "active";

  @Property({ type: "string", nullable: true })
  bio: string | null = null;

  @Property({ type: "Date", onCreate: () => new Date() })
  createdAt!: Date;

  @OneToMany(() => Book, (book) => book.author)
  books = new Collection<Book>(this);

  // The owning side of a many-to-many, so array-valued relation writes have
  // somewhere to land.
  @ManyToMany(() => Shelf, undefined, { owner: true })
  shelves = new Collection<Shelf>(this);
}

@Entity()
class Shelf {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  label!: string;
}

@Entity()
class Book {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  title!: string;

  // Nullable, so an association can be *cleared* as well as set.
  @ManyToOne(() => Author, { nullable: true })
  author: Author | null = null;
}

let orm: MikroORM;
let kavo: KavoInstance;
let authors: DefaultKavoService<Author>;

beforeAll(async () => {
  orm = await newTestOrm([Author, Book, Shelf]);
  kavo = createMikroOrmKavo(orm);
  authors = kavo.createCrud(Author) as DefaultKavoService<Author>;
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await clearDatabase(orm);
});

/** The persisted foreign key of one book, read straight from the database. */
async function readAuthorId(bookId: number): Promise<number | undefined> {
  const row = await orm.em.fork().findOne(Book, { id: bookId }, { populate: ["author"] });
  return row?.author?.id;
}

async function seed(): Promise<void> {
  const rows = [
    { email: "ada@x.io", name: "Ada", age: 36, status: "active" },
    { email: "grace@x.io", name: "Grace", age: 45, status: "active" },
    { email: "alan@x.io", name: "Alan", age: 41, status: "banned" },
    { email: "joan@x.io", name: "Joan", age: 28, status: "pending" },
  ];
  for (const row of rows) {
    await authors.createOne(row as never);
  }
}

/** A normalized query with no filter — what a custom handler hands the reader. */
function unfilteredQuery() {
  return {
    filter: { root: null },
    sort: [],
    include: {},
    select: { root: null, relations: {} },
    pagination: { limit: 10, offset: 0 },
    count: false,
    withDeleted: false,
    onlyDeleted: false,
  };
}

function hardDeleteContext() {
  return { entityName: "Author", operation: "findOne", config: { softDelete: { strategy: "hard" } } };
}

describe("metadata derivation seam", () => {
  it("derives fields, id, generated flags, and relations", () => {
    const metadata = buildEntityMetadata(orm, Author);
    expect(metadata.name).toBe("Author");
    expect(metadata.idField).toBe("id");
    const byName = Object.fromEntries(metadata.fields.map((field) => [field.name, field]));
    expect(byName["id"]).toMatchObject({ kind: "number", generated: true });
    expect(byName["email"]).toMatchObject({ kind: "string", generated: false });
    expect(byName["age"]).toMatchObject({ kind: "number", generated: false });
    expect(byName["createdAt"]).toMatchObject({ kind: "date", generated: true });
    expect(byName["bio"]).toMatchObject({ nullable: true });
    expect(byName["books"]).toBeUndefined(); // relations are not fields
    expect(metadata.relations.map((relation) => relation.name).sort()).toEqual(["books", "shelves"]);
    expect(metadata.relations[0]).toMatchObject({ cardinality: "many", includable: false });
    // The lazy target thunk resolves to the class itself — the identity core
    // matches registered entities by, with no marker class in sight.
    expect(metadata.relations[0]!.target()).toBe(Book);
  });

  it("reports the to-one side of the same relation as cardinality 'one'", () => {
    const metadata = buildEntityMetadata(orm, Book);
    expect(metadata.relations).toMatchObject([{ name: "author", cardinality: "one" }]);
    expect(metadata.relations[0]!.target()).toBe(Author);
  });

  it("refuses an entity MikroORM never registered", () => {
    class Ghost {
      id!: number;
    }
    let thrown: unknown;
    try {
      buildEntityMetadata(orm, Ghost);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toMatch(/no registered entity named 'Ghost'/);
  });
});

describe("MikroOrmRepositoryAdapter — CRUD", () => {
  it("creates, reads, updates, patches, deletes against the real database", async () => {
    const created = await authors.createOne({
      email: "ada@x.io",
      name: "Ada",
      age: 36,
    } as never);
    expect(created).toMatchObject({ name: "Ada", status: "active" });
    const id = (created as Author).id;

    const fetched = await authors.findOne(id);
    expect(fetched).toMatchObject({ email: "ada@x.io" });

    await authors.updateOne(id, { email: "ada@x.io", name: "Ada L", age: 37 } as never);
    const patched = await authors.patchOne(id, { age: 38 } as never);
    expect(patched).toMatchObject({ name: "Ada L", age: 38 });

    await authors.deleteOne(id);
    await expect(authors.findOne(id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFound for updates/deletes on missing rows", async () => {
    await expect(authors.updateOne(4242, { name: "x" } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(authors.deleteOne(4242)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("maps unique violations to ConflictException (error-mapping table)", async () => {
    await authors.createOne({ email: "dup@x.io", name: "A", age: 1 } as never);
    await expect(authors.createOne({ email: "dup@x.io", name: "B", age: 2 } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects a patch that carries no field changes with KAVO_PATCH_NO_CHANGES", async () => {
    const created = await authors.createOne({ email: "noop@x.io", name: "Noop", age: 5 } as never);
    const id = (created as Author).id;
    const error = await authors.patchOne(id, {} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect((error as PatchNoChangesException).code).toBe("KAVO_PATCH_NO_CHANGES");
    expect((error as PatchNoChangesException).status).toBe(400);
  });

  it("rejects a patch whose only field is the immutable id", async () => {
    const created = await authors.createOne({ email: "id-only@x.io", name: "IdOnly", age: 5 } as never);
    const id = (created as Author).id;
    const error = await authors.patchOne(id, { id } as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PatchNoChangesException);
  });

  it("rejects a patch with KAVO_PATCH_NO_CHANGES when every field is present but `undefined` (issue #289)", async () => {
    // Reproduces the entity-subclass DTO fallback under `useDefineForClassFields`:
    // fields are *own* properties initialized to `undefined`, not absent, so a
    // naive `Object.keys(...).length === 0` check must not be fooled by them.
    const created = await authors.createOne({ email: "phantom@x.io", name: "Phantom", age: 5 } as never);
    const id = (created as Author).id;
    const phantomBody = { id: undefined, email: undefined, name: undefined, age: undefined };
    const error = await authors.patchOne(id, phantomBody as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect((error as PatchNoChangesException).code).toBe("KAVO_PATCH_NO_CHANGES");
  });

  it("returns plain objects, never live MikroORM entities", async () => {
    // The adapter converts at its boundary: a `Collection` would break core's
    // `Array.isArray` branch in the serializer, and a managed entity would
    // carry an identity map into the response.
    await seed();
    const list = await authors.findMany();
    for (const item of list.items) {
      expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    }
  });

  it("does not leak a stale identity map between calls", async () => {
    // Every operation forks its own EntityManager; a shared one would answer
    // the second read from the first read's identity map.
    const created = (await authors.createOne({ email: "a@x.io", name: "Ada", age: 36 } as never)) as Author;
    await orm.em.fork().nativeUpdate(Author, { id: created.id }, { name: "Renamed outside Kavo" });
    expect(await authors.findOne(created.id)).toMatchObject({ name: "Renamed outside Kavo" });
  });

  it("associates a relation by id on create and on patch", async () => {
    // Core's deserializer narrows a relation to `{ id }` (ADR-0014); MikroORM
    // associates by the bare primary key, so the adapter unwraps it.
    const books = kavo.createCrud(Book) as DefaultKavoService<Book>;
    const ada = (await authors.createOne({ email: "ada@x.io", name: "Ada", age: 36 } as never)) as Author;
    const alan = (await authors.createOne({ email: "alan@x.io", name: "Alan", age: 41 } as never)) as Author;

    // The association is asserted against the database, not the response:
    // core's serializer emits a relation key only for an included node, so a
    // written-but-not-included relation is correctly absent from the result.
    const created = (await books.createOne({ title: "Notes", author: { id: ada.id } } as never)) as Book;
    expect(created).toMatchObject({ title: "Notes" });
    expect(await readAuthorId(created.id)).toBe(ada.id);

    await books.patchOne(created.id, { author: { id: alan.id } } as never);
    expect(await readAuthorId(created.id)).toBe(alan.id);
  });
});

describe("MikroOrmRepositoryAdapter — relation writes are association-only", () => {
  it("refuses to deep-write a relation whose target Kavo never registered", async () => {
    // Core narrows a relation to `{ id }` only when the *target* entity is in
    // its catalog; a target that was never `createCrud`-ed arrives at the
    // adapter as whatever the client sent. Handing that object to
    // `em.create` would leave a nested write one cascade setting away from
    // working — ADR-0014 says relations are associated by id, never
    // deep-written, so the object is dropped instead.
    const isolated = createMikroOrmKavo(orm);
    const books = isolated.createCrud(Book) as DefaultKavoService<Book>;
    const before = await orm.em.fork().count(Author, {});

    const created = (await books.createOne({
      title: "smuggled",
      author: { email: "evil@x.io", name: "Injected", age: 1 },
    } as never)) as Book;

    // The row is created, the smuggled object is not: an id-less relation
    // value becomes `null`, so no Author is written and none is associated.
    expect(await orm.em.fork().count(Author, {})).toBe(before);
    expect(await readAuthorId(created.id)).toBeUndefined();
  });
});

describe("MikroOrmRepositoryAdapter — relation writes", () => {
  async function newShelf(label: string): Promise<number> {
    const em = orm.em.fork();
    const shelf = em.create(Shelf, { label } as never);
    await em.flush();
    return (shelf as Shelf).id;
  }

  /** The shelf ids actually persisted against one author. */
  async function shelvesOf(authorId: number): Promise<string[]> {
    const row = await orm.em.fork().findOne(Author, { id: authorId }, { populate: ["shelves"] });
    return row!.shelves
      .getItems()
      .map((shelf) => shelf.label)
      .sort();
  }

  it("associates a to-many by an array of { id } references", async () => {
    const a = await newShelf("A");
    const b = await newShelf("B");
    const created = (await authors.createOne({
      email: "ada@x.io",
      name: "Ada",
      age: 36,
      shelves: [{ id: a }, { id: b }],
    } as never)) as Author;

    expect(await shelvesOf(created.id)).toEqual(["A", "B"]);
  });

  it("drops id-less elements from a to-many write instead of failing the whole request", async () => {
    // Core's own `associate` filters nulls out of an array; the adapter's
    // unwrap must too. A relation whose target is not in core's catalog
    // arrives here as the raw client value, so `[{}]` and `[null]` are
    // shapes that really can reach this code — and passing `[null]` to
    // `em.create` fails at the driver as a 500 rather than being ignored.
    const a = await newShelf("A");
    const created = (await authors.createOne({
      email: "ada@x.io",
      name: "Ada",
      age: 36,
      shelves: [{ id: a }, {}, null],
    } as never)) as Author;

    expect(await shelvesOf(created.id)).toEqual(["A"]);
  });

  it("clears a to-one association when the payload sends null", async () => {
    const books = kavo.createCrud(Book) as DefaultKavoService<Book>;
    const ada = (await authors.createOne({ email: "ada@x.io", name: "Ada", age: 36 } as never)) as Author;
    const book = (await books.createOne({ title: "Notes", author: { id: ada.id } } as never)) as Book;
    expect(await readAuthorId(book.id)).toBe(ada.id);

    await books.patchOne(book.id, { author: null } as never);
    expect(await readAuthorId(book.id)).toBeUndefined();
  });
});

describe("MikroOrmRepositoryAdapter — relation values core never narrowed", () => {
  /**
   * A service built on core's explicit-runtime path — `createCrud(Entity,
   * config, runtime)`, no root instance and therefore no entity catalog.
   * That is the state the adapter's own unwrapping exists for: core's
   * deserializer narrows a relation to `{ id }` only when the *target* is in
   * the catalog, so with an empty one the client's raw value reaches the
   * adapter exactly as it was sent. (Through `createMikroOrmKavo` the catalog
   * derives every target from MikroORM's own metadata, so core narrows first
   * and these shapes never get that far.)
   */
  function bareBooks(): DefaultKavoService<Book> {
    return createCrud(Book, undefined, {
      metadata: buildEntityMetadata(orm, Book),
      adapter: createInfrastructure(orm).adapterFor(Book),
    }) as DefaultKavoService<Book>;
  }

  it("associates a bare scalar id, which MikroORM takes as the foreign key", async () => {
    const ada = (await authors.createOne({ email: "ada@x.io", name: "Ada", age: 36 } as never)) as Author;
    const created = (await bareBooks().createOne({ title: "Notes", author: ada.id } as never)) as Book;
    expect(await readAuthorId(created.id)).toBe(ada.id);
  });

  it("drops an id-less relation object rather than deep-writing it", async () => {
    // ADR-0014: relations are associated by id, never deep-written. Handing
    // `{ name: "nope" }` to `em.create` would leave a nested write one cascade
    // setting away from working, so an object carrying no id becomes `null` —
    // the book is written, the smuggled author is not.
    const before = await orm.em.fork().count(Author, {});
    const created = (await bareBooks().createOne({ title: "smuggled", author: { name: "nope" } } as never)) as Book;

    expect(await orm.em.fork().count(Author, {})).toBe(before);
    expect(await readAuthorId(created.id)).toBeUndefined();
  });
});

describe("MikroOrmRepositoryAdapter — findOne by query", () => {
  it("returns the first row when the query carries no filter at all", async () => {
    // Regression: MikroORM's validator rejects `em.findOne` with an empty
    // `where` outright, while `em.find` accepts it. An unfiltered query is a
    // legitimate shape — `findOne`'s contract is "first match of the query,
    // or null", and no filter matches everything — so routing it through
    // `em.findOne` turned a valid read into a 500. Not reachable from a
    // generated route (the standard `findOne` is by id), but it is exactly
    // what a custom handler or a direct adapter call produces.
    await seed();
    const reader = createInfrastructure(orm).adapterFor(Author);
    const row = await reader.findOne(unfilteredQuery() as never, hardDeleteContext() as never);
    expect(row).not.toBeNull();
  });

  it("returns null when the query matches nothing", async () => {
    // The limit-1 `em.find` behind this answers with an empty array, so the
    // adapter has to produce the `null` itself — `findOne`'s contract is "a
    // row or null", and core reads that null as the 404 signal. An
    // `undefined` leaking through instead would be serialized as a body.
    const reader = createInfrastructure(orm).adapterFor(Author);
    const row = await reader.findOne(unfilteredQuery() as never, hardDeleteContext() as never);
    expect(row).toBeNull();
  });

  it("still applies sort and soft-delete scope on the unfiltered path", async () => {
    await seed();
    const reader = createInfrastructure(orm).adapterFor(Author);
    const row = (await reader.findOne(
      { ...unfilteredQuery(), sort: [{ field: "age", direction: "asc" }] } as never,
      hardDeleteContext() as never,
    )) as Author | null;
    expect(row).toMatchObject({ name: "Joan" }); // the youngest, not just any row
  });
});

describe("MikroOrmRepositoryAdapter — query translation", () => {
  it("filters, sorts, and paginates in the database", async () => {
    await seed();
    const list = await authors.findMany({
      filter: {
        kind: "condition",
        field: "status",
        operator: "EQ",
        value: "active",
      },
      sort: [{ field: "age", direction: "desc" }],
      limit: 1,
      offset: 1,
    });
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Ada"]);
    expect(list.total).toBe(2); // total counts all matches, not the page
    expect(list.limit).toBe(1);
    expect(list.offset).toBe(1);
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
    const joan = (await authors.findMany()).items
      .map((author) => author as Author)
      .find((author) => author.name === "Joan")!;
    await authors.patchOne(joan.id, { bio: "wrote code" } as never);

    const inSet = await authors.findMany({
      filter: {
        kind: "condition",
        field: "status",
        operator: "IN",
        value: ["banned", "pending"],
      },
    });
    expect(inSet.items).toHaveLength(2);

    const notIn = await authors.findMany({
      filter: {
        kind: "condition",
        field: "status",
        operator: "NOT_IN",
        value: ["banned", "pending"],
      },
    });
    expect(notIn.items).toHaveLength(2);

    const between = await authors.findMany({
      filter: {
        kind: "condition",
        field: "age",
        operator: "BETWEEN",
        value: [40, 50],
      },
    });
    expect(between.items.map((author) => (author as Author).name).sort()).toEqual(["Alan", "Grace"]);

    const like = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "LIKE", value: "A%" },
    });
    expect(like.items.map((author) => (author as Author).name).sort()).toEqual(["Ada", "Alan"]);

    // SQLite's own LIKE is ASCII case-insensitive, so ILIKE degrading to
    // `$like` under the default `caseInsensitiveFilters: false` still matches
    // — see the adapter doc's note on why that default is the portable one.
    const ilike = await authors.findMany({
      filter: { kind: "condition", field: "name", operator: "ILIKE", value: "a%" },
    });
    expect(ilike.items.map((author) => (author as Author).name).sort()).toEqual(["Ada", "Alan"]);

    const withBio = await authors.findMany({
      filter: { kind: "condition", field: "bio", operator: "IS_NOT_NULL", value: true },
    });
    expect(withBio.items.map((author) => (author as Author).name)).toEqual(["Joan"]);

    const withoutBio = await authors.findMany({
      filter: { kind: "condition", field: "bio", operator: "IS_NULL", value: true },
    });
    expect(withoutBio.items).toHaveLength(3);
  });

  it("matches nothing on an empty IN set instead of erroring", async () => {
    await seed();
    const list = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "IN", value: [] },
    });
    expect(list.items).toHaveLength(0);
  });

  it("matches everything on an empty NOT IN set", async () => {
    await seed();
    const list = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "NOT_IN", value: [] },
    });
    expect(list.items).toHaveLength(4);
  });

  it("applies the configured defaults.sort when the caller supplies no sort", async () => {
    await seed();
    const withDefault = kavo.createCrud(Author, {
      defaults: { sort: ["age"] },
    }) as DefaultKavoService<Author>;
    const list = await withDefault.findMany();
    expect(list.items.map((author) => (author as Author).name)).toEqual(["Joan", "Ada", "Alan", "Grace"]);
  });

  it("keeps defaults.sort-ordered pages disjoint and stable across offsets", async () => {
    await seed();
    const withDefault = kavo.createCrud(Author, {
      defaults: { sort: ["age"] },
    }) as DefaultKavoService<Author>;
    const page1 = await withDefault.findMany({ limit: 2, offset: 0 });
    const page2 = await withDefault.findMany({ limit: 2, offset: 2 });
    const names1 = page1.items.map((author) => (author as Author).name);
    const names2 = page2.items.map((author) => (author as Author).name);
    expect(names1).toEqual(["Joan", "Ada"]);
    expect(names2).toEqual(["Alan", "Grace"]);
    expect(new Set([...names1, ...names2]).size).toBe(4); // disjoint, no repeats/skips
  });

  it("skips the count query when counting is disabled", async () => {
    await seed();
    const list = await authors.findMany(undefined, {
      settings: { pagination: { count: false } },
    });
    expect(list.total).toBeNull();
    expect(list.items).toHaveLength(4);
  });

  it("refuses an operator outside the AST enum rather than dropping the predicate", async () => {
    await seed();
    // The parser can never emit this, but a programmatic caller hand-builds
    // the AST and `validateExpression` checks allowed, not operators.
    // Falling through the translator's switch would add no predicate at all —
    // the caller asked to narrow to one row and would silently get all four
    // back. The guard surfaces as PersistenceException: a forged AST is an
    // internal contract violation (500), not a bad request.
    await expect(
      authors.findMany({
        filter: {
          kind: "condition",
          field: "status",
          operator: "SOUNDS_LIKE" as never,
          value: "active",
        },
      }),
    ).rejects.toBeInstanceOf(PersistenceException);
  });

  it("still rejects non-allowlisted programmatic filters", async () => {
    await expect(
      authors.findMany({
        filter: {
          kind: "condition",
          field: "books.title" as never,
          operator: "EQ",
          value: "x",
        },
      }),
    ).rejects.toBeInstanceOf(QueryValidationException);
  });

  it("filters on relation paths when explicitly allowlisted", async () => {
    const scoped = kavo.createCrud(Book, {
      allowed: { filterable: ["title", "author.name" as never] },
    }) as DefaultKavoService<Book>;
    await seed();
    const all = (await authors.findMany()).items.map((author) => author as Author);
    const ada = all.find((author) => author.name === "Ada")!;
    const alan = all.find((author) => author.name === "Alan")!;

    const em = orm.em.fork();
    em.create(Book, { title: "Notes", author: em.getReference(Author, ada.id) });
    em.create(Book, { title: "Other", author: em.getReference(Author, alan.id) });
    await em.flush();

    const list = await scoped.findMany({
      filter: {
        kind: "condition",
        field: "author.name" as never,
        operator: "EQ",
        value: "Ada",
      },
    });
    expect(list.items.map((book) => (book as Book).title)).toEqual(["Notes"]);
  });

  it("sorts on an allowlisted relation path", async () => {
    const scoped = kavo.createCrud(Book, {
      allowed: { sortable: ["title", "author.name" as never] },
    }) as DefaultKavoService<Book>;
    await seed();
    const all = (await authors.findMany()).items.map((author) => author as Author);
    const ada = all.find((author) => author.name === "Ada")!;
    const alan = all.find((author) => author.name === "Alan")!;

    const em = orm.em.fork();
    em.create(Book, { title: "By Alan", author: em.getReference(Author, alan.id) });
    em.create(Book, { title: "By Ada", author: em.getReference(Author, ada.id) });
    await em.flush();

    const list = await scoped.findMany({ sort: [{ field: "author.name" as never, direction: "asc" }] });
    expect(list.items.map((book) => (book as Book).title)).toEqual(["By Ada", "By Alan"]);
  });
});
