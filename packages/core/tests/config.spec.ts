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
    expect(merged.limits.filterDepth).toBe(3);
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
    // Allowed derive from own scalar columns.
    expect(config.allowed.filterable).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
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

  it("uses explicit allowlists verbatim when configured", () => {
    const config = resolveEntityConfig(userMetadata, { allowed: { filterable: ["name", "age"] } }, undefined);
    expect(config.allowed.filterable).toEqual(["name", "age"]);
    // Unconfigured lists still derive.
    expect(config.allowed.sortable).toContain("email");
  });

  // Issue #367 finding 1: `filterable`/`sortable` feed `@kavo/typeorm`'s raw
  // SQL identifier interpolation, so an explicit array override — used
  // verbatim, unlike `{ exclude }` — is validated at bootstrap rather than
  // trusted blindly.
  describe("validates explicit filterable/sortable entries (issue #367)", () => {
    it.each(["filterable", "sortable"] as const)(
      "rejects a bare %s entry that names no real column, relation, or computed field",
      (key) => {
        let caught: unknown;
        try {
          resolveEntityConfig(userMetadata, { allowed: { [key]: ["notAColumn"] } }, undefined);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigurationException);
        expect((caught as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
        expect((caught as ConfigurationException).message).toContain("'notAColumn' is not a column on 'User'");
      },
    );

    it.each(["filterable", "sortable"] as const)(
      "rejects a %s entry whose relation path carries a non-identifier segment",
      (key) => {
        for (const poisoned of [
          "profile.city; DROP TABLE users; --",
          "profile.`city`",
          "profile. city",
          "profile.city.$where",
        ]) {
          let caught: unknown;
          try {
            resolveEntityConfig(userMetadata, { allowed: { [key]: [poisoned] } }, undefined);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(ConfigurationException);
          expect((caught as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
          expect((caught as ConfigurationException).message).toContain("is not a valid relation path");
        }
      },
    );

    it.each(["filterable", "sortable"] as const)("accepts a well-formed relation-path %s entry", (key) => {
      expect(() =>
        resolveEntityConfig(userMetadata, { allowed: { [key]: ["profile.city"] } }, undefined),
      ).not.toThrow();
    });

    it.each(["filterable", "sortable"] as const)(
      "accepts a bare relation name as a %s entry (e.g. filtering a to-one relation's FK directly)",
      (key) => {
        const metadata = {
          ...userMetadata,
          relations: [{ name: "posts", target: () => class {}, cardinality: "one", includable: false }],
        } as unknown as typeof userMetadata;
        expect(() => resolveEntityConfig(metadata, { allowed: { [key]: ["posts"] } }, undefined)).not.toThrow();
      },
    );

    it("still lets { exclude } through unchecked, same as before (it only subtracts from known-safe own columns)", () => {
      const notAColumn = "notAColumn" as unknown as keyof User;
      expect(() =>
        resolveEntityConfig(userMetadata, { allowed: { filterable: { exclude: [notAColumn] } } }, undefined),
      ).not.toThrow();
    });
  });

  it("resolves { exclude } to every own column except the ones named", () => {
    const config = resolveEntityConfig(userMetadata, { allowed: { filterable: { exclude: ["email"] } } }, undefined);
    expect(config.allowed.filterable).toEqual(["id", "name", "age", "status", "createdAt"]);
    // Unconfigured lists still derive in full.
    expect(config.allowed.sortable).toContain("email");
  });

  it("never lets { exclude } surface a column outside own columns", () => {
    // A name that isn't an own column is a no-op to exclude — the result
    // stays a subset of own columns, never an arbitrary string added in.
    const notAColumn = "notAColumn" as unknown as keyof User;
    const config = resolveEntityConfig(userMetadata, { allowed: { filterable: { exclude: [notAColumn] } } }, undefined);
    expect(config.allowed.filterable).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
  });

  it("resolves { exclude } independently for sortable and selectable too", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        allowed: {
          sortable: { exclude: ["status"] },
          selectable: { exclude: ["age", "status"] },
        },
      },
      undefined,
    );
    expect(config.allowed.sortable).toEqual(["id", "name", "email", "age", "createdAt"]);
    expect(config.allowed.selectable).toEqual(["id", "name", "email", "createdAt"]);
    // Unconfigured filterable still derives in full.
    expect(config.allowed.filterable).toContain("status");
  });

  it("defaults searchable to every own string-kind column, unlike filterable's every-column default", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    // `age` (number), `status` (enum), `createdAt` (date), `id` (number) are
    // excluded — only `name`/`email` are string-kind.
    expect(config.allowed.searchable).toEqual(["name", "email"]);
    expect(config.allowed.filterable).toContain("age");
  });

  it("uses an explicit searchable array verbatim, including a relation path", () => {
    const config = resolveEntityConfig(
      authorMetadata,
      { allowed: { searchable: ["name", "posts.title" as never] } },
      undefined,
    );
    expect(config.allowed.searchable).toEqual(["name", "posts.title"]);
  });

  it("resolves searchable { exclude } against the string-column base, not every column", () => {
    const config = resolveEntityConfig(userMetadata, { allowed: { searchable: { exclude: ["email"] } } }, undefined);
    expect(config.allowed.searchable).toEqual(["name"]);
  });

  it("rejects a computed field named in allowed.searchable", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          allowed: { searchable: ["fullName" as never] },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowed.searchable",
      });
      expect((error as ConfigurationException).message).toContain("searched on");
    }
  });

  it("rejects an explicit searchable entry naming a non-string own column", () => {
    try {
      resolveEntityConfig(userMetadata, { allowed: { searchable: ["age" as never] } }, undefined);
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowed.searchable",
      });
      expect((error as ConfigurationException).message).toContain("'number'-kind");
    }
  });

  it("does not kind-check a relation-path searchable entry (no target metadata in scope)", () => {
    // `posts.authorId` is a number-kind column on the relation target, not
    // on `Author` itself — unreachable from `Author`'s own `metadata.fields`,
    // so it is accepted verbatim rather than rejected, the same laxity
    // `filterable`/`sortable` already have for relation paths.
    const config = resolveEntityConfig(
      authorMetadata,
      { allowed: { searchable: ["posts.authorId" as never] } },
      undefined,
    );
    expect(config.allowed.searchable).toEqual(["posts.authorId"]);
  });

  it("defaults creatable/updatable to every non-generated own column except the id, plus every relation", () => {
    const config = resolveEntityConfig(postMetadata, undefined, undefined);
    // `id` (generated, and the primary key regardless) and `deletedAt`
    // (generated) are excluded; `title`/`authorId` and both relations join
    // the default, the same base `DefaultDeserializer`'s own derived
    // writable projection uses.
    expect(config.allowed.creatable).toEqual(["title", "authorId", "author", "comments"]);
    expect(config.allowed.updatable).toEqual(["title", "authorId", "author", "comments"]);
  });

  it("uses explicit creatable/updatable arrays verbatim, independently of each other", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { allowed: { creatable: ["name"], updatable: ["name", "email"] } },
      undefined,
    );
    expect(config.allowed.creatable).toEqual(["name"]);
    expect(config.allowed.updatable).toEqual(["name", "email"]);
    // Unconfigured allowlists still derive.
    expect(config.allowed.filterable).toContain("age");
  });

  it("resolves creatable/updatable { exclude } against the writable base, not every column", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { allowed: { creatable: { exclude: ["age"] }, updatable: { exclude: ["status"] } } },
      undefined,
    );
    // `id`/`createdAt` are excluded from the base itself (generated/id), so
    // naming them in `exclude` would be a no-op either way.
    expect(config.allowed.creatable).toEqual(["name", "email", "status"]);
    expect(config.allowed.updatable).toEqual(["name", "email", "age"]);
  });

  it("rejects a computed field named in allowed.creatable or allowed.updatable", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          allowed: { creatable: ["fullName" as never] },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowed.creatable",
      });
      expect((error as ConfigurationException).message).toContain("never writable");
    }
  });

  it("resolves an entity-scope defaults.sort", () => {
    const config = resolveEntityConfig(userMetadata, { defaults: { sort: ["-createdAt"] } }, undefined);
    expect(config.settings.defaults.sort).toEqual(["-createdAt"]);
  });

  it("lets an operation override the entity-scope defaults.sort", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        defaults: { sort: ["-createdAt"] },
        operations: { findMany: { defaults: { sort: ["name"] } } },
      },
      undefined,
    );
    expect(config.settingsFor("findMany").defaults.sort).toEqual(["name"]);
    expect(config.settingsFor("findOne").defaults.sort).toEqual(["-createdAt"]);
  });

  it("applies the precedence chain global -> entity for defaults.sort", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { defaults: { sort: ["name"] } },
      { defaults: { sort: ["-createdAt"] } },
    );
    expect(config.settings.defaults.sort).toEqual(["name"]); // entity beats global

    const globalOnly = resolveEntityConfig(userMetadata, undefined, {
      defaults: { sort: ["-createdAt"] },
    });
    expect(globalOnly.settings.defaults.sort).toEqual(["-createdAt"]);
  });

  it("rejects an entity-scope defaults.sort field outside the sortable allowlist", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          allowed: { sortable: ["name"] },
          defaults: { sort: ["email"] },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).detail).toContain("email");
    }
  });

  it("rejects an operation-scope defaults.sort field outside the sortable allowlist", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          allowed: { sortable: ["name"] },
          operations: { findMany: { defaults: { sort: ["email"] } } },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).detail).toContain("email");
    }
  });

  it("rejects an operation-scope defaults.include on a relation absent from allowed.includable", () => {
    // `validateDefaults` runs for the per-operation settings view too, not
    // only entity scope — an operation override can name `defaults.include`
    // just as the entity config can.
    try {
      resolveEntityConfig(
        authorMetadata,
        {
          operations: { findMany: { defaults: { include: ["posts"] } } },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author.operations.findMany",
        path: "defaults.include",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });
});

/**
 * ADR-0028: `defaults.include` vs. permission is cross-checked against
 * `allowed.includable`, not `relations.edges`'s own (now-removed)
 * `includable` key — `validateDefaults` in resolve-entity-config.ts, run
 * after `allowed` is resolved.
 */
describe("resolveEntityConfig — allowed.includable", () => {
  it("rejects defaults.include on a relation absent from allowed.includable", () => {
    try {
      resolveEntityConfig(authorMetadata, { defaults: { include: ["posts"] } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "defaults.include",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });

  it("rejects defaults.include set at global scope when no entity opts the relation into allowed.includable", () => {
    // Migration hazard: `defaults.include` at global scope used to be safe
    // under the old `relations.edges.<name>.defaultInclude` — naming the
    // relation at all was the opt-in before this PR. It is not safe now:
    // `allowed.includable` is entity-scope-only, so a global
    // `defaults.include` with no matching entity grant is a bootstrap crash
    // on every entity sharing that relation name, not a silent no-op.
    // Pinning the crash here so a future change to this cross-check doesn't
    // silently turn it into the no-op adopters might expect.
    expect(() => resolveEntityConfig(authorMetadata, undefined, { defaults: { include: ["posts"] } })).toThrow(
      ConfigurationException,
    );
  });

  it("accepts defaults.include on a relation allowed.includable named", () => {
    expect(() =>
      resolveEntityConfig(
        authorMetadata,
        {
          allowed: { includable: ["posts"] },
          defaults: { include: ["posts"] },
          relations: { edges: { posts: { maxDepth: 1 } } },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("fails fast on a typo'd relation name in allowed.includable", () => {
    try {
      resolveEntityConfig(authorMetadata, { allowed: { includable: ["ghosts" as never] } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "allowed.includable",
      });
      expect((error as ConfigurationException).detail).toContain("ghosts");
    }
  });

  it("fails fast on a typo'd relation name in allowed.includable's { exclude } form", () => {
    // Unlike `resolveFieldSelector`'s `{ exclude }` (filterable/sortable/
    // selectable), which silently excludes nothing on a name that matches
    // nothing, `includable`'s `{ exclude }` checks its own names — a typo
    // here would otherwise open every relation instead of leaving the
    // intended one closed, the opposite of what the author wrote.
    try {
      resolveEntityConfig(authorMetadata, { allowed: { includable: { exclude: ["ptes" as never] } } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "allowed.includable.exclude",
      });
      expect((error as ConfigurationException).detail).toContain("ptes");
    }
  });

  it("defaults to no relation includable when the key is unconfigured (opt-in, unlike the other allowlists)", () => {
    const config = resolveEntityConfig(authorMetadata, undefined, undefined);
    expect(config.allowed.includable).toEqual([]);
    expect(config.relations.get("posts")?.includable).toBe(false);
  });

  it("opts every own relation in via an explicit { exclude: [] }", () => {
    const config = resolveEntityConfig(authorMetadata, { allowed: { includable: { exclude: [] } } }, undefined);
    expect(config.allowed.includable).toEqual(["posts"]);
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
