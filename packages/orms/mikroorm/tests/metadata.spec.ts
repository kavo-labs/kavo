import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BigIntType, Collection, MikroORM } from "@mikro-orm/core";
import {
  Embeddable,
  Embedded,
  Entity,
  Enum,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
} from "@mikro-orm/decorators/legacy";
import { ConfigurationException, type FieldMetadata } from "@kavo/core";
import { buildEntityMetadata } from "@kavo/mikroorm";
import { newTestOrm } from "./support/database.js";

enum Status {
  Active = "active",
  Banned = "banned",
}

@Entity()
class Widget {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  name!: string;

  @Property({ type: "number" })
  count!: number;

  @Property({ type: "boolean" })
  active!: boolean;

  @Property({ type: "Date" })
  releasedOn!: Date;

  @Property({ type: "json", nullable: true })
  payload: unknown = null;

  @Enum({ items: () => Status })
  status: Status = Status.Active;

  /**
   * A column whose JavaScript representation is not its column type.
   * `BigIntType`'s default mode is native `bigint` (v7); `'string'` mode is
   * what keeps the runtime value precision-safe through Kavo's coercion and
   * JSON serialization, which cannot represent a native `bigint` at all.
   */
  @Property({ columnType: "bigint", type: new BigIntType("string") })
  serial!: string;

  @Property({ type: "Date", onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ type: "Date", onUpdate: () => new Date(), nullable: true })
  updatedAt: Date | null = null;

  @Property({ type: "number", version: true })
  version!: number;

  @Property({ type: "string", persist: false })
  computed!: string;

  /** An ORM-derived field (issue #373): a `formula` property. */
  @Property({ type: "string", formula: (cols: unknown) => `upper(${String(cols)}.name)` })
  nameUpper!: string;

  /** MikroORM's "never expose this" — a password hash, an API key. */
  @Property({ type: "string", hidden: true, nullable: true })
  secret: string | null = null;

  /** Not loaded with the entity, so a filter on it would outrun the DTO. */
  @Property({ type: "string", lazy: true, nullable: true })
  bulky: string | null = null;
}

/**
 * Column types MikroORM cannot give a JavaScript equivalent for: every
 * property here comes back with a `runtimeType` that narrows nothing
 * (`"unknown"`, `"any"`, `"Buffer"`), so the *declared* type is the only
 * thing left to read a field kind off. Custom types and driver-native column
 * types are the real-world case — Kavo's coercion depends on getting them
 * right, and there is no reflection to fall back on.
 */
@Entity()
class Reading {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "int8", nullable: true })
  samples: unknown = null;

  @Property({ type: "timestamptz", nullable: true })
  observedAt: unknown = null;

  @Property({ type: "bool", nullable: true })
  verified: unknown = null;

  @Property({ type: "jsonb", nullable: true })
  extra: unknown = null;

  @Property({ type: "blob", nullable: true })
  raw: unknown = null;
}

let orm: MikroORM;
let byName: Record<string, FieldMetadata>;
let declaredOnly: Record<string, FieldMetadata>;

beforeAll(async () => {
  orm = await newTestOrm([Widget, Reading]);
  byName = Object.fromEntries(buildEntityMetadata(orm, Widget).fields.map((field) => [field.name, field]));
  declaredOnly = Object.fromEntries(buildEntityMetadata(orm, Reading).fields.map((field) => [field.name, field]));
});

afterAll(async () => {
  await orm.close();
});

