import { describe, expect, it } from "vitest";
import type { OperationDescriptor } from "@kavo/core";
import { resolveRoute } from "@kavo/next";

function descriptor(overrides: Partial<OperationDescriptor<object>>): OperationDescriptor<object> {
  return {
    id: "findMany",
    kind: "read",
    cardinality: "many",
    enabled: true,
    handler: { execute: async () => null },
    input: null,
    output: null,
    meta: {},
    ...overrides,
  } as OperationDescriptor<object>;
}

describe("resolveRoute", () => {
  it("resolves every standard operation to @kavo/nest's own default route shape", () => {
    expect(resolveRoute(descriptor({ id: "createOne", kind: "write" }))).toEqual({
      method: "POST",
      path: "",
      status: 201,
      hasIdParam: false,
    });
    expect(resolveRoute(descriptor({ id: "findMany" }))).toEqual({
      method: "GET",
      path: "",
      status: 200,
      hasIdParam: false,
    });
    expect(resolveRoute(descriptor({ id: "findOne" }))).toEqual({
      method: "GET",
      path: ":id",
      status: 200,
      hasIdParam: true,
    });
    expect(resolveRoute(descriptor({ id: "updateOne", kind: "write" }))).toEqual({
      method: "PUT",
      path: ":id",
      status: 200,
      hasIdParam: true,
    });
    expect(resolveRoute(descriptor({ id: "patchOne", kind: "write" }))).toEqual({
      method: "PATCH",
      path: ":id",
      status: 200,
      hasIdParam: true,
    });
    expect(resolveRoute(descriptor({ id: "deleteOne", kind: "write" }))).toEqual({
      method: "DELETE",
      path: ":id",
      status: 204,
      hasIdParam: true,
    });
    expect(resolveRoute(descriptor({ id: "restoreOne", kind: "write" }))).toEqual({
      method: "PATCH",
      path: ":id/restore",
      status: 200,
      hasIdParam: true,
    });
    expect(resolveRoute(descriptor({ id: "purgeOne", kind: "write" }))).toEqual({
      method: "DELETE",
      path: ":id/purge",
      status: 204,
      hasIdParam: true,
    });
  });

  it("returns null for a service-only operation (meta.routes.enabled: false)", () => {
    expect(resolveRoute(descriptor({ id: "findOne", meta: { routes: { enabled: false } } }))).toBeNull();
  });

  it("honors an explicit meta.routes override", () => {
    expect(
      resolveRoute(
        descriptor({ id: "findOne", meta: { routes: { method: "POST", path: "lookup", successStatus: 200 } } }),
      ),
    ).toEqual({ method: "POST", path: "lookup", status: 200, hasIdParam: false });
  });

  it("defaults a custom operation to POST /<operation id>", () => {
    expect(resolveRoute(descriptor({ id: "markPaidOne", kind: "write" }))).toEqual({
      method: "POST",
      path: "markPaidOne",
      status: 201,
      hasIdParam: false,
    });
  });

  it("resolves an array-mutation operation from its convention, not the standard table", () => {
    expect(
      resolveRoute(
        descriptor({
          id: "addAuthorsOne" as never,
          kind: "write",
          meta: { arrayMutation: { relation: "authors", strategy: "resource", action: "add" } },
        }),
      ),
    ).toEqual({ method: "POST", path: ":id/authors", status: 200, hasIdParam: true });

    expect(
      resolveRoute(
        descriptor({
          id: "replaceAuthorsOne" as never,
          kind: "write",
          meta: { arrayMutation: { relation: "authors", strategy: "replace", action: "replace" } },
        }),
      ),
    ).toEqual({ method: "PUT", path: ":id/authors", status: 200, hasIdParam: true });
  });
});
