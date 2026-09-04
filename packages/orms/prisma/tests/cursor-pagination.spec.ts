import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { QueryValidationException, type DefaultKavoService, type ListMetaDto, type ListResultDto } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";

/**
 * Keyset pagination against a real Prisma client (ADR-0021). Prisma has a
 * `cursor` option of its own, but it takes a single unique id and cannot
 * express a multi-column keyset with mixed directions — so the adapter
 * translates core's keyset predicate through the same `where` path as any
 * other filter, and this suite proves that composes with the client's own
 * filter, with `include`, and with the soft-delete scope, and that the
 * driver actually round-trips every cursor key type: int, text, and `Date`.
 */

class Post {
  id!: number;
  title!: string;
  score!: number;
  status!: string;
  /** Set explicitly by the seeds, so several rows can share a timestamp. */
  createdAt!: Date;
  deletedAt!: Date | null;
  comments?: Comment[];
}

class Comment {
  id!: number;
  body!: string;
  postId!: number | null;
}

let client: PrismaClient;
let posts: DefaultKavoService<Post>;

beforeAll(() => {
  client = newTestPrismaClient();
  const kavo = createPrismaKavo(
    client as never,
    {
      datamodel: Prisma.dmmf.datamodel,
      entities: [Post, Comment],
      caseInsensitiveFilters: false,
      defaults: {
        pagination: { strategy: "cursor" },
        query: { defaultSort: [{ field: "id", direction: "asc" }] },
      },
    } as never,
  );
  posts = kavo.createCrud(Post, {
    softDelete: { field: "deletedAt" },
    allowed: { includable: ["comments"] },
  } as never) as DefaultKavoService<Post>;
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.comment.deleteMany();
  await client.post.deleteMany();
});

/** Three distinct days across the seeded rows, so the date key really has ties to break. */
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

describe("PrismaRepositoryAdapter — keyset pagination", () => {
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

  it("pages a mixed asc/desc sort — the orderBy and the keyset agree", async () => {
    await seed(7);
    const titles = await walk(2, {
      sort: [
        { field: "score", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    } as never);
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
    expect(nextCursorOf(second)).toBeNull();
  });

  it("composes with an include without duplicating or dropping rows", async () => {
    await seed(4);
    const all = await posts.findMany({ limit: 10 } as never);
    const target = all.items[0] as Post;
    await client.comment.createMany({
      data: [
        { body: "a", postId: target.id },
        { body: "b", postId: target.id },
      ],
    });

    expect(await walk(2, { include: ["comments"] })).toEqual(["post-1", "post-2", "post-3", "post-4"]);
  });

  it("keeps soft-deleted rows out of every cursor page", async () => {
    await seed(6);
    const all = await posts.findMany({ limit: 10 } as never);
    await posts.deleteOne((all.items[1] as Post).id);
    await posts.deleteOne((all.items[3] as Post).id);

    expect(await walk(2)).toEqual(["post-1", "post-3", "post-5", "post-6"]);
  });

  it("pages a date-typed cursor key, ties and all — the Date survives the driver", async () => {
    // `?sort=-createdAt,id` is the canonical example in the docs, and a
    // revived `Date` has to survive as a bound Prisma `DateTime` parameter:
    // sqlite stores a datetime as text, so a cursor that came back as a
    // string would either compare lexically or blow up against the client.
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
    await client.comment.createMany({
      data: [
        { body: "a", postId: published[0]!.id },
        { body: "b", postId: published[0]!.id },
      ],
    });

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
