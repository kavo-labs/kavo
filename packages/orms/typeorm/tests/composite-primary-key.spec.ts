import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import {
  Column,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from "typeorm";
import type { ListMetaDto, RepositoryAdapter } from "@kavo/core";
import { ConfigurationException, NotFoundException, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import { createInfrastructure, createTypeOrmKavo } from "@kavo/typeorm";

/**
 * The motivating shape for issue #261: a join-table-style entity with a
 * natural composite key and no surrogate `id`, mirroring the `UserSentence`
 * example the issue was filed against — a `@ManyToOne` to a single-key
 * owner, plus two `@PrimaryColumn`s of its own.
 */
@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

@Entity()
class Grant {
  @PrimaryColumn("varchar")
  userId!: string;

  @PrimaryColumn("varchar")
  topic!: string;

  @Column("varchar")
  note!: string;

  @ManyToOne(() => Owner)
  @JoinColumn({ name: "owner_id" })
  owner!: Owner;

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];

  // A OneToMany fixture — the FK lives on `Label`, not in a junction table,
  // so `.add()`'s `relation.joinColumns` check (issue #263's ManyToMany
  // limitation) reads from a different metadata path.
  @OneToMany(() => Label, (label) => label.grant)
  labels!: Label[];
}

/** A `ManyToMany` target, so `Grant`'s own array-mutation writes (issue #263) go through a junction table. */
@Entity()
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

@Entity()
class Label {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  text!: string;

  @ManyToOne(() => Grant, (grant) => grant.labels)
  grant!: Grant;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let grants: DefaultKavoService<Grant>;
let owners: DefaultKavoService<Owner>;
let grantAdapter: RepositoryAdapter<Grant>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Owner, Grant, Tag, Label],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  owners = kavo.createCrud(Owner) as DefaultKavoService<Owner>;
  grants = kavo.createCrud(Grant) as DefaultKavoService<Grant>;
  grantAdapter = createInfrastructure(dataSource).adapterFor(Grant);
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Label).clear();
  await dataSource.getRepository(Grant).clear();
  await dataSource.getRepository(Owner).clear();
  await dataSource.getRepository(Tag).clear();
});

