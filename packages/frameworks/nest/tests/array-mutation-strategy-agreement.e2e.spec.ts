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
 * `@Kavo`'s decoration-time route generation (`kavo.decorator.ts`) assumes
 * `arrayMutation.strategy: "replace"` for an entity that never declares the
 * key itself — the same default `BUILT_IN_DEFAULTS` uses. That assumption
 * is wrong when a *global* default resolves the strategy to `"jsonPatch"`
 * instead: decoration time still generates a `replace<Relation>` route, but
 * `createCrud`'s registry (built from the fully resolved settings) never
 * registers a matching operation, so the route would 405 every request.
 * `KavoModule`'s discovery binder is the earliest point both facts are known
 * and must reject the disagreement at bootstrap (ADR-0029's jsonPatch
 * amendment) rather than let the broken route reach traffic.
 */

class Tag {
  id = 0;
  name = "";
}

class Post {
  id = 0;
  title = "";
  tags: Tag[] = [];
}

const postMetadata: EntityMetadata<Post> = {
  entity: Post,
  name: "Post",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "title", kind: "string", nullable: false, generated: false },
  ],
  relations: [{ name: "tags", target: () => Tag, cardinality: "many", includable: false, strategy: "auto" }],
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
  rows: Post[] = [{ id: 1, title: "Hello", tags: [] }];

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
    const row = { id: this.rows.length + 1, title: "", tags: [], ...data } as Post;
    this.rows.push(row);
    return row;
  }
  async update(id: EntityId, data: Partial<Post>, context: KavoContext<Post>): Promise<Post> {
    const row = await this.findOneById(id);
    if (row === null) throw new NotFoundException({ messageParams: { entity: context.entityName, id: String(id) } });
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
    if (row === null) throw new Error("fixture: row not found");
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
  ): Promise<Post> {
    const row = await this.findOneById(id);
    if (row === null) throw new Error("fixture: row not found");
    (row as unknown as Record<string, unknown>)[relation] = changes.add;
    return row;
  }
}

function fakeInfrastructure(adapter: FakePostAdapter): KavoInfrastructure {
  return {
    metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
      if ((entity as ClassRef) === Tag) return tagMetadata as unknown as EntityMetadata<Entity>;
      if ((entity as ClassRef) !== Post) throw new Error(`no metadata for ${entity.name}`);
      return postMetadata as unknown as EntityMetadata<Entity>;
    },
    adapterFor<Entity extends object>() {
      return adapter as unknown as RepositoryAdapter<Entity>;
    },
  };
}

describe("KavoModule — arrayMutation strategy agreement (ADR-0029's jsonPatch amendment)", () => {
  it("rejects at bootstrap when a global 'jsonPatch' default disagrees with the replace<Relation> route decoration time generated", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
    @Controller("posts")
    class PostController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({
            infrastructure: fakeInfrastructure(new FakePostAdapter()),
            defaults: { arrayMutation: { strategy: "jsonPatch" } } as never,
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
    expect(error.detail).toContain("replace<Relation>");
    expect(error.detail).toContain("jsonPatch");
  });

  it("boots cleanly when the entity declares arrayMutation.strategy: 'jsonPatch' itself, matching the global default", async () => {
    @Kavo(Post, { arrayMutation: { strategy: "jsonPatch" }, relations: { edges: { tags: { write: true } } } } as never)
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

  it("boots cleanly for the ordinary case: no global override, entity relies on the default 'replace'", async () => {
    @Kavo(Post, { relations: { edges: { tags: { write: true } } } } as never)
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
