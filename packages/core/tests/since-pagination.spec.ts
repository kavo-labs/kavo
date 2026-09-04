import { describe, expect, it } from "vitest";
import type {
  DeepPartial,
  EntityId,
  EntityMetadata,
  KavoContext,
  KavoSettings,
  ListMetaDto,
  ListResultDto,
  NormalizedQueryContext,
  PaginationStrategy,
  RepositoryAdapter,
  Sort,
} from "@kavo/core";
import {
  ConfigurationException,
  QueryValidationException,
  SincePaginationStrategy,
  WireQuery,
  createKavo,
  hasKeyset,
  readFilter,
  sinceValueOf,
} from "@kavo/core";
import { issuesOf } from "./support/query-issues.js";

/**
 * Since (seek-by-timestamp) pagination — ADR-0022.
 *
 * Mirrors `cursor-pagination.spec.ts`'s approach: drive the real
 * composition root and the real engine, since `since` paging is an
 * interaction between the strategy, the normalizer's forced sort, the
 * built-in handler's `limit + 1` over-fetch, and the engine's
 * `meta.nextSince` — testing any one alone would pass while the feature
 * was broken.
 *
 * Uses a dedicated fixture rather than the shared `User`/`Account` ones:
 * `since` needs explicit control over a non-nullable `date` boundary field
 * (including deliberate ties) and, separately, a monotonic *string* field
 * (a UUIDv7-style id) — neither existing fixture's `createOne` lets a test
 * set its own timestamp.
 */

class Event {
  id = 0;
  name = "";
  occurredAt: Date = new Date(0);
  externalId = "";
  deletedAt: Date | null = null;
}

const eventMetadata: EntityMetadata<Event> = {
  entity: Event,
  name: "Event",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
    { name: "occurredAt", kind: "date", nullable: false, generated: false },
    { name: "externalId", kind: "string", nullable: false, generated: false },
    { name: "deletedAt", kind: "date", nullable: true, generated: true },
  ],
  relations: [],
  softDeleteField: "deletedAt",
};

class InMemoryEventAdapter implements RepositoryAdapter<Event> {
  rows: Event[] = [];
  private nextId = 1;