describe("composite primary keys — @kavo/typeorm (issue #261)", () => {
  it("creates, reads, updates, patches, and deletes by the composite route id", async () => {
    const owner = await owners.createOne({ name: "Ada" } as never);

    const created = await grants.createOne({
      userId: "u1",
      topic: "billing",
      note: "initial",
      owner: { id: (owner as { id: number }).id },
    } as never);
    expect(created).toMatchObject({ userId: "u1", topic: "billing", note: "initial" });
    // No synthetic `id` field — the real key columns speak for themselves.
    expect(created).not.toHaveProperty("id");

    const routeId = "u1~billing";
    const fetched = await grants.findOne(routeId);
    expect(fetched).toMatchObject({ userId: "u1", topic: "billing", note: "initial" });

    const updated = await grants.updateOne(routeId, {
      userId: "u1",
      topic: "billing",
      note: "replaced",
    } as never);
    expect(updated).toMatchObject({ note: "replaced" });

    const patched = await grants.patchOne(routeId, { note: "patched" } as never);
    expect(patched).toMatchObject({ note: "patched", userId: "u1", topic: "billing" });

    await grants.deleteOne(routeId);
    await expect(grants.findOne(routeId)).rejects.toThrow(NotFoundException);
  });

  it("ignores an attempt to change the key columns through patch — they are creatable but not updatable", async () => {
    await grants.createOne({ userId: "u2", topic: "shipping", note: "n" } as never);
    const patched = await grants.patchOne("u2~shipping", { userId: "u2", topic: "renamed", note: "n2" } as never);
    // The default writable projection excludes composite key fields from
    // `updatable`, so `topic` in the body is silently dropped, not applied.
    expect(patched).toMatchObject({ userId: "u2", topic: "shipping", note: "n2" });
  });

  it("round-trips a key value containing the wire separator", async () => {
    await grants.createOne({ userId: "u~3", topic: "a~b", note: "n" } as never);
    const routeId = "u~~3~a~~b";
    const fetched = await grants.findOne(routeId);
    expect(fetched).toMatchObject({ userId: "u~3", topic: "a~b" });
  });

  it("finds many and filters/sorts normally (offset pagination is unaffected)", async () => {
    await grants.createOne({ userId: "u1", topic: "a", note: "1" } as never);
    await grants.createOne({ userId: "u1", topic: "b", note: "2" } as never);
    await grants.createOne({ userId: "u2", topic: "a", note: "3" } as never);
    const page = await grants.findMany({
      filter: { kind: "condition", field: "userId", operator: "EQ", value: "u1" },
    });
    expect(page.items).toHaveLength(2);
  });

  it("400s on a malformed route id rather than a driver error", async () => {
    await expect(grants.findOne("not-enough-parts")).rejects.toThrow();
  });

  it("pages stably across a boundary with cursor pagination, using the full composite tiebreaker (issue #263)", async () => {
    const cursorGrants = kavo.createCrud(Grant, {
      pagination: { strategy: "cursor" },
      query: {
        defaultSort: [
          { field: "note", direction: "asc" },
          { field: "userId", direction: "asc" },
          { field: "topic", direction: "asc" },
        ],
      },
    } as never) as DefaultKavoService<Grant>;

    // Three rows share the same `note` — without the full compositeIdFields
    // tiebreaker (not just one of the two key columns), the keyset
    // predicate could not tell them apart and a page boundary landing
    // mid-tie would skip or repeat a row.
    await grants.createOne({ userId: "a", topic: "1", note: "tie" } as never);
    await grants.createOne({ userId: "b", topic: "2", note: "tie" } as never);
    await grants.createOne({ userId: "c", topic: "3", note: "tie" } as never);

    const page1 = await cursorGrants.findMany({ limit: 2 } as never);
    expect(page1.items).toHaveLength(2);
    const nextCursor = (page1.meta as ListMetaDto | undefined)?.["nextCursor"] as string | null;
    expect(nextCursor).toBeTruthy();

    const page2 = await cursorGrants.findMany({ limit: 2, cursor: nextCursor } as never);
    expect(page2.items).toHaveLength(1);
    expect((page2.meta as ListMetaDto | undefined)?.["nextCursor"]).toBeNull();

    const seen = [...page1.items, ...page2.items].map((row) => `${row.userId}~${row.topic}`);
    expect(new Set(seen).size).toBe(3);
  });

  it("pages stably with since pagination, using the full composite tiebreaker (issue #263)", async () => {
    const sinceGrants = kavo.createCrud(Grant, {
      pagination: { strategy: "since", since: { field: "note" } },
    } as never) as DefaultKavoService<Grant>;

    await grants.createOne({ userId: "a", topic: "1", note: "tie" } as never);
    await grants.createOne({ userId: "b", topic: "2", note: "tie" } as never);
    await grants.createOne({ userId: "c", topic: "3", note: "tie" } as never);

    const page1 = await sinceGrants.findMany({ limit: 2 } as never);
    expect(page1.items).toHaveLength(2);
    const nextSince = (page1.meta as ListMetaDto | undefined)?.["nextSince"] as string;
    expect(nextSince).toBeTruthy();

    const page2 = await sinceGrants.findMany({ limit: 2, since: nextSince } as never);
    expect(page2.items).toHaveLength(1);

    const seen = [...page1.items, ...page2.items].map((row) => `${row.userId}~${row.topic}`);
    expect(new Set(seen).size).toBe(3);
  });
});

function grantContext(operation = "replaceTags") {
  return { entityName: "Grant", operation, config: { softDelete: { strategy: "hard" } } } as never;
}

describe("TypeOrmRepositoryAdapter — array-mutation reads on a composite-key parent (issue #263)", () => {
  it("readRelation decodes the composite parent id (a pure read, no TypeORM RelationQueryBuilder involved)", async () => {
    await grants.createOne({ userId: "u2", topic: "shipping", note: "n" } as never);
    const read = await grantAdapter.readRelation!("u2~shipping", "tags", grantContext("listTags"));
    expect(read).toMatchObject({ userId: "u2", topic: "shipping" });
    expect(read.tags).toEqual([]);
  });
});

