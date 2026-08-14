import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, Entity, JoinTable, ManyToMany, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { JsonPatchTargetNotFoundException, NotFoundException, type RepositoryAdapter } from "@kavo/core";
import { createInfrastructure } from "@kavo/typeorm";

@Entity()
class Writer {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @OneToMany(() => Novel, (novel) => novel.writer)
  novels!: Novel[];
}

@Entity()
class Novel {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToOne(() => Writer, (writer) => writer.novels)
  writer!: Writer;
}

/** A `ManyToMany` fixture — a junction-table write. */
@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToMany(() => Topic)
  @JoinTable()
  topics!: Topic[];
}

@Entity()
class Topic {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

let dataSource: DataSource;
let adapter: RepositoryAdapter<Writer>;
let articleAdapter: RepositoryAdapter<Article>;

function context(operation = "patchOne") {
  return { entityName: "Writer", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

function articleContext(operation = "patchOne") {
  return { entityName: "Article", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Writer, Novel, Article, Topic],
    synchronize: true,
  });
  await dataSource.initialize();
  adapter = createInfrastructure(dataSource).adapterFor(Writer);
  articleAdapter = createInfrastructure(dataSource).adapterFor(Article);
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Novel).clear();
  await dataSource.getRepository(Writer).clear();
  await dataSource.getRepository(Article).clear();
  await dataSource.getRepository(Topic).clear();
});

async function seed(): Promise<{ writerId: number; novelIds: number[] }> {
  const writer = await dataSource.getRepository(Writer).save({ name: "Ursula" });
  const novels = await dataSource.getRepository(Novel).save([
    { title: "A", writer },
    { title: "B", writer },
  ]);
  return { writerId: writer.id, novelIds: novels.map((novel) => novel.id) };
}

async function seedArticle(): Promise<{ articleId: number; topicIds: number[] }> {
  const article = await dataSource.getRepository(Article).save({ title: "Piece" });
  const topics = await dataSource.getRepository(Topic).save([{ name: "A" }, { name: "B" }]);
  return { articleId: article.id, topicIds: topics.map((topic) => topic.id) };
}

describe("TypeOrmRepositoryAdapter#patchRelation (arrayMutation's jsonPatch strategy, ADR-0029)", () => {
  it("adds a member not previously related", async () => {
    const writer = await dataSource.getRepository(Writer).save({ name: "Le Guin" });
    const [novel] = await dataSource.getRepository(Novel).save([{ title: "Solo" }]);
    await adapter.patchRelation!(writer.id, "novels", { add: [novel!.id], remove: [] }, context());

    const reloaded = await dataSource
      .getRepository(Novel)
      .findOne({ where: { id: novel!.id }, relations: { writer: true } });
    expect(reloaded?.writer?.id).toBe(writer.id);
  });

  it("removes a currently-linked member, keeping the rest", async () => {
    const { writerId, novelIds } = await seed();
    await adapter.patchRelation!(writerId, "novels", { add: [], remove: [novelIds[0]!] }, context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id)).toEqual([novelIds[1]]);
  });

  it("applies add and remove for the same relation in one call", async () => {
    const { writerId, novelIds } = await seed();
    const [extra] = await dataSource.getRepository(Novel).save([{ title: "C" }]);
    await adapter.patchRelation!(writerId, "novels", { add: [extra!.id], remove: [novelIds[0]!] }, context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([novelIds[1]!, extra!.id].sort());
  });

  it("is idempotent when adding a member that is already linked", async () => {
    const { writerId, novelIds } = await seed();
    await adapter.patchRelation!(writerId, "novels", { add: [novelIds[0]!], remove: [] }, context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });

  it("returns the parent row with the relation loaded", async () => {
    const { writerId, novelIds } = await seed();
    const updated = await adapter.patchRelation!(writerId, "novels", { add: [], remove: [] }, context());

    expect(updated.id).toBe(writerId);
    expect(updated.novels.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });

  it("raises NotFoundException for a parent id that does not exist", async () => {
    await expect(adapter.patchRelation!(999999, "novels", { add: [], remove: [] }, context())).rejects.toThrowError(
      NotFoundException,
    );
  });

  it("raises NotFoundException for an add target with no matching row, rather than a silent no-op", async () => {
    const { writerId } = await seed();
    await expect(
      adapter.patchRelation!(writerId, "novels", { add: [999999], remove: [] }, context()),
    ).rejects.toThrowError(NotFoundException);
  });

  it("raises JsonPatchTargetNotFoundException for a remove target that isn't currently a member", async () => {
    const { writerId, novelIds } = await seed();
    const call = adapter.patchRelation!(writerId, "novels", { add: [], remove: [999999] }, context());
    await expect(call).rejects.toThrowError(JsonPatchTargetNotFoundException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_JSON_PATCH_TARGET_NOT_FOUND", status: 404 });

    // The rejected write must not have partially applied.
    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });

  it("does not remove any member when the remove list mixes a valid and an invalid target", async () => {
    // Atomicity: one bad target in the batch must not let the others through.
    const { writerId, novelIds } = await seed();
    await expect(
      adapter.patchRelation!(writerId, "novels", { add: [], remove: [novelIds[0]!, 999999] }, context()),
    ).rejects.toThrowError(JsonPatchTargetNotFoundException);

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });
});

describe("TypeOrmRepositoryAdapter#patchRelation — ManyToMany (junction-table writes)", () => {
  it("adds and removes members through the junction table in one call", async () => {
    const { articleId, topicIds } = await seedArticle();
    await articleAdapter.patchRelation!(articleId, "topics", { add: [topicIds[0]!], remove: [] }, articleContext());
    await articleAdapter.patchRelation!(
      articleId,
      "topics",
      { add: [topicIds[1]!], remove: [topicIds[0]!] },
      articleContext(),
    );

    const remaining = await dataSource
      .getRepository(Article)
      .findOne({ where: { id: articleId }, relations: { topics: true } });
    expect(remaining?.topics.map((topic) => topic.id)).toEqual([topicIds[1]]);
  });

  it("raises JsonPatchTargetNotFoundException removing a topic never linked", async () => {
    const { articleId, topicIds } = await seedArticle();
    await expect(
      articleAdapter.patchRelation!(articleId, "topics", { add: [], remove: [topicIds[0]!] }, articleContext()),
    ).rejects.toThrowError(JsonPatchTargetNotFoundException);
  });
});
