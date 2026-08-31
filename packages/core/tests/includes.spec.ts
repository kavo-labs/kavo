import { describe, expect, it } from "vitest";
import {
  AssociationInvalidShapeException,
  ConfigurationException,
  QueryValidationException,
  createKavo,
  resolveEntityConfig,
} from "@kavo/core";
import type {
  KavoInstance,
  KavoOptions,
  DefaultKavoService,
  EntityConfig,
  EntityMetadata,
  IncludeNode,
  IncludePath,
} from "@kavo/core";
import {
  Author,
  Comment,
  Post,
  SeededAdapter,
  authorMetadata,
  commentMetadata,
  postMetadata,
} from "./support/blog-fixture.js";

interface Blog {
  kavo: KavoInstance;
  authors: DefaultKavoService<Author>;
  posts: DefaultKavoService<Post>;
  authorAdapter: SeededAdapter<Author>;
  postAdapter: SeededAdapter<Post>;
  authorRows: Author[];
  postRows: Post[];
}

/**
 * A three-entity graph wired through one root instance, so nested include
 * resolution walks real per-entity configs — the thing that makes a
 * relation unable to widen its target.
 */
function blog(
  configs: {
    author?: EntityConfig<Author>;
    post?: EntityConfig<Post>;
    comment?: EntityConfig<Comment>;
  } = {},
  options: KavoOptions = {},
): Blog {
  const metadata = new Map<unknown, EntityMetadata<object>>([
    [Author, authorMetadata as EntityMetadata<object>],
    [Post, postMetadata as EntityMetadata<object>],
    [Comment, commentMetadata as EntityMetadata<object>],
  ]);
  const authorAdapter = new SeededAdapter<Author>([]);
  const postAdapter = new SeededAdapter<Post>([]);
  const commentAdapter = new SeededAdapter<Comment>([]);
  const adapters = new Map<unknown, unknown>([
    [Author, authorAdapter],
    [Post, postAdapter],
    [Comment, commentAdapter],
  ]);
  const kavo = createKavo({
    ...options,
    infrastructure: {
      metadataFor: (entity) => metadata.get(entity) as never,
      adapterFor: (entity) => adapters.get(entity) as never,
    },
  });
  const authors = kavo.createCrud(Author, configs.author as never) as DefaultKavoService<Author>;
  const posts = kavo.createCrud(Post, configs.post as never) as DefaultKavoService<Post>;
  kavo.createCrud(Comment, configs.comment as never);
  return {
    kavo,
    authors,
    posts,
    authorAdapter,
    postAdapter,
    authorRows: authorAdapter.rows,
    postRows: postAdapter.rows,
  };
}

const authorWithPosts = (): Author =>
  Object.assign(new Author(), {
    id: 1,
    name: "Ada",
    posts: [
      Object.assign(new Post(), {
        id: 10,
        title: "First",
        authorId: 1,
        comments: [Object.assign(new Comment(), { id: 100, body: "nice", postId: 10 })],
      }),
    ],
  });