  async findOneById(id: EntityId, query: NormalizedQueryContext<Event> | null, context: KavoContext<Event>) {
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null) {
      return null;
    }
    return this.visible(row, context, query?.withDeleted ?? false, query?.onlyDeleted ?? false) ? row : null;
  }

  async findOne(query: NormalizedQueryContext<Event>, context: KavoContext<Event>) {
    return (await this.findMany(query, context))[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<Event>, context: KavoContext<Event>): Promise<readonly Event[]> {
    const visible = this.rows.filter((row) => this.visible(row, context, query.withDeleted, query.onlyDeleted));
    const matched = this.match(visible, readFilter(query).root).sort(comparatorFor(query.sort));
    const { pagination } = query;
    if (hasKeyset(pagination)) {
      return matched.slice(0, pagination.limit);
    }
    return matched.slice(pagination.offset, pagination.offset + pagination.limit);
  }

  async count(query: NormalizedQueryContext<Event>, context: KavoContext<Event>): Promise<number> {
    const visible = this.rows.filter((row) => this.visible(row, context, query.withDeleted, query.onlyDeleted));
    return this.match(visible, query.filter.root).length;
  }

  async create(data: Partial<Event>): Promise<Event> {
    const row = { ...new Event(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<Event>): Promise<Event> {
    const row = this.require(id);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<Event>): Promise<Event> {
    return this.update(id, data);
  }

  async delete(id: EntityId, context: KavoContext<Event>): Promise<void> {
    const row = this.require(id);
    if (context.config.softDelete.strategy === "hard") {
      this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
      return;
    }
    row.deletedAt = new Date();
  }

  async restore(id: EntityId): Promise<Event> {
    const row = this.require(id);
    row.deletedAt = null;
    return row;
  }

  async purge(id: EntityId): Promise<void> {
    this.require(id);
    this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
  }

  private visible(row: Event, context: KavoContext<Event>, withDeleted: boolean, onlyDeleted: boolean): boolean {
    if (context.config.softDelete.strategy !== "soft") {
      return true;
    }
    if (onlyDeleted) {
      return row.deletedAt !== null;
    }
    return withDeleted || row.deletedAt === null;
  }

  private match(rows: Event[], root: NormalizedQueryContext<Event>["filter"]["root"]): Event[] {
    return rows.filter((row) => matches(row, root));
  }

  private require(id: EntityId): Event {
    const row = this.rows.find((candidate) => candidate.id === Number(id));
    if (row === undefined) {
      throw new Error(`Event ${String(id)} not found`);
    }
    return row;
  }
}

function matches(row: Event, node: NormalizedQueryContext<Event>["filter"]["root"]): boolean {
  if (node === null) {
    return true;
  }
  if (node.kind === "group") {
    if (node.operator === "NOT") {
      return !matches(row, node.children[0]!);
    }
    const test = (child: (typeof node.children)[number]) => matches(row, child);
    return node.operator === "AND" ? node.children.every(test) : node.children.some(test);
  }
  const actual = valueOf(row, node.field as string);
  const expected = node.value as number | string | boolean | Date | null;
  switch (node.operator) {
    case "EQ":
      return compare(actual, expected) === 0;
    case "NE":
      return compare(actual, expected) !== 0;
    case "GT":
      return compare(actual, expected) > 0;
    case "GTE":
      return compare(actual, expected) >= 0;
    case "LT":
      return compare(actual, expected) < 0;
    case "LTE":
      return compare(actual, expected) <= 0;
    default:
      throw new Error(`InMemoryEventAdapter does not evaluate '${node.operator}'`);
  }
}

function comparatorFor(sort: readonly Sort<Event>[]): (left: Event, right: Event) => number {
  return (left, right) => {
    for (const entry of sort) {
      const sign = compare(valueOf(left, entry.field as string), valueOf(right, entry.field as string));
      if (sign !== 0) {
        return entry.direction === "desc" ? -sign : sign;
      }
    }
    return 0;
  };
}

function valueOf(row: Event, field: string): number | string | boolean | Date | null {
  return (row as unknown as Record<string, number | string | boolean | Date | null>)[field] ?? null;
}

function compare(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) {
    return 0;
  }
  return (a as never) < (b as never) ? -1 : 1;
}

function sinceCrud(overrides: DeepPartial<KavoSettings> = {}) {
  const adapter = new InMemoryEventAdapter();
  const crud = createKavo({
    defaults: {
      ...overrides,
      pagination: { strategy: "since", ...overrides.pagination },
    },
  } as never).createCrud(Event, undefined, { adapter, metadata: eventMetadata });
  return { crud, adapter };
}

function nextSinceOf(list: Pick<ListResultDto<unknown>, "meta">): string | null {
  expect(list.meta).toBeDefined();
  return (list.meta as ListMetaDto)["nextSince"] as string | null;
}

/** Async mirror of `support/query-issues.ts`'s `issuesOf`, for a rejected promise. */
async function issuesOfAsync(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof QueryValidationException) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected QueryValidationException");
}

// ── SincePaginationStrategy ─────────────────────────────────────────────

