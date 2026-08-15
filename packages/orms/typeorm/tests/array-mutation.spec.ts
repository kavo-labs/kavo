import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import { ArrayMutationMemberNotFoundException, NotFoundException, type RepositoryAdapter } from "@kavo/core";
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

  // Soft-deletable, so a member-id existence check can be pinned against a
  // row that still exists physically but is excluded by TypeORM's own
  // default `find()` scope (which `replaceRelation`'s existence check uses).
  @DeleteDateColumn()
  deletedAt!: Date | null;
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

/**
 * A soft-deletable parent through a *plain* marker column, not
 * `@DeleteDateColumn` — the case `readRelation`/`addRelationMember`/
 * `removeRelationMember` must scope explicitly, since TypeORM's own
 * repository API only excludes soft-deleted rows automatically for the
 * declared `@DeleteDateColumn` (`replaceRelation`'s `byId` already handles
 * both cases; this fixture pins the plain-column one for the three
 * `resource`-strategy primitives).
 */
@Entity()
class Studio {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @Column({ type: Date, nullable: true })
  archivedAt!: Date | null;

  @OneToMany(() => Album, (album) => album.studio)
  albums!: Album[];
}

@Entity()
class Album {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToOne(() => Studio, (studio) => studio.albums)
  studio!: Studio;
}

let dataSource: DataSource;
let adapter: RepositoryAdapter<Writer>;
let articleAdapter: RepositoryAdapter<Article>;
let studioAdapter: RepositoryAdapter<Studio>;

