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
    expect(merged.query.maxFilterDepth).toBe(3);
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
    // Allowlists derive from own scalar columns.
    expect(config.allowlists.filterable).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
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
    const config = resolveEntityConfig(userMetadata, { allowlists: { filterable: ["name", "age"] } }, undefined);
    expect(config.allowlists.filterable).toEqual(["name", "age"]);
    // Unconfigured lists still derive.
    expect(config.allowlists.sortable).toContain("email");
  });

  // Issue #367 finding 1: `filterable`/`sortable` feed `@kavo/typeorm`'s raw
  // SQL identifier interpolation, so an explicit array override — used
  // verbatim, unlike `{ exclude }` — is validated at bootstrap rather than
  // trusted blindly.
  describe("validates explicit filterable/sortable entries (issue #367)", () => {
    it.each(["filterable", "sortable"] as const)(
      "rejects a bare %s entry that names no real column, relation, or computed field",
      (key) => {
        expect(() =>
          resolveEntityConfig(userMetadata, { allowlists: { [key]: ["notAColumn"] } }, undefined),
        ).toThrowError(/'notAColumn' is not a column on 'User'/);
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
          expect(() =>
            resolveEntityConfig(userMetadata, { allowlists: { [key]: [poisoned] } }, undefined),
          ).toThrowError(/is not a valid relation path/);
        }
      },
    );

    it.each(["filterable", "sortable"] as const)("accepts a well-formed relation-path %s entry", (key) => {
      expect(() =>
        resolveEntityConfig(userMetadata, { allowlists: { [key]: ["profile.city"] } }, undefined),
      ).not.toThrow();
    });

    it("still lets { exclude } through unchecked, same as before (it only subtracts from known-safe own columns)", () => {
      const notAColumn = "notAColumn" as unknown as keyof User;
      expect(() =>
        resolveEntityConfig(userMetadata, { allowlists: { filterable: { exclude: [notAColumn] } } }, undefined),
      ).not.toThrow();
    });
  });

  it("resolves { exclude } to every own column except the ones named", () => {
    const config = resolveEntityConfig(userMetadata, { allowlists: { filterable: { exclude: ["email"] } } }, undefined);
    expect(config.allowlists.filterable).toEqual(["id", "name", "age", "status", "createdAt"]);
    // Unconfigured lists still derive in full.
    expect(config.allowlists.sortable).toContain("email");
  });

  it("never lets { exclude } surface a column outside own columns", () => {
    // A name that isn't an own column is a no-op to exclude — the result
    // stays a subset of own columns, never an arbitrary string added in.
    const notAColumn = "notAColumn" as unknown as keyof User;
    const config = resolveEntityConfig(
      userMetadata,
      { allowlists: { filterable: { exclude: [notAColumn] } } },
      undefined,
    );
    expect(config.allowlists.filterable).toEqual(["id", "name", "email", "age", "status", "createdAt"]);
  });

  it("resolves { exclude } independently for sortable and selectable too", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        allowlists: {
          sortable: { exclude: ["status"] },
          selectable: { exclude: ["age", "status"] },
        },
      },
      undefined,
    );
    expect(config.allowlists.sortable).toEqual(["id", "name", "email", "age", "createdAt"]);
    expect(config.allowlists.selectable).toEqual(["id", "name", "email", "createdAt"]);
    // Unconfigured filterable still derives in full.
    expect(config.allowlists.filterable).toContain("status");
  });

  it("defaults searchable to every own string-kind column, unlike filterable's every-column default", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    // `age` (number), `status` (enum), `createdAt` (date), `id` (number) are
    // excluded — only `name`/`email` are string-kind.
    expect(config.allowlists.searchable).toEqual(["name", "email"]);
    expect(config.allowlists.filterable).toContain("age");
  });

  it("uses an explicit searchable array verbatim, including a relation path", () => {
    const config = resolveEntityConfig(
      authorMetadata,
      { allowlists: { searchable: ["name", "posts.title" as never] } },
      undefined,
    );
    expect(config.allowlists.searchable).toEqual(["name", "posts.title"]);
  });

  it("resolves searchable { exclude } against the string-column base, not every column", () => {
    const config = resolveEntityConfig(userMetadata, { allowlists: { searchable: { exclude: ["email"] } } }, undefined);
    expect(config.allowlists.searchable).toEqual(["name"]);
  });

  it("rejects a computed field named in allowlists.searchable", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          allowlists: { searchable: ["fullName" as never] },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowlists.searchable",
      });
      expect((error as ConfigurationException).message).toContain("searched on");
    }
  });

  it("rejects an explicit searchable entry naming a non-string own column", () => {
    try {
      resolveEntityConfig(userMetadata, { allowlists: { searchable: ["age" as never] } }, undefined);
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowlists.searchable",
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
      { allowlists: { searchable: ["posts.authorId" as never] } },
      undefined,
    );
    expect(config.allowlists.searchable).toEqual(["posts.authorId"]);
  });

  it("defaults creatable/updatable to every non-generated own column except the id, plus every relation", () => {
    const config = resolveEntityConfig(postMetadata, undefined, undefined);
    // `id` (generated, and the primary key regardless) and `deletedAt`
    // (generated) are excluded; `title`/`authorId` and both relations join
    // the default, the same base `DefaultDeserializer`'s own derived
    // writable projection uses.
    expect(config.allowlists.creatable).toEqual(["title", "authorId", "author", "comments"]);
    expect(config.allowlists.updatable).toEqual(["title", "authorId", "author", "comments"]);
  });

  it("uses explicit creatable/updatable arrays verbatim, independently of each other", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { allowlists: { creatable: ["name"], updatable: ["name", "email"] } },
      undefined,
    );
    expect(config.allowlists.creatable).toEqual(["name"]);
    expect(config.allowlists.updatable).toEqual(["name", "email"]);
    // Unconfigured allowlists still derive.
    expect(config.allowlists.filterable).toContain("age");
  });

  it("resolves creatable/updatable { exclude } against the writable base, not every column", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { allowlists: { creatable: { exclude: ["age"] }, updatable: { exclude: ["status"] } } },
      undefined,
    );
    // `id`/`createdAt` are excluded from the base itself (generated/id), so
    // naming them in `exclude` would be a no-op either way.
    expect(config.allowlists.creatable).toEqual(["name", "email", "status"]);
    expect(config.allowlists.updatable).toEqual(["name", "email", "age"]);
  });

  it("rejects a computed field named in allowlists.creatable or allowlists.updatable", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          computed: { fullName: { resolve: () => "" } },
          allowlists: { creatable: ["fullName" as never] },
        },
        undefined,
      );
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User",
        path: "allowlists.creatable",
      });
      expect((error as ConfigurationException).message).toContain("never writable");
    }
  });

  it("resolves an entity-scope defaultSort", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { query: { defaultSort: [{ field: "createdAt", direction: "desc" }] } },
      undefined,
    );
    expect(config.settings.query.defaultSort).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("lets an operation override the entity-scope defaultSort", () => {
    const config = resolveEntityConfig(
      userMetadata,
      {
        query: { defaultSort: [{ field: "createdAt", direction: "desc" }] },
        operations: { findMany: { query: { defaultSort: [{ field: "name", direction: "asc" }] } } },
      },
      undefined,
    );
    expect(config.settingsFor("findMany").query.defaultSort).toEqual([{ field: "name", direction: "asc" }]);
    expect(config.settingsFor("findOne").query.defaultSort).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("applies the precedence chain global -> entity for defaultSort", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { query: { defaultSort: [{ field: "name", direction: "asc" }] } },
      { query: { defaultSort: [{ field: "createdAt", direction: "desc" }] } },
    );
    expect(config.settings.query.defaultSort).toEqual([{ field: "name", direction: "asc" }]); // entity beats global

    const globalOnly = resolveEntityConfig(userMetadata, undefined, {
      query: { defaultSort: [{ field: "createdAt", direction: "desc" }] },
    });
    expect(globalOnly.settings.query.defaultSort).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("rejects an entity-scope defaultSort field outside the sortable allowlist", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          allowlists: { sortable: ["name"] },
          query: { defaultSort: [{ field: "email", direction: "asc" }] },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).detail).toContain("email");
    }
  });

  it("rejects an operation-scope defaultSort field outside the sortable allowlist", () => {
    try {
      resolveEntityConfig(
        userMetadata,
        {
          allowlists: { sortable: ["name"] },
          operations: { findMany: { query: { defaultSort: [{ field: "email", direction: "asc" }] } } },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).detail).toContain("email");
    }
  });

  it("rejects an operation-scope defaultInclude on a relation absent from allowlists.includable", () => {
    // `validateIncludableRelations` runs for the per-operation settings view
    // too, not only entity scope — an operation override can name
    // `relations.edges` just as the entity config can.
    try {
      resolveEntityConfig(
        authorMetadata,
        {
          operations: { findMany: { relations: { edges: { posts: { defaultInclude: true } } } } },
        },
        undefined,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author.operations.findMany",
        path: "relations.edges.posts",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });
});