describe("include resolution", () => {
  it("rejects a relation nobody opted in — inclusion is an allowlist", async () => {
    const fixture = blog();
    const { authors } = fixture;
    await expect(authors.findMany({ include: ["posts"] })).rejects.toMatchObject({
      issues: [{ field: "posts", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("rejects an unknown relation with the same 400", async () => {
    const fixture = blog({ author: { allowlists: { includable: ["posts"] } } });
    const { authors } = fixture;
    // `IncludePath` rejects 'ghosts' at compile time now, which is the point
    // of the type — but the *runtime* rejection is a separate guarantee and
    // still has to hold: wire requests arrive as strings and never meet the
    // type. Casting keeps that path under test.
    const unknownPath = ["ghosts"] as unknown as readonly IncludePath<Author>[];
    await expect(authors.findMany({ include: unknownPath })).rejects.toBeInstanceOf(QueryValidationException);
  });

  it("fails at bootstrap when allowlists.includable names a relation the entity does not have", () => {
    expect(() => blog({ author: { allowlists: { includable: ["ghosts" as never] } } })).toThrow(ConfigurationException);
  });

  it("fails at bootstrap when relations.edges names a relation the entity does not have", () => {
    try {
      blog({ author: { relations: { edges: { ghosts: { strategy: "join" } } } } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      // A distinct path from the sibling allowlists.includable typo check
      // above — edges (tuning) and includable (permission) are two
      // different config keys that both fail fast on the same kind of
      // typo, and the path is what tells them apart.
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "relations.edges.ghosts",
      });
    }
  });

  it("merges overlapping paths into one tree", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { includable: ["comments"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    await authors.findMany({ include: ["posts", "posts.comments"] });
    const tree = includeTree(fixture.authorAdapter);
    expect(Object.keys(tree)).toEqual(["posts"]);
    expect(Object.keys(tree["posts"]!.children)).toEqual(["comments"]);
    expect(tree["posts"]!.path).toBe("posts");
    expect(tree["posts"]!.children["comments"]!.path).toBe("posts.comments");
  });

  it("resolves auto strategies from cardinality: to-one joins, to-many batches", async () => {
    const fixture = blog({
      post: { allowlists: { includable: ["author", "comments"] } },
    });
    const { posts, postRows } = fixture;
    postRows.push(Object.assign(new Post(), { id: 10, title: "First" }));

    await posts.findMany({ include: ["author", "comments"] });
    const tree = includeTree(fixture.postAdapter);
    expect(tree["author"]!.strategy).toBe("join");
    expect(tree["comments"]!.strategy).toBe("batch");
  });

  it("honors an explicit strategy over the heuristic", async () => {
    const fixture = blog({
      post: {
        allowlists: { includable: ["comments"] },
        relations: { edges: { comments: { strategy: "join" } } },
      },
    });
    const { posts, postRows } = fixture;
    postRows.push(Object.assign(new Post(), { id: 10 }));
    await posts.findMany({ include: ["comments"] });
    expect(includeTree(fixture.postAdapter)["comments"]!.strategy).toBe("join");
  });

  it("carries the target's delete strategy, not the root's", async () => {
    const fixture = blog({ author: { allowlists: { includable: ["posts"] } } });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());
    await authors.findMany({ include: ["posts"] });
    // Author has no marker field; Post does.
    expect(includeTree(fixture.authorAdapter)["posts"]!.softDelete).toEqual({ strategy: "soft", field: "deletedAt" });
  });

  it("enforces maxIncludeDepth", async () => {
    const fixture = blog(
      {
        author: { allowlists: { includable: ["posts"] } },
        post: { allowlists: { includable: ["comments"] } },
      },
      { defaults: { relations: { maxIncludeDepth: 1 } } },
    );
    const { authors } = fixture;
    await expect(authors.findMany({ include: ["posts.comments"] })).rejects.toMatchObject({
      issues: [{ field: "posts.comments", code: "KAVO_QUERY_LIMIT_EXCEEDED" }],
    });
  });

  it("lets a per-relation maxDepth override the budget below it", async () => {
    const fixture = blog(
      {
        author: {
          allowlists: { includable: ["posts"] },
          relations: { edges: { posts: { maxDepth: 3 } } },
        },
        post: { allowlists: { includable: ["comments"] } },
      },
      { defaults: { relations: { maxIncludeDepth: 1 } } },
    );
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());
    const list = await authors.findMany({ include: ["posts.comments"] });
    expect(Object.keys(includeTree(fixture.authorAdapter)["posts"]!.children)).toEqual(["comments"]);
    expect(list.items[0]).toMatchObject({ posts: [{ comments: [{ body: "nice" }] }] });
  });

  it("enforces maxIncludedNodes across the whole tree", async () => {
    const fixture = blog(
      { post: { allowlists: { includable: ["author", "comments"] } } },
      { defaults: { relations: { maxIncludedNodes: 1 } } },
    );
    const { posts, postRows } = fixture;
    postRows.push(Object.assign(new Post(), { id: 10 }));
    await expect(posts.findMany({ include: ["author", "comments"] })).rejects.toMatchObject({
      issues: [{ code: "KAVO_QUERY_LIMIT_EXCEEDED" }],
    });
  });

  it("bounds a self-revisiting path by depth, not by visited types", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { includable: ["author"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());
    // posts.author revisits Author — legal, because depth is the contract.
    await expect(authors.findMany({ include: ["posts.author"] })).resolves.toBeDefined();
    await expect(authors.findMany({ include: ["posts.author.posts"] })).rejects.toMatchObject({
      issues: [{ code: "KAVO_QUERY_LIMIT_EXCEEDED" }],
    });
  });

  it("adds defaultInclude relations with no include param at all", async () => {
    const fixture = blog({
      author: {
        allowlists: { includable: ["posts"] },
        relations: { edges: { posts: { defaultInclude: true } } },
      },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());
    const list = await authors.findMany();
    expect(list.items[0]).toMatchObject({ name: "Ada", posts: [{ title: "First" }] });
  });
});

describe("include serialization", () => {
  it("projects an included node through the target's own shape", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { selectable: ["id", "title"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({ include: ["posts"] });
    // `authorId` and `deletedAt` are columns of Post, so the derived
    // default still emits them — the allowlist governs *selection*.
    expect(list.items[0]).toMatchObject({ id: 1, name: "Ada" });
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toMatchObject({ id: 10, title: "First" });
  });

  it("narrows an included node with select[path], validated against the target", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({
      include: ["posts"],
      select: { relations: { posts: ["id", "title"] } },
    });
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toEqual({ id: 10, title: "First" });
  });

  it("accepts the relation-keyed select spelling identically", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    // `{ posts: [...] }` is sugar for `{ relations: { posts: [...] } }` — the
    // sugar has to survive include resolution, not just normalization.
    const list = await authors.findMany({
      include: ["posts"],
      select: { posts: ["id", "title"] },
    });
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toEqual({ id: 10, title: "First" });
  });

  it("rejects a fieldset the target does not allow", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { selectable: ["id"] } },
    });
    const { authors } = fixture;
    await expect(
      authors.findMany({ include: ["posts"], select: { relations: { posts: ["title"] } } }),
    ).rejects.toMatchObject({
      issues: [{ field: "posts.title", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("rejects a non-array relation fieldset value rather than throwing", async () => {
    // Runtime strings — or, here, a caller bypassing the type entirely —
    // can hand the resolver a shape `IncludeRequest.fields` was never meant
    // to carry. This must fail the same way a malformed top-level `select`
    // value does: one issue, never an uncaught error that surfaces as 500.
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
    });
    const { authors } = fixture;
    await expect(
      authors.findMany({ include: ["posts"], select: { relations: { posts: 5 as never } } }),
    ).rejects.toMatchObject({
      issues: [{ field: "posts", code: "KAVO_QUERY_INVALID_VALUE" }],
    });
  });

  it("omits relation keys that were not included", async () => {
    const fixture = blog({ author: { allowlists: { includable: ["posts"] } } });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());
    const list = await authors.findMany();
    expect(list.items[0]).not.toHaveProperty("posts");
  });

  it("emits an empty list / null for a relation with nothing loaded", async () => {
    const fixture = blog({
      post: { allowlists: { includable: ["author", "comments"] } },
    });
    const { posts, postRows } = fixture;
    postRows.push(Object.assign(new Post(), { id: 10, title: "Lonely", author: null, comments: [] }));
    const list = await posts.findMany({ include: ["author", "comments"] });
    expect(list.items[0]).toMatchObject({ author: null, comments: [] });
  });

  it("normalizes a null to-many relation to an empty array, never null", async () => {
    // Adapters disagree on whether an unhydrated collection comes back as
    // `[]` or `null`; the envelope must not leak that difference, or a
    // client would have to null-check a field the schema types as a list.
    const fixture = blog({
      post: { allowlists: { includable: ["comments"] } },
    });
    const { posts, postRows } = fixture;
    postRows.push(Object.assign(new Post(), { id: 11, title: "Null comments", comments: null as never }));
    const list = await posts.findMany({ include: ["comments"] });
    expect(list.items[0]).toMatchObject({ comments: [] });
  });
});

describe("association by id (ADR-0014)", () => {
  it("accepts an { id } reference, and narrows a deep payload", async () => {
    const fixture = blog();
    const { posts, postAdapter } = fixture;

    const created = await posts.createOne({ title: "a", author: { id: 7 } } as never);
    expect(created).toMatchObject({ title: "a" });
    expect(lastRow(postAdapter)["author"]).toEqual({ id: 7 });

    // A nested object is narrowed to the id: association, never a deep write.
    await posts.createOne({ title: "b", author: { id: 8, name: "smuggled" } } as never);
    expect(lastRow(postAdapter)["author"]).toEqual({ id: 8 });

    await posts.createOne({ title: "c", author: null } as never);
    expect(lastRow(postAdapter)["author"]).toBeNull();
  });

  it("rejects a bare scalar id instead of resolving it as shorthand for an { id } reference (issue #291)", async () => {
    const fixture = blog();
    const { posts } = fixture;
    await expect(posts.createOne({ title: "a", author: 7 } as never)).rejects.toThrowError(
      AssociationInvalidShapeException,
    );
  });

  it("maps a to-many association element-wise", async () => {
    const fixture = blog();
    const { authors, authorAdapter } = fixture;
    await authors.createOne({ name: "Ada", posts: [{ id: 1 }, { id: 2 }] } as never);
    expect(lastRow(authorAdapter)["posts"]).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

/**
 * Issue #7: the two ways an include can be rejected used to render the
 * identical sentence, so the message could not tell a typo from a
 * permission that was never granted. Assertions stay on the actionable
 * clause (`toContain`), never on the whole string — the prose is meant to
 * keep improving.
 */
describe("include rejection messages", () => {
  const detailOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (error) {
      const issues = (error as QueryValidationException).issues;
      expect(issues).toHaveLength(1);
      return issues[0]!.detail;
    }
    throw new Error("expected QueryValidationException");
  };

  it("says the same thing for a relation that exists and one that does not", async () => {
    // The oracle this closes: `Author.posts` is real but never opted in,
    // `ghosts` is not a relation at all. Inclusion is opt-in and defaults to
    // empty, so a message that distinguished them would confirm the
    // existence of every edge the config deliberately closed — one guessed
    // name per request. Both rejections differ only in the name echoed back.
    const { authors } = blog();
    const real = await detailOf(() => authors.findMany({ include: ["posts"] }));
    const invented = await detailOf(() =>
      authors.findMany({ include: ["ghosts"] as unknown as readonly IncludePath<Author>[] }),
    );
    expect(real.replace(/posts/g, "X")).toBe(invented.replace(/ghosts/g, "X"));
    expect(real).toContain("is not includable on Author");
    expect(invented).toContain("is not includable on Author");
  });

  it("names the config key that opts a real relation in", async () => {
    const { authors } = blog();
    const detail = await detailOf(() => authors.findMany({ include: ["posts"] }));
    expect(detail).toContain("allowlists.includable");
    expect(detail).toContain("on the Author config");
  });

  it("lists the includable relations, and says 'none' when the default empty config is why", async () => {
    const { authors } = blog();
    const detail = await detailOf(() =>
      authors.findMany({ include: ["ghosts"] as unknown as readonly IncludePath<Author>[] }),
    );
    expect(detail).toContain("Includable relations on Author: none.");
  });

  it("suggests the near miss, drawn only from relations already opted in", async () => {
    const { authors } = blog({ author: { allowlists: { includable: ["posts"] } } });
    const detail = await detailOf(() =>
      authors.findMany({ include: ["postz"] as unknown as readonly IncludePath<Author>[] }),
    );
    expect(detail).toContain("Did you mean 'posts'?");
  });

  it("never enumerates a relation the config has not opted in", async () => {
    // The disclosure rule: a rejection may name only what the client is
    // already permitted to ask for. `Post.author` exists in metadata but no
    // edge names it, so it must not appear.
    const { authors } = blog({
      author: { allowlists: { includable: ["posts"] } },
    });
    const detail = await detailOf(() =>
      authors.findMany({ include: ["posts.authr"] as unknown as readonly IncludePath<Author>[] }),
    );
    expect(detail).toContain("Includable relations on Post: none.");
    expect(detail).not.toContain("'author'");
  });

  it("blames the entity that owns the failing segment, not the root", async () => {
    const { authors } = blog({
      author: { allowlists: { includable: ["posts"] } },
    });
    const detail = await detailOf(() =>
      authors.findMany({ include: ["posts.comments"] as unknown as readonly IncludePath<Author>[] }),
    );
    expect(detail).toContain("is not includable on Post");
    expect(detail).toContain("(in include path 'posts.comments')");
    expect(detail).toContain("on the Post config");
    expect(detail).not.toContain("Author");
  });

  it("names the target entity's allowlist when a relation fieldset is rejected", async () => {
    const { authors } = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { selectable: ["id", "title"] } },
    });
    const detail = await detailOf(() =>
      authors.findMany({ include: ["posts"], select: { relations: { posts: ["titel"] } } }),
    );
    expect(detail).toContain("Did you mean 'title'?");
    expect(detail).toContain("Selectable fields on Post: id, title.");
    expect(detail).toContain("allowlists.selectable on the Post config");
  });
});

describe("relation projection ceiling — allowlists.selectable relation paths (ADR-0044)", () => {
  const authorCeiling = (): EntityConfig<Author> => ({
    allowlists: { includable: ["posts"], selectable: ["id", "name", "posts.title"] },
  });

  it("derives relationProjection from the dotted selectable entries and strips them from the root list", () => {
    const config = resolveEntityConfig(authorMetadata, authorCeiling() as never, undefined);
    expect(config.relationProjection).toEqual({ posts: ["title"] });
    // The relation path is the ceiling, not a root `select=` path — it must
    // not leak into the resolved selectable list or the response projection.
    expect(config.allowlists.selectable).toEqual(["id", "name"]);
    expect(config.projection).toEqual(["id", "name"]);
  });

  it("relationProjection is undefined when selectable names no relation path", () => {
    const config = resolveEntityConfig(
      authorMetadata,
      { allowlists: { selectable: ["id", "name"] } } as never,
      undefined,
    );
    expect(config.relationProjection).toBeUndefined();
  });

  it("projects an included relation to the ceiling with no select[path] in the request", async () => {
    const fixture = blog({ author: authorCeiling() });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({ include: ["posts"] });
    // Post's own config would serve id/title/authorId/deletedAt; the ceiling
    // on the *Author* config cuts the included node to `title` alone.
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toEqual({ title: "First" });
  });

  it("applies the ceiling to findOne", async () => {
    const fixture = blog({ author: authorCeiling() });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const one = await authors.findOne(1, { include: ["posts"] });
    expect((one as { posts: unknown[] }).posts[0]).toEqual({ title: "First" });
  });

  it("lets a request narrow within the ceiling but not past it", async () => {
    const fixture = blog({
      author: {
        allowlists: { includable: ["posts"], selectable: ["id", "name", "posts.id", "posts.title"] },
      },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const narrowed = await authors.findMany({
      include: ["posts"],
      select: { relations: { posts: ["id"] } },
    });
    expect((narrowed.items[0] as { posts: unknown[] }).posts[0]).toEqual({ id: 10 });

    await expect(
      authors.findMany({ include: ["posts"], select: { relations: { posts: ["title", "authorId"] } } }),
    ).rejects.toMatchObject({
      // `title` is on the ceiling; `authorId` is a real Post column but off it.
      issues: [{ field: "posts.authorId", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("blames the owner entity's config when a request escapes the ceiling", async () => {
    const { authors } = blog({ author: authorCeiling() });
    const detail = await authors.findMany({ include: ["posts"], select: { relations: { posts: ["authorId"] } } }).then(
      () => {
        throw new Error("expected a QueryValidationException");
      },
      (error: unknown) => (error as QueryValidationException).issues[0]!.detail,
    );
    expect(detail).toContain("the 'Author' config restricts 'posts' to");
    expect(detail).toContain("title");
  });

  it("bounds the ceiling even where the target registers a wider item DTO", async () => {
    class PostItemDto {
      id = 0;
      title = "";
      authorId = 0;
    }
    const fixture = blog({
      author: authorCeiling(),
      post: { dto: { item: PostItemDto } as never },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({ include: ["posts"] });
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toEqual({ title: "First" });
  });

  it("applies each owner's own ceiling at its own level of a nested include", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"], selectable: ["id", "name", "posts.title"] } },
      post: { allowlists: { includable: ["comments"], selectable: ["id", "title", "comments.body"] } },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({ include: ["posts.comments"] });
    const post = (list.items[0] as unknown as { posts: Array<Record<string, unknown>> }).posts[0]!;
    // Author's ceiling keeps `title`; the `comments` key still rides along
    // because it is an included child, projected by Post's own ceiling.
    expect(post["title"]).toBe("First");
    expect(post["comments"]).toEqual([{ body: "nice" }]);
  });

  it("holds even when the relation target never went through createCrud", async () => {
    // Comment's metadata is known to the instance but it is never
    // `createCrud`-ed, so it gets a derived config that configures nothing
    // (ADR-0026 §"Decision 4 holds only for registered entities"). The
    // ceiling still applies, because it rides on Post's `node.fields`, not
    // on Comment's config.
    const metadata = new Map<unknown, EntityMetadata<object>>([
      [Post, postMetadata as EntityMetadata<object>],
      [Comment, commentMetadata as EntityMetadata<object>],
    ]);
    const postAdapter = new SeededAdapter<Post>([
      Object.assign(new Post(), {
        id: 10,
        title: "First",
        authorId: 1,
        comments: [Object.assign(new Comment(), { id: 100, body: "nice", postId: 10 })],
      }),
    ]);
    const adapters = new Map<unknown, unknown>([
      [Post, postAdapter],
      [Comment, new SeededAdapter<Comment>([])],
    ]);
    const kavo = createKavo({
      infrastructure: {
        metadataFor: (entity) => metadata.get(entity) as never,
        adapterFor: (entity) => adapters.get(entity) as never,
      },
    });
    const posts = kavo.createCrud(Post, {
      allowlists: { includable: ["comments"], selectable: ["id", "title", "comments.body"] },
    } as never) as DefaultKavoService<Post>;

    const list = await posts.findMany({ include: ["comments"] });
    // The derived Comment config would serve id/body/postId; the ceiling on
    // the Post config cuts the embed to `body` alone.
    expect((list.items[0] as unknown as { comments: unknown[] }).comments[0]).toEqual({ body: "nice" });
  });

  it("omits a ceiling field that names no real column on the target", async () => {
    // The field half of a ceiling entry is not checked at bootstrap (the
    // target's metadata is not in scope). On the default path — no
    // `select[posts]=` in the request — an unknown ceiling field is simply
    // dropped from the embed, not raised as an error.
    const fixture = blog({
      author: {
        allowlists: { includable: ["posts"], selectable: ["id", "name", "posts.title", "posts.ghost" as never] },
      },
    });
    const { authors, authorRows } = fixture;
    authorRows.push(authorWithPosts());

    const list = await authors.findMany({ include: ["posts"] });
    expect((list.items[0] as { posts: unknown[] }).posts[0]).toEqual({ title: "First" });
  });

  describe("bootstrap rejections", () => {
    const bootstrap =
      (selectable: readonly string[], includable: readonly string[] = ["posts"]): (() => unknown) =>
      () =>
        resolveEntityConfig(authorMetadata, { allowlists: { includable, selectable } } as never, undefined);

    it("rejects a dotted selectable entry whose head is not a relation", () => {
      expect(bootstrap(["id", "postz.title"])).toThrow(/'postz' is not a relation of Author/);
    });

    it("rejects a selectable relation path deeper than one segment", () => {
      expect(bootstrap(["id", "posts.author.name"])).toThrow(/deeper than one relation segment/);
    });

    it("rejects a relation projected by selectable but not on allowlists.includable", () => {
      expect(bootstrap(["id", "posts.title"], [])).toThrow(/not on allowlists\.includable/);
    });

    it("rejects a relation path inside the { exclude } form of selectable", () => {
      expect(() =>
        resolveEntityConfig(
          authorMetadata,
          { allowlists: { includable: ["posts"], selectable: { exclude: ["posts.title"] } } } as never,
          undefined,
        ),
      ).toThrow(/the \{ exclude \} form cannot/);
    });

    it("every rejection is a ConfigurationException", () => {
      expect(bootstrap(["id", "postz.title"])).toThrow(ConfigurationException);
    });
  });
});

describe("defaultInclude", () => {
  it("does not duplicate a relation the client also asked for, and keeps the requested subtree", () => {
    // The dedupe has to lose to the client's own draft, not the other way
    // round: a `defaultInclude` node carries no children, so clobbering
    // would silently drop `posts.comments` from the response.
    const fixture = blog({
      author: {
        allowlists: { includable: ["posts"] },
        relations: { edges: { posts: { defaultInclude: true } } },
      },
      post: { allowlists: { includable: ["comments"] } },
    } as never);

    return fixture.authors.findMany({ include: ["posts.comments"] } as never).then(() => {
      const tree = includeTree(fixture.authorAdapter);
      expect(Object.keys(tree)).toEqual(["posts"]);
      expect(Object.keys(tree["posts"]!.children)).toEqual(["comments"]);
    });
  });

  it("gives a nested defaultInclude relation its full dotted path", async () => {
    // `path` is what `select[...]` and every issue message key off, so a
    // nested default that reported a bare name would be unaddressable.
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: {
        allowlists: { includable: ["comments"] },
        relations: { edges: { comments: { defaultInclude: true } } },
      },
    } as never);

    await fixture.authors.findMany({ include: ["posts"] } as never);

    const tree = includeTree(fixture.authorAdapter);
    expect(tree["posts"]!.children["comments"]!.path).toBe("posts.comments");
  });
});

/**
 * ADR-0028: permission moved out of `relations.edges` into
 * `allowlists.includable`. `relations.edges` naming a relation used to be
 * the opt-in itself (`includable: edge.includable ?? true`); it no longer
 * grants anything — it only tunes `defaultInclude`/`maxDepth`/`strategy`
 * for a relation `allowlists.includable` has already opened.
 */
describe("allowlists.includable — where inclusion permission now lives", () => {
  it("does not open a relation that relations.edges only tunes", async () => {
    const fixture = blog({
      author: { relations: { edges: { posts: { strategy: "join" } } } },
    });

    await expect(fixture.authors.findMany({ include: ["posts"] })).rejects.toBeInstanceOf(QueryValidationException);
  });

  it("opens a relation named in allowlists.includable alone, with no relations.edges entry", async () => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
    });

    await fixture.authors.findMany({ include: ["posts"] });

    expect(Object.keys(includeTree(fixture.authorAdapter))).toEqual(["posts"]);
  });

  it("still applies relations.edges tuning to a relation also opened by allowlists.includable", async () => {
    const fixture = blog({
      author: {
        allowlists: { includable: ["posts"] },
        relations: { edges: { posts: { strategy: "join" } } },
      },
    });

    await fixture.authors.findMany({ include: ["posts"] });

    expect(includeTree(fixture.authorAdapter)["posts"]!.strategy).toBe("join");
  });

  it("opts every own relation in via an explicit { exclude: [] }", async () => {
    const fixture = blog({
      post: { allowlists: { includable: { exclude: [] } } },
    });

    await fixture.posts.findMany({ include: ["author", "comments"] });

    expect(Object.keys(includeTree(fixture.postAdapter))).toEqual(["author", "comments"]);
  });

  it("excludes a named relation via { exclude }, leaving the rest includable", async () => {
    const fixture = blog({
      post: { allowlists: { includable: { exclude: ["comments"] } } },
    });

    await expect(fixture.posts.findMany({ include: ["comments"] })).rejects.toBeInstanceOf(QueryValidationException);
    await fixture.posts.findMany({ include: ["author"] });
    expect(Object.keys(includeTree(fixture.postAdapter))).toEqual(["author"]);
  });

  it("says 'none' rather than trailing a bare colon when the entity has no relations at all", () => {
    // `Comment` declares no relations, so the message has an empty list to
    // render — the one case where the join would produce nothing.
    expect(() => blog({ comment: { allowlists: { includable: ["ghosts" as never] } } })).toThrow(/relations: none/);
  });
});

describe("malformed include paths", () => {
  it.each([
    ["a trailing dot", "posts."],
    ["a leading dot", ".posts"],
    ["a doubled dot", "posts..comments"],
    ["an empty string", ""],
  ])("rejects %s as a query issue rather than building an empty-named node", async (_label, path) => {
    const fixture = blog({
      author: { allowlists: { includable: ["posts"] } },
      post: { allowlists: { includable: ["comments"] } },
    } as never);

    const issues = await fixture.authors
      .findMany({ include: [path] } as unknown as { include: readonly IncludePath<Author>[] })
      .then(
        () => {
          throw new Error("expected a QueryValidationException");
        },
        (error: unknown) => (error as QueryValidationException).issues,
      );

    expect(issues[0]).toMatchObject({ field: "include", code: "KAVO_QUERY_INVALID_VALUE" });
  });
});

describe("an includable relation whose target is unknown to this instance", () => {
  it("reports an unsupported-param issue on that path instead of throwing a TypeError", async () => {
    // `Comment` is never registered here, so the catalog cannot resolve
    // `posts.comments`'s target. A missing `createCrud` call is an ordinary
    // adopter mistake and must not surface as a crash.
    const metadata = new Map<unknown, EntityMetadata<object>>([
      [Author, authorMetadata as EntityMetadata<object>],
      [Post, postMetadata as EntityMetadata<object>],
    ]);
    const authorAdapter = new SeededAdapter<Author>([]);
    const postAdapter = new SeededAdapter<Post>([]);
    const adapters = new Map<unknown, unknown>([
      [Author, authorAdapter],
      [Post, postAdapter],
    ]);
    const kavo = createKavo({
      infrastructure: {
        metadataFor: (entity) => metadata.get(entity) as never,
        adapterFor: (entity) => adapters.get(entity) as never,
      },
    });
    const authors = kavo.createCrud(Author, {
      allowlists: { includable: ["posts"] },
    } as never) as DefaultKavoService<Author>;
    kavo.createCrud(Post, { allowlists: { includable: ["comments"] } } as never);

    const issues = await authors.findMany({ include: ["posts.comments"] } as never).then(
      () => {
        throw new Error("expected a QueryValidationException");
      },
      (error: unknown) => (error as QueryValidationException).issues,
    );

    expect(issues[0]).toMatchObject({ field: "posts.comments", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });
});

/** The include tree the adapter last received — what resolution produced. */
function includeTree<Entity extends object>(adapter: SeededAdapter<Entity>): Record<string, IncludeNode> {
  return (adapter.lastQuery?.include ?? {}) as Record<string, IncludeNode>;
}

/** The row the adapter last stored — what deserialization produced. */
function lastRow<Entity extends object>(adapter: SeededAdapter<Entity>): Record<string, unknown> {
  return adapter.rows[adapter.rows.length - 1] as Record<string, unknown>;
}
