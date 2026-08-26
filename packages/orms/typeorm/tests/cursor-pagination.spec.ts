import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, DeleteDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import {
  QueryValidationException,
  type DefaultKavoService,
  type ListMetaDto,
  type ListResultDto,
  type KavoInstance,
} from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * Keyset pagination against the real database (ADR-0021). The keyset
 * predicate is built in core as an ordinary filter AST, so what this suite
 * proves is that `@kavo/typeorm` *composes* it correctly — with the client's
 * own `WHERE`, with include joins, and with the soft-delete scope — and that
 * the driver actually round-trips every cursor key type: int, text, and
 * `Date`.
 *
 * These are behavioral tests, deliberately: the emitted SQL still carries an
 * `OFFSET 0` (TypeORM's `take` without `skip` renders one, and it costs
 * nothing on any of the four engines), so "no offset scan" is a claim about
 * the *predicate*, which every walk below proves by returning each row
 * exactly once.
 */

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @Column("int")
  score!: number;

  @Column("varchar")
  status!: string;

  /** Set explicitly by the seeds, so several rows can share a timestamp. */
  @Column("datetime")
  createdAt!: Date;

  /** Nullable on purpose — the subject of the null-sort-key limitation tests. */
  @Column({ type: "int", nullable: true })
  rank!: number | null;

  @DeleteDateColumn()
  deletedAt!: Date | null;

  @OneToMany(() => Comment, (comment) => comment.post)
  comments!: Comment[];
}

@Entity()
class Comment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  body!: string;

  @ManyToOne(() => Post, (post) => post.comments)
  post!: Post;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let posts: DefaultKavoService<Post>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Post, Comment],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource, {
    defaults: {
      pagination: { strategy: "cursor" },
      query: { defaultSort: [{ field: "id", direction: "asc" }] },
    },
  });
  posts = kavo.createCrud(Post, {
    allowlists: { includable: ["comments"] },
  } as never) as DefaultKavoService<Post>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Comment).clear();
  await dataSource.getRepository(Post).clear();
});

/** Two distinct timestamps across the seeded rows, so the date key really has ties to break. */
const EPOCH = new Date("2024-01-01T00:00:00.000Z");

async function seed(count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await posts.createOne({
      title: `post-${index}`,
      score: index % 3,
      status: index % 2 === 0 ? "published" : "draft",
      createdAt: new Date(EPOCH.getTime() + Math.floor((index - 1) / 3) * 86_400_000),
    } as never);
  }
}

/**
 * The `nextCursor` a cursor page carries.
 *
 * `ListResultDto.meta` is optional and absent when nothing contributed to
 * it (#122), but a cursor page always contributes: `nextCursor` is `null`
 * on the last page rather than missing. Asserting that here is what lets
 * every call site read the token directly.
 */
function nextCursorOf(list: Pick<ListResultDto<unknown>, "meta">): string | null {
  expect(list.meta).toBeDefined();
  return (list.meta as ListMetaDto)["nextCursor"] as string | null;
}

/** Walk every page, collecting titles in order. */
async function walk(limit: number, query: Record<string, unknown> = {}): Promise<string[]> {
  const titles: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const result = await posts.findMany({ ...query, limit, cursor } as never);
    titles.push(...result.items.map((item) => (item as Post).title));
    cursor = nextCursorOf(result);
    if (cursor === null) {
      return titles;
    }
  }
  throw new Error("cursor paging did not terminate");
}