describe("buildEntityMetadata — field kinds", () => {
  it.each([
    ["name", "string"],
    ["count", "number"],
    ["active", "boolean"],
    ["releasedOn", "date"],
    ["payload", "json"],
    ["status", "enum"],
  ])("maps %s to the %s field kind", (field, kind) => {
    expect(byName[field]).toMatchObject({ kind });
  });

  it("follows the runtime representation, not the column type, for bigint", () => {
    // `Widget.serial` explicitly requests `BigIntType`'s `'string'` mode to
    // keep precision, so `string` is what core must coerce toward — reading
    // `number` off the column type would corrupt values past 2^53.
    expect(byName["serial"]).toMatchObject({ kind: "string" });
  });

  it("falls back to the declared type when there is no JavaScript equivalent", () => {
    // `JsonType`'s `runtimeType` is `"any"`, which narrows nothing; the
    // declared type is the only thing left that says "json".
    expect(byName["payload"]).toMatchObject({ kind: "json" });
  });

  it.each([
    ["samples", "int8", "number"],
    ["observedAt", "timestamptz", "date"],
    ["verified", "bool", "boolean"],
    ["extra", "jsonb", "json"],
    ["raw", "blob", "string"],
  ])("reads %s, declared '%s', as the %s field kind", (field, _declared, kind) => {
    // The declared-type ladder, one row per rung. It is not a guard: these
    // are ordinary columns whose `runtimeType` narrows nothing, and getting
    // one wrong is silent — `filter[observedAt][gt]=2024-01-01` would be
    // compared as a string, and `int8` values would never coerce to numbers.
    // The last rung is the honest one: an unrecognized type degrades to
    // `string`, so comparison still works even though coercion cannot narrow.
    expect(declaredOnly[field]).toMatchObject({ kind });
  });

  it("carries the enum's allowed values as the coercion allowlist", () => {
    expect(byName["status"]?.enumValues).toEqual(["active", "banned"]);
  });

  it("reports nullability from the property declaration", () => {
    expect(byName["payload"]).toMatchObject({ nullable: true });
    expect(byName["name"]).toMatchObject({ nullable: false });
  });
});

describe("buildEntityMetadata — generated properties", () => {
  it.each([
    ["id", "an auto-increment primary key"],
    ["createdAt", "an onCreate hook"],
    ["updatedAt", "an onUpdate hook"],
    ["version", "an optimistic-lock version"],
    ["computed", "a non-persisted property"],
    ["nameUpper", "a formula property"],
  ])("marks %s generated (%s)", (field) => {
    expect(byName[field]).toMatchObject({ generated: true });
  });

  it.each(["name", "count", "status", "payload"])("leaves %s writable by the caller", (field) => {
    expect(byName[field]).toMatchObject({ generated: false });
  });
});

describe("buildEntityMetadata — ORM-derived fields (issue #373)", () => {
  it("carries the formula callback as the opaque derivedExpression marker", () => {
    expect(byName["nameUpper"]?.derivedExpression).toBeTypeOf("function");
  });

  it("leaves an ordinary column's derivedExpression absent", () => {
    expect(byName["name"]).not.toHaveProperty("derivedExpression");
  });
});

describe("buildEntityMetadata — never-expose properties", () => {
  it.each(["secret", "bulky"])("drops the %s property from the metadata seam entirely", (field) => {
    // Not merely hidden from responses: excluded from `fields`, so it never
    // reaches the derived DTOs *or* the default filterable/sortable
    // allowed. A column that is invisible in the body but filterable in
    // the database is a blind extraction oracle —
    // `filter[secret][like]=sk_live_9%` answered by the row count.
    expect(byName[field]).toBeUndefined();
  });

  it("still exposes ordinary properties alongside them", () => {
    expect(byName["name"]).toBeDefined();
  });
});

describe("buildEntityMetadata — embeddables", () => {
  it("exposes the embeddable property and drops its inner columns", async () => {
    @Embeddable()
    class Address {
      @Property({ type: "string" })
      city!: string;

      @Property({ type: "string" })
      street!: string;
    }

    @Entity()
    class Office {
      @PrimaryKey({ type: "number" })
      id!: number;

      @Embedded(() => Address, { object: true })
      address = new Address();

      @Embedded(() => Address, { object: false, prefix: "billing_" })
      billing = new Address();
    }

    const embedded = await newTestOrm([Office, Address]);
    try {
      const fields = buildEntityMetadata(embedded, Office).fields;
      // The addressable properties only — never MikroORM's internal child
      // names (`address~city`, `billing_city`), which would otherwise land in
      // derived DTOs and allowlists as unusable wire fields.
      expect(fields.map((field) => field.name)).toEqual(["id", "address", "billing"]);
      expect(fields.filter((field) => field.name !== "id")).toMatchObject([{ kind: "json" }, { kind: "json" }]);
    } finally {
      await embedded.close();
    }
  });
});

