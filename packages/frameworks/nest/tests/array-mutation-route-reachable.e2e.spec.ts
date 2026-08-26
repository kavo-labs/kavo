import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type {
  ClassRef,
  EntityId,
  EntityMetadata,
  KavoContext,
  KavoInfrastructure,
  NormalizedQueryContext,
  RepositoryAdapter,
} from "@kavo/core";
import { ConfigurationException, NotFoundException, hasKeyset } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";

/**
 * `@Kavo`'s decoration-time route generation (`kavo.decorator.ts`) has no
 * built-in default for `arrayMutation.strategy` (issue #221 amends
 * ADR-0029): an entity that never declares the key gets no synthesized
 * route for a write-opted relation, full stop — decoration time cannot see
 * a *global* default, so it generates nothing rather than assuming
 * something. That is safe on its own, but it opens a different gap:
 * `createCrud`'s registry, built from the fully resolved settings, still
 * registers the operation once a global default resolves `"replace"` or
 * `"resource"` — so the operation exists and is callable programmatically,
 * yet no HTTP route ever reaches it. `KavoModule`'s discovery binder is the
 * earliest point both facts are known at once and must reject that silent
 * gap at bootstrap rather than ship a configured write surface nothing can
 * reach.
 */

class Tag {
  id = 0;
  name = "";
}

class Post {
  id = 0;
  title = "";
  tags: Tag[] = [];
  labels: Tag[] = [];
}

const postMetadata: EntityMetadata<Post> = {
  entity: Post,
  name: "Post",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "title", kind: "string", nullable: false, generated: false },
  ],
  relations: [
    { name: "tags", target: () => Tag, cardinality: "many", includable: false, strategy: "auto" },
    { name: "labels", target: () => Tag, cardinality: "many", includable: false, strategy: "auto" },
  ],
};

const tagMetadata: EntityMetadata<Tag> = {
  entity: Tag,
  name: "Tag",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
  ],
  relations: [],
};

/** Bare-minimum adapter — implements every write `arrayMutation` needs so bootstrap gets past its own capability checks. */
class FakePostAdapter implements RepositoryAdapter<Post> {
  rows: Post[] = [{ id: 1, title: "Hello", tags: [], labels: [] }];

  async findOneById(id: EntityId): Promise<Post | null> {
    return this.rows.find((row) => row.id === Number(id)) ?? null;
  }
  async findOne(): Promise<Post | null> {
    return this.rows[0] ?? null;
  }
  async findMany(query: NormalizedQueryContext<Post>): Promise<readonly Post[]> {
    const offset = hasKeyset(query.pagination) ? 0 : query.pagination.offset;
    return this.rows.slice(offset, offset + query.pagination.limit);
  }
  async count(): Promise<number> {
    return this.rows.length;
  }
  async create(data: Partial<Post>): Promise<Post> {
    const row = { id: this.rows.length + 1, title: "", tags: [], labels: [], ...data } as Post;
    this.rows.push(row);
    return row;
  }
  async update(id: EntityId, data: Partial<Post>, context: KavoContext<Post>): Promise<Post> {
    const row = await this.findOneById(id);
    if (row === null) {
      throw new NotFoundException({ messageParams: { entity: context.entityName, id: String(id) } });
    }
    Object.assign(row, data);
    return row;
  }
  async patch(id: EntityId, data: Partial<Post>, context: KavoContext<Post>): Promise<Post> {
    return this.update(id, data, context);
  }
  async delete(): Promise<void> {}
  async restore(): Promise<Post> {
    throw new Error("not soft-deletable in this fixture");
  }
  async purge(): Promise<void> {}
  async replaceRelation(id: EntityId, relation: string, memberIds: readonly EntityId[] | null): Promise<Post> {
    const row = await this.findOneById(id);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
  ): Promise<Post> {
    const row = await this.findOneById(id);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = changes.add;
    return row;
  }
}

function fakeInfrastructure(adapter: FakePostAdapter): KavoInfrastructure {
  return {
    metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
      if ((entity as ClassRef) === Tag) {
        return tagMetadata as unknown as EntityMetadata<Entity>;
      }
      if ((entity as ClassRef) !== Post) {
        throw new Error(`no metadata for ${entity.name}`);
      }
      return postMetadata as unknown as EntityMetadata<Entity>;
    },
    adapterFor<Entity extends object>() {
      return adapter as unknown as RepositoryAdapter<Entity>;
    },
  };
}

