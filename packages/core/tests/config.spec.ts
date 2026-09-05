import { describe, expect, it } from "vitest";
import { BUILT_IN_DEFAULTS, ConfigurationException, createKavo, mergeSettings, resolveEntityConfig } from "@kavo/core";
import { User, userMetadata } from "./support/user-fixture.js";
import { authorMetadata, postMetadata } from "./support/blog-fixture.js";

describe("mergeSettings — merge algebra", () => {
  it("replaces scalars key-by-key, nearer scope wins", () => {
    const merged = mergeSettings(
      BUILT_IN_DEFAULTS,
      { pagination: { defaultLimit: 10 } },
      { pagination: { maxLimit: 50 } },
    );
    expect(merged.pagination.defaultLimit).toBe(10);
    expect(merged.pagination.maxLimit).toBe(50);
    // Untouched keys keep the farther scope's values.
    expect(merged.pagination.strategy).toBe("offset");
  });

  it("skips a key whose override value is explicitly undefined", () => {
    // This is what makes it safe for a framework layer to spread an
    // options object with optional keys into a settings override: an
    // absent option must not erase the scope above it. `false` still
    // disables (see the next test); only `undefined` means "no opinion".
    const merged = mergeSettings(BUILT_IN_DEFAULTS, { pagination: { count: undefined } });
    expect(merged.pagination.count).toBe(BUILT_IN_DEFAULTS.pagination.count);
  });

  it("distinguishes an undefined override from a false one", () => {
    expect(mergeSettings(BUILT_IN_DEFAULTS, { pagination: { count: undefined } }).pagination.count).toBe(true);
    expect(mergeSettings(BUILT_IN_DEFAULTS, { pagination: { count: false } }).pagination.count).toBe(false);
  });

  it("lets `false` disable an inheritable feature", () => {
    const merged = mergeSettings(BUILT_IN_DEFAULTS, { softDelete: false });
    expect(merged.softDelete).toBe(false);
    // …and a nearer object re-enables it.
    const reEnabled = mergeSettings(merged, { softDelete: { field: "removedAt" } });
    expect(reEnabled.softDelete).toEqual({ field: "removedAt" });
  });

  it("skips undefined scopes", () => {
    const merged = mergeSettings(BUILT_IN_DEFAULTS, undefined, {
      errors: { exposeInternals: true },
    });
    expect(merged.errors.exposeInternals).toBe(true);
  });
});