/**
 * `replaceRelation`/`patchRelation`/`add`/`removeRelationMember` all end in
 * TypeORM's `RelationQueryBuilder.add`/`.set` for a *ManyToMany* relation
 * (`.of(criteria)` → `@JoinTable()`), and that validation
 * (`node_modules/typeorm/query-builder/RelationQueryBuilder.js`, the
 * `relation.joinColumns.length > 1` check in `add`/`set`) reads
 * `relation.joinColumns` — the junction columns pointing back at the
 * *owning* side, `Grant`. A composite-key owner makes that length 2, and
 * the check then demands the *member* value (a plain `Tag` id) carry ≥2
 * keys too — which no bare id ever will, regardless of how the parent id
 * decodes. This is an upstream TypeORM validation gap for a composite-key
 * ManyToMany owner, not something `@kavo/typeorm`'s own decode can work
 * around (issue #263, kept out of scope here).
 */
describe("TypeOrmRepositoryAdapter — ManyToMany array-mutation writes on a composite-key parent hit an upstream TypeORM limitation (issue #263)", () => {
  it("replaceRelation rejects, even for a fully valid member id", async () => {
    await grants.createOne({ userId: "u1", topic: "billing", note: "n" } as never);
    const [tag] = await dataSource.getRepository(Tag).save([{ name: "urgent" }]);
    await expect(grantAdapter.replaceRelation!("u1~billing", "tags", [tag!.id], grantContext())).rejects.toThrow();
  });

  it("is caught at createCrud bootstrap, not just at request time", () => {
    expect(() =>
      kavo.createCrud(Grant, { relations: { edges: { tags: { write: { strategy: "replace" } } } } } as never),
    ).toThrow(ConfigurationException);
  });
});

/**
 * A `OneToMany` relation's FK lives on the child (`Label.grant`), not in a
 * junction table — `relation.joinColumns` on the `Grant.labels` side is
 * empty, so `RelationQueryBuilder`'s composite-owner check above never
 * fires. Array-mutation writes work for this relation shape.
 */
describe("TypeOrmRepositoryAdapter — OneToMany array-mutation writes on a composite-key parent (issue #263)", () => {
  it("is not rejected at createCrud bootstrap — only the ManyToMany case is", () => {
    expect(() =>
      kavo.createCrud(Grant, { relations: { edges: { labels: { write: { strategy: "replace" } } } } } as never),
    ).not.toThrow();
  });

  it("replaceRelation decodes the composite parent id and reassigns the child rows' FK", async () => {
    await grants.createOne({ userId: "u3", topic: "onboarding", note: "n" } as never);
    const [label] = await dataSource.getRepository(Label).save([{ text: "welcome" }]);

    const updated = await grantAdapter.replaceRelation!("u3~onboarding", "labels", [label!.id], {
      entityName: "Grant",
      operation: "replaceLabels",
      config: { softDelete: { strategy: "hard" } },
    } as never);
    expect(updated).toMatchObject({ userId: "u3", topic: "onboarding" });
    expect(updated.labels.map((l) => l.id)).toEqual([label!.id]);

    const reloaded = await dataSource
      .getRepository(Label)
      .findOne({ where: { id: label!.id }, relations: { grant: true } });
    expect(reloaded?.grant).toMatchObject({ userId: "u3", topic: "onboarding" });
  });

  it("raises NotFoundException for a composite parent id that does not exist", async () => {
    await expect(
      grantAdapter.replaceRelation!("nope~nope", "labels", [], {
        entityName: "Grant",
        operation: "replaceLabels",
        config: { softDelete: { strategy: "hard" } },
      } as never),
    ).rejects.toThrowError(NotFoundException);
  });

  it("addRelationMember/removeRelationMember decode the composite parent id", async () => {
    await grants.createOne({ userId: "u4", topic: "review", note: "n" } as never);
    const [label] = await dataSource.getRepository(Label).save([{ text: "notes" }]);
    const ctx = (operation: string) =>
      ({ entityName: "Grant", operation, config: { softDelete: { strategy: "hard" } } }) as never;

    const added = await grantAdapter.addRelationMember!("u4~review", "labels", label!.id, ctx("addLabel"));
    expect(added.labels.map((l) => l.id)).toEqual([label!.id]);

    const removed = await grantAdapter.removeRelationMember!("u4~review", "labels", label!.id, ctx("removeLabel"));
    expect(removed.labels).toEqual([]);
  });
});