describe("buildEntityMetadata — relation targets", () => {
  it("resolves a target declared by name, not just by class thunk", async () => {
    // `@ManyToOne(() => Owner)` leaves `property.entity` a thunk resolving to
    // the class, but `@ManyToOne(() => "Owner")` — the spelling that keeps a
    // bidirectional relation's import cycle off the runtime graph, which
    // `.dependency-cruiser.cjs` forbids — leaves it a thunk resolving to a
    // plain *string*. Calling it would throw, and core matches relation
    // targets by class identity, so a string would break include projection
    // outright.
    @Entity()
    class Kennel {
      @PrimaryKey({ type: "number" })
      id!: number;

      @OneToMany((): any => "Hound", "kennel")
      hounds = new Collection<object>(this);
    }

    @Entity()
    class Hound {
      @PrimaryKey({ type: "number" })
      id!: number;

      @ManyToOne((): any => "Kennel", { nullable: true })
      kennel: object | null = null;
    }

    const named = await newTestOrm([Kennel, Hound]);
    try {
      expect(buildEntityMetadata(named, Hound).relations[0]!.target()).toBe(Kennel);
      expect(buildEntityMetadata(named, Kennel).relations[0]!.target()).toBe(Hound);
    } finally {
      await named.close();
    }
  });

  // `targetOf`'s final `ConfigurationException` — the guard that stops a
  // bare string reaching core, where relation targets are matched by class
  // identity — is deliberately left uncovered. MikroORM's discovery
  // validator refuses to initialize an ORM whose relation names an
  // undiscovered entity, so the only way in is to forge the discovered
  // property afterwards, and a test that rewrites ORM internals asserts
  // the shape of those internals rather than any behavior of ours.
  // `@kavo/mongoose` covers the same guard through a supported path,
  // because an unregistered `ref` there is an ordinary runtime state.
});

describe("buildEntityMetadata — single-table inheritance", () => {
  it("reports inherited columns and marks the discriminator generated", async () => {
    @Entity({ abstract: true, discriminatorColumn: "species" })
    abstract class Beast {
      @PrimaryKey({ type: "number" })
      id!: number;

      @Property({ type: "string" })
      name!: string;
    }

    @Entity({ discriminatorValue: "feline" })
    class Feline extends Beast {
      @Property({ type: "boolean", nullable: true })
      indoor!: boolean;
    }

    const sti = await newTestOrm([Beast, Feline]);
    try {
      const byField = Object.fromEntries(buildEntityMetadata(sti, Feline).fields.map((field) => [field.name, field]));
      // The subtype's own column and the base's both surface.
      expect(byField["name"]).toMatchObject({ kind: "string", generated: false });
      expect(byField["indoor"]).toMatchObject({ kind: "boolean", generated: false });
      // The discriminator is write-only bookkeeping MikroORM manages from
      // the subtype being persisted. Marking it generated is what keeps it
      // out of the *writable* projection: a client sending `species` for a
      // different subtype would produce a row this entity's own repository
      // can no longer load.
      expect(byField["species"]).toMatchObject({ generated: true });
    } finally {
      await sti.close();
    }
  });
});

describe("buildEntityMetadata — refusals", () => {
  it("refuses a composite primary key", async () => {
    @Entity()
    class Membership {
      @PrimaryKey({ type: "number" })
      userId!: number;

      @PrimaryKey({ type: "number" })
      groupId!: number;

      @Property({ type: "string" })
      role!: string;
    }

    const composite = await newTestOrm([Membership]);
    try {
      let thrown: unknown;
      try {
        buildEntityMetadata(composite, Membership);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigurationException);
      expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((thrown as Error).message).toMatch(/requires exactly one primary key; found 2/);
    } finally {
      await composite.close();
    }
  });
});
