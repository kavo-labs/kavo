import { describe, expect, it } from "vitest";
import type { FilterExpression, NormalizedQueryContext } from "@kavo/core";
import { QueryNormalizer, createKavo, resolveEntityConfig } from "@kavo/core";
import {
  Author,
  Comment,
  Post,
  SeededAdapter,
  authorMetadata,
  commentMetadata,
  postMetadata,
} from "./support/blog-fixture.js";

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new SeededAdapter<Post>([]);
  const kavo = createKavo();
  kavo.createCrud(Author, undefined, { adapter: new SeededAdapter<Author>(), metadata: authorMetadata });
  kavo.createCrud(Comment, undefined, { adapter: new SeededAdapter<Comment>(), metadata: commentMetadata });
  const crud = kavo.createCrud(Post, config as never, { adapter, metadata: postMetadata });
  return { crud, adapter, kavo };
}

const statusFilter: FilterExpression<Post> = {
  kind: "condition",
  field: "title" as never,
  operator: "EQ",
  value: "default-title",
};

describe("filter.default — applies only when the client sends no filter=", () => {
  it("is used for findMany when the request carries no filter", async () => {
    const { crud, adapter } = makeCrud({
      filter: { fields: ["title", "authorId"], default: statusFilter },
    } as never);
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.filter.root).toEqual(statusFilter);
  });

  it("is fully overridden — not merged — by a client-supplied filter", async () => {
    const { crud, adapter } = makeCrud({
      filter: { fields: ["title", "authorId"], default: statusFilter },
    } as never);
    const clientFilter: FilterExpression<Post> = {
      kind: "condition",
      field: "authorId" as never,
      operator: "EQ",
      value: "u-1",
    };
    await crud.findMany({ filter: clientFilter } as never);
    expect(adapter.lastQuery?.filter.root).toEqual(clientFilter);
  });

  it("composes with filter.apply — apply still AND's in over the default", async () => {
    const { crud, adapter } = makeCrud({
      filter: {
        fields: ["title", "authorId"],
        default: statusFilter,
        apply: () => ({ kind: "condition", field: "authorId" as never, operator: "EQ", value: "u-1" }),
      },
    } as never);
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [statusFilter, { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" }],
    });
  });

  it("has no effect when unconfigured", async () => {
    const { crud, adapter } = makeCrud();
    await crud.findMany(undefined);
    expect(adapter.lastQuery?.filter.root).toBeNull();
  });
});

describe("filter.default — bootstrap validation", () => {
  it("rejects a default naming a field not in filter.fields", () => {
    expect(() =>
      makeCrud({
        filter: {
          fields: ["title"],
          default: { kind: "condition", field: "authorId" as never, operator: "EQ", value: "u-1" },
        },
      } as never),
    ).toThrow(/filter\.default/);
  });

  it("validates fields nested inside groups", () => {
    expect(() =>
      makeCrud({
        filter: {
          fields: ["title"],
          default: {
            kind: "group",
            operator: "AND",
            children: [
              { kind: "condition", field: "title" as never, operator: "EQ", value: "a" },
              { kind: "condition", field: "authorId" as never, operator: "EQ", value: "u-1" },
            ],
          },
        },
      } as never),
    ).toThrow(/filter\.default/);
  });
});

describe("QueryNormalizer — filter.default via both entry points", () => {
  const config = resolveEntityConfig(
    postMetadata,
    {
      filter: { fields: ["title", "authorId"], default: statusFilter },
      select: { fields: ["title", "authorId"] },
    },
    undefined,
  );
  const normalizer = new QueryNormalizer<Post>(postMetadata);

  it("normalizeWire substitutes the default when no filter[...] param is present", () => {
    const result: NormalizedQueryContext<Post> = normalizer.normalizeWire({}, config);
    expect(result.filter.root).toEqual(statusFilter);
  });

  it("normalizeInput substitutes the default when input.filter is absent", () => {
    const result = normalizer.normalizeInput(undefined, config);
    expect(result.filter.root).toEqual(statusFilter);
  });

  it("normalizeWire lets a client filter[...] param override the default outright", () => {
    const result = normalizer.normalizeWire({ "filter[title][eq]": "hello" }, config);
    expect(result.filter.root).toEqual({ kind: "condition", field: "title", operator: "EQ", value: "hello" });
  });
});