describe("KavoModule — arrayMutation route reachability (issue #221 amends ADR-0029)", () => {
  // This one never reaches `requireArrayMutationRouteReachable` at all:
  // `createCrud` (called just before it in `KavoBinder.onModuleInit`) throws
  // first via core's own `validateArrayMutationRelations`, the same path
  // `packages/core/tests/array-mutation.spec.ts` exercises directly. Pinned
  // here as an integration check that the core-level guard still surfaces
  // correctly through KavoModule's bootstrap sequence — `messageParams.path`
  // is asserted specifically so this fails loudly (rather than passing for
  // an unrelated reason) if that call order ever changes.
  it("rejects at bootstrap (via createCrud, before the route-reachability check runs) when no strategy is resolvable anywhere", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({ infrastructure: fakeInfrastructure(new FakePostAdapter()) }),
        }),
      ],
      controllers: [PostController],
    });
    const app = await moduleRef.compile();
    await expect(app.init()).rejects.toBeInstanceOf(ConfigurationException);
    const error = (await app.init().catch((thrown: unknown) => thrown)) as ConfigurationException;
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.context.entityName).toBe("Post");
    expect(error.messageParams).toMatchObject({ path: "relations.edges.tags.write" });
    expect(error.detail).toContain("arrayMutation.strategy");
  });

  it("rejects at bootstrap when a global 'replace'/'resource' default resolves an operation no route was generated for", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({
            infrastructure: fakeInfrastructure(new FakePostAdapter()),
            defaults: { arrayMutation: { strategy: "replace" } } as never,
          }),
        }),
      ],
      controllers: [PostController],
    });
    const app = await moduleRef.compile();
    await expect(app.init()).rejects.toBeInstanceOf(ConfigurationException);
    const error = (await app.init().catch((thrown: unknown) => thrown)) as ConfigurationException;
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.context.entityName).toBe("Post");
    expect(error.messageParams).toMatchObject({ path: "arrayMutation" });
    expect(error.detail).toContain("arrayMutation.strategy");
    expect(error.detail).toContain("replace");
  });

  it("names every write-opted relation left routeless, not just the first, when several opt in", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true }, labels: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({
            infrastructure: fakeInfrastructure(new FakePostAdapter()),
            defaults: { arrayMutation: { strategy: "replace" } } as never,
          }),
        }),
      ],
      controllers: [PostController],
    });
    const app = await moduleRef.compile();
    const error = (await app.init().catch((thrown: unknown) => thrown)) as ConfigurationException;
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error.detail).toContain("tags");
    expect(error.detail).toContain("labels");
  });

  it("boots cleanly when a global 'jsonPatch' default resolves the strategy — jsonPatch needs no synthesized route", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({
            infrastructure: fakeInfrastructure(new FakePostAdapter()),
            defaults: { arrayMutation: { strategy: "jsonPatch" } } as never,
          }),
        }),
      ],
      controllers: [PostController],
    }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it("names only the relation relying on an undeclared global default, not a sibling with its own pinned strategy (issue #223)", async () => {
    @Kavo(Post, {
      relations: { edges: { tags: { write: true }, labels: { write: { strategy: "replace" } } } },
    } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({
            infrastructure: fakeInfrastructure(new FakePostAdapter()),
            defaults: { arrayMutation: { strategy: "replace" } } as never,
          }),
        }),
      ],
      controllers: [PostController],
    });
    const app = await moduleRef.compile();
    const error = (await app.init().catch((thrown: unknown) => thrown)) as ConfigurationException;
    expect(error).toBeInstanceOf(ConfigurationException);
    // `labels` pinned its own strategy locally (`write: { strategy: "replace" }`),
    // so decoration time already generated its route — only `tags`, which
    // relies on the undeclared global default, is unreachable.
    expect(error.detail).toContain("tags");
    expect(error.detail).not.toContain("labels");
  });

  it("boots cleanly when every write-opted relation pins its own strategy locally, even with no entity-level arrayMutation declared", async () => {
    @Kavo(Post, {
      relations: { edges: { tags: { write: { strategy: "replace" } }, labels: { write: { strategy: "replace" } } } },
    } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({ infrastructure: fakeInfrastructure(new FakePostAdapter()) }),
        }),
      ],
      controllers: [PostController],
    }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it("boots cleanly when the entity declares arrayMutation.strategy: 'replace' itself, matching the resolved strategy", async () => {
    @Kavo(Post, { arrayMutation: { strategy: "replace" }, relations: { edges: { tags: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({ infrastructure: fakeInfrastructure(new FakePostAdapter()) }),
        }),
      ],
      controllers: [PostController],
    }).compile();
    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });
});