describe("TypeOrmRepositoryAdapter — keyset pagination", () => {
  it("walks the whole table exactly once, in order", async () => {
    await seed(7);
    expect(await walk(3)).toEqual(["post-1", "post-2", "post-3", "post-4", "post-5", "post-6", "post-7"]);
  });

  it("reports null on the last page and a token before it", async () => {
    await seed(3);
    const first = await posts.findMany({ limit: 2 } as never);
    expect(typeof nextCursorOf(first)).toBe("string");
    const second = await posts.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect(second.items).toHaveLength(1);
    expect(nextCursorOf(second)).toBeNull();
  });

  it("returns an empty page with no cursor for an empty table", async () => {
    const page = await posts.findMany({ limit: 5 } as never);
    expect(page.items).toEqual([]);
    expect(nextCursorOf(page)).toBeNull();
    expect(page.total).toBe(0);
  });

  it("pages a mixed asc/desc sort — the ORDER BY and the keyset agree", async () => {
    await seed(7);
    const titles = await walk(2, {
      sort: [
        { field: "score", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    // score = id % 3, so: 2,2 | 1,1,1 | 0,0 — ties broken by ascending id.
    expect(titles).toEqual(["post-2", "post-5", "post-1", "post-4", "post-7", "post-3", "post-6"]);
    expect(new Set(titles).size).toBe(7);
  });

  it("composes with the client's own filter, and total still spans the match set", async () => {
    await seed(8);
    const published = { filter: { kind: "condition", field: "status", operator: "EQ", value: "published" } };

    const first = await posts.findMany({ ...published, limit: 2 } as never);
    expect(first.items.map((item) => (item as Post).title)).toEqual(["post-2", "post-4"]);
    expect(first.total).toBe(4);

    const second = await posts.findMany({ ...published, limit: 2, cursor: nextCursorOf(first) } as never);
    expect(second.items.map((item) => (item as Post).title)).toEqual(["post-6", "post-8"]);
    expect(second.total).toBe(4);
    expect(nextCursorOf(second)).toBeNull();
  });

  it("composes with an include join without duplicating or dropping rows", async () => {
    await seed(4);
    const all = await posts.findMany({ limit: 10 } as never);
    const target = all.items[0] as Post;
    await dataSource.getRepository(Comment).save([
      { body: "a", post: { id: target.id } },
      { body: "b", post: { id: target.id } },
    ] as never);

    const titles = await walk(2, { include: ["comments"] });
    expect(titles).toEqual(["post-1", "post-2", "post-3", "post-4"]);
  });

  it("keeps soft-deleted rows out of every cursor page", async () => {
    await seed(6);
    const all = await posts.findMany({ limit: 10 } as never);
    await posts.deleteOne((all.items[1] as Post).id);
    await posts.deleteOne((all.items[3] as Post).id);

    expect(await walk(2)).toEqual(["post-1", "post-3", "post-5", "post-6"]);
  });

  it("pages only soft-deleted rows under onlyDeleted", async () => {
    await seed(5);
    const all = await posts.findMany({ limit: 10 } as never);
    await posts.deleteOne((all.items[0] as Post).id);
    await posts.deleteOne((all.items[2] as Post).id);
    await posts.deleteOne((all.items[4] as Post).id);

    expect(await walk(2, { onlyDeleted: true })).toEqual(["post-1", "post-3", "post-5"]);
  });

  it("pages a date-typed cursor key, ties and all — the Date survives the driver", async () => {
    // `?sort=-createdAt,id` is the canonical example in the docs, and a
    // revived `Date` has to survive as a bound parameter: sqlite stores a
    // datetime as text, so a cursor that came back as a string would either
    // compare lexically or blow up.
    await seed(7);
    const titles = await walk(2, {
      sort: [
        { field: "createdAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    // Day 2 holds posts 4–6, day 1 holds 1–3, and post 7 is alone on day 3.
    expect(titles).toEqual(["post-7", "post-4", "post-5", "post-6", "post-1", "post-2", "post-3"]);
    expect(new Set(titles).size).toBe(7);
  });

  it("pages a text cursor key — the ORDER BY collation and the keyset agree", async () => {
    // If the database's collation for `>` disagreed with its `ORDER BY`, a
    // page boundary would skip or repeat a row rather than fail loudly.
    for (const title of ["delta", "Bravo", "alpha", "Echo", "charlie"]) {
      await posts.createOne({ title, score: 0, status: "draft", createdAt: EPOCH } as never);
    }
    const titles = await walk(2, {
      sort: [
        { field: "title", direction: "asc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    const oneShot = await posts.findMany({
      limit: 50,
      sort: [
        { field: "title", direction: "asc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    expect(titles).toEqual(oneShot.items.map((item) => (item as Post).title));
    expect(new Set(titles).size).toBe(5);
  });

  it("pages a three-key sort whose deepest AND chain actually decides a boundary", async () => {
    // `status` and `score` both tie across rows, so the final `id > …` link
    // of the chain is the only thing separating two adjacent pages.
    for (let index = 1; index <= 6; index++) {
      await posts.createOne({ title: `tied-${index}`, score: 1, status: "draft", createdAt: EPOCH } as never);
    }
    const titles = await walk(2, {
      sort: [
        { field: "status", direction: "asc" },
        { field: "score", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    expect(titles).toEqual(["tied-1", "tied-2", "tied-3", "tied-4", "tied-5", "tied-6"]);
  });

  it("pages filter, include and soft delete together in one walk", async () => {
    // Each of the three is covered alone above; this is the interaction —
    // where a join-induced duplicate or a scope-vs-keyset precedence bug
    // would hide.
    await seed(10);
    const all = await posts.findMany({ limit: 20 } as never);
    const published = (all.items as Post[]).filter((post) => post.status === "published");
    await posts.deleteOne(published[1]!.id);
    await posts.deleteOne(published[3]!.id);
    await dataSource.getRepository(Comment).save([
      { body: "a", post: { id: published[0]!.id } },
      { body: "b", post: { id: published[0]!.id } },
    ] as never);

    const titles = await walk(2, {
      filter: { kind: "condition", field: "status", operator: "EQ", value: "published" },
      include: ["comments"],
    });
    expect(titles).toEqual(["post-2", "post-6", "post-10"]);
    expect(new Set(titles).size).toBe(3);
  });

  it("pages live and soft-deleted rows together under withDeleted", async () => {
    await seed(5);
    const all = await posts.findMany({ limit: 10 } as never);
    await posts.deleteOne((all.items[1] as Post).id);
    await posts.deleteOne((all.items[3] as Post).id);

    expect(await walk(2, { withDeleted: true })).toEqual(["post-1", "post-2", "post-3", "post-4", "post-5"]);
  });

  // ── The null-sort-key limitation (ADR-0021 §4) ──────────────────────
  //
  // These two pin the *documented* behavior, not the desired one. Cursor
  // pagination must not be used over a nullable sort key; which of the two
  // failure modes an adopter gets depends on where the engine sorts NULLs,
  // which is engine- and direction-specific. sqlite sorts NULLs first on
  // ASC and last on DESC, so one suite can show both.

  it("fails loudly when a null sort key lands on a page boundary (NULLS FIRST)", async () => {
    await posts.createOne({ title: "n1", score: 0, status: "draft", createdAt: EPOCH, rank: null } as never);
    await posts.createOne({ title: "n2", score: 0, status: "draft", createdAt: EPOCH, rank: null } as never);
    await posts.createOne({ title: "r1", score: 0, status: "draft", createdAt: EPOCH, rank: 1 } as never);

    const sort = [
      { field: "rank", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    const first = await posts.findMany({ limit: 2, sort } as never);
    expect(first.items.map((item) => (item as Post).title)).toEqual(["n1", "n2"]);
    // The boundary row's `rank` is NULL, so the token carries a null and the
    // replay is a 400 naming the column — the loud half of the story.
    await expect(posts.findMany({ limit: 2, sort, cursor: nextCursorOf(first) } as never)).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      issues: [{ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" }],
    });
  });

  it("silently omits null-keyed rows when NULLs sort last — the reason cursor paging bans nullable keys", async () => {
    await posts.createOne({ title: "r2", score: 0, status: "draft", createdAt: EPOCH, rank: 2 } as never);
    await posts.createOne({ title: "r1", score: 0, status: "draft", createdAt: EPOCH, rank: 1 } as never);
    await posts.createOne({ title: "n1", score: 0, status: "draft", createdAt: EPOCH, rank: null } as never);
    await posts.createOne({ title: "n2", score: 0, status: "draft", createdAt: EPOCH, rank: null } as never);

    const titles = await walk(2, {
      sort: [
        { field: "rank", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
    // `rank < 1` is UNKNOWN for a NULL row, so page 2 matches nothing and
    // paging terminates with `nextCursor: null` — no error, two rows gone.
    // `total` meanwhile still counts all four.
    expect(titles).toEqual(["r2", "r1"]);
    const all = await posts.findMany({ limit: 10 } as never);
    expect(all.total).toBe(4);
  });

  it("rejects a tampered cursor as a query validation error", async () => {
    await seed(2);
    await expect(posts.findMany({ limit: 1, cursor: "tampered!!" } as never)).rejects.toBeInstanceOf(
      QueryValidationException,
    );
    await expect(posts.findMany({ limit: 1, cursor: "tampered!!" } as never)).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      status: 400,
    });
  });

  it("rejects a sort with no unique tiebreaker", async () => {
    await expect(
      posts.findMany({ limit: 2, sort: [{ field: "score", direction: "asc" }] } as never),
    ).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      issues: [{ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" }],
    });
  });
});
