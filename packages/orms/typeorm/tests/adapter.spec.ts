import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, CreateDateColumn, Entity, ManyToOne, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import {
  ConflictException,
  NotFoundException,
  PatchNoChangesException,
  PersistenceException,
  QueryValidationException,
  type KavoInstance,
  type DefaultKavoService,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createTypeOrmKavo } from "@kavo/typeorm";

// Explicit column types throughout: the swc test transform emits decorator
// metadata, but explicit types keep entities transform-agnostic.
@Entity()
class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar", { unique: true })
  email!: string;

  @Column("varchar")
  name!: string;

  @Column("int")
  age!: number;

  @Column("varchar", { default: "active" })
  status!: string;

  @Column("varchar", { nullable: true })
  bio!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => Book, (book) => book.author)
  books!: Book[];
}

@Entity()
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToOne(() => Author, (author) => author.books)
  author!: Author;
}

/**
 * The column spellings the rest of the fixtures deliberately avoid.
 * Everything above uses an explicit driver-type string to stay
 * transform-agnostic, which leaves the constructor-typed and JSON arms of
 * `fieldKindOf` unexercised.
 */
@Entity()
class Widget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: String })
  label!: string;

  @Column({ type: Boolean, default: false })
  active!: boolean;

  @Column("simple-json", { nullable: true })
  payload!: unknown;
}

/** Two primary columns — a composite key (issue #261). */
@Entity()
class CompositeKey {
  @PrimaryColumn("int")
  left!: number;

  @PrimaryColumn("int")
  right!: number;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let authors: DefaultKavoService<Author>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Author, Book, Widget, CompositeKey],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  authors = kavo.createCrud(Author) as DefaultKavoService<Author>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Book).clear();
  await dataSource.getRepository(Author).clear();
});

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

describe("metadata derivation seam", () => {
  it("derives fields, id, generated flags, and relations", () => {
    const metadata = buildEntityMetadata(dataSource, Author);
    expect(metadata.name).toBe("Author");
    expect(metadata.idField).toBe("id");
    const byName = Object.fromEntries(metadata.fields.map((f) => [f.name, f]));
    expect(byName["id"]).toMatchObject({ kind: "number", generated: true });
    expect(byName["email"]).toMatchObject({ kind: "string", generated: false });
    expect(byName["createdAt"]).toMatchObject({ kind: "date", generated: true });
    expect(byName["bio"]).toMatchObject({ nullable: true });
    expect(byName["books"]).toBeUndefined(); // relations are not fields
    expect(metadata.relations.map((r) => r.name)).toEqual(["books"]);
    expect(metadata.relations[0]).toMatchObject({
      cardinality: "many",
      includable: false,
    });
  });

  it("maps constructor-typed columns, which never reach the driver-string ladder", () => {
    // `@Column({ type: String })` leaves `column.type` as the constructor
    // itself, so it is answered before the regex fallbacks below it. Every
    // other fixture here spells a driver string, which is why this arm was
    // unexercised.
    const byName = Object.fromEntries(buildEntityMetadata(dataSource, Widget).fields.map((f) => [f.name, f]));
    expect(byName["label"]).toMatchObject({ kind: "string" });
    expect(byName["active"]).toMatchObject({ kind: "boolean" });
  });

  it("maps a JSON column to the json kind, so core does not coerce it as text", () => {
    const byName = Object.fromEntries(buildEntityMetadata(dataSource, Widget).fields.map((f) => [f.name, f]));
    expect(byName["payload"]).toMatchObject({ kind: "json", nullable: true });
  });

  it("populates compositeIdFields (declaration order) for a two-column primary key, issue #261", () => {
    const metadata = buildEntityMetadata(dataSource, CompositeKey);
    expect(metadata.compositeIdFields).toEqual(["left", "right"]);
    // `idField` still names a single column — the first declared one —
    // for callers that only ever need a name, but nothing that addresses
    // this row's real identity may rely on it alone.
    expect(metadata.idField).toBe("left");
  });

  it("leaves compositeIdFields undefined for a single-column primary key", () => {
    expect(buildEntityMetadata(dataSource, Author).compositeIdFields).toBeUndefined();
  });

  // TypeORM itself refuses to build metadata for an entity with zero
  // primary columns (`MissingPrimaryColumnError`, thrown at
  // `DataSource.initialize`), so `buildEntityMetadata`'s own "found 0"
  // branch is unreachable through a real DataSource — defense in depth
  // for a metadata source that skipped TypeORM's own validation, not a
  // path this suite can exercise end-to-end.
});

