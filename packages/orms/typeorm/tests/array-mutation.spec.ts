import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, Entity, JoinTable, ManyToMany, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { NotFoundException, type RepositoryAdapter } from "@kavo/core";
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

/** A `ManyToMany` fixture — a junction-table write, architecturally distinct
 * from `Writer.novels`'s foreign-key-column write above. */
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

function context(operation = "replaceNovels") {
  return { entityName: "Writer", operation, config: { softDelete: { strategy: "hard" } } } as never;
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
    { title: "C", writer },
  ]);
  return { writerId: writer.id, novelIds: novels.map((novel) => novel.id) };
}

describe("TypeOrmRepositoryAdapter#replaceRelation (arrayMutation's replace strategy, ADR-0014)", () => {
  it("adds members that were not previously related", async () => {
    const writer = await dataSource.getRepository(Writer).save({ name: "Le Guin" });
    const [novel] = await dataSource.getRepository(Novel).save([{ title: "Solo" }]);
    await adapter.replaceRelation!(writer.id, "novels", [novel!.id], context());

    const reloaded = await dataSource
      .getRepository(Novel)
      .findOne({ where: { id: novel!.id }, relations: { writer: true } });
    expect(reloaded?.writer?.id).toBe(writer.id);
  });

  it("removes members no longer named, keeping the ones still named", async () => {
    const { writerId, novelIds } = await seed();
    await adapter.replaceRelation!(writerId, "novels", [novelIds[0]!], context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id)).toEqual([novelIds[0]]);
  });

  it("removes every member when memberIds is null", async () => {
    const { writerId } = await seed();
    await adapter.replaceRelation!(writerId, "novels", null, context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining).toEqual([]);
  });

  it("removes every member when memberIds is an empty array", async () => {
    const { writerId } = await seed();
    await adapter.replaceRelation!(writerId, "novels", [], context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining).toEqual([]);
  });

  it("is a no-op when the desired membership already matches", async () => {
    const { writerId, novelIds } = await seed();
    await adapter.replaceRelation!(writerId, "novels", novelIds, context());

    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });

  it("returns the parent row with the relation loaded", async () => {
    const { writerId, novelIds } = await seed();
    const updated = await adapter.replaceRelation!(writerId, "novels", [novelIds[0]!, novelIds[1]!], context());

    expect(updated.id).toBe(writerId);
    expect(updated.novels.map((novel) => novel.id).sort()).toEqual([novelIds[0], novelIds[1]].sort());
  });

  it("raises NotFoundException for a parent id that does not exist", async () => {
    await expect(adapter.replaceRelation!(999999, "novels", [], context())).rejects.toThrowError(NotFoundException);
  });

  it("raises NotFoundException for a member id that does not exist, rather than a silent no-op", async () => {
    const { writerId, novelIds } = await seed();
    await expect(adapter.replaceRelation!(writerId, "novels", [novelIds[0]!, 999999], context())).rejects.toThrowError(
      NotFoundException,
    );

    // The rejected write must not have partially applied.
    const remaining = await dataSource.getRepository(Novel).find({ where: { writer: { id: writerId } } });
    expect(remaining.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });
});

function articleContext(operation = "replaceTopics") {
  return { entityName: "Article", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

async function seedArticle(): Promise<{ articleId: number; topicIds: number[] }> {
  const article = await dataSource.getRepository(Article).save({ title: "Piece" });
  const topics = await dataSource.getRepository(Topic).save([{ name: "A" }, { name: "B" }]);
  return { articleId: article.id, topicIds: topics.map((topic) => topic.id) };
}

describe("TypeOrmRepositoryAdapter#replaceRelation — ManyToMany (junction-table writes)", () => {
  it("adds and removes members through the junction table", async () => {
    const { articleId, topicIds } = await seedArticle();
    await articleAdapter.replaceRelation!(articleId, "topics", [topicIds[0]!], articleContext());

    const remaining = await dataSource
      .getRepository(Article)
      .findOne({ where: { id: articleId }, relations: { topics: true } });
    expect(remaining?.topics.map((topic) => topic.id)).toEqual([topicIds[0]]);
  });

  it("clears every member when memberIds is null", async () => {
    const { articleId } = await seedArticle();
    await articleAdapter.replaceRelation!(articleId, "topics", null, articleContext());

    const remaining = await dataSource
      .getRepository(Article)
      .findOne({ where: { id: articleId }, relations: { topics: true } });
    expect(remaining?.topics).toEqual([]);
  });

  it("raises NotFoundException for a nonexistent member id, rather than a silent no-op", async () => {
    const { articleId, topicIds } = await seedArticle();
    await expect(
      articleAdapter.replaceRelation!(articleId, "topics", [topicIds[0]!, 999999], articleContext()),
    ).rejects.toThrowError(NotFoundException);

    const remaining = await dataSource
      .getRepository(Article)
      .findOne({ where: { id: articleId }, relations: { topics: true } });
    expect(remaining?.topics).toEqual([]);
  });
});