describe("resolveEntityConfig — bootstrap", () => {
  it("resolves the zero-config path on built-in defaults", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    expect(config.entityName).toBe("User");
    expect(config.settings.pagination.defaultLimit).toBe(20);
    // Field-group `fields` derive from own scalar columns.
    expect(config.filter.fields).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
  });

  it("applies the precedence chain global → entity → operation", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        pagination: { defaultLimit: 5 },
        operations: { findMany: { pagination: { defaultLimit: 3 } } },
      },
      { pagination: { defaultLimit: 10, maxLimit: 50 } },
    );
    expect(config.settings.pagination.defaultLimit).toBe(5); // entity beats global
    expect(config.settings.pagination.maxLimit).toBe(50); // global beats built-in
    expect(config.settingsFor("findMany").pagination.defaultLimit).toBe(3);
    expect(config.settingsFor("findOne").pagination.defaultLimit).toBe(5);
  });

  it("freezes the resolved settings", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    expect(Object.isFrozen(config.settings)).toBe(true);
    expect(Object.isFrozen(config.settings.pagination)).toBe(true);
  });

  it("fails fast naming entity, key path, and offending value", () => {
    expect(() => resolveEntityConfig(userMetadata, { pagination: { maxLimit: -1 } }, undefined)).toThrowError(
      ConfigurationException,
    );
    try {
      resolveEntityConfig(userMetadata, { pagination: { maxLimit: -1 } }, undefined);
    } catch (error) {
      const detail = (error as ConfigurationException).detail;
      expect(detail).toContain("User");
      expect(detail).toContain("pagination.maxLimit");
      expect(detail).toContain("-1");
    }
  });

  it("rejects defaultLimit above maxLimit", () => {
    expect(() => resolveEntityConfig(userMetadata, { pagination: { defaultLimit: 200 } }, undefined)).toThrowError(
      /exceeds maxLimit/,
    );
  });

  it("uses explicit field lists verbatim when configured", () => {
    const config = resolveEntityConfig(userMetadata, { filter: { fields: ["name", "age"] } }, undefined);
    expect(config.filter.fields).toEqual(["name", "age"]);
    // Unconfigured lists still derive.
    expect(config.sort.fields).toContain("email");
  });

  // Issue #367 finding 1: `filter.fields`/`sort.fields` feed `@kavo/typeorm`'s
  // raw SQL identifier interpolation, so an explicit array override — used
  // verbatim, unlike `{ exclude }` — is validated at bootstrap rather than
  // trusted blindly.
  describe("validates explicit filter.fields/sort.fields entries (issue #367)", () => {
    it.each(["filter", "sort"] as const)(
      "rejects a bare %s.fields entry that names no real column, relation, or computed field",
      (block) => {
        let caught: unknown;
        try {
          resolveEntityConfig(userMetadata, { [block]: { fields: ["notAColumn"] } }, undefined);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigurationException);
        expect((caught as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
        expect((caught as ConfigurationException).message).toContain("'notAColumn' is not a column on 'User'");
      },
    );

    it.each(["filter", "sort"] as const)(
      "rejects a %s.fields entry whose relation path carries a non-identifier segment",
      (block) => {
        for (const poisoned of [
          "profile.city; DROP TABLE users; --",
          "profile.`city`",
          "profile. city",
          "profile.city.$where",
        ]) {
          let caught: unknown;
          try {
            resolveEntityConfig(userMetadata, { [block]: { fields: [poisoned] } }, undefined);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(ConfigurationException);
          expect((caught as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
          expect((caught as ConfigurationException).message).toContain("is not a valid relation path");
        }
      },
    );

    it.each(["filter", "sort"] as const)("accepts a well-formed relation-path %s.fields entry", (block) => {
      expect(() =>
        resolveEntityConfig(userMetadata, { [block]: { fields: ["profile.city"] } }, undefined),
      ).not.toThrow();
    });

    it.each(["filter", "sort"] as const)(
      "accepts a bare relation name as a %s.fields entry (e.g. filtering a to-one relation's FK directly)",
      (block) => {
        const metadata = {
          ...userMetadata,
          relations: [{ name: "posts", target: () => class {}, cardinality: "one", includable: false }],
        } as unknown as typeof userMetadata;
        expect(() => resolveEntityConfig(metadata, { [block]: { fields: ["posts"] } }, undefined)).not.toThrow();
      },
    );

    it("still lets { exclude } through unchecked, same as before (it only subtracts from known-safe own columns)", () => {
      const notAColumn = "notAColumn" as unknown as keyof User;
      expect(() =>
        resolveEntityConfig(userMetadata, { filter: { fields: { exclude: [notAColumn] } } }, undefined),
      ).not.toThrow();
    });
  });

  it("resolves { exclude } to every own column except the ones named", () => {
    const config = resolveEntityConfig(userMetadata, { filter: { fields: { exclude: ["email"] } } }, undefined);
    expect(config.filter.fields).toEqual(["id", "name", "age", "status", "createdAt"]);
    // Unconfigured lists still derive in full.
    expect(config.sort.fields).toContain("email");
  });

  it("never lets { exclude } surface a column outside own columns", () => {
    // A name that isn't an own column is a no-op to exclude — the result
    // stays a subset of own columns, never an arbitrary string added in.
    const notAColumn = "notAColumn" as unknown as keyof User;
    const config = resolveEntityConfig(userMetadata, { filter: { fields: { exclude: [notAColumn] } } }, undefined);
    expect(config.filter.fields).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
  });

  it("resolves { exclude } independently for sort and select too", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        sort: { fields: { exclude: ["status"] } },
        select: { fields: { exclude: ["age", "status"] } },
      },
      undefined,
    );
    expect(config.sort.fields).toEqual(["id", "name", "email", "age", "createdAt"]);
    expect(config.select.fields).toEqual(["id", "name", "email", "createdAt"]);
    // Unconfigured filter.fields still derives in full.
    expect(config.filter.fields).toContain("status");
  });

  it("defaults search.fields to every own string-kind column, unlike filter.fields's every-column default", () => {
    const config = resolveEntityConfig(userMetadata, { search: {} }, undefined);
    // `age` (number), `status` (enum), `createdAt` (date), `id` (number) are
    // excluded — only `name`/`email` are string-kind.
    expect(config.search !== false && config.search.fields).toEqual(["name", "email"]);
    expect(config.filter.fields).toContain("age");
  });

  it("uses an explicit search.fields array verbatim, including a relation path", () => {
    const config = resolveEntityConfig(
      authorMetadata,
      { search: { fields: ["name", "posts.title" as never] } },
      undefined,
    );
    expect(config.search !== false && config.search.fields).toEqual(["name", "posts.title"]);
  });

  it("resolves search.fields { exclude } against the string-column base, not every column", () => {
    const config = resolveEntityConfig(userMetadata, { search: { fields: { exclude: ["email"] } } }, undefined);
    expect(config.search !== false && config.search.fields).toEqual(["name"]);
  });

  it("rejects a computed field named in search.fields", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          search: { fields: ["fullName" as never] },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "search.fields",
      });
      expect((error as ConfigurationException).message).toContain("searched on");
    }
  });

  it("rejects an explicit search.fields entry naming a non-string own column", () => {
    try {
      resolveEntityConfig(userMetadata, { search: { fields: ["age" as never] } }, undefined);
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "search.fields",
      });
      expect((error as ConfigurationException).message).toContain("'number'-kind");
    }
  });

  it("does not kind-check a relation-path search.fields entry (no target metadata in scope)", () => {
    // `posts.authorId` is a number-kind column on the relation target, not
    // on `Author` itself — unreachable from `Author`'s own `metadata.fields`,
    // so it is accepted verbatim rather than rejected, the same laxity
    // `filter.fields`/`sort.fields` already have for relation paths.
    const config = resolveEntityConfig(
      authorMetadata,
      { search: { fields: ["posts.authorId" as never] } },
      undefined,
    );
    expect(config.search !== false && config.search.fields).toEqual(["posts.authorId"]);
  });

  it("defaults create/update's writable projection to every non-generated own column except the id, plus every relation", () => {
    const config = resolveEntityConfig(postMetadata, undefined, undefined);
    // No `dto.create`/`dto.update` shorthand configured, so the engine falls
    // back to `DefaultDeserializer`'s own derived writable projection: `id`
    // (generated, and the primary key regardless) and `deletedAt`
    // (generated) are excluded; `title`/`authorId` and both relations join
    // the default.
    expect(config.dto.resolve("create", "createOne")).toBeNull();
    expect(config.dto.resolve("update", "updateOne")).toBeNull();
  });

  it("reaches creatable/updatable through dto.create/dto.update's { fields } shorthand", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { dto: { create: { fields: ["name"] }, update: { fields: ["name", "email"] } } },
      undefined,
    );
    const createDto = config.dto.resolve("create", "createOne");
    const updateDto = config.dto.resolve("update", "updateOne");
    expect(createDto).not.toBeNull();
    expect(updateDto).not.toBeNull();
    expect(Object.keys(new (createDto as new () => object)())).toEqual(["name"]);
    expect(Object.keys(new (updateDto as new () => object)())).toEqual(["name", "email"]);
    // Unconfigured field-groups still derive.
    expect(config.filter.fields).toContain("age");
  });

  it("rejects a computed field named in dto.create's or dto.update's { fields } shorthand", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          dto: { create: { fields: ["fullName" as never] } },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).message).toContain("computed field");
    }
  });

  it("resolves an entity-scope sort.default", () => {
    const config = resolveEntityConfig(userMetadata, { sort: { default: ["-createdAt"] } }, undefined);
    expect(config.sortDefault).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("rejects an entity-scope sort.default field outside sort.fields", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          sort: { fields: ["name"], default: ["email"] },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).detail).toContain("email");
    }
  });

  it("rejects an include.default entry absent from include.fields", () => {
    try {
      resolveEntityConfig(
        authorMetadata,
        {
          include: { default: ["posts"] },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "include.default",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });
});

/** ADR-0028: `include.default` vs. permission is cross-checked against `include.fields`. */
describe("resolveEntityConfig — include.fields", () => {
  it("rejects include.default on a relation absent from include.fields", () => {
    try {
      resolveEntityConfig(authorMetadata, { include: { default: ["posts"] } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "include.default",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });

  it("accepts include.default on a relation include.fields named", () => {
    expect(() =>
      resolveEntityConfig(
        authorMetadata,
        {
          include: { fields: ["posts"], default: ["posts"] },
          relations: { edges: { posts: { maxDepth: 1 } } },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("fails fast on a typo'd relation name in include.fields", () => {
    try {
      resolveEntityConfig(authorMetadata, { include: { fields: ["ghosts" as never] } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "include.fields",
      });
    }
  });

  it("fails fast on a typo'd relation name in include.fields's { exclude } form", () => {
    // Unlike `resolveFieldSelector`'s `{ exclude }` (filter/sort/select),
    // which silently excludes nothing on a name that matches nothing,
    // `include.fields`'s `{ exclude }` checks its own names — a typo here
    // would otherwise open every relation instead of leaving the intended
    // one closed, the opposite of what the author wrote.
    try {
      resolveEntityConfig(authorMetadata, { include: { fields: { exclude: ["ptes" as never] } } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "include.fields.exclude",
      });
      expect((error as ConfigurationException).detail).toContain("ptes");
    }
  });

  it("defaults to no relation includable when the key is unconfigured (opt-in, unlike the other field-groups)", () => {
    const config = resolveEntityConfig(authorMetadata, undefined, undefined);
    expect(config.include.fields).toEqual([]);
    expect(config.relations.get("posts")?.includable).toBe(false);
  });

  it("opts every own relation in via an explicit { exclude: [] }", () => {
    const config = resolveEntityConfig(authorMetadata, { include: { fields: { exclude: [] } } }, undefined);
    expect(config.include.fields).toEqual(["posts"]);
  });
});

describe("User fixture sanity", () => {
  it("has runtime shape (initialized fields)", () => {
    expect(Object.keys(new User())).toContain("email");
  });
});

/**
 * Issue #7: a bootstrap failure has to name the call that fixes it,
 * including for the framework the developer is actually holding — the core
 * message named only the core API, which is not what a Nest app wrote.
 */
describe("bootstrap wiring errors", () => {
  const detailOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      return (error as ConfigurationException).detail;
    }
    throw new Error("expected ConfigurationException");
  };

  it("names both the core and the NestJS entry point when metadata is missing", () => {
    const detail = detailOf(() => createKavo().createCrud(User));
    expect(detail).toContain("createKavo");
    expect(detail).toContain("createInfrastructure(dataSource)");
    expect(detail).toContain("KavoModule.forRoot({ infrastructure })");
  });

  it("names them again when only the adapter is missing", () => {
    const detail = detailOf(() => createKavo().createCrud(User, undefined, { metadata: userMetadata }));
    expect(detail).toContain("runtime.adapter");
    expect(detail).toContain("KavoModule.forRoot({ infrastructure })");
  });

  it("never reports a configuration error against the entity named 'unknown'", () => {
    // The registry used to hardcode that literal, so every config error it
    // raised blamed an entity nobody had declared.
    const detail = detailOf(() =>
      createKavo().createCrud(User, { operations: { restoreOne: true } } as never, {
        metadata: userMetadata,
        adapter: {} as never,
      }),
    );
    expect(detail).toContain("User");
    expect(detail).not.toContain("'unknown'");
  });
});