describe("TypeOrmRepositoryAdapter — CRUD", () => {
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

  it("does not reject `updateOne` (full replace) for the same shape of body", async () => {
    // Out of scope by design: PATCH-specific, PUT is unaffected.
    const created = await authors.createOne({ email: "put@x.io", name: "Put", age: 5 } as never);
    const id = (created as Author).id;
    await expect(authors.updateOne(id, { id } as never)).resolves.toMatchObject({ name: "Put" });
  });

  it("rejects a patch with KAVO_PATCH_NO_CHANGES when every field is present but `undefined` (issue #289)", async () => {
    // Reproduces the entity-subclass DTO fallback under `useDefineForClassFields`:
    // fields are *own* properties initialized to `undefined`, not absent, so a
    // naive `Object.keys(...).length === 0` check must not be fooled by them.
    const created = await authors.createOne({ email: "phantom@x.io", name: "Phantom", age: 5 } as never);
    const id = (created as Author).id;
    const phantomBody = { id: undefined, email: undefined, name: undefined, age: undefined };
    expect(Object.keys(phantomBody)).not.toHaveLength(0);
    const error = await authors.patchOne(id, phantomBody as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PatchNoChangesException);
    expect((error as PatchNoChangesException).code).toBe("KAVO_PATCH_NO_CHANGES");
  });

  it("still applies a real field change carried alongside phantom `undefined` fields", async () => {
    const created = await authors.createOne({ email: "mixed@x.io", name: "Mixed", age: 5 } as never);
    const id = (created as Author).id;
    const mixedBody = { id: undefined, email: undefined, name: "Renamed", age: undefined };
    await expect(authors.patchOne(id, mixedBody as never)).resolves.toMatchObject({ name: "Renamed" });
  });
});

describe("TypeOrmRepositoryAdapter — query translation", () => {
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
    expect(list.items.map((a) => (a as Author).name)).toEqual(["Ada"]);
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
    expect(either.items.map((a) => (a as Author).name)).toEqual(["Ada", "Alan"]);

    const negated = await authors.findMany({
      filter: {
        kind: "group",
        operator: "NOT",
        children: [{ kind: "condition", field: "status", operator: "EQ", value: "active" }],
      },
      sort: [{ field: "age", direction: "asc" }],
    });
    expect(negated.items.map((a) => (a as Author).name)).toEqual(["Joan", "Alan"]);
  });

  it("translates IN, BETWEEN, LIKE, ILIKE and null checks", async () => {
    await seed();
    await authors.patchOne(
      (await authors.findMany()).items.map((a) => a as Author).find((a) => a.name === "Joan")!.id,
      { bio: "wrote code" } as never,
    );

    const inSet = await authors.findMany({
      filter: {
        kind: "condition",
        field: "status",
        operator: "IN",
        value: ["banned", "pending"],
      },
    });
    expect(inSet.items).toHaveLength(2);

    const between = await authors.findMany({
      filter: {
        kind: "condition",
        field: "age",
        operator: "BETWEEN",
        value: [40, 50],
      },
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

    const withBio = await authors.findMany({
      filter: { kind: "condition", field: "bio", operator: "IS_NOT_NULL", value: true },
    });
    expect(withBio.items.map((a) => (a as Author).name)).toEqual(["Joan"]);
  });

  it("matches nothing on an empty IN set instead of erroring", async () => {
    await seed();
    const list = await authors.findMany({
      filter: { kind: "condition", field: "status", operator: "IN", value: [] },
    });
    expect(list.items).toHaveLength(0);
  });

  it("applies the configured defaultSort when the caller supplies no sort", async () => {
    await seed();
    const withDefault = kavo.createCrud(Author, {
      query: { defaultSort: [{ field: "age", direction: "asc" }] },
    }) as DefaultKavoService<Author>;
    const list = await withDefault.findMany();
    expect(list.items.map((a) => (a as Author).name)).toEqual(["Joan", "Ada", "Alan", "Grace"]);
  });

  it("lets a caller-supplied sort override the configured defaultSort", async () => {
    await seed();
    const withDefault = kavo.createCrud(Author, {
      query: { defaultSort: [{ field: "age", direction: "asc" }] },
    }) as DefaultKavoService<Author>;
    const list = await withDefault.findMany({ sort: [{ field: "age", direction: "desc" }] });
    expect(list.items.map((a) => (a as Author).name)).toEqual(["Grace", "Alan", "Ada", "Joan"]);
  });

  it("breaks ties on the second field of a multi-field defaultSort", async () => {
    const withDefault = kavo.createCrud(Author, {
      query: {
        defaultSort: [
          { field: "status", direction: "asc" },
          { field: "name", direction: "asc" },
        ],
      },
    }) as DefaultKavoService<Author>;
    await withDefault.createOne({ email: "b@x.io", name: "Bea", age: 30, status: "active" } as never);
    await withDefault.createOne({ email: "c@x.io", name: "Cy", age: 31, status: "active" } as never);
    await withDefault.createOne({ email: "a@x.io", name: "Amy", age: 29, status: "active" } as never);
    const list = await withDefault.findMany();
    expect(list.items.map((a) => (a as Author).name)).toEqual(["Amy", "Bea", "Cy"]);
  });

  it("keeps defaultSort-ordered pages disjoint and stable across offsets", async () => {
    await seed();
    const withDefault = kavo.createCrud(Author, {
      query: { defaultSort: [{ field: "age", direction: "asc" }] },
    }) as DefaultKavoService<Author>;
    const page1 = await withDefault.findMany({ limit: 2, offset: 0 });
    const page2 = await withDefault.findMany({ limit: 2, offset: 2 });
    const names1 = page1.items.map((a) => (a as Author).name);
    const names2 = page2.items.map((a) => (a as Author).name);
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
    // the AST and `validateExpression` checks allowlists, not operators.
    // Falling through the translator's switch would add no predicate at
    // all — the caller asked to narrow to one row and would silently get
    // all four back. The guard surfaces as PersistenceException: a forged
    // AST is an internal contract violation (500), not a bad request.
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
      allowlists: { filterable: ["title", "author.name" as never] },
    }) as DefaultKavoService<Book>;
    await seed();
    const ada = (await authors.findMany()).items.map((a) => a as Author).find((a) => a.name === "Ada")!;
    await dataSource.getRepository(Book).save([
      { title: "Notes", author: { id: ada.id } },
      { title: "Other", author: { id: ada.id + 1 } },
    ] as never);

    const list = await scoped.findMany({
      filter: {
        kind: "condition",
        field: "author.name" as never,
        operator: "EQ",
        value: "Ada",
      },
    });
    expect(list.items.map((b) => (b as Book).title)).toEqual(["Notes"]);
  });
});

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

