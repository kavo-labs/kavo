import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
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

let dataSource: DataSource;
let adapter: RepositoryAdapter<Writer>;

function context(operation = "replaceNovels") {
  return { entityName: "Writer", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Writer, Novel],
    synchronize: true,
  });
  await dataSource.initialize();
  adapter = createInfrastructure(dataSource).adapterFor(Writer);
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Novel).clear();
  await dataSource.getRepository(Writer).clear();
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
});
