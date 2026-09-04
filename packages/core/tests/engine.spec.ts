import { describe, expect, it } from "vitest";
import type { KavoContext } from "@kavo/core";
import {
  ConfigurationException,
  NotFoundException,
  OperationDisabledException,
  OperationNotRegisteredException,
  createKavo,
  isEtagEnabled,
  toProblemDetails,
} from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import { Account, InMemoryAccountAdapter, accountMetadata } from "./support/account-fixture.js";

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new InMemoryUserAdapter();
  const kavo = createKavo();
  const crud = kavo.createCrud(User, config as never, {
    adapter,
    metadata: userMetadata,
  });
  return { crud, adapter, kavo };
}

/**
 * A call naming an operation the registry has no entry for. Only reachable
 * through the engine: the typed service surface has no such method, and
 * route generation walks the same registry, so no route exists either.
 */
const unregisteredRequest = () => ({ operation: "findAll", id: null, body: null, query: null, options: null }) as never;

describe("KavoEngine pipeline", () => {
  it("runs createOne → findOne → updateOne → patchOne → deleteOne", async () => {
    const { crud } = makeCrud();
    const created = await crud.createOne({
      name: "Ada",
      email: "ada@example.com",
      age: 36,
      status: "active",
    } as never);
    expect(created).toMatchObject({ id: 1, name: "Ada" });

    const found = await crud.findOne(1);
    expect(found).toMatchObject({ email: "ada@example.com" });

    const updated = await crud.updateOne(1, { name: "Ada Lovelace" } as never);
    expect(updated).toMatchObject({ name: "Ada Lovelace" });

    const patched = await crud.patchOne(1, { age: 37 } as never);
    expect(patched).toMatchObject({ age: 37 });

    await crud.deleteOne(1);
    await expect(crud.findOne(1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("strips generated and unknown keys from write payloads", async () => {
    const { crud, adapter } = makeCrud();
    await crud.createOne({
      id: 999,
      name: "Eve",
      email: "eve@example.com",
      role: "admin",
    } as never);
    const row = adapter.rows[0]!;
    expect(row.id).toBe(1); // client-sent id ignored (generated column)
    expect((row as unknown as Record<string, unknown>)["role"]).toBeUndefined();
  });

  it("returns the ListResultDto envelope from findMany", async () => {
    const { crud } = makeCrud();
    for (let i = 0; i < 5; i++) {
      await crud.createOne({ name: `u${i}`, email: `u${i}@x.io`, age: 20 + i } as never);
    }
    const list = await crud.findMany({ limit: 2, offset: 1 });
    expect(list.items).toHaveLength(2);
    expect(list.limit).toBe(2);
    expect(list.offset).toBe(1);
    expect(list.total).toBe(5);
    // `meta` is optional and nothing contributed here, so the key is absent
    // rather than an empty bag.
    expect(list.meta).toBeUndefined();
    expect("meta" in list).toBe(false);
  });

  it("reports total: null when counting is disabled", async () => {
    const { crud } = makeCrud({ pagination: { count: false } } as never);
    await crud.createOne({ name: "x", email: "x@x.io", age: 1 } as never);
    const list = await crud.findMany();
    expect(list.total).toBeNull();
  });

  it("applies field selection after DTO mapping", async () => {
    const { crud } = makeCrud();
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    const list = await crud.findMany({ select: { root: ["id", "name"] } } as never);
    expect(Object.keys(list.items[0] as object)).toEqual(["id", "name"]);
  });

  it("serializes through a registered item DTO class", async () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    const { crud } = makeCrud({ dto: { item: UserItemDto } } as never);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(Object.keys(created as object)).toEqual(["id", "name"]);
  });

  it("honors per-call settings overrides without touching config", async () => {
    const { crud } = makeCrud();
    await crud.createOne({ name: "x", email: "x@x.io", age: 1 } as never);
    const uncounted = await crud.findMany(undefined, {
      settings: { pagination: { count: false } },
    });
    expect(uncounted.total).toBeNull();
    const counted = await crud.findMany();
    expect(counted.total).toBe(1);
  });

  it("honors a per-call defaults.sort override for one request only", async () => {
    const { crud, adapter } = makeCrud();
    await crud.findMany(undefined, {
      settings: { defaults: { sort: ["name"] } },
    });
    expect(adapter.lastQuery?.sort).toEqual([{ field: "name", direction: "asc" }]);

    await crud.findMany();
    expect(adapter.lastQuery?.sort).toEqual([]);
  });

  it("rejects a per-call defaults.sort field outside the sortable allowlist", async () => {
    const { crud } = makeCrud();
    await expect(
      crud.findMany(undefined, {
        settings: { defaults: { sort: ["notAColumn"] } },
      }),
    ).rejects.toBeInstanceOf(ConfigurationException);
  });

  it("raises OperationDisabledException for operations off by default", async () => {
    const { crud } = makeCrud();
    // `restoreOne` stays off until the entity config declares soft delete.
    await expect(crud.restoreOne(1)).rejects.toBeInstanceOf(OperationDisabledException);
  });

  it("raises OperationDisabledException for config-disabled operations", async () => {
    const { crud } = makeCrud({ operations: { createOne: true } } as never);
    await expect(crud.deleteOne(1)).rejects.toBeInstanceOf(OperationDisabledException);
  });

  it("names the config key that would switch a disabled operation back on", async () => {
    const { crud } = makeCrud({ operations: { createOne: true } } as never);
    await expect(crud.deleteOne(1)).rejects.toMatchObject({
      code: "KAVO_OPERATION_DISABLED",
      messageParams: { operation: "deleteOne", entity: "User" },
    });
    await expect(crud.deleteOne(1)).rejects.toThrow("operations.deleteOne");
  });

  it("does not send a restoreOne caller toward a config that fails to boot", async () => {
    // `restoreOne` is disabled here because `User` is not soft-deletable,
    // and `requireSoftDeletable` rejects `operations.restoreOne = true` on a
    // hard-delete entity at bootstrap. Naming the flag without the
    // prerequisite would turn a 405 into an app that no longer starts.
    const { crud } = makeCrud();
    await expect(crud.restoreOne(1)).rejects.toThrow("also need the entity to be soft-deletable");
  });

  it("separates an unregistered operation from a disabled one (issue #7)", async () => {
    // Both are 405, but "disabled" is a lie about an id the registry never
    // had — and `messageKey` is the code, so a localizing consumer would
    // re-render that lie. Unreachable over HTTP (no route is generated for
    // an id the registry does not hold), so only this path can prove it.
    const { crud } = makeCrud();
    await expect(crud.engine.execute(unregisteredRequest())).rejects.toMatchObject({
      code: "KAVO_OPERATION_NOT_REGISTERED",
      status: 405,
      context: { entityName: "User", operation: "findAll" },
    });
  });

  it("lists what a caller could have called instead", async () => {
    const { crud } = makeCrud();
    try {
      await crud.engine.execute(unregisteredRequest());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OperationNotRegisteredException);
      const { detail } = error as OperationNotRegisteredException;
      expect(detail).toContain("Registered operations:");
      expect(detail).toContain("findMany");
      expect(detail).not.toContain("disabled");
    }
  });

  it("dispatches overridden handlers through the same pipeline", async () => {
    const { crud } = makeCrud({
      operations: {
        findOne: {
          enabled: true,
          handler: {
            async execute() {
              return Object.assign(new User(), { id: 42, name: "override" });
            },
          },
        },
      },
    } as never);
    const found = await crud.findOne(42);
    expect(found).toMatchObject({ id: 42, name: "override" });
  });

  it("maps NotFound into a problem-details document", async () => {
    const { crud } = makeCrud();
    try {
      await crud.findOne(123);
      expect.unreachable();
    } catch (error) {
      const problem = toProblemDetails(error as never);
      expect(problem).toMatchObject({
        status: 404,
        code: "KAVO_NOT_FOUND",
        type: "https://kavo.dev/errors/kavo-not-found",
      });
      expect(problem.detail).toContain("123");
      expect(problem.instance).toMatch(/^urn:kavo:request:/);
    }
  });

  it("exposes the debug dump through kavo.describe", () => {
    const { kavo } = makeCrud();
    const dump = kavo.describe("User");
    expect(dump).toMatchObject({ entityName: "User" });
  });
});

describe("KavoEngine — per-operation DTO override (issue #131)", () => {
  it("deserializes createOne's body through its own input override, ahead of the root 'create' slot", async () => {
    class RootCreateDto {
      name = "";
      email = "";
      age = 0;
    }
    class CreateUserRequestDto {
      name = "";
      email = "";
      // No `age` field — this DTO's runtime key set is what the
      // deserializer projects onto, so a client-sent `age` is dropped even
      // though the root `create` DTO carries it.
    }
    const { crud } = makeCrud({
      dto: { create: RootCreateDto },
      operations: { createOne: { enabled: true, dto: { input: CreateUserRequestDto } } },
    } as never);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(created).toMatchObject({ name: "Ada", email: "a@x.io" });
  });

  it("serializes findOne's response through its own output override, independent of createOne's", async () => {
    class UserProfileDto {
      id = 0;
      name = "";
    }
    class UserCreatedDto {
      id = 0;
      email = "";
    }
    const { crud } = makeCrud({
      operations: {
        findOne: { enabled: true, dto: { output: UserProfileDto } },
        createOne: { enabled: true, dto: { output: UserCreatedDto } },
      },
    } as never);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(Object.keys(created as object)).toEqual(["id", "email"]);

    const found = await crud.findOne(1);
    expect(Object.keys(found as object)).toEqual(["id", "name"]);
  });

  it("serializes findMany's list element through its own output override", async () => {
    class UserListItemDto {
      id = 0;
    }
    const { crud } = makeCrud({
      operations: { createOne: true, findMany: { enabled: true, dto: { output: UserListItemDto } } },
    } as never);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    const list = await crud.findMany();
    expect(Object.keys(list.items[0] as object)).toEqual(["id"]);
  });

  it("serializes restoreOne's response through its own output override", async () => {
    class AccountProfileDto {
      id = 0;
      name = "";
    }
    const adapter = new InMemoryAccountAdapter();
    const crud = createKavo().createCrud(
      Account,
      {
        operations: {
          createOne: true,
          deleteOne: true,
          restoreOne: { enabled: true, dto: { output: AccountProfileDto } },
        },
      } as never,
      { adapter, metadata: accountMetadata },
    );
    await crud.createOne({ name: "Acme" } as never);
    await crud.deleteOne(1);
    const restored = await crud.restoreOne(1);
    expect(Object.keys(restored as object)).toEqual(["id", "name"]);
  });

  it("falls back to the root dto slot when an operation declares no override", async () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    class UserCreatedDto {
      id = 0;
      email = "";
    }
    const { crud } = makeCrud({
      dto: { item: UserItemDto },
      operations: { findOne: true, createOne: { enabled: true, dto: { output: UserCreatedDto } } },
    } as never);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(Object.keys(created as object)).toEqual(["id", "email"]);

    // `findOne` declared no override, so it still gets the root `item` slot.
    const found = await crud.findOne(1);
    expect(Object.keys(found as object)).toEqual(["id", "name"]);
  });

  it("rejects a dto override that doesn't apply to that operation, at createCrud (bootstrap)", () => {
    class Bogus {}
    expect(() => makeCrud({ operations: { deleteOne: { dto: { output: Bogus } } } } as never)).toThrowError(
      ConfigurationException,
    );
  });

  it("treats an explicitly undefined dto key as unset, not as an inapplicable override", () => {
    // The counterpart of the rejection above, and what makes it safe to
    // build an entity config by spreading optional values: `deleteOne`
    // permits no `dto` fields at all, yet `{ output: undefined }` states
    // no opinion rather than stating a wrong one.
    expect(() => makeCrud({ operations: { deleteOne: { dto: { output: undefined } } } } as never)).not.toThrow();
  });
});

describe("KavoEngine — custom operations", () => {
  /** Registers a custom operation and captures what its handler received. */
  function withArchive(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
    const { crud, adapter } = makeCrud(config);
    const seen: unknown[] = [];
    crud.engine.registry.register({
      id: "archiveOne",
      kind: "write",
      cardinality: "one",
      enabled: true,
      handler: {
        async execute(input: unknown) {
          seen.push(input);
          return null;
        },
      },
      input: null,
      output: null,
      meta: {},
    } as never);
    return { crud, adapter, seen };
  }

  it("hands a custom operation invoked without an id the bare body", async () => {
    // The body is deserialized through the resolved DTO first, the same as
    // any standard write, so it arrives projected onto entity columns.
    const { crud, seen } = withArchive();
    await crud.engine.execute({ operation: "archiveOne", id: null, body: { name: "Ada" } } as never);
    expect(seen[0]).toEqual({ name: "Ada" });
  });

  it("hands a custom operation invoked with an id both halves, with the id coerced", async () => {
    // A custom route whose path carries `:id` passes the segment through as
    // a string; the engine coerces it against the id column's kind, so the
    // handler sees `7`, not `"7"`.
    const { crud, seen } = withArchive();
    await crud.engine.execute({ operation: "archiveOne", id: "7", body: { name: "Ada" } } as never);
    expect(seen[0]).toEqual({ id: 7, body: { name: "Ada" } });
  });
});

describe("KavoEngine — custom operations declared in config (issue #145)", () => {
  /**
   * The motivating shape: one `operations` key outside the standard eight,
   * carrying a handler and a route. Nothing here reaches the registry
   * directly — the config is the whole surface.
   */
  function withPromote(
    entry: Record<string, unknown>,
    seen: { input?: unknown; operation?: string; hasQuery?: boolean } = {},
  ) {
    const { crud, adapter } = makeCrud({
      operations: {
        createOne: true,
        promoteOne: {
          handler: {
            async execute(input: unknown, context: KavoContext<User>) {
              seen.input = input;
              seen.operation = context.operation;
              seen.hasQuery = context.query !== null;
              return adapter.rows[0] ?? null;
            },
          },
          ...entry,
        },
      },
    } as never);
    return { crud, adapter, seen };
  }

  it("runs a config-declared custom operation through the typed service surface", async () => {
    const { crud, seen } = withPromote({});
    await crud.createOne({ name: "Ada", email: "ada@x.io", age: 36 } as never);

    const promoted = await crud.run("promoteOne", { id: 1, body: { name: "Ada L" } } as never);

    expect(seen).toMatchObject({ operation: "promoteOne", hasQuery: false });
    expect(seen.input).toEqual({ id: 1, body: { name: "Ada L" } });
    // The result is serialized through the `item` slot, like any single-row
    // response — a custom operation gets the whole pipeline, not a bypass.
    expect(promoted).toMatchObject({ id: 1, name: "Ada" });
  });

  it("runs query resolution for a custom read, and hands it no body", async () => {
    const { crud, seen } = withPromote({ kind: "read" });
    await crud.createOne({ name: "Ada", email: "ada@x.io", age: 36 } as never);

    await crud.run("promoteOne", { id: 1, query: { select: ["name"] } } as never);

    expect(seen).toMatchObject({ hasQuery: true });
    // A read has no request body to deserialize; its input is the target id.
    expect(seen.input).toBe(1);
  });

  it("maps a many-cardinality custom operation through the list envelope", async () => {
    // `mapResponse` branches on the descriptor's cardinality, not on the
    // literal id `findMany`, so a custom list operation gets the same
    // envelope and the same `list` DTO projection.
    const rows: User[] = [];
    const { crud } = makeCrud({
      operations: {
        findRecentMany: {
          kind: "read",
          cardinality: "many",
          handler: {
            async execute() {
              return { entities: rows, total: rows.length };
            },
          },
        },
      },
    } as never);
    rows.push(Object.assign(new User(), { id: 1, name: "Ada" }));

    const list = await crud.run("findRecentMany");

    expect(list).toMatchObject({ items: [expect.objectContaining({ name: "Ada" })], total: 1, offset: 0 });
  });

  describe("a result the entity projection empties (#181)", () => {
    /** A handler returning a shape with no field in common with `User`. */
    function withShape(result: unknown, entry: Record<string, unknown> = {}) {
      const { crud, adapter } = makeCrud({
        operations: {
          probeOne: {
            handler: {
              async execute() {
                return result;
              },
            },
            ...entry,
          },
        },
      } as never);
      return { crud, adapter };
    }

    it("refuses rather than serving {}", async () => {
      // The silent version of this shipped `{}` with a 201, and the static
      // types disagreed with it: `CustomOperationResult` types `run`'s
      // return as the handler's own return type when no `dto.output` is
      // declared, so the signature promised `{ probed, checkedAt }` while
      // the wire served nothing at all.
      const { crud } = withShape({ probed: true, checkedAt: "now" });
      await expect(crud.run("probeOne")).rejects.toBeInstanceOf(ConfigurationException);
    });

    it("names the operation, what it returned, and dto.output as the fix", async () => {
      const { crud } = withShape({ probed: true, checkedAt: "now" });
      const error = (await crud.run("probeOne").catch((thrown: unknown) => thrown)) as ConfigurationException;

      expect(error.code).toBe("KAVO_CONFIG_INVALID");
      expect(error.messageParams).toMatchObject({ entity: "User", path: "operations.probeOne.dto.output" });
      expect(error.message).toContain("keys are checkedAt, probed");
      expect(error.message).toContain("dto: { output:");
    });

    it("leaves a genuine narrowing alone", async () => {
      // A subset of the entity's fields is exactly what the projection is
      // for. Only zero intersection is a mistake.
      const { crud } = withShape({ id: 7, name: "Ada" });
      expect(await crud.run("probeOne")).toEqual({ id: 7, name: "Ada" });
    });

    it("leaves a registered dto.output alone", async () => {
      class ProbeResultDto {
        probed = false;
        checkedAt = "";
      }
      const { crud } = withShape({ probed: true, checkedAt: "now" }, { dto: { output: ProbeResultDto } });
      expect(await crud.run("probeOne")).toEqual({ probed: true, checkedAt: "now" });
    });

    it("leaves a void result alone", async () => {
      const { crud } = withShape(null);
      await expect(crud.run("probeOne")).resolves.toBeNull();
    });

    it("does not blame the operation when it was select= that emptied the projection", async () => {
      // A sparse fieldset can empty a projection on its own, and the message
      // would then point at a `dto.output` that is not the problem. The
      // client's request is the mistake here, and the operation trips the
      // real guard the moment the fieldset comes off.
      const { crud } = withShape({ id: 7, name: "Ada" }, { kind: "read" });
      expect(await crud.run("probeOne", { query: { select: ["email"] } } as never)).toEqual({});
    });

    it("checks a many-cardinality operation on its first row", async () => {
      const { crud } = makeCrud({
        operations: {
          probeMany: {
            kind: "read",
            cardinality: "many",
            handler: {
              async execute() {
                return { entities: [{ probed: true }], total: 1 };
              },
            },
          },
        },
      } as never);

      const error = (await crud.run("probeMany").catch((thrown: unknown) => thrown)) as ConfigurationException;
      expect(error).toBeInstanceOf(ConfigurationException);
      // "the first row", not "every row": the check reads index 0 only, and
      // the message must not claim more than it verified.
      expect(error.message).toContain("the first row of the list");
      expect(error.messageParams).toMatchObject({ path: "operations.probeMany.dto.output" });
    });

    it("names the registered DTO, not the entity, when the DTO is what emptied the result", async () => {
      // The message used to send an author who had already declared
      // `dto.output` back to declare `dto.output`. With one registered, the
      // entity's fields are irrelevant — the projection is the DTO's keys.
      class OutcomeDto {
        applied = 0;
        skus: string[] = [];
      }
      const { crud } = withShape({ appliedCount: 3, skuList: ["a"] }, { dto: { output: OutcomeDto } });
      const error = (await crud.run("probeOne").catch((thrown: unknown) => thrown)) as ConfigurationException;

      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error.message).toContain("registered 'OutcomeDto'");
      expect(error.message).toContain("applied, skus");
      expect(error.message).not.toContain("declare 'dto: { output:");
    });

    it("names the missing initializers when a registered DTO has no runtime shape", async () => {
      // The declared-only DTO `@kavo/nest` supports on purpose, so Swagger's
      // own decorators can answer. The projection falls back to the entity,
      // and the fault is the erased fields rather than a missing DTO.
      class DeclaredOnlyDto {
        declare applied: number;
      }
      const { crud } = withShape({ applied: 3 }, { dto: { output: DeclaredOnlyDto } });
      const error = (await crud.run("probeOne").catch((thrown: unknown) => thrown)) as ConfigurationException;

      expect(error.message).toContain("'DeclaredOnlyDto' declares no runtime fields");
      expect(error.message).toContain("give each field an initializer".replace("give", "Give"));
    });

    it("refuses a class instance whose fields are accessors", async () => {
      // `Object.keys` never sees a prototype getter, but the serializer
      // emits with `key in source` and does — so this shape slipped through
      // the first cut of the guard and served {} exactly as #181 reports.
      class Outcome {
        get applied(): number {
          return 3;
        }
      }
      const { crud } = withShape(new Outcome());
      await expect(crud.run("probeOne")).rejects.toBeInstanceOf(ConfigurationException);
    });

    it("refuses a non-empty array from a cardinality-one operation", async () => {
      // What a handler that meant `cardinality: "many"` and left it at the
      // default returns. It projected to {} in silence.
      const { crud } = withShape([{ applied: 1 }, { applied: 2 }]);
      const error = (await crud.run("probeOne").catch((thrown: unknown) => thrown)) as ConfigurationException;

      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error.message).toContain('cardinality: "many"');
    });

    it("leaves an empty list alone — there is no row to judge", async () => {
      const { crud } = makeCrud({
        operations: {
          probeMany: {
            kind: "read",
            cardinality: "many",
            handler: {
              async execute() {
                return { entities: [], total: 0 };
              },
            },
          },
        },
      } as never);
      expect(await crud.run("probeMany")).toMatchObject({ items: [], total: 0 });
    });

    it("leaves a standard operation alone, whatever its handler returns", async () => {
      // A standard operation's result *is* the entity by contract, so an
      // empty projection there is a different bug and `dto.output` is not
      // its fix. Scoping the guard is what keeps the message honest.
      const { crud } = makeCrud({
        operations: {
          findOne: {
            enabled: true,
            handler: {
              async execute() {
                return { unrelated: true } as never;
              },
            },
          },
        },
      } as never);
      await expect(crud.findOne(1)).resolves.toEqual({});
    });
  });

  it("raises OperationDisabledException for a custom operation switched off", async () => {
    const { crud } = withPromote({ enabled: false });
    await expect(crud.run("promoteOne")).rejects.toBeInstanceOf(OperationDisabledException);
  });

  it("still raises OperationNotRegisteredException for an id nothing declared", async () => {
    const { crud } = withPromote({});
    await expect(crud.run("demoteOne")).rejects.toBeInstanceOf(OperationNotRegisteredException);
  });

  it("applies per-operation settings to a custom operation like any other", async () => {
    // `resolveEntityConfig` walks `operations` by key, so the operation
    // scope of the precedence chain reaches a custom id for free.
    let observed: boolean | undefined;
    const { crud } = makeCrud({
      operations: {
        promoteOne: {
          cache: { etag: false },
          handler: {
            async execute(_input: unknown, context: KavoContext<User>) {
              observed = isEtagEnabled(context.config.settings.cache);
              return null;
            },
          },
        },
      },
    } as never);

    await crud.run("promoteOne");

    expect(observed).toBe(false);
  });

  it("deserializes the body through a declared input DTO", async () => {
    class PromoteUserDto {
      name = "";
    }
    let received: unknown;
    const { crud } = makeCrud({
      operations: {
        promoteOne: {
          dto: { input: PromoteUserDto },
          handler: {
            async execute(input: unknown) {
              received = input;
              return null;
            },
          },
        },
      },
    } as never);

    await crud.run("promoteOne", { body: { name: "Ada", age: 99 } } as never);

    // `age` is outside the declared DTO's shape, so it never reaches the
    // handler — the same projection every standard write gets.
    expect(received).toEqual({ name: "Ada" });
  });
});

describe("KavoEngine — the per-call config view", () => {
  it("answers settingsFor with the per-call settings, whichever operation is named", async () => {
    // The merge already happened at the requested operation's scope, so the
    // view's `settingsFor` is a constant function. Pinning that keeps a
    // caller from believing it re-resolves per operation.
    let observed: unknown;
    const { crud } = makeCrud({
      operations: {
        findMany: {
          enabled: true,
          handler: {
            async execute(
              _input: unknown,
              context: { config: { settingsFor(id: string): { pagination: { count: boolean } } } },
            ) {
              observed = {
                own: context.config.settingsFor("findMany").pagination.count,
                other: context.config.settingsFor("findOne").pagination.count,
              };
              return { entities: [], total: null };
            },
          },
        },
      },
    } as never);

    await crud.findMany(undefined, { settings: { pagination: { count: false } } } as never);

    expect(observed).toEqual({ own: false, other: false });
  });
});