function hardDeleteContext() {
  return { entityName: "Author", operation: "findOne", config: { softDelete: { strategy: "hard" } } };
}

describe("TypeOrmRepositoryAdapter — findOne by query", () => {
  // `findOne` is on the `EntityReader` contract but core never calls it:
  // every engine read goes through `findOneById`. It exists for custom
  // handlers and programmatic callers, which is exactly why nothing was
  // exercising it.
  it("returns the first row for a query carrying no filter at all", async () => {
    await seed();
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    const row = await reader.findOne(unfilteredQuery() as never, hardDeleteContext() as never);
    expect(row).not.toBeNull();
  });

  it("applies the query's sort rather than returning an arbitrary row", async () => {
    await seed();
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    const row = (await reader.findOne(
      { ...unfilteredQuery(), sort: [{ field: "age", direction: "asc" }] } as never,
      hardDeleteContext() as never,
    )) as Author | null;
    expect(row).toMatchObject({ name: "Joan" });
  });

  it("applies the query's filter", async () => {
    await seed();
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    const row = (await reader.findOne(
      {
        ...unfilteredQuery(),
        filter: { root: { kind: "condition", field: "status", operator: "EQ", value: "banned" } },
      } as never,
      hardDeleteContext() as never,
    )) as Author | null;
    expect(row).toMatchObject({ name: "Alan" });
  });

  it("answers null rather than throwing when nothing matches", async () => {
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    expect(await reader.findOne(unfilteredQuery() as never, hardDeleteContext() as never)).toBeNull();
  });
});

describe("TypeOrmRepositoryAdapter — findOneById with no query", () => {
  it("reads a row when the caller passes null for the query", async () => {
    // The signature admits `null`, so a programmatic caller with no query
    // to hand must still get its row rather than a crash on `query.include`.
    await seed();
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    const first = (await reader.findOne(unfilteredQuery() as never, hardDeleteContext() as never)) as Author;

    const row = (await reader.findOneById(first.id, null, hardDeleteContext() as never)) as Author | null;
    expect(row).toMatchObject({ id: first.id });
  });

  it("answers null for an id that is not there", async () => {
    const reader = createInfrastructure(dataSource).adapterFor(Author);
    expect(await reader.findOneById(9999, null, hardDeleteContext() as never)).toBeNull();
  });
});