/**
 * ADR-0028: `defaultInclude` vs. permission is cross-checked against
 * `allowlists.includable`, not `relations.edges`'s own (now-removed)
 * `includable` key — `validateIncludableRelations` in
 * resolve-entity-config.ts, run after `allowlists` is resolved.
 */
describe("resolveEntityConfig — allowlists.includable", () => {
  it("rejects defaultInclude on a relation absent from allowlists.includable", () => {
    try {
      resolveEntityConfig(authorMetadata, { relations: { edges: { posts: { defaultInclude: true } } } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "relations.edges.posts",
      });
      expect((error as ConfigurationException).detail).toContain("posts");
    }
  });

  it("rejects defaultInclude set at global scope when no entity opts the relation into allowlists.includable", () => {
    // Migration hazard: `relations.edges.<name>.defaultInclude` at global
    // `defaults` scope used to be safe — naming the relation at all was the
    // opt-in before this PR. It is not safe now: `allowlists.includable` is
    // entity-scope-only, so a global defaultInclude with no matching entity
    // grant is a bootstrap crash on every entity sharing that relation name,
    // not a silent no-op. Pinning the crash here so a future change to this
    // cross-check doesn't silently turn it into the no-op adopters might
    // expect.
    expect(() =>
      resolveEntityConfig(authorMetadata, undefined, { relations: { edges: { posts: { defaultInclude: true } } } }),
    ).toThrow(ConfigurationException);
  });

  it("accepts defaultInclude on a relation allowlists.includable named", () => {
    expect(() =>
      resolveEntityConfig(
        authorMetadata,
        {
          allowlists: { includable: ["posts"] },
          relations: { edges: { posts: { defaultInclude: true, maxDepth: 1 } } },
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("fails fast on a typo'd relation name in allowlists.includable", () => {
    try {
      resolveEntityConfig(authorMetadata, { allowlists: { includable: ["ghosts" as never] } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "allowlists.includable",
      });
      expect((error as ConfigurationException).detail).toContain("ghosts");
    }
  });

  it("fails fast on a typo'd relation name in allowlists.includable's { exclude } form", () => {
    // Unlike `resolveFieldSelector`'s `{ exclude }` (filterable/sortable/
    // selectable), which silently excludes nothing on a name that matches
    // nothing, `includable`'s `{ exclude }` checks its own names — a typo
    // here would otherwise open every relation instead of leaving the
    // intended one closed, the opposite of what the author wrote.
    try {
      resolveEntityConfig(authorMetadata, { allowlists: { includable: { exclude: ["ptes" as never] } } }, undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "allowlists.includable.exclude",
      });
      expect((error as ConfigurationException).detail).toContain("ptes");
    }
  });

  it("defaults to no relation includable when the key is unconfigured (opt-in, unlike the other allowlists)", () => {
    const config = resolveEntityConfig(authorMetadata, undefined, undefined);
    expect(config.allowlists.includable).toEqual([]);
    expect(config.relations.get("posts")?.includable).toBe(false);
  });

  it("opts every own relation in via an explicit { exclude: [] }", () => {
    const config = resolveEntityConfig(authorMetadata, { allowlists: { includable: { exclude: [] } } }, undefined);
    expect(config.allowlists.includable).toEqual(["posts"]);
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