function context(operation = "replaceNovels") {
  return { entityName: "Writer", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

/** A plain-marker-column soft-deletable context, unlike `context()` above. */
function studioContext(operation: string) {
  return {
    entityName: "Studio",
    operation,
    config: { softDelete: { strategy: "soft", field: "archivedAt" } },
  } as never;
}

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Writer, Novel, Article, Topic, Studio, Album],
    synchronize: true,
  });
  await dataSource.initialize();
  adapter = createInfrastructure(dataSource).adapterFor(Writer);
  articleAdapter = createInfrastructure(dataSource).adapterFor(Article);
  studioAdapter = createInfrastructure(dataSource).adapterFor(Studio);
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Novel).clear();
  await dataSource.getRepository(Writer).clear();
  await dataSource.getRepository(Article).clear();
  await dataSource.getRepository(Topic).clear();
  await dataSource.getRepository(Album).clear();
  await dataSource.getRepository(Studio).clear();
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

  it("raises NotFoundException for a soft-deleted member id, same as a nonexistent one", async () => {
    // The existence check reuses the target repository's default `find()`,
    // which excludes soft-deleted rows the same way every other read in
    // this adapter does — a soft-deleted novel is not associable through
    // `replaceRelation` even though the row still physically exists.
    const { writerId } = await seed();
    const [novel] = await dataSource.getRepository(Novel).save([{ title: "Ghost" }]);
    await dataSource.getRepository(Novel).softDelete(novel!.id);

    await expect(adapter.replaceRelation!(writerId, "novels", [novel!.id], context())).rejects.toThrowError(
      NotFoundException,
    );
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

describe("TypeOrmRepositoryAdapter#readRelation (arrayMutation's resource strategy, ADR-0029's resource amendment)", () => {
  it("returns the parent row with the relation loaded", async () => {
    const { writerId, novelIds } = await seed();
    const read = await adapter.readRelation!(writerId, "novels", context("listNovels"));
    expect(read.id).toBe(writerId);
    expect(read.novels.map((novel) => novel.id).sort()).toEqual([...novelIds].sort());
  });

  it("raises NotFoundException for a parent id that does not exist", async () => {
    await expect(adapter.readRelation!(999999, "novels", context("listNovels"))).rejects.toThrowError(
      NotFoundException,
    );
  });

  it("raises NotFoundException for a soft-deleted parent through a plain marker column", async () => {
    // Unlike `@DeleteDateColumn`, a plain marker column gets no automatic
    // exclusion from TypeORM's repository API — `readRelation` must apply
    // `scopeToLive` itself, the same as `replaceRelation`'s `byId` already
    // does, or a soft-deleted parent stays reachable here.
    const studio = await dataSource.getRepository(Studio).save({ name: "Ghost Studio", archivedAt: new Date() });
    await expect(studioAdapter.readRelation!(studio.id, "albums", studioContext("listAlbums"))).rejects.toThrowError(
      NotFoundException,
    );
  });
});

describe("TypeOrmRepositoryAdapter#addRelationMember (arrayMutation's resource strategy, ADR-0029's resource amendment)", () => {
  it("adds a member that was not previously related", async () => {
    const { writerId } = await seed();
    const [novel] = await dataSource.getRepository(Novel).save([{ title: "Solo" }]);
    const updated = await adapter.addRelationMember!(writerId, "novels", novel!.id, context("addNovels"));
    expect(updated.novels.map((n) => n.id)).toContain(novel!.id);
  });

  it("is a no-op when the id is already a member", async () => {
    const { writerId, novelIds } = await seed();
    const updated = await adapter.addRelationMember!(writerId, "novels", novelIds[0]!, context("addNovels"));
    expect(updated.novels.map((n) => n.id).sort()).toEqual([...novelIds].sort());
  });

  it("raises NotFoundException for a member id that does not exist", async () => {
    const { writerId } = await seed();
    await expect(adapter.addRelationMember!(writerId, "novels", 999999, context("addNovels"))).rejects.toThrowError(
      NotFoundException,
    );
  });

  it("raises NotFoundException for a parent id that does not exist", async () => {
    const [novel] = await dataSource.getRepository(Novel).save([{ title: "Solo" }]);
    await expect(adapter.addRelationMember!(999999, "novels", novel!.id, context("addNovels"))).rejects.toThrowError(
      NotFoundException,
    );
  });

  it("adds and removes members through the junction table (ManyToMany)", async () => {
    const { articleId, topicIds } = await seedArticle();
    const updated = await articleAdapter.addRelationMember!(
      articleId,
      "topics",
      topicIds[0]!,
      articleContext("addTopics"),
    );
    expect(updated.topics.map((t) => t.id)).toEqual([topicIds[0]]);
  });

  it("raises NotFoundException for a nonexistent member id through the junction table (ManyToMany)", async () => {
    const { articleId } = await seedArticle();
    await expect(
      articleAdapter.addRelationMember!(articleId, "topics", 999999, articleContext("addTopics")),
    ).rejects.toThrowError(NotFoundException);
  });

  it("raises NotFoundException for a soft-deleted parent through a plain marker column", async () => {
    const studio = await dataSource.getRepository(Studio).save({ name: "Ghost Studio", archivedAt: new Date() });
    const [album] = await dataSource.getRepository(Album).save([{ title: "Solo" }]);
    await expect(
      studioAdapter.addRelationMember!(studio.id, "albums", album!.id, studioContext("addAlbums")),
    ).rejects.toThrowError(NotFoundException);
  });
});

describe("TypeOrmRepositoryAdapter#removeRelationMember (arrayMutation's resource strategy, ADR-0029's resource amendment)", () => {
  it("removes a currently-related member, keeping the rest", async () => {
    const { writerId, novelIds } = await seed();
    const updated = await adapter.removeRelationMember!(writerId, "novels", novelIds[0]!, context("removeNovels"));
    expect(updated.novels.map((n) => n.id).sort()).toEqual([novelIds[1], novelIds[2]].sort());
  });

  it("raises ArrayMutationMemberNotFoundException for an id that is not currently a member", async () => {
    const { writerId } = await seed();
    await expect(
      adapter.removeRelationMember!(writerId, "novels", 999999, context("removeNovels")),
    ).rejects.toThrowError(ArrayMutationMemberNotFoundException);
  });

  it("removes a member through the junction table (ManyToMany)", async () => {
    const { articleId, topicIds } = await seedArticle();
    await articleAdapter.replaceRelation!(articleId, "topics", topicIds, articleContext());
    const updated = await articleAdapter.removeRelationMember!(
      articleId,
      "topics",
      topicIds[0]!,
      articleContext("removeTopics"),
    );
    expect(updated.topics.map((t) => t.id)).toEqual([topicIds[1]]);
  });

  it("raises ArrayMutationMemberNotFoundException for a nonexistent membership through the junction table (ManyToMany)", async () => {
    const { articleId } = await seedArticle();
    await expect(
      articleAdapter.removeRelationMember!(articleId, "topics", 999999, articleContext("removeTopics")),
    ).rejects.toThrowError(ArrayMutationMemberNotFoundException);
  });

  it("raises NotFoundException for a soft-deleted parent through a plain marker column", async () => {
    const studio = await dataSource.getRepository(Studio).save({ name: "Ghost Studio" });
    const [album] = await dataSource.getRepository(Album).save([{ title: "Solo", studio }]);
    await dataSource.getRepository(Studio).update(studio.id, { archivedAt: new Date() });
    await expect(
      studioAdapter.removeRelationMember!(studio.id, "albums", album!.id, studioContext("removeAlbums")),
    ).rejects.toThrowError(NotFoundException);
  });
});