describe("SincePaginationStrategy", () => {
  const strategy = new SincePaginationStrategy();
  const limits = { defaultLimit: 20, maxLimit: 100 };

  it("carries the raw value through and leaves the keyset for the normalizer", () => {
    expect(strategy.normalize({ since: "2024-01-01T00:00:00.000Z", limit: "5" }, limits)).toEqual({
      limit: 5,
      since: "2024-01-01T00:00:00.000Z",
      keyset: null,
    });
  });

  it("reports no since value at all for the first poll", () => {
    expect(strategy.normalize({}, limits)).toEqual({ limit: 20, since: null, keyset: null });
  });

  it("produces no offset, so an adapter cannot read a meaningless one", () => {
    expect(strategy.normalize({}, limits)).not.toHaveProperty("offset");
  });

  it("clamps limit to maxLimit, exactly like offset paging", () => {
    expect(strategy.normalize({ limit: "9999" }, limits).limit).toBe(100);
  });

  it("rejects a repeated since param rather than picking one arbitrarily", () => {
    expect(issuesOf(() => strategy.normalize({ since: ["a", "b"] }, limits))[0]).toMatchObject({
      field: "since",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });
});

describe("QueryNormalizer.resolveSince enforces the allowlists directly, not only via bootstrap", () => {
  // `resolveEntityConfig`'s bootstrap check is name-gated on the literal
  // string "since" (it has no strategy instance to probe structurally), so
  // a third-party strategy that emits a since-shaped `Pagination` under
  // another registered name bypasses it entirely. `resolveSince` must
  // still refuse to compose a keyset — or leak via `meta.nextSince` — over
  // a column the allowlists exclude, exactly as `resolveKeyset` already
  // does for cursor pagination (ADR-0021 §2, ADR-0022).
  class ThirdPartySince implements PaginationStrategy {
    readonly name = "poll";
    normalize(rawParams: Readonly<Record<string, unknown>>) {
      const raw = rawParams["since"];
      return { limit: 20, since: typeof raw === "string" ? raw : null, keyset: null };
    }
  }

  function pollCrud() {
    const adapter = new InMemoryEventAdapter();
    const crud = createKavo({
      defaults: { pagination: { strategy: "poll", since: { field: "occurredAt" } } },
      paginationStrategies: [new ThirdPartySince()],
    } as never).createCrud(Event, { allowed: { filterable: { exclude: ["occurredAt"] } } } as never, {
      adapter,
      metadata: eventMetadata,
    });
    return crud;
  }

  it("bypasses the bootstrap check (proving the gap this test targets is real)", () => {
    // No ConfigurationException at createCrud — `validateSincePagination`
    // never runs, because `strategy` is `"poll"`, not the literal `"since"`.
    expect(() => pollCrud()).not.toThrow();
  });

  it("still rejects a since.field excluded from the filterable allowlist at request time", async () => {
    const client = pollCrud();
    const issues = await issuesOfAsync(() => client.findMany({ since: "2024-01-01T00:00:00.000Z|1" } as never));
    expect(issues[0]?.detail).toContain("filterable");
  });
});

// ── Bootstrap validation (resolveEntityConfig) ───────────────────────────

describe("bootstrap validation of pagination.since.field", () => {
  it("fails fast when the configured field does not exist on the entity", () => {
    expect(() =>
      createKavo({
        defaults: { pagination: { strategy: "since", since: { field: "nope" } } },
      } as never).createCrud(Event, undefined, { adapter: new InMemoryEventAdapter(), metadata: eventMetadata }),
    ).toThrow(ConfigurationException);
  });

  it("fails fast when the configured field is not a date or string column", () => {
    expect(() =>
      createKavo({
        defaults: { pagination: { strategy: "since", since: { field: "id" } } },
      } as never).createCrud(Event, undefined, { adapter: new InMemoryEventAdapter(), metadata: eventMetadata }),
    ).toThrow(/'date'- or 'string'-kind/);
  });

  it("fails fast when the since field is excluded from the filterable allowlist", () => {
    expect(() =>
      createKavo({
        defaults: {
          pagination: { strategy: "since", since: { field: "occurredAt" } },
        },
      } as never).createCrud(Event, { allowed: { filterable: { exclude: ["occurredAt"] } } } as never, {
        adapter: new InMemoryEventAdapter(),
        metadata: eventMetadata,
      }),
    ).toThrow(/filterable allowlist/);
  });

  it("accepts the documented default ('updatedAt') when the entity declares no override — a missing column is fine unless strategy is 'since'", () => {
    // Sanity: offset strategy never looks at `since.field` at all, so an
    // entity with no such column is unaffected.
    expect(() =>
      createKavo({}).createCrud(Event, undefined, { adapter: new InMemoryEventAdapter(), metadata: eventMetadata }),
    ).not.toThrow();
  });
});

// ── Since pagination end to end ───────────────────────────────────────

describe("since pagination end to end", () => {
  const BASE = new Date("2024-01-01T00:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  async function seed(
    crud: ReturnType<typeof sinceCrud>["crud"],
    count: number,
    field: "occurredAt" = "occurredAt",
  ): Promise<void> {
    for (let index = 1; index <= count; index++) {
      await crud.createOne({
        name: `event-${index}`,
        [field]: new Date(BASE.getTime() + index * HOUR),
      } as never);
    }
  }

  function crud(overrides: DeepPartial<KavoSettings> = {}) {
    return sinceCrud({ pagination: { since: { field: "occurredAt" }, ...overrides.pagination }, ...overrides });
  }

  it("forces the sort to '[since.field, idField]', rejecting a client-supplied sort", async () => {
    const { crud: client } = crud();
    const issues = await issuesOfAsync(() => client.findMany({ sort: [{ field: "name", direction: "asc" }] } as never));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
    expect(issues[0]?.detail).toContain("forced to 'occurredAt,id'");
  });

  it("walks every row exactly once, in order, when polled repeatedly", async () => {
    // The wire token is `<value>|<id>`, so `keysetExpression` breaks ties
    // the same way cursor pagination does — no redelivery, unlike a bare
    // single-column `>=` bound (ADR-0022).
    const { crud: client } = crud();
    await seed(client, 5);

    const names: string[] = [];
    let since: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await client.findMany({ limit: 2, since } as never);
      if (result.items.length === 0) {
        break;
      }
      names.push(...(result.items as Event[]).map((event) => event.name));
      since = nextSinceOf(result);
    }
    expect(names).toEqual(["event-1", "event-2", "event-3", "event-4", "event-5"]);
  });

  it("advances nextSince from the last returned row even on a partial (not full) page", async () => {
    // Unlike cursor's nextCursor, this must not wait for `hasMore` — a
    // polling boundary that only advances on a full page would re-fetch
    // already-seen rows on every partial poll (ADR-0022).
    const { crud: client } = crud();
    await seed(client, 2);

    const page = await client.findMany({ limit: 10 } as never);
    expect(page.items).toHaveLength(2);
    expect(nextSinceOf(page)).toBe(`${new Date(BASE.getTime() + 2 * HOUR).toISOString()}|2`);
  });

  it("echoes the request's own since back on an exhausted (empty) poll, not null", async () => {
    const { crud: client } = crud();
    await seed(client, 1);

    const first = await client.findMany({ limit: 10 } as never);
    const boundary = nextSinceOf(first);
    const caughtUp = await client.findMany({ limit: 10, since: boundary } as never);
    expect(caughtUp.items).toEqual([]);
    expect(nextSinceOf(caughtUp)).toBe(boundary);
  });

  it("returns nextSince: null-request echo on a first poll with no matching rows at all", async () => {
    const { crud: client } = crud();
    const page = await client.findMany({ limit: 10 } as never);
    expect(page.items).toEqual([]);
    expect(nextSinceOf(page)).toBeNull();
  });

  it("resumes correctly from a tied boundary row without redelivering it", async () => {
    const { crud: client } = crud();
    // Two rows share the exact same 'occurredAt'.
    await client.createOne({ name: "tied-a", occurredAt: BASE } as never);
    await client.createOne({ name: "tied-b", occurredAt: BASE } as never);
    await client.createOne({ name: "later", occurredAt: new Date(BASE.getTime() + HOUR) } as never);

    const first = await client.findMany({ limit: 1 } as never);
    expect((first.items as Event[])[0]!.name).toBe("tied-a");
    const boundary = nextSinceOf(first);

    const second = await client.findMany({ limit: 10, since: boundary } as never);
    expect((second.items as Event[]).map((event) => event.name)).toEqual(["tied-b", "later"]);
  });

  it("makes forward progress on a tied group larger than limit — the bug a single-column bound cannot avoid", async () => {
    // Regression: an inclusive `since.field >= value` bound with no id
    // tiebreaker never advances once a tie exceeds `limit` — every poll
    // refetches the same leading slice forever, and the tail rows are never
    // delivered. The `<value>|<id>` token composed with `keysetExpression`
    // (ADR-0022) is what fixes this.
    const { crud: client } = crud();
    await client.createOne({ name: "A", occurredAt: BASE } as never);
    await client.createOne({ name: "B", occurredAt: BASE } as never);
    await client.createOne({ name: "C", occurredAt: BASE } as never);

    const names: string[] = [];
    let since: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await client.findMany({ limit: 2, since } as never);
      if (result.items.length === 0) {
        break;
      }
      names.push(...(result.items as Event[]).map((event) => event.name));
      since = nextSinceOf(result);
    }
    expect(names).toEqual(["A", "B", "C"]);
  });

  it("composes the since boundary with a client filter — AND, never a replacement", async () => {
    const { crud: client } = crud();
    await seed(client, 4);

    // Establish a real boundary first, so the second call actually builds a
    // keyset — the AND-composition this test names is between that keyset
    // and the client filter, not between an unfiltered offset-0 page and a
    // filter (which `readFilter` would pass through unchanged either way).
    const first = await client.findMany({ limit: 1 } as never);
    const boundary = nextSinceOf(first);

    const page = await client.findMany({
      limit: 10,
      since: boundary,
      filter: { kind: "condition", field: "name", operator: "NE", value: "event-3" },
    } as never);
    // Without the since boundary this would include event-1; without the
    // filter it would include event-3. Both narrow the same result.
    expect((page.items as Event[]).map((event) => event.name)).toEqual(["event-2", "event-4"]);
  });

  it("excludes soft-deleted rows by default, composing with the since boundary", async () => {
    const { crud: client } = crud();
    await seed(client, 3);
    const first = await client.findMany({ limit: 1 } as never);
    const boundary = nextSinceOf(first);
    const middle = (await client.findMany({ limit: 1, since: boundary } as never)).items[0] as Event;
    expect(middle.name).toBe("event-2");
    await client.deleteOne(middle.id as never);

    // Polling from before the deleted row: it is excluded from the default
    // (live-only) scope, composing with the since boundary rather than
    // replacing it.
    const page = await client.findMany({ limit: 10, since: boundary } as never);
    expect((page.items as Event[]).map((event) => event.name)).toEqual(["event-3"]);

    const withDeleted = await client.findMany({ limit: 10, since: boundary, withDeleted: true } as never);
    expect((withDeleted.items as Event[]).map((event) => event.name)).toEqual(["event-2", "event-3"]);
  });

  it("reports offset 0 and total across the whole match set, same as cursor pagination", async () => {
    const { crud: client } = crud();
    await seed(client, 3);
    const page = await client.findMany({ limit: 2 } as never);
    expect(page.offset).toBe(0);
    expect(page.total).toBe(3);
  });

  it("pages by a UUIDv7-style monotonic string field, alongside a date-typed entity elsewhere in the suite", async () => {
    const { crud: client } = sinceCrud({ pagination: { since: { field: "externalId" } } });
    // Lexicographically sortable, time-ordered ids — the realistic case a
    // UUIDv7 primary key gives when there is no separate timestamp column.
    const ids = [
      "01890a5d-ac96-774b-8b1a-000000000001",
      "01890a5d-ac96-774b-8b1a-000000000002",
      "01890a5d-ac96-774b-8b1a-000000000003",
    ];
    for (const [index, externalId] of ids.entries()) {
      await client.createOne({ name: `row-${index}`, externalId } as never);
    }

    const first = await client.findMany({ limit: 2 } as never);
    expect((first.items as Event[]).map((event) => event.externalId)).toEqual([ids[0], ids[1]]);
    const boundary = nextSinceOf(first);
    expect(boundary).toBe(`${ids[1]}|2`);

    const second = await client.findMany({ limit: 2, since: boundary } as never);
    expect((second.items as Event[]).map((event) => event.externalId)).toEqual([ids[2]]);
  });

  it("accepts the wire spelling of a since page", async () => {
    const { crud: client } = crud();
    await seed(client, 3);

    const first = await client.engine.execute({
      operation: "findMany",
      query: new WireQuery({ limit: "2" }),
    } as never);
    const boundary = nextSinceOf(first.list ?? {});

    const second = await client.engine.execute({
      operation: "findMany",
      query: new WireQuery({ limit: "10", since: boundary }),
    } as never);
    const items = (second.list?.items ?? []) as readonly Event[];
    expect(items.map((event) => event.name)).toEqual(["event-3"]);
  });

  it("rejects a malformed since token over the wire as a query issue, not a crash", async () => {
    const { crud: client } = crud();
    await seed(client, 1);

    await expect(
      client.engine.execute({
        operation: "findMany",
        query: new WireQuery({ limit: "10", since: "no-pipe-separator" }),
      } as never),
    ).rejects.toMatchObject({
      issues: [{ field: "since", code: "KAVO_QUERY_INVALID_VALUE" }],
    });
  });

  it("rejects a since value under the wrong strategy rather than silently ignoring it", async () => {
    const adapter = new InMemoryEventAdapter();
    const offsetCrud = createKavo({}).createCrud(Event, undefined, { adapter, metadata: eventMetadata });
    const issues = await issuesOfAsync(() => offsetCrud.findMany({ since: "2024-01-01" } as never));
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("rejects a cursor value under the since strategy rather than silently ignoring it", async () => {
    const { crud: client } = crud();
    const issues = await issuesOfAsync(() => client.findMany({ cursor: "abc" } as never));
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("emits a since token carrying null for a null sort key, and 400s naming the column on replay", async () => {
    // The same half-guard cursor pagination documents (ADR-0021 §4): the
    // encode side never refuses a null value (it is the previous row's
    // problem to have one), but replaying that token is a loud rejection
    // rather than a keyset predicate built over a comparison SQL treats as
    // UNKNOWN.
    const { crud: client } = sinceCrud({ pagination: { since: { field: "deletedAt" } } });
    await client.createOne({ name: "event-1" } as never);

    const first = await client.findMany({ limit: 10 } as never);
    const boundary = nextSinceOf(first);
    expect(boundary).toBe("null|1");

    const issues = await issuesOfAsync(() => client.findMany({ limit: 10, since: boundary } as never));
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("'deletedAt'");
  });
});

// ── sinceValueOf: encoding the boundary off a row ────────────────────────

describe("sinceValueOf — a boundary column's runtime type must be encodable", () => {
  // The since mirror of `cursorValuesOf`'s guard (ADR-0021's documented
  // bigint/decimal limitation, which ADR-0022 inherits). `meta.nextSince`
  // is read off the entity before serialization, so a column whose runtime
  // value is neither string, number, nor Date has no wire form. It must
  // fail loudly rather than stringify into a token that will not replay.
  const occurredAt = eventMetadata.fields.find((field) => field.name === "occurredAt")!;
  const idField = eventMetadata.fields.find((field) => field.name === "id")!;
  const externalId = eventMetadata.fields.find((field) => field.name === "externalId")!;

  it("joins the boundary value and the id tiebreaker with a pipe", () => {
    const row = { occurredAt: new Date("2024-01-01T00:00:00.000Z"), id: 7 };
    expect(sinceValueOf(row, occurredAt, idField, "Event")).toBe("2024-01-01T00:00:00.000Z|7");
  });

  it("encodes a string boundary column as-is", () => {
    expect(sinceValueOf({ externalId: "018f2c8e", id: 7 }, externalId, idField, "Event")).toBe("018f2c8e|7");
  });

  it("writes the literal 'null' for an absent boundary, leaving the replay to reject it", () => {
    // Deliberately not a throw: an absent boundary column is the
    // normalizer's problem on replay, where it can name the column in a
    // 400, not the encoder's to refuse mid-response (ADR-0022).
    expect(sinceValueOf({ occurredAt: null, id: 7 }, occurredAt, idField, "Event")).toBe("null|7");
    expect(sinceValueOf({ occurredAt: undefined, id: 7 }, occurredAt, idField, "Event")).toBe("null|7");
  });

  it("refuses a bigint id rather than emitting a token that cannot round-trip", () => {
    const encode = () => sinceValueOf({ occurredAt: new Date(0), id: 1n }, occurredAt, idField, "Event");
    expect(encode).toThrow(ConfigurationException);
    expect(encode).toThrow(/bigint/);
  });

  it("names the offending column, its declared kind, and the entity", () => {
    let message = "";
    try {
      sinceValueOf({ occurredAt: new Date(0), id: 1n }, occurredAt, idField, "Event");
    } catch (thrown) {
      message = (thrown as Error).message;
    }
    expect(message).toContain("'id'");
    expect(message).toContain("number");
    expect(message).toContain("Event");
  });

  it("describes a class instance by its constructor name, so a Decimal column is diagnosable", () => {
    class Decimal {}
    expect(() => sinceValueOf({ occurredAt: new Decimal(), id: 1 }, occurredAt, idField, "Event")).toThrow(
      /Decimal object/,
    );
  });

  it("degrades to plain 'object' for a value carrying no constructor", () => {
    expect(() => sinceValueOf({ occurredAt: Object.create(null), id: 1 }, occurredAt, idField, "Event")).toThrow(
      /runtime value is a object/,
    );
  });
});

// ── Replaying a token: both halves are validated ─────────────────────────

describe("since token replay validates each half independently", () => {
  it("rejects a token whose value half does not coerce to the boundary column", async () => {
    const { crud } = sinceCrud({ pagination: { since: { field: "occurredAt" } } } as never);
    const issues = await issuesOfAsync(() => crud.findMany({ since: "not-a-date|1" } as never));
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects a token whose id half does not coerce to the id column", async () => {
    const { crud } = sinceCrud({ pagination: { since: { field: "occurredAt" } } } as never);
    const issues = await issuesOfAsync(() => crud.findMany({ since: "2024-01-01T01:00:00.000Z|nope" } as never));
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_INVALID_VALUE" });
  });
});

// ── `since` under the wrong strategy, over the wire ──────────────────────

describe("a since param under a non-since strategy is refused, not ignored", () => {
  // The programmatic half of this is already pinned; the wire half is the
  // one a real client hits. Silently dropping the param would serve page 1
  // forever while the client believed it was polling forward.
  function offsetCrud() {
    return createKavo({}).createCrud(Event, undefined, {
      adapter: new InMemoryEventAdapter(),
      metadata: eventMetadata,
    });
  }

  it("reports KAVO_QUERY_UNSUPPORTED_PARAM for ?since= under offset pagination", async () => {
    const crud = offsetCrud();
    const issues = await issuesOfAsync(() =>
      crud.engine.execute({
        operation: "findMany",
        query: new WireQuery({ since: "2024-01-01T00:00:00.000Z|1" }),
      } as never),
    );
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("treats an empty ?since= as absent rather than unsupported", async () => {
    const crud = offsetCrud();
    const response = await crud.engine.execute({
      operation: "findMany",
      query: new WireQuery({ since: "" }),
    } as never);
    expect(response.list?.items).toEqual([]);
  });
});

// ── Bootstrap: the selectable allowlist half ─────────────────────────────

describe("bootstrap validation of pagination.since.field — the selectable allowlist", () => {
  // The filterable half is what composes the keyset predicate; the
  // selectable half is what lets the engine read the next boundary back
  // off a returned row. Both are required, and each fails with its own
  // wording so the adopter knows which allowlist to fix.
  function bootstrap(allowed: unknown) {
    return () =>
      createKavo({
        defaults: { pagination: { strategy: "since", since: { field: "occurredAt" } } },
      } as never).createCrud(Event, { allowed } as never, {
        adapter: new InMemoryEventAdapter(),
        metadata: eventMetadata,
      });
  }

  it("fails fast when the since field is excluded from selectable", () => {
    expect(bootstrap({ selectable: { exclude: ["occurredAt"] } })).toThrow(/selectable allowlist/);
  });

  it("fails fast when the forced idField tiebreaker is excluded from selectable", () => {
    expect(bootstrap({ selectable: { exclude: ["id"] } })).toThrow(/forced tiebreaker 'idField'/);
  });

  it("fails fast when the forced idField tiebreaker is excluded from filterable", () => {
    expect(bootstrap({ filterable: { exclude: ["id"] } })).toThrow(/forced tiebreaker 'idField'/);
  });
});
